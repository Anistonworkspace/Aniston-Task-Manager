const { Task, TaskDependency, DependencyRequest, User, Notification, Board } = require('../models');
const { Op } = require('sequelize');
const { emitToUser } = require('../services/socketService');
const realtime = require('../services/realtimeService');
const { logActivity } = require('../services/activityService');
const depService = require('../services/dependencyService');
const { canPermanentlyDelete, getProtectionInfo } = require('../utils/archiveHelpers');
const dependencyRequestController = require('./dependencyRequestController');
const { createNotification, buildIdempotencyKey } = require('../services/notificationService');
const { sanitizeNotificationField, sanitizeNotificationMessage } = require('../utils/sanitize');

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

    const isBlockedByLegacy = blockedBy.some(d =>
      d.dependsOnTask && d.dependsOnTask.status !== 'done' &&
      ['blocks', 'required_for'].includes(d.dependencyType)
    );

    // Surface the new DependencyRequest rows alongside the legacy
    // task-to-task links so the frontend can read both shapes from one call.
    // The frontend will gradually move to consume `dependencyRequests` and
    // ignore `blockedBy`/`blocking` for delegated work.
    const dependencyRequests = await DependencyRequest.findAll({
      where: { parentTaskId: taskId, archivedAt: null },
      include: [
        { model: User, as: 'requestedBy', attributes: ['id', 'name', 'avatar', 'role'] },
        { model: User, as: 'assignedTo',  attributes: ['id', 'name', 'avatar', 'role'] },
      ],
      order: [['createdAt', 'DESC']],
    });

    const isBlockedByRequests = dependencyRequests.some(d =>
      ['pending', 'accepted', 'working_on_it', 'rejected'].includes(d.status)
    );

    res.json({
      success: true,
      data: {
        blockedBy,
        blocking,
        dependencyRequests,
        isBlocked: isBlockedByLegacy || isBlockedByRequests,
      },
    });
  } catch (error) {
    console.error('[Dependency] Get error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching dependencies.' });
  }
};

/**
 * Dispatcher for POST /api/tasks/:taskId/dependencies.
 *
 * Two body shapes are accepted at the same URL:
 *   - { dependsOnTaskId, ... }       → legacy task-to-task link (TaskDependency)
 *   - { assignedToUserId, title, ... } → new DependencyRequest (delegated work)
 *
 * The new behaviour is the default — any caller that doesn't pass
 * `dependsOnTaskId` lands in the new request handler. This is what the spec
 * calls for and what the existing UI's Add Dependency dialog will use.
 */
const createDependencyOrRequest = async (req, res) => {
  if (req.body?.dependsOnTaskId && !req.body?.assignedToUserId && !req.body?.assignToUserId) {
    return createDependency(req, res);
  }
  return dependencyRequestController.createDependencyRequest(req, res);
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
      Task.findByPk(taskId, { attributes: ['id', 'title', 'boardId', 'status'] }),
      Task.findByPk(dependsOnTaskId, { attributes: ['id', 'title'] }),
    ]);

    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
    if (!blockerTask) return res.status(404).json({ success: false, message: 'Blocker task not found.' });

    // Completed tasks are immutable for dependency relationships — adding work
    // to something already done would silently re-open it.
    if (task.status === 'done') {
      return res.status(400).json({
        success: false,
        message: 'Cannot add a dependency to a completed task. Reopen the task first.',
      });
    }

    // Phase 7 — granular dependencies.create gate. Admins can revoke a
    // user's ability to create dependencies without revoking task view/edit.
    {
      const { denyIfNoPermission } = require('../utils/permissionGate');
      if (await denyIfNoPermission(res, req.user, 'dependencies', 'create',
          'You do not have permission to create task dependencies.')) return;
    }

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
    // Two known business-rule throws from dependencyService — translate to
    // canonical client messages rather than forwarding the raw error text,
    // so any future detail added to the thrown message (paths, ids, debug
    // context) can't leak.
    if (error.message?.includes('circular')) {
      return res.status(400).json({
        success: false,
        code: 'DEPENDENCY_CIRCULAR',
        message: 'This would create a circular dependency between the selected tasks.',
      });
    }
    if (error.message?.includes('already exists')) {
      return res.status(400).json({
        success: false,
        code: 'DEPENDENCY_DUPLICATE',
        message: 'This dependency already exists for these tasks.',
      });
    }
    const safeLogger = require('../utils/safeLogger');
    safeLogger.error('[Dependency] Create error', { err: error });
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

    // Phase 5d — destructive-action gate.
    {
      const { assertCanDelete } = require('../services/tierEnforcement');
      const { sendIfTierError } = require('../utils/tierResponseHelpers');
      const isOwnResource = dep.createdById === req.user.id;
      if (sendIfTierError(res, () => assertCanDelete(req.user, 'dependency', { isOwnResource }))) return;
    }

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
    if (task.assignedTo !== req.user.id && !['admin', 'manager'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only the assigned user or admin can delegate this task.' });
    }

    // Phase B — granular dependencies.delegate gate. Umbrella → dependencies.create.
    {
      const { denyIfNoPermission } = require('../utils/permissionGate');
      if (await denyIfNoPermission(res, req.user, 'dependencies', 'delegate',
          'You do not have permission to delegate tasks.')) return;
    }

    // Mirror the global "no assignment without a due date" rule. Delegation
    // is just "reassign to someone else" — same protections apply, including
    // when the actor is delegating to themselves (a no-op the UI shouldn't
    // generate, but we still enforce on the server).
    if (!task.dueDate) {
      return res.status(400).json({
        success: false,
        message: 'Please set a due date before assigning this task to another user.',
      });
    }

    const toUser = await User.findByPk(toUserId, { attributes: ['id', 'name', 'email'] });
    if (!toUser) return res.status(404).json({ success: false, message: 'Target user not found.' });

    const previousAssignee = task.assignee?.name || 'Unassigned';
    await task.update({ assignedTo: toUserId });

    // Notify new assignee. Idempotent on the (task, fromUser, toUser) tuple
    // so a retried delegation POST doesn't double-notify, but a fresh
    // delegation between the same pair (rare but possible — task delegated
    // back-and-forth) gets its own row. We include the time bucket to
    // disambiguate intentional repeats.
    const safeMsg = sanitizeNotificationMessage(
      `${sanitizeNotificationField(req.user.name)} delegated task "${sanitizeNotificationField(task.title)}" to you${notes ? `: "${sanitizeNotificationField(notes, 80)}"` : ''}`
    );
    await createNotification({
      userId: toUserId,
      type: 'task_assigned',
      message: safeMsg,
      entityType: 'task',
      entityId: taskId,
      boardId: task.boardId,
      idempotencyKey: buildIdempotencyKey('task-delegated', taskId, req.user.id, toUserId, Math.floor(Date.now() / 60000)),
      sanitize: false,
    });
    // Targeted "you got delegated something" event for the new assignee
    // (TaskModal / MyWork can show a banner).
    emitToUser(toUserId, 'task:delegated', { taskId, title: task.title, fromUser: req.user.name, notes });
    // Realtime task update — fans out to board + assignees + watchers + the
    // PREVIOUS assignee (so their MyWork drops the row) and the new one
    // (so theirs picks it up). previousAssigneeId may be null if the task
    // was unassigned before delegation.
    const previousAssigneeId = task.assignedTo === toUserId ? null : task.assignedTo;
    realtime.emitTaskUpdated(
      { ...task.toJSON(), assignedTo: toUserId },
      {
        actorId: req.user.id,
        changedFields: ['assignedTo'],
        extraUserIds: [toUserId, previousAssigneeId].filter(Boolean),
      }
    );

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
    const isAdmin = ['admin', 'manager'].includes(req.user.role);

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
 * POST /api/tasks/:taskId/dependencies/assign  (legacy URL — preserved)
 *
 * Used to create a placeholder Task on the assignee's board and link it via
 * TaskDependency. That was the source of the "random duplicate task" bug.
 *
 * Now: thin shim that delegates to dependencyRequestController.createDependencyRequest,
 * which writes a DependencyRequest row and never creates a Task. Body shape
 * stays compatible — `assignToUserId`/`description` are accepted as aliases
 * for `assignedToUserId`/`blockingReason` inside the new handler.
 */
const assignDependency = (req, res) => dependencyRequestController.createDependencyRequest(req, res);

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

module.exports = { getTaskDependencies, createDependency, createDependencyOrRequest, removeDependency, delegateTask, getCrossTeamDependencies, assignDependency, archiveDependency, getArchivedDependencies, permanentDeleteDependency, restoreDependency };
