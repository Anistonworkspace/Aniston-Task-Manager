const { Task, TaskDependency, User, Notification, Board } = require('../models');
const { Op } = require('sequelize');
const { emitToUser, emitToBoard } = require('../services/socketService');
const { logActivity } = require('../services/activityService');
const depService = require('../services/dependencyService');
const { canPermanentlyDelete, getProtectionInfo } = require('../utils/archiveHelpers');

/**
 * GET /api/tasks/:taskId/dependencies
 */
const getTaskDependencies = async (req, res) => {
  try {
    const { taskId } = req.params;

    // Tasks this task is blocked by
    const blockedBy = await TaskDependency.findAll({
      where: { taskId },
      include: [
        {
          model: Task, as: 'dependsOnTask',
          attributes: ['id', 'title', 'status', 'priority', 'assignedTo', 'boardId'],
          include: [
            { model: User, as: 'assignee', attributes: ['id', 'name', 'avatar'] },
            { model: Board, as: 'board', attributes: ['id', 'name', 'color'] },
          ],
        },
        { model: User, as: 'autoAssignTo', attributes: ['id', 'name'] },
        { model: User, as: 'createdBy', attributes: ['id', 'name'] },
      ],
    });

    // Tasks this task is blocking
    const blocking = await TaskDependency.findAll({
      where: { dependsOnTaskId: taskId },
      include: [
        {
          model: Task, as: 'task',
          attributes: ['id', 'title', 'status', 'priority', 'assignedTo', 'boardId'],
          include: [
            { model: User, as: 'assignee', attributes: ['id', 'name', 'avatar'] },
            { model: Board, as: 'board', attributes: ['id', 'name', 'color'] },
          ],
        },
        { model: User, as: 'autoAssignTo', attributes: ['id', 'name'] },
      ],
    });

    const isBlocked = blockedBy.some(d =>
      d.dependsOnTask && d.dependsOnTask.status !== 'done' &&
      ['blocks', 'required_for'].includes(d.dependencyType)
    );

    res.json({
      success: true,
      data: { blockedBy, blocking, isBlocked },
    });
  } catch (error) {
    console.error('[Dependency] Get error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching dependencies.' });
  }
};

/**
 * POST /api/tasks/:taskId/dependencies
 */
const createDependency = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { dependsOnTaskId, dependencyType, autoAssignOnComplete, autoAssignToUserId, description } = req.body;

    if (!dependsOnTaskId) {
      return res.status(400).json({ success: false, message: 'dependsOnTaskId is required.' });
    }

    // Verify both tasks exist
    const [task, blockerTask] = await Promise.all([
      Task.findByPk(taskId, { attributes: ['id', 'title', 'boardId'] }),
      Task.findByPk(dependsOnTaskId, { attributes: ['id', 'title'] }),
    ]);

    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
    if (!blockerTask) return res.status(404).json({ success: false, message: 'Blocker task not found.' });

    const dep = await depService.createDependency({
      taskId,
      dependsOnTaskId,
      dependencyType,
      autoAssignOnComplete,
      autoAssignToUserId,
      description,
      createdById: req.user.id,
    });

    // Fetch full dependency with includes
    const fullDep = await TaskDependency.findByPk(dep.id, {
      include: [
        { model: Task, as: 'dependsOnTask', attributes: ['id', 'title', 'status'] },
        { model: User, as: 'autoAssignTo', attributes: ['id', 'name'] },
      ],
    });

    logActivity({
      action: 'dependency_created',
      description: `${req.user.name} added dependency: "${task.title}" depends on "${blockerTask.title}"`,
      entityType: 'task',
      entityId: taskId,
      taskId,
      boardId: task.boardId,
      userId: req.user.id,
    });

    res.status(201).json({
      success: true,
      message: 'Dependency created successfully.',
      data: { dependency: fullDep },
    });
  } catch (error) {
    if (error.message.includes('circular') || error.message.includes('already exists')) {
      return res.status(400).json({ success: false, message: error.message });
    }
    console.error('[Dependency] Create error:', error);
    res.status(500).json({ success: false, message: 'Server error creating dependency.' });
  }
};

/**
 * DELETE /api/tasks/:taskId/dependencies/:dependencyId
 */
const removeDependency = async (req, res) => {
  try {
    const { taskId, dependencyId } = req.params;

    const dep = await TaskDependency.findOne({
      where: { id: dependencyId, taskId },
      include: [{ model: Task, as: 'dependsOnTask', attributes: ['id', 'title'] }],
    });

    if (!dep) {
      return res.status(404).json({ success: false, message: 'Dependency not found.' });
    }

    const task = await Task.findByPk(taskId, { attributes: ['id', 'title', 'boardId'] });

    const wasBocking = ['blocks', 'required_for'].includes(dep.dependencyType);

    await dep.destroy();

    // If the removed dependency was blocking, check if the task is now unblocked
    if (wasBocking) {
      await depService.unlockTaskIfUnblocked(taskId);
    }

    logActivity({
      action: 'dependency_removed',
      description: `${req.user.name} removed dependency from "${task?.title}"`,
      entityType: 'task',
      entityId: taskId,
      taskId,
      boardId: task?.boardId,
      userId: req.user.id,
    });

    res.json({ success: true, message: 'Dependency removed.' });
  } catch (error) {
    console.error('[Dependency] Remove error:', error);
    res.status(500).json({ success: false, message: 'Server error removing dependency.' });
  }
};

/**
 * POST /api/tasks/:taskId/delegate
 * Employee delegates their task to a teammate.
 */
const delegateTask = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { toUserId, notes } = req.body;

    if (!toUserId) {
      return res.status(400).json({ success: false, message: 'toUserId is required.' });
    }

    const task = await Task.findByPk(taskId, {
      include: [
        { model: User, as: 'assignee', attributes: ['id', 'name'] },
        { model: Board, as: 'board', attributes: ['id', 'name'] },
      ],
    });

    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });

    // Only current assignee or admin can delegate
    if (task.assignedTo !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only the assigned user or admin can delegate this task.' });
    }

    const toUser = await User.findByPk(toUserId, { attributes: ['id', 'name', 'email'] });
    if (!toUser) return res.status(404).json({ success: false, message: 'Target user not found.' });

    const previousAssignee = task.assignee?.name || 'Unassigned';
    await task.update({ assignedTo: toUserId });

    // Notify new assignee
    const notification = await Notification.create({
      type: 'task_assigned',
      message: `${req.user.name} delegated task "${task.title}" to you${notes ? `: "${notes}"` : ''}`,
      entityType: 'task',
      entityId: taskId,
      userId: toUserId,
    });
    emitToUser(toUserId, 'notification:new', { notification });
    emitToUser(toUserId, 'task:delegated', { taskId, title: task.title, fromUser: req.user.name, notes });

    if (task.boardId) {
      emitToBoard(task.boardId, 'task:updated', { task: { ...task.toJSON(), assignedTo: toUserId } });
    }

    logActivity({
      action: 'task_delegated',
      description: `${req.user.name} delegated "${task.title}" from ${previousAssignee} to ${toUser.name}`,
      entityType: 'task',
      entityId: taskId,
      taskId,
      boardId: task.boardId,
      userId: req.user.id,
      meta: { fromUserId: req.user.id, fromUserName: req.user.name, toUserId, toUserName: toUser.name, notes },
    });

    res.json({
      success: true,
      message: `Task delegated to ${toUser.name} successfully.`,
      data: { task: { ...task.toJSON(), assignedTo: toUserId } },
    });
  } catch (error) {
    console.error('[Dependency] Delegate error:', error);
    res.status(500).json({ success: false, message: 'Server error delegating task.' });
  }
};

/**
 * GET /api/tasks/cross-team-deps
 * Returns tasks that have cross-board dependencies involving the current user's boards
 */
const getCrossTeamDependencies = async (req, res) => {
  try {
    const userId = req.user.id;
    const isAdmin = req.user.role === 'admin';

    // Get all non-archived dependencies
    const deps = await TaskDependency.findAll({
      where: { [Op.or]: [{ isArchived: false }, { isArchived: null }] },
      include: [
        {
          model: Task, as: 'task', required: false,
          attributes: ['id', 'title', 'description', 'status', 'priority', 'assignedTo', 'boardId', 'dueDate'],
          include: [
            { model: User, as: 'assignee', attributes: ['id', 'name', 'avatar'], required: false },
            { model: Board, as: 'board', attributes: ['id', 'name', 'color'], required: false },
          ],
        },
        {
          model: Task, as: 'dependsOnTask', required: false,
          attributes: ['id', 'title', 'description', 'status', 'priority', 'assignedTo', 'boardId', 'dueDate'],
          include: [
            { model: User, as: 'assignee', attributes: ['id', 'name', 'avatar'], required: false },
            { model: Board, as: 'board', attributes: ['id', 'name', 'color'], required: false },
          ],
        },
        { model: User, as: 'createdBy', attributes: ['id', 'name'], required: false },
      ],
      order: [['createdAt', 'DESC']],
    });

    console.log(`[Dependency] getCrossTeamDeps: found ${deps.length} total deps for user ${userId} (isAdmin: ${isAdmin})`);

    // Filter: all dependencies involving the user (or all for admin)
    const crossDeps = deps.filter(d => {
      if (!d.task || !d.dependsOnTask) {
        console.log(`[Dependency] Skipping dep ${d.id}: task=${!!d.task}, dependsOnTask=${!!d.dependsOnTask}`);
        return false;
      }
      if (isAdmin) return true;
      const match = d.task.assignedTo === userId || d.dependsOnTask.assignedTo === userId || d.createdById === userId;
      if (!match) {
        console.log(`[Dependency] No match: task.assignedTo=${d.task.assignedTo}, dep.assignedTo=${d.dependsOnTask.assignedTo}, createdById=${d.createdById}, userId=${userId}`);
      }
      return match;
    });

    console.log(`[Dependency] After filter: ${crossDeps.length} deps`);

    res.json({ success: true, data: { dependencies: crossDeps } });
  } catch (error) {
    console.error('[Dependency] CrossTeam error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * POST /api/tasks/:taskId/dependencies/assign
 * Employee assigns a dependency to another employee.
 * Creates a new task assigned to the target employee and links it as a dependency.
 */
const assignDependency = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { assignToUserId, title, description, dependencyType } = req.body;

    if (!assignToUserId) {
      return res.status(400).json({ success: false, message: 'assignToUserId is required.' });
    }
    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, message: 'Task title is required.' });
    }

    // Verify current task exists
    const currentTask = await Task.findByPk(taskId, { attributes: ['id', 'title', 'boardId'] });
    if (!currentTask) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    // Verify target user exists
    const targetUser = await User.findByPk(assignToUserId, { attributes: ['id', 'name', 'email'] });
    if (!targetUser) {
      return res.status(404).json({ success: false, message: 'Target user not found.' });
    }

    // Create new task assigned to the target employee on the same board
    const newTask = await Task.create({
      title: title.trim(),
      description: description || '',
      boardId: currentTask.boardId,
      assignedTo: assignToUserId,
      createdBy: req.user.id,
      status: 'not_started',
      priority: 'medium',
      position: 0,
    });

    // Create dependency: current task depends on the new task
    const dep = await depService.createDependency({
      taskId,
      dependsOnTaskId: newTask.id,
      dependencyType: dependencyType || 'blocks',
      autoAssignOnComplete: false,
      createdById: req.user.id,
    });

    // Notify the assigned employee
    const notification = await Notification.create({
      type: 'task_assigned',
      message: `${req.user.name} assigned you a dependency task: "${title.trim()}"`,
      entityType: 'task',
      entityId: newTask.id,
      userId: assignToUserId,
    });
    emitToUser(assignToUserId, 'notification:new', { notification });
    emitToBoard(currentTask.boardId, 'task:created', { task: newTask });

    logActivity({
      action: 'dependency_assigned',
      description: `${req.user.name} assigned dependency "${title.trim()}" to ${targetUser.name}`,
      entityType: 'task',
      entityId: taskId,
      taskId,
      boardId: currentTask.boardId,
      userId: req.user.id,
      meta: { assignedToUserId: assignToUserId, newTaskId: newTask.id },
    });

    res.status(201).json({
      success: true,
      message: `Dependency assigned to ${targetUser.name} successfully.`,
      data: { task: newTask, dependency: dep },
    });
  } catch (error) {
    if (error.message.includes('circular') || error.message.includes('already exists')) {
      return res.status(400).json({ success: false, message: error.message });
    }
    console.error('[Dependency] Assign error:', error);
    res.status(500).json({ success: false, message: 'Server error assigning dependency.' });
  }
};

/**
 * PUT /api/tasks/:taskId/dependencies/:dependencyId/archive
 * Archive a resolved dependency
 */
const archiveDependency = async (req, res) => {
  try {
    const { dependencyId } = req.params;
    const dep = await TaskDependency.findByPk(dependencyId, {
      include: [
        { model: Task, as: 'task', attributes: ['id', 'assignedTo'] },
        { model: Task, as: 'dependsOnTask', attributes: ['id', 'assignedTo'] },
      ],
    });
    if (!dep) return res.status(404).json({ success: false, message: 'Dependency not found.' });

    const isManager = ['manager', 'admin', 'assistant_manager'].includes(req.user.role);
    const isInvolved = dep.createdById === req.user.id ||
      dep.task?.assignedTo === req.user.id ||
      dep.dependsOnTask?.assignedTo === req.user.id;

    if (!isManager && !isInvolved) {
      return res.status(403).json({ success: false, message: 'Not authorized to archive this dependency.' });
    }

    await dep.update({ isArchived: true, archivedAt: new Date(), archivedBy: req.user.id });

    // Check if the blocked task is now unblocked after archiving this dependency
    if (['blocks', 'required_for'].includes(dep.dependencyType) && dep.task?.id) {
      await depService.unlockTaskIfUnblocked(dep.task.id);
    }

    logActivity({ action: 'dependency_archived', description: `${req.user.name} archived a dependency`, entityType: 'dependency', entityId: dep.id, userId: req.user.id });

    res.json({ success: true, message: 'Dependency archived.' });
  } catch (error) {
    console.error('[Dependency] Archive error:', error);
    res.status(500).json({ success: false, message: 'Server error archiving dependency.' });
  }
};

/**
 * GET /api/archive/dependencies
 * Manager+ — list archived dependencies with search/date filters
 */
const getArchivedDependencies = async (req, res) => {
  try {
    const { search, dateFrom, dateTo } = req.query;
    const where = { isArchived: true };

    if (dateFrom || dateTo) {
      where.archivedAt = {};
      if (dateFrom) where.archivedAt[Op.gte] = new Date(dateFrom);
      if (dateTo) where.archivedAt[Op.lte] = new Date(dateTo + 'T23:59:59Z');
    }

    const deps = await TaskDependency.findAll({
      where,
      include: [
        {
          model: Task, as: 'task',
          attributes: ['id', 'title', 'status', 'boardId'],
          include: [{ model: Board, as: 'board', attributes: ['id', 'name', 'color'] }],
          ...(search ? { where: { title: { [Op.iLike]: `%${search}%` } } } : {}),
          required: !!search,
        },
        {
          model: Task, as: 'dependsOnTask',
          attributes: ['id', 'title', 'status', 'boardId'],
          include: [{ model: Board, as: 'board', attributes: ['id', 'name', 'color'] }],
        },
        { model: User, as: 'createdBy', attributes: ['id', 'name'] },
        { model: User, as: 'archiver', attributes: ['id', 'name'] },
      ],
      order: [['archivedAt', 'DESC']],
    });

    const data = deps.map(d => {
      const plain = d.toJSON();
      plain.protectionInfo = getProtectionInfo(plain.archivedAt);
      return plain;
    });

    res.json({ success: true, data: { dependencies: data } });
  } catch (error) {
    console.error('[Dependency] getArchivedDependencies error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * DELETE /api/archive/dependencies/:id
 * Permanently delete — enforces 90-day rule
 */
const permanentDeleteDependency = async (req, res) => {
  try {
    const dep = await TaskDependency.findByPk(req.params.id);
    if (!dep) return res.status(404).json({ success: false, message: 'Dependency not found.' });
    if (!dep.isArchived) return res.status(400).json({ success: false, message: 'Only archived dependencies can be permanently deleted.' });

    const { allowed, daysRemaining } = canPermanentlyDelete(req.user, dep.archivedAt);
    if (!allowed) {
      return res.status(403).json({ success: false, message: `This item is protected for ${daysRemaining} more days. Only Super Admin can delete before 90 days.` });
    }

    await dep.destroy();
    logActivity({ action: 'dependency_deleted', description: `${req.user.name} permanently deleted an archived dependency`, entityType: 'dependency', entityId: req.params.id, userId: req.user.id });

    res.json({ success: true, message: 'Dependency permanently deleted.' });
  } catch (error) {
    console.error('[Dependency] permanentDelete error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * PUT /api/archive/dependencies/:id/restore
 * Restore an archived dependency
 */
const restoreDependency = async (req, res) => {
  try {
    const dep = await TaskDependency.findByPk(req.params.id);
    if (!dep) return res.status(404).json({ success: false, message: 'Dependency not found.' });

    await dep.update({ isArchived: false, archivedAt: null, archivedBy: null });

    // If restored dependency is blocking, re-check if the task should be locked
    if (['blocks', 'required_for'].includes(dep.dependencyType)) {
      const blockerTask = await Task.findByPk(dep.dependsOnTaskId, { attributes: ['id', 'status'] });
      if (blockerTask && blockerTask.status !== 'done') {
        await depService.lockTaskAsDependencyBlocked(dep.taskId);
      }
    }

    res.json({ success: true, message: 'Dependency restored.' });
  } catch (error) {
    console.error('[Dependency] restore error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

module.exports = { getTaskDependencies, createDependency, removeDependency, delegateTask, getCrossTeamDependencies, assignDependency, archiveDependency, getArchivedDependencies, permanentDeleteDependency, restoreDependency };
