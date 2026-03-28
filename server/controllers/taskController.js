const { Task, Board, User, Notification, Subtask, Label, TaskOwner } = require('../models');
const { sequelize } = require('../config/db');
const { validationResult } = require('express-validator');
const logger = require('../utils/logger');
const { Op } = require('sequelize');
const { emitToBoard, emitToUser } = require('../services/socketService');
const teamsWebhook = require('../services/teamsWebhook');
const { logActivity } = require('../services/activityService');
const depService = require('../services/dependencyService');
const { processAutomations } = require('../services/automationService');
const { sanitizeInput } = require('../utils/sanitize');
const calendarService = require('../services/calendarService');
const { checkConflicts: detectConflicts, autoReschedule: rescheduleTask, getScheduleSummary } = require('../services/conflictDetectionService');

// Reusable include block for the two user associations that appear on every task query
const TASK_INCLUDES = [
  { model: User, as: 'assignee', attributes: ['id', 'name', 'email', 'avatar'] },
  { model: User, as: 'creator', attributes: ['id', 'name', 'email', 'avatar', 'role'] },
  { model: User, as: 'owners', attributes: ['id', 'name', 'email', 'avatar'], through: { attributes: ['isPrimary'] } },
];

/**
 * POST /api/tasks
 */
const createTask = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const {
      title, description, status, priority, groupId,
      dueDate, startDate, tags, customFields, boardId, assignedTo, ownerIds,
    } = req.body;

    // Verify board exists
    const board = await Board.findByPk(boardId);
    if (!board) {
      return res.status(404).json({ success: false, message: 'Board not found.' });
    }

    // Members can only create tasks assigned to themselves; all other roles can assign anyone
    const canAssignOthers = ['admin', 'manager', 'assistant_manager'].includes(req.user.role);
    const isMember = !canAssignOthers;
    const finalAssignedTo = canAssignOthers ? (assignedTo || null) : req.user.id;

    // Determine position (append to end of group)
    const maxPosition = await Task.max('position', {
      where: { boardId, groupId: groupId || 'new' },
    });

    const task = await Task.create({
      title: sanitizeInput(title),
      description: sanitizeInput(description) || '',
      status: status || 'not_started',
      priority: isMember ? 'medium' : (priority || 'medium'),
      groupId: groupId || 'new',
      dueDate: dueDate || null,
      startDate: startDate || null,
      position: (maxPosition || 0) + 1,
      tags: tags || [],
      customFields: customFields || {},
      boardId,
      assignedTo: finalAssignedTo,
      createdBy: req.user.id,
    });

    // Sync multi-owner records
    if (Array.isArray(ownerIds) && ownerIds.length > 0 && canAssignOthers) {
      const ownerRecords = ownerIds.map((uid, idx) => ({
        taskId: task.id,
        userId: uid,
        isPrimary: idx === 0,
      }));
      await TaskOwner.bulkCreate(ownerRecords, { ignoreDuplicates: true });
      // Auto-add all owners as board members
      for (const uid of ownerIds) {
        try { await board.addMember(uid); } catch (e) { /* already a member */ }
      }
    }

    const fullTask = await Task.findByPk(task.id, {
      include: [
        ...TASK_INCLUDES,
        { model: Board, as: 'board', attributes: ['id', 'name'] },
      ],
    });

    // Auto-add assignee as board member if not already
    if (finalAssignedTo && boardId) {
      try {
        await board.addMember(finalAssignedTo);
      } catch (e) { /* already a member, ignore */ }
    }

    // Create notification for assignee
    if (assignedTo && assignedTo !== req.user.id) {
      const notification = await Notification.create({
        type: 'task_assigned',
        message: `${req.user.name} assigned you to "${title}" on board "${board.name}"`,
        entityType: 'task',
        entityId: task.id,
        userId: assignedTo,
      });
      emitToUser(assignedTo, 'notification:new', { notification });
    }

    // Activity log
    logActivity({
      action: 'task_created',
      description: `${req.user.name} created task "${title}"`,
      entityType: 'task',
      entityId: task.id,
      taskId: task.id,
      boardId,
      userId: req.user.id,
    });

    // Socket.io real-time event
    emitToBoard(boardId, 'task:created', { task: fullTask });

    // Teams webhook
    teamsWebhook.sendTaskCreated({
      task: fullTask,
      boardName: board.name,
      creatorName: req.user.name,
      assigneeName: fullTask.assignee ? fullTask.assignee.name : null,
    });

    // Sync to Teams calendar (fire-and-forget)
    if (finalAssignedTo) {
      calendarService.createTaskEvent(task.id, finalAssignedTo).catch(err =>
        console.warn('[Teams] Calendar sync failed for new task:', err.message)
      );
    }

    res.status(201).json({
      success: true,
      message: 'Task created successfully.',
      data: { task: fullTask },
    });
  } catch (error) {
    logger.error('[Task] Create error:', error);
    res.status(500).json({ success: false, message: 'Server error creating task.' });
  }
};

/**
 * GET /api/tasks
 * Query params: boardId (required), status, priority, assignedTo, groupId, search, sortBy, sortOrder
 */
const getTasks = async (req, res) => {
  try {
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(req.user.id)) {
      return res.status(401).json({ success: false, message: 'Invalid user session' });
    }

    const { boardId, status, priority, assignedTo, groupId, search, sortBy, sortOrder, limit, archived, context } = req.query;

    const where = {};
    // By default exclude archived tasks, unless ?archived=true is passed
    if (archived === 'true') {
      where.isArchived = true;
    } else {
      where.isArchived = false;
    }

    if (boardId) where.boardId = boardId;

    // Visibility filter for multi-owner support
    const ownershipFilter = [
      { assignedTo: req.user.id },
      sequelize.literal(`"Task"."id" IN (SELECT "taskId" FROM task_owners WHERE "userId" = '${req.user.id}')`),
    ];

    // Support "me" shorthand for current user's tasks across all boards (including multi-owner)
    if (assignedTo === 'me') {
      if (!where[Op.and]) where[Op.and] = [];
      where[Op.and].push({ [Op.or]: ownershipFilter });
    } else if (assignedTo) {
      where.assignedTo = assignedTo;
    }

    // Members without boardId can only see their own tasks (unless fetching for dependency selector)
    if (!boardId && req.user.role === 'member' && context !== 'dependency' && assignedTo !== 'me') {
      if (!where[Op.and]) where[Op.and] = [];
      where[Op.and].push({ [Op.or]: ownershipFilter });
    }

    if (status) where.status = status;
    if (priority) where.priority = priority;
    if (groupId) where.groupId = groupId;

    if (search) {
      if (!where[Op.and]) where[Op.and] = [];
      where[Op.and].push({
        [Op.or]: [
          { title: { [Op.iLike]: `%${search}%` } },
          { description: { [Op.iLike]: `%${search}%` } },
        ],
      });
    }

    const ALLOWED_SORT_FIELDS = ['title', 'status', 'priority', 'dueDate', 'position', 'createdAt', 'progress', 'startDate', 'updatedAt'];
    const order = [];
    if (sortBy && ALLOWED_SORT_FIELDS.includes(sortBy)) {
      order.push([sortBy, sortOrder === 'desc' ? 'DESC' : 'ASC']);
    } else {
      order.push(['position', 'ASC']);
    }

    const queryOpts = {
      where,
      include: [
        ...TASK_INCLUDES,
        { model: Subtask, as: 'subtasks', attributes: ['id', 'status'] },
        { model: Board, as: 'board', attributes: ['id', 'name', 'color'] },
        { model: Label, as: 'labels', through: { attributes: [] }, attributes: ['id', 'name', 'color'] },
      ],
      order,
    };
    if (limit) queryOpts.limit = Math.min(parseInt(limit, 10) || 50, 100);

    const tasks = await Task.findAll(queryOpts);

    // Add subtask counts and Board info to each task
    const tasksWithCounts = tasks.map(t => {
      const plain = t.toJSON();
      const subs = plain.subtasks || [];
      plain.subtaskTotal = subs.length;
      plain.subtaskDone = subs.filter(s => s.status === 'done').length;
      plain.Board = plain.board || null;
      delete plain.subtasks;
      return plain;
    });

    res.json({ success: true, data: { tasks: tasksWithCounts } });
  } catch (error) {
    logger.error('[Task] GetTasks error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching tasks.' });
  }
};

/**
 * GET /api/tasks/:id
 */
const getTask = async (req, res) => {
  try {
    const task = await Task.findByPk(req.params.id, {
      include: [
        ...TASK_INCLUDES,
        { model: Board, as: 'board', attributes: ['id', 'name', 'color'] },
      ],
    });

    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    res.json({ success: true, data: { task } });
  } catch (error) {
    logger.error('[Task] GetTask error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching task.' });
  }
};

/**
 * PUT /api/tasks/:id
 */
const updateTask = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const task = await Task.findByPk(req.params.id, {
      include: [{ model: Board, as: 'board', attributes: ['id', 'name'] }],
    });

    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    // Members can only update tasks assigned to them or where they are an owner
    const isMember = req.user.role === 'member';
    const isManager = req.user.role === 'manager';
    const isAssistantManager = req.user.role === 'assistant_manager';
    const isAdmin = req.user.role === 'admin';
    if (isMember && task.assignedTo !== req.user.id) {
      // Check if user is a task owner
      const isOwner = await TaskOwner.findOne({ where: { taskId: task.id, userId: req.user.id } });
      if (!isOwner) {
        return res.status(403).json({
          success: false,
          message: 'You can only update tasks assigned to you.',
        });
      }
    }

    const allFields = [
      'title', 'description', 'status', 'priority', 'groupId',
      'dueDate', 'startDate', 'position', 'tags', 'customFields',
      'assignedTo', 'isArchived', 'progress',
      'plannedStartTime', 'plannedEndTime', 'estimatedHours', 'actualHours',
    ];
    const restrictedFields = ['title', 'status', 'progress', 'groupId', 'position'];

    // Determine allowed fields based on role + task creator
    let allowedFields;
    if (isAdmin) {
      allowedFields = allFields;
    } else if (isManager || isAssistantManager) {
      // Manager/Assistant Manager can only edit status/progress on admin-assigned tasks
      let creatorRole = null;
      if (task.createdBy) {
        const creator = await User.findByPk(task.createdBy, { attributes: ['id', 'role'] });
        creatorRole = creator?.role;
      }
      allowedFields = (creatorRole === 'admin') ? restrictedFields : allFields;
    } else {
      allowedFields = restrictedFields;
    }

    const updates = {};
    const changes = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        const oldValue = task[field];
        updates[field] = req.body[field];
        if (JSON.stringify(oldValue) !== JSON.stringify(req.body[field])) {
          changes[field] = req.body[field];
        }
      }
    }

    const previousStatus = task.status;
    const previousAssignee = task.assignedTo;

    await task.update(updates);

    // Sync multi-owner records if ownerIds provided
    if (Array.isArray(req.body.ownerIds) && (isAdmin || isManager || isAssistantManager)) {
      const newOwnerIds = req.body.ownerIds;
      // Remove owners not in the new list
      await TaskOwner.destroy({ where: { taskId: task.id, userId: { [Op.notIn]: newOwnerIds } } });
      // Upsert new owners
      for (let i = 0; i < newOwnerIds.length; i++) {
        const [record] = await TaskOwner.findOrCreate({
          where: { taskId: task.id, userId: newOwnerIds[i] },
          defaults: { isPrimary: i === 0 },
        });
        // Update isPrimary for existing records
        if (record.isPrimary !== (i === 0)) {
          await record.update({ isPrimary: i === 0 });
        }
      }
      // Auto-add all owners as board members
      const board = await Board.findByPk(task.boardId);
      if (board) {
        for (const uid of newOwnerIds) {
          try { await board.addMember(uid); } catch (e) { /* already a member */ }
        }
      }
    }

    const fullTask = await Task.findByPk(task.id, {
      include: [
        ...TASK_INCLUDES,
        { model: Board, as: 'board', attributes: ['id', 'name'] },
      ],
    });

    // Auto-add new assignee as board member
    if (updates.assignedTo && task.boardId) {
      try {
        const board = await Board.findByPk(task.boardId);
        if (board) await board.addMember(updates.assignedTo);
      } catch (e) { /* already a member */ }
    }

    // Notification: new assignee
    if (updates.assignedTo && updates.assignedTo !== previousAssignee && updates.assignedTo !== req.user.id) {
      const notification = await Notification.create({
        type: 'task_assigned',
        message: `${req.user.name} assigned you to "${task.title}" on board "${task.board.name}"`,
        entityType: 'task',
        entityId: task.id,
        userId: updates.assignedTo,
      });
      emitToUser(updates.assignedTo, 'notification:new', { notification });
    }

    // Notification: task completed
    if (updates.status === 'done' && previousStatus !== 'done') {
      // Update Teams calendar event with [DONE] prefix (fire-and-forget)
      if (task.teamsEventId && task.assignedTo) {
        const { updateCalendarEvent } = require('../services/teamsCalendarService');
        (async () => {
          try {
            await updateCalendarEvent(task.assignedTo, task.teamsEventId, {
              subject: `[DONE] ${task.title}`,
            });
          } catch (err) {
            console.error('[Task] Teams calendar [DONE] update error:', err.message);
          }
        })();
      }

      teamsWebhook.sendTaskCompleted({
        task: fullTask,
        boardName: task.board.name,
        completedByName: req.user.name,
      });

      // Notify the creator if they didn't complete it themselves
      if (task.createdBy !== req.user.id) {
        const notification = await Notification.create({
          type: 'task_updated',
          message: `${req.user.name} completed "${task.title}" on board "${task.board.name}"`,
          entityType: 'task',
          entityId: task.id,
          userId: task.createdBy,
        });
        emitToUser(task.createdBy, 'notification:new', { notification });
      }

      // Process dependency chain — unblock dependent tasks & auto-assign
      depService.processTaskCompletion(task.id, req.user.id);
    }

    // Activity log for each change
    for (const [field, value] of Object.entries(changes)) {
      const actionName = field === 'status' ? 'status_changed' : 'task_updated';
      const desc = field === 'status'
        ? `${req.user.name} changed status to "${value}"`
        : field === 'assignedTo'
          ? `${req.user.name} reassigned the task`
          : `${req.user.name} updated ${field}`;
      logActivity({
        action: actionName,
        description: desc,
        entityType: 'task',
        entityId: task.id,
        taskId: task.id,
        boardId: task.boardId,
        userId: req.user.id,
        meta: { field, value },
      });
    }

    // Process automations
    if (updates.status && updates.status !== previousStatus) {
      processAutomations('status_changed', { task: fullTask, previousStatus, newStatus: updates.status, userId: req.user.id });
    }
    if (updates.assignedTo && updates.assignedTo !== previousAssignee) {
      processAutomations('task_assigned', { task: fullTask, userId: req.user.id });
    }

    // Socket.io — broadcast to board room and assignee's personal room
    emitToBoard(task.boardId, 'task:updated', { task: fullTask });
    if (task.assignedTo) emitToUser(task.assignedTo, 'task:updated', { task: fullTask });
    if (previousAssignee && previousAssignee !== task.assignedTo) emitToUser(previousAssignee, 'task:updated', { task: fullTask });

    // Teams webhook for general updates (skip if it was only a completion)
    if (Object.keys(changes).length > 0 && updates.status !== 'done') {
      teamsWebhook.sendTaskUpdated({
        task: fullTask,
        boardName: task.board.name,
        updaterName: req.user.name,
        changes,
      });
    }

    // Sync to Teams calendar (fire-and-forget)
    if (updates.assignedTo && updates.assignedTo !== previousAssignee) {
      // Assignee changed — delete old event, create new one
      if (previousAssignee && task.teamsEventId) {
        calendarService.deleteTaskEvent(task.id, previousAssignee).catch(() => {});
      }
      calendarService.createTaskEvent(task.id, updates.assignedTo).catch(err =>
        console.warn('[Teams] Calendar sync failed for reassigned task:', err.message)
      );
    } else if (task.teamsEventId && task.assignedTo && Object.keys(changes).length > 0) {
      // Task details changed (title, dates, etc.) — update existing event
      calendarService.updateTaskEvent(task.id, task.assignedTo).catch(err =>
        console.warn('[Teams] Calendar event update failed:', err.message)
      );
    }

    res.json({
      success: true,
      message: 'Task updated successfully.',
      data: { task: fullTask },
    });
  } catch (error) {
    logger.error('[Task] Update error:', error);
    res.status(500).json({ success: false, message: 'Server error updating task.' });
  }
};

/**
 * DELETE /api/tasks/:id
 */
const deleteTask = async (req, res) => {
  try {
    const task = await Task.findByPk(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    const isMember = req.user.role === 'member';

    // Members can only archive, not delete. Only managers/admins can permanently delete.
    if (isMember) {
      // Members can only archive tasks assigned to them
      if (task.assignedTo !== req.user.id) {
        return res.status(403).json({ success: false, message: 'You can only archive tasks assigned to you.' });
      }
      // Remove Teams calendar event on archive
      if (task.teamsEventId && task.assignedTo) {
        calendarService.deleteTaskEvent(task.id, task.assignedTo).catch(() => {});
      }
      await task.update({ isArchived: true, archivedAt: new Date(), archivedBy: req.user.id });
      logActivity({
        action: 'task_archived',
        description: `${req.user.name} archived task "${task.title}"`,
        entityType: 'task', entityId: task.id, taskId: task.id, boardId: task.boardId, userId: req.user.id,
      });
      emitToBoard(task.boardId, 'task:updated', { task: { ...task.toJSON(), isArchived: true } });
      return res.json({ success: true, message: 'Task archived successfully. Only managers can permanently delete tasks.' });
    }

    // Managers/admins: permanent delete — enforce 90-day rule
    const { canPermanentlyDelete } = require('../utils/archiveHelpers');
    if (task.isArchived) {
      const { allowed, daysRemaining } = canPermanentlyDelete(req.user, task.archivedAt);
      if (!allowed) {
        return res.status(403).json({ success: false, message: `This task is protected for ${daysRemaining} more days. Only Super Admin can delete before 90 days.` });
      }
    }

    const boardId = task.boardId;
    const taskId = task.id;
    const taskTitle = task.title;

    // Remove Teams calendar event before deleting
    if (task.teamsEventId && task.assignedTo) {
      calendarService.deleteTaskEvent(task.id, task.assignedTo).catch(() => {});
    }

    await task.destroy();

    logActivity({
      action: 'task_deleted',
      description: `${req.user.name} deleted task "${taskTitle}"`,
      entityType: 'task',
      entityId: taskId,
      taskId: null,
      boardId,
      userId: req.user.id,
    });

    emitToBoard(boardId, 'task:deleted', { taskId, boardId });

    res.json({ success: true, message: 'Task deleted successfully.' });
  } catch (error) {
    logger.error('[Task] Delete error:', error);
    res.status(500).json({ success: false, message: 'Server error deleting task.' });
  }
};

/**
 * PUT /api/tasks/:id/move
 * Body: { groupId, position }
 * Moves a task to a different group and/or position within that group.
 */
const moveTask = async (req, res) => {
  try {
    const task = await Task.findByPk(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    const { groupId, position } = req.body;

    const targetGroupId = groupId || task.groupId;
    const targetPosition = position !== undefined ? position : task.position;

    // Shift positions of other tasks in the target group
    await Task.increment('position', {
      by: 1,
      where: {
        boardId: task.boardId,
        groupId: targetGroupId,
        position: { [Op.gte]: targetPosition },
        id: { [Op.ne]: task.id },
      },
    });

    await task.update({ groupId: targetGroupId, position: targetPosition });

    const fullTask = await Task.findByPk(task.id, {
      include: [...TASK_INCLUDES],
    });

    emitToBoard(task.boardId, 'task:moved', { task: fullTask });

    res.json({
      success: true,
      message: 'Task moved successfully.',
      data: { task: fullTask },
    });
  } catch (error) {
    logger.error('[Task] Move error:', error);
    res.status(500).json({ success: false, message: 'Server error moving task.' });
  }
};

/**
 * PUT /api/tasks/bulk
 * Body: { taskIds: [...], updates: { status, priority, assignedTo, groupId, ... } }
 */
const bulkUpdateTasks = async (req, res) => {
  try {
    const { taskIds, updates } = req.body;

    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return res.status(400).json({ success: false, message: 'taskIds array is required.' });
    }

    const allowedFields = [
      'status', 'priority', 'groupId', 'assignedTo',
      'dueDate', 'isArchived',
    ];

    const safeUpdates = {};
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        safeUpdates[field] = updates[field];
      }
    }

    if (Object.keys(safeUpdates).length === 0) {
      return res.status(400).json({ success: false, message: 'No valid update fields provided.' });
    }

    await Task.update(safeUpdates, {
      where: { id: { [Op.in]: taskIds } },
    });

    const updatedTasks = await Task.findAll({
      where: { id: { [Op.in]: taskIds } },
      include: [...TASK_INCLUDES],
    });

    // Emit to all affected boards
    const boardIds = [...new Set(updatedTasks.map((t) => t.boardId))];
    boardIds.forEach((boardId) => {
      const boardTasks = updatedTasks.filter((t) => t.boardId === boardId);
      emitToBoard(boardId, 'tasks:bulkUpdated', { tasks: boardTasks });
    });

    res.json({
      success: true,
      message: `${updatedTasks.length} tasks updated successfully.`,
      data: { tasks: updatedTasks },
    });
  } catch (error) {
    logger.error('[Task] BulkUpdate error:', error);
    res.status(500).json({ success: false, message: 'Server error during bulk update.' });
  }
};

/**
 * PUT /api/tasks/reorder
 * Body: { boardId, items: [{ id, groupId, position }] }
 * Batch update positions and group assignments for drag-and-drop reordering.
 */
const reorderTasks = async (req, res) => {
  try {
    const { boardId, items } = req.body;

    if (!boardId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'boardId and items array are required.' });
    }

    const transaction = await require('../config/db').sequelize.transaction();
    try {
      for (const item of items) {
        await Task.update(
          { groupId: item.groupId, position: item.position },
          { where: { id: item.id, boardId }, transaction }
        );
      }
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }

    emitToBoard(boardId, 'tasks:reordered', { boardId, items });

    res.json({ success: true, message: 'Tasks reordered successfully.' });
  } catch (error) {
    logger.error('[Task] Reorder error:', error);
    res.status(500).json({ success: false, message: 'Server error reordering tasks.' });
  }
};

/**
 * POST /api/tasks/:id/duplicate
 * Duplicate a task with optional subtasks.
 */
const duplicateTask = async (req, res) => {
  try {
    const original = await Task.findByPk(req.params.id, {
      include: [{ model: Subtask, as: 'subtasks' }],
    });

    if (!original) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    const { includeSubtasks = true } = req.body;

    // Get max position in the same group
    const maxPos = await Task.max('position', {
      where: { boardId: original.boardId, groupId: original.groupId },
    });

    const newTask = await Task.create({
      title: `${original.title} (copy)`,
      description: original.description,
      status: 'not_started',
      priority: original.priority,
      groupId: original.groupId,
      dueDate: original.dueDate,
      startDate: original.startDate,
      position: (maxPos || 0) + 1,
      tags: original.tags,
      customFields: original.customFields,
      boardId: original.boardId,
      assignedTo: original.assignedTo,
      createdBy: req.user.id,
      plannedStartTime: original.plannedStartTime,
      plannedEndTime: original.plannedEndTime,
      estimatedHours: original.estimatedHours,
    });

    // Duplicate subtasks if requested
    if (includeSubtasks && original.subtasks?.length > 0) {
      for (const sub of original.subtasks) {
        await Subtask.create({
          title: sub.title,
          status: 'not_started',
          position: sub.position,
          taskId: newTask.id,
          createdBy: req.user.id,
          assignedTo: sub.assignedTo,
        });
      }
    }

    const fullTask = await Task.findByPk(newTask.id, {
      include: [
        ...TASK_INCLUDES,
        { model: Board, as: 'board', attributes: ['id', 'name'] },
        { model: Subtask, as: 'subtasks', attributes: ['id', 'status'] },
      ],
    });

    emitToBoard(original.boardId, 'task:created', { task: fullTask });

    logActivity({
      action: 'task_duplicated',
      description: `${req.user.name} duplicated task "${original.title}"`,
      entityType: 'task',
      entityId: newTask.id,
      taskId: newTask.id,
      boardId: original.boardId,
      userId: req.user.id,
      meta: { originalTaskId: original.id },
    });

    // Sync duplicated task to Teams calendar (fire-and-forget)
    if (newTask.assignedTo) {
      calendarService.createTaskEvent(newTask.id, newTask.assignedTo).catch(err =>
        console.warn('[Teams] Calendar sync failed for duplicated task:', err.message)
      );
    }

    res.status(201).json({
      success: true,
      message: 'Task duplicated successfully.',
      data: { task: fullTask },
    });
  } catch (error) {
    logger.error('[Task] Duplicate error:', error);
    res.status(500).json({ success: false, message: 'Server error duplicating task.' });
  }
};

/**
 * POST /api/tasks/check-conflicts
 * Body: { userId, startTime, endTime, excludeTaskId? }
 * Checks for scheduling conflicts for a user in a given time range.
 */
const checkConflicts = async (req, res) => {
  try {
    const { userId, startTime, endTime, excludeTaskId } = req.body;

    if (!userId || !startTime || !endTime) {
      return res.status(400).json({ success: false, message: 'userId, startTime, and endTime are required.' });
    }

    // Members can only check their own schedule
    if (req.user.role === 'member' && userId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const conflicts = await detectConflicts(userId, startTime, endTime, excludeTaskId || null);
    res.json({ success: true, data: { conflicts, hasConflicts: conflicts.length > 0 } });
  } catch (error) {
    logger.error('[Task] checkConflicts error:', error);
    res.status(500).json({ success: false, message: 'Failed to check conflicts.' });
  }
};

/**
 * POST /api/tasks/auto-reschedule
 * Body: { taskId, afterTime }
 * Auto-reschedules a conflicting task to start after the given time (with 15-min buffer).
 */
const autoReschedule = async (req, res) => {
  try {
    const { taskId, afterTime } = req.body;

    if (!taskId || !afterTime) {
      return res.status(400).json({ success: false, message: 'taskId and afterTime are required.' });
    }

    const result = await rescheduleTask(taskId, afterTime);
    if (!result) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    logActivity({
      action: 'task_auto_rescheduled',
      description: `Task "${result.title}" auto-rescheduled to ${result.newDueDate} to avoid conflict`,
      entityType: 'task',
      entityId: taskId,
      taskId,
      userId: req.user.id,
    });

    // Refresh the full task for socket emit
    const fullTask = await Task.findByPk(taskId, {
      include: [
        ...TASK_INCLUDES,
        { model: Board, as: 'board', attributes: ['id', 'name'] },
      ],
    });

    if (fullTask) {
      emitToBoard(fullTask.boardId, 'task:updated', { task: fullTask });
      if (fullTask.assignedTo) emitToUser(fullTask.assignedTo, 'task:updated', { task: fullTask });

      // Sync rescheduled task to Teams calendar (fire-and-forget)
      if (fullTask.teamsEventId && fullTask.assignedTo) {
        calendarService.updateTaskEvent(fullTask.id, fullTask.assignedTo).catch(err =>
          console.warn('[Teams] Calendar sync failed for rescheduled task:', err.message)
        );
      }
    }

    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('[Task] autoReschedule error:', error);
    res.status(500).json({ success: false, message: 'Failed to reschedule task.' });
  }
};

/**
 * GET /api/tasks/schedule-summary
 * Query: { userId, date }
 * Returns a schedule summary for a user on a given date.
 */
const scheduleSummary = async (req, res) => {
  try {
    const { userId, date } = req.query;

    if (!userId || !date) {
      return res.status(400).json({ success: false, message: 'userId and date are required.' });
    }

    // Members can only check their own schedule
    if (req.user.role === 'member' && userId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    const summary = await getScheduleSummary(userId, date);
    res.json({ success: true, data: summary });
  } catch (error) {
    logger.error('[Task] scheduleSummary error:', error);
    res.status(500).json({ success: false, message: 'Failed to get schedule summary.' });
  }
};

module.exports = {
  createTask,
  getTasks,
  getTask,
  updateTask,
  deleteTask,
  moveTask,
  bulkUpdateTasks,
  reorderTasks,
  duplicateTask,
  checkConflicts,
  autoReschedule,
  scheduleSummary,
};
