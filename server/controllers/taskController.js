const { Task, Board, User, Notification, Subtask, Label, TaskOwner, TaskAssignee, TaskDependency } = require('../models');
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
const { buildTaskVisibilityFilter, checkTaskAction } = require('../middleware/taskPermissions');
const { scheduleReminders, cancelReminders, rescheduleReminders } = require('../services/reminderService');
const { notifyNewAssignments, diffAndNotify } = require('../services/assignmentNotificationService');
const teamsNotif = require('../services/teamsNotificationService');
const { isValidStatus, isValidStatusForTask } = require('../utils/statusConfig');
const { buildPendingPriorityOrder } = require('../utils/taskPrioritization');

// Reusable include block for the two user associations that appear on every task query
const TASK_INCLUDES = [
  { model: User, as: 'assignee', attributes: ['id', 'name', 'email', 'avatar'] },
  { model: User, as: 'creator', attributes: ['id', 'name', 'email', 'avatar', 'role'] },
  { model: User, as: 'owners', attributes: ['id', 'name', 'email', 'avatar'], through: { attributes: ['isPrimary'] } },
  { model: TaskAssignee, as: 'taskAssignees', include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'avatar', 'role'] }] },
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
      dueDate, startDate, tags, customFields, boardId,
      assignedTo, ownerIds, supervisors, statusConfig,
    } = req.body;

    // Verify board exists
    const board = await Board.findByPk(boardId);
    if (!board) {
      return res.status(404).json({ success: false, message: 'Board not found.' });
    }

    // Validate status against task-level config (if provided), then board config
    if (status) {
      const tempTask = statusConfig ? { statusConfig } : {};
      if (!isValidStatusForTask(status, tempTask, board)) {
        return res.status(400).json({ success: false, message: `Invalid status "${status}" for this task.` });
      }
    }

    // Only authorized users (non-members) can set statusConfig
    const canAssignOthers = ['admin', 'manager', 'assistant_manager'].includes(req.user.role);
    const isMemberRole = !canAssignOthers;

    // Members cannot configure task-level statuses
    const safeStatusConfig = (!isMemberRole && Array.isArray(statusConfig) && statusConfig.length > 0)
      ? statusConfig : null;

    // Support both single assignedTo (backward compat) and array format
    let assigneeIds = [];
    if (Array.isArray(assignedTo)) {
      assigneeIds = canAssignOthers ? assignedTo : [req.user.id];
    } else if (assignedTo) {
      assigneeIds = canAssignOthers ? [assignedTo] : [req.user.id];
    }
    // Members must always self-assign (they can't leave tasks unassigned)
    if (assigneeIds.length === 0 && isMemberRole) {
      assigneeIds = [req.user.id];
    }
    // For admin/manager/assistant_manager: if no assignee specified, leave unassigned (NULL)

    const supervisorIds = (Array.isArray(supervisors) && canAssignOthers) ? supervisors : [];

    // Hierarchy-based assignment validation: managers can only assign within their subtree
    if (canAssignOthers && (assigneeIds.length > 0 || supervisorIds.length > 0)) {
      const { canAssignTo } = require('../services/hierarchyService');
      const allTargetIds = [...assigneeIds, ...supervisorIds];
      for (const targetId of allTargetIds) {
        const allowed = await canAssignTo(req.user, targetId);
        if (!allowed) {
          return res.status(403).json({ success: false, message: 'You can only assign tasks to users in your reporting subtree.' });
        }
      }
    }

    // Keep backward compat: set assignedTo to first assignee
    const primaryAssignee = assigneeIds.length > 0 ? assigneeIds[0] : null;

    // Determine position (append to end of group)
    const maxPosition = await Task.max('position', {
      where: { boardId, groupId: groupId || 'new' },
    });

    const task = await Task.create({
      title: sanitizeInput(title),
      description: sanitizeInput(description) || '',
      status: status || 'not_started',
      statusConfig: safeStatusConfig,
      priority: isMemberRole ? 'medium' : (priority || 'medium'),
      groupId: groupId || 'new',
      dueDate: dueDate || null,
      startDate: startDate || null,
      position: (maxPosition || 0) + 1,
      tags: tags || [],
      customFields: customFields || {},
      boardId,
      assignedTo: primaryAssignee,
      createdBy: req.user.id,
    });

    // Insert into task_assignees (assignees)
    if (assigneeIds.length > 0) {
      const assigneeRecords = assigneeIds.map(uid => ({
        taskId: task.id,
        userId: uid,
        role: 'assignee',
        assignedAt: new Date(),
      }));
      await TaskAssignee.bulkCreate(assigneeRecords, { ignoreDuplicates: true });
    }

    // Insert into task_assignees (supervisors)
    if (supervisorIds.length > 0) {
      const supervisorRecords = supervisorIds.map(uid => ({
        taskId: task.id,
        userId: uid,
        role: 'supervisor',
        assignedAt: new Date(),
      }));
      await TaskAssignee.bulkCreate(supervisorRecords, { ignoreDuplicates: true });
    }

    // Sync multi-owner records (backward compat for TaskOwner table)
    if (Array.isArray(ownerIds) && ownerIds.length > 0 && canAssignOthers) {
      const ownerRecords = ownerIds.map((uid, idx) => ({
        taskId: task.id,
        userId: uid,
        isPrimary: idx === 0,
      }));
      await TaskOwner.bulkCreate(ownerRecords, { ignoreDuplicates: true });
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

    // Auto-add all assignees and supervisors as board members
    const allUserIds = [...new Set([...assigneeIds, ...supervisorIds])];
    for (const uid of allUserIds) {
      try { await board.addMember(uid); } catch (e) { /* already a member */ }
    }

    // Notify assignees and supervisors (exclude the creator — they already know)
    const assigneesToNotify = assigneeIds.filter(uid => uid !== req.user.id);
    const supervisorsToNotify = supervisorIds.filter(uid => uid !== req.user.id);
    notifyNewAssignments(task.id, assigneesToNotify, 'assignee', req.user.id).catch(err =>
      logger.warn('[Task] Assignment notification failed:', err.message)
    );
    notifyNewAssignments(task.id, supervisorsToNotify, 'supervisor', req.user.id).catch(err =>
      logger.warn('[Task] Supervisor notification failed:', err.message)
    );

    // Teams chat notifications (fire-and-forget)
    teamsNotif.notifyTaskAssigned(task.id, assigneesToNotify, 'assignee', req.user.id).catch(err =>
      logger.warn('[Task] Teams assignee notification failed:', err.message)
    );
    teamsNotif.notifyTaskAssigned(task.id, supervisorsToNotify, 'supervisor', req.user.id).catch(err =>
      logger.warn('[Task] Teams supervisor notification failed:', err.message)
    );

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

    // Sync to Teams calendar (fire-and-forget) for primary assignee
    if (primaryAssignee) {
      calendarService.createTaskEvent(task.id, primaryAssignee).catch(err =>
        console.warn('[Teams] Calendar sync failed for new task:', err.message)
      );
    }

    // Schedule deadline reminders (fire-and-forget)
    if (dueDate) {
      scheduleReminders(task.id, dueDate).catch(err =>
        logger.warn('[Task] Failed to schedule reminders:', err.message)
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

    // Ownership filter — checks all three sources where a user can be linked to a task
    const ownershipFilter = [
      { assignedTo: req.user.id },
      sequelize.literal(`"Task"."id" IN (SELECT "taskId" FROM task_owners WHERE "userId" = '${req.user.id}')`),
    ];
    // Only include task_assignees subquery if the table exists (graceful fallback)
    try {
      ownershipFilter.push(
        sequelize.literal(`"Task"."id" IN (SELECT "taskId" FROM task_assignees WHERE "userId" = '${req.user.id}')`)
      );
    } catch (e) { /* task_assignees table may not exist yet */ }

    // Support "me" shorthand for current user's tasks across all boards
    if (assignedTo === 'me') {
      if (!where[Op.and]) where[Op.and] = [];
      where[Op.and].push({ [Op.or]: ownershipFilter });
    } else if (assignedTo) {
      // Filter by specific assignee — check assignedTo column, task_owners, and task_assignees
      if (!where[Op.and]) where[Op.and] = [];
      where[Op.and].push({
        [Op.or]: [
          { assignedTo: assignedTo },
          sequelize.literal(`"Task"."id" IN (SELECT "taskId" FROM task_owners WHERE "userId" = '${assignedTo}')`),
          sequelize.literal(`"Task"."id" IN (SELECT "taskId" FROM task_assignees WHERE "userId" = '${assignedTo}' AND role = 'assignee')`),
        ],
      });
    } else if (boardId) {
      // ── Layer 2: Apply role-based visibility filter only for board-level queries ──
      // When fetching by board, restrict visibility based on role.
      // Skip for assignedTo=me (already filtered above) to avoid redundant AND.
      const visibilityFilter = await buildTaskVisibilityFilter(req.user, boardId);
      if (visibilityFilter[Op.or]) {
        if (!where[Op.and]) where[Op.and] = [];
        where[Op.and].push(visibilityFilter);
      }
    }

    // Members without boardId and without assignedTo filter can only see their own tasks
    if (!boardId && req.user.role === 'member' && context !== 'dependency' && assignedTo !== 'me' && !assignedTo) {
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
    let order;
    if (sortBy && ALLOWED_SORT_FIELDS.includes(sortBy)) {
      // User explicitly selected a sort — respect it
      order = [[sortBy, sortOrder === 'desc' ? 'DESC' : 'ASC']];
    } else {
      // Default for ALL queries: pending task prioritization
      // Board, My Work, Home, cross-board — all use urgency-based ordering
      // DnD manual ordering is applied only when user explicitly selects sortBy=position
      order = buildPendingPriorityOrder();
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
 * canViewTask middleware runs before this to enforce Layer 2 visibility.
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

    // Attach permission info for frontend to know what the user can do
    const taskAssignees = task.taskAssignees || [];
    const viewCheck = checkTaskAction('view', req.user, task, taskAssignees);
    const editCheck = checkTaskAction('edit', req.user, task, taskAssignees);
    const reassignCheck = checkTaskAction('reassign', req.user, task, taskAssignees);
    const deleteCheck = checkTaskAction('delete', req.user, task, taskAssignees);

    const taskJSON = task.toJSON();
    taskJSON._permissions = {
      canView: viewCheck.allowed,
      canEdit: editCheck.allowed,
      canEditAllFields: editCheck.allowed && !editCheck.allowedFields,
      allowedFields: editCheck.allowedFields || null,
      canReassign: reassignCheck.allowed,
      canDelete: deleteCheck.allowed,
    };

    res.json({ success: true, data: { task: taskJSON } });
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
      logger.warn('[Task] UpdateTask validation errors:', JSON.stringify(errors.array()));
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const task = await Task.findByPk(req.params.id, {
      include: [
        { model: Board, as: 'board', attributes: ['id', 'name', 'columns'] },
        { model: User, as: 'creator', attributes: ['id', 'role'] },
        { model: TaskAssignee, as: 'taskAssignees' },
      ],
    });

    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    // Layer 3: Check action permission using the new system
    const taskAssignees = task.taskAssignees || [];
    const editPermission = checkTaskAction('edit', req.user, task, taskAssignees);

    // If user can't edit at all, check if they can at least update status
    if (!editPermission.allowed) {
      const statusPermission = checkTaskAction('edit_status', req.user, task, taskAssignees);
      if (!statusPermission.allowed) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to update this task.',
        });
      }
      // Only allow status/progress fields
      editPermission.allowed = true;
      editPermission.allowedFields = ['status', 'progress'];
    }

    const isMember = req.user.role === 'member';
    const isManager = req.user.role === 'manager';
    const isAssistantManager = req.user.role === 'assistant_manager';
    const isAdmin = req.user.role === 'admin';

    const allFields = [
      'title', 'description', 'status', 'priority', 'groupId',
      'dueDate', 'startDate', 'position', 'tags', 'customFields',
      'assignedTo', 'isArchived', 'progress',
      'plannedStartTime', 'plannedEndTime', 'estimatedHours', 'actualHours',
      'statusConfig',
    ];

    // Use Layer 3 allowedFields if set, otherwise allow all
    const allowedFields = editPermission.allowedFields || allFields;

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
    const previousDueDate = task.dueDate;

    // Members cannot modify statusConfig — only creators/managers/admins
    if (updates.statusConfig !== undefined && isMember) {
      delete updates.statusConfig;
      delete changes.statusConfig;
    }

    // When statusConfig is being updated alongside status, validate against the NEW config
    // Otherwise validate against the task's existing config → board → global fallback
    if (updates.status) {
      const effectiveTask = updates.statusConfig ? { statusConfig: updates.statusConfig } : task;
      const board = task.board || await Board.findByPk(task.boardId);
      if (!isValidStatusForTask(updates.status, effectiveTask, board)) {
        const { getAllowedStatusesForTask } = require('../utils/statusConfig');
        const allowed = getAllowedStatusesForTask(effectiveTask, board);
        logger.warn(`[Task] Status validation failed: "${updates.status}" not in allowed [${allowed.join(', ')}]. Task statusConfig: ${JSON.stringify(task.statusConfig)}`);
        return res.status(400).json({ success: false, message: `Invalid status "${updates.status}" for this task. Allowed: ${allowed.join(', ')}` });
      }
    }

    // Prevent status changes on tasks blocked by dependencies
    if (updates.status && updates.status !== task.status) {
      const blocked = await depService.isTaskBlocked(task.id);
      if (blocked) {
        return res.status(403).json({
          success: false,
          message: 'This task is blocked by an incomplete dependency and cannot have its status changed. Complete the blocking task(s) first.',
        });
      }
    }

    // Prevent manual startDate edits on dependency RECEIVER tasks
    // (tasks that other tasks depend on — appear as dependsOnTaskId in TaskDependency)
    if (updates.startDate !== undefined && updates.startDate !== task.startDate) {
      const blockingOthers = await TaskDependency.findOne({
        where: { dependsOnTaskId: task.id },
        attributes: ['id'],
      });
      if (blockingOthers) {
        delete updates.startDate;
        delete changes.startDate;
      }
    }

    // Auto-set startDate when task moves into an active status (set-if-empty)
    const ACTIVE_STATUSES = ['working_on_it', 'stuck', 'review', 'done'];
    if (updates.status && ACTIVE_STATUSES.includes(updates.status) && !task.startDate && !updates.startDate) {
      const today = new Date().toISOString().slice(0, 10);
      updates.startDate = today;
      changes.startDate = today;
    }

    await task.update(updates);

    // Sync task_assignees if assignedTo (array) or supervisors provided
    const canManageMembers = isAdmin || isManager || isAssistantManager || !!req.user.isSuperAdmin;
    const membersChanged = canManageMembers && (Array.isArray(req.body.assignedTo) || Array.isArray(req.body.supervisors));

    // Capture old members BEFORE syncing so we can diff later
    let oldAssigneeIds = [];
    let oldSupervisorIds = [];
    if (membersChanged) {
      const currentAssignees = taskAssignees || [];
      oldAssigneeIds = currentAssignees.filter(ta => ta.role === 'assignee').map(ta => ta.userId);
      oldSupervisorIds = currentAssignees.filter(ta => ta.role === 'supervisor').map(ta => ta.userId);
    }

    if (canManageMembers) {
      // Handle assignedTo as array → sync assignee rows in task_assignees
      if (Array.isArray(req.body.assignedTo)) {
        const newAssigneeIds = req.body.assignedTo;
        // Remove assignees not in the new list
        await TaskAssignee.destroy({ where: { taskId: task.id, role: 'assignee', userId: { [Op.notIn]: newAssigneeIds } } });
        // Upsert new assignees
        for (const uid of newAssigneeIds) {
          await TaskAssignee.findOrCreate({
            where: { taskId: task.id, userId: uid, role: 'assignee' },
            defaults: { assignedAt: new Date() },
          });
        }
        // Update legacy assignedTo to first in list
        if (newAssigneeIds.length > 0) {
          await task.update({ assignedTo: newAssigneeIds[0] });
        }
        // Auto-add as board members
        const boardForMembers = await Board.findByPk(task.boardId);
        if (boardForMembers) {
          for (const uid of newAssigneeIds) {
            try { await boardForMembers.addMember(uid); } catch (e) { /* already a member */ }
          }
        }
      } else if (updates.assignedTo && typeof updates.assignedTo === 'string') {
        // Single assignedTo string — sync into task_assignees (remove old assignees, add new one)
        try {
          await TaskAssignee.destroy({
            where: { taskId: task.id, role: 'assignee', userId: { [Op.ne]: updates.assignedTo } },
          });
          await TaskAssignee.findOrCreate({
            where: { taskId: task.id, userId: updates.assignedTo, role: 'assignee' },
            defaults: { assignedAt: new Date() },
          });
        } catch (e) { /* task_assignees table may not exist yet */ }
      } else if (updates.assignedTo === null) {
        // Explicitly unassigned — remove all assignee entries from task_assignees
        try {
          await TaskAssignee.destroy({ where: { taskId: task.id, role: 'assignee' } });
        } catch (e) { /* task_assignees table may not exist yet */ }
      }

      // Handle supervisors array → sync supervisor rows in task_assignees
      if (Array.isArray(req.body.supervisors)) {
        const newSupervisorIds = req.body.supervisors;
        await TaskAssignee.destroy({ where: { taskId: task.id, role: 'supervisor', userId: { [Op.notIn]: newSupervisorIds } } });
        for (const uid of newSupervisorIds) {
          await TaskAssignee.findOrCreate({
            where: { taskId: task.id, userId: uid, role: 'supervisor' },
            defaults: { assignedAt: new Date() },
          });
        }
        const boardForMembers = await Board.findByPk(task.boardId);
        if (boardForMembers) {
          for (const uid of newSupervisorIds) {
            try { await boardForMembers.addMember(uid); } catch (e) { /* already a member */ }
          }
        }
      }

      // Diff and notify for member changes
      if (membersChanged) {
        const newAssignees = Array.isArray(req.body.assignedTo) ? req.body.assignedTo : oldAssigneeIds;
        const newSupervisors = Array.isArray(req.body.supervisors) ? req.body.supervisors : oldSupervisorIds;
        diffAndNotify(task.id, oldAssigneeIds, newAssignees, oldSupervisorIds, newSupervisors, req.user.id).catch(err =>
          logger.warn('[Task] Assignment diff notification failed:', err.message)
        );
      }
    }

    // Sync multi-owner records if ownerIds provided (backward compat)
    if (Array.isArray(req.body.ownerIds) && canManageMembers) {
      const newOwnerIds = req.body.ownerIds;
      await TaskOwner.destroy({ where: { taskId: task.id, userId: { [Op.notIn]: newOwnerIds } } });
      for (let i = 0; i < newOwnerIds.length; i++) {
        const [record] = await TaskOwner.findOrCreate({
          where: { taskId: task.id, userId: newOwnerIds[i] },
          defaults: { isPrimary: i === 0 },
        });
        if (record.isPrimary !== (i === 0)) {
          await record.update({ isPrimary: i === 0 });
        }
      }
      // Sync ownerIds into task_assignees (remove old, add new) so visibility filters find them
      try {
        if (newOwnerIds.length > 0) {
          await TaskAssignee.destroy({
            where: { taskId: task.id, role: 'assignee', userId: { [Op.notIn]: newOwnerIds } },
          });
          for (const uid of newOwnerIds) {
            await TaskAssignee.findOrCreate({
              where: { taskId: task.id, userId: uid, role: 'assignee' },
              defaults: { assignedAt: new Date() },
            });
          }
        } else {
          await TaskAssignee.destroy({ where: { taskId: task.id, role: 'assignee' } });
        }
      } catch (e) { /* task_assignees table may not exist yet */ }
      // Update legacy assignedTo to first owner (or null if empty)
      await task.update({ assignedTo: newOwnerIds.length > 0 ? newOwnerIds[0] : null });
      const boardForOwners = await Board.findByPk(task.boardId);
      if (boardForOwners) {
        for (const uid of newOwnerIds) {
          try { await boardForOwners.addMember(uid); } catch (e) { /* already a member */ }
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

    // Notification: new assignee (only for single-string assignedTo, not array — array is handled by diffAndNotify above)
    if (!membersChanged && updates.assignedTo && updates.assignedTo !== previousAssignee && updates.assignedTo !== req.user.id) {
      notifyNewAssignments(task.id, [updates.assignedTo], 'assignee', req.user.id).catch(err =>
        logger.warn('[Task] Single-assignee notification failed:', err.message)
      );
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

      // Cancel pending deadline reminders — task is done
      cancelReminders(task.id).catch(err =>
        logger.warn('[Task] Failed to cancel reminders on completion:', err.message)
      );
    }

    // Reschedule deadline reminders if dueDate changed (and task is not done)
    if (changes.dueDate && task.status !== 'done') {
      rescheduleReminders(task.id, updates.dueDate).catch(err =>
        logger.warn('[Task] Failed to reschedule reminders:', err.message)
      );
    }

    // Teams chat notifications for deadline and status changes (fire-and-forget)
    if (changes.dueDate && task.status !== 'done' && !task.isArchived) {
      teamsNotif.notifyDeadlineChanged(task.id, previousDueDate, updates.dueDate, req.user.id).catch(err =>
        logger.warn('[Task] Teams deadline notification failed:', err.message)
      );
    }
    if (changes.status && updates.status !== previousStatus && !task.isArchived) {
      teamsNotif.notifyStatusChanged(task.id, updates.status, req.user.id).catch(err =>
        logger.warn('[Task] Teams status notification failed:', err.message)
      );
    }

    // Teams notifications for member changes (additions and removals)
    if (membersChanged && !task.isArchived && task.status !== 'done') {
      const newAssignees = Array.isArray(req.body.assignedTo) ? req.body.assignedTo : oldAssigneeIds;
      const newSupervisors = Array.isArray(req.body.supervisors) ? req.body.supervisors : oldSupervisorIds;
      const addedAssignees = newAssignees.filter(uid => !oldAssigneeIds.includes(uid) && uid !== req.user.id);
      const addedSupervisors = newSupervisors.filter(uid => !oldSupervisorIds.includes(uid) && uid !== req.user.id);
      const removedUsers = [...oldAssigneeIds, ...oldSupervisorIds].filter(uid => !newAssignees.includes(uid) && !newSupervisors.includes(uid));
      if (addedAssignees.length > 0) {
        teamsNotif.notifyTaskAssigned(task.id, addedAssignees, 'assignee', req.user.id).catch(err =>
          logger.warn('[Task] Teams new assignee notification failed:', err.message)
        );
      }
      if (addedSupervisors.length > 0) {
        teamsNotif.notifyTaskAssigned(task.id, addedSupervisors, 'supervisor', req.user.id).catch(err =>
          logger.warn('[Task] Teams new supervisor notification failed:', err.message)
        );
      }
      if (removedUsers.length > 0) {
        teamsNotif.notifyMemberRemoved(task.id, removedUsers).catch(err =>
          logger.warn('[Task] Teams member removed notification failed:', err.message)
        );
      }
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
      // Members can only archive tasks assigned to them (check both assignedTo and task_assignees)
      const isAssignedLegacy = task.assignedTo === req.user.id;
      const assigneeRecord = await TaskAssignee.findOne({ where: { taskId: task.id, userId: req.user.id, role: 'assignee' } });
      if (!isAssignedLegacy && !assigneeRecord) {
        return res.status(403).json({ success: false, message: 'You can only archive tasks assigned to you.' });
      }
      // Remove Teams calendar event on archive
      if (task.teamsEventId && task.assignedTo) {
        calendarService.deleteTaskEvent(task.id, task.assignedTo).catch(() => {});
      }
      await task.update({ isArchived: true, archivedAt: new Date(), archivedBy: req.user.id });
      // Cancel pending deadline reminders on archive
      cancelReminders(task.id).catch(err =>
        logger.warn('[Task] Failed to cancel reminders on archive:', err.message)
      );
      // Cancel pending Teams notifications on archive (no new notification sent)
      teamsNotif.notifyTaskArchived(task.id).catch(err =>
        logger.warn('[Task] Teams archive cancel failed:', err.message)
      );
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

    // Gather assigned users BEFORE deletion so we can notify them
    const taskAssignees = await TaskAssignee.findAll({ where: { taskId: task.id } });
    const assignedUserIds = taskAssignees.map(ta => ta.userId);
    const boardForNotif = await Board.findByPk(task.boardId, { attributes: ['id', 'name'] });
    const boardName = boardForNotif ? boardForNotif.name : 'Unknown Board';

    // Send "Task Removed" Teams notification BEFORE deleting
    teamsNotif.notifyTaskDeleted(task.id, taskTitle, boardName, assignedUserIds, req.user.id).catch(err =>
      logger.warn('[Task] Teams delete notification failed:', err.message)
    );

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

    // Validate status against task-level then board config for all affected tasks
    if (safeUpdates.status) {
      const affectedTasks = await Task.findAll({
        where: { id: { [Op.in]: taskIds } },
        attributes: ['id', 'boardId', 'statusConfig'],
        include: [{ model: Board, as: 'board', attributes: ['id', 'columns'] }],
      });
      for (const t of affectedTasks) {
        if (!isValidStatusForTask(safeUpdates.status, t, t.board)) {
          return res.status(400).json({ success: false, message: `Invalid status "${safeUpdates.status}" for task "${t.id}".` });
        }
      }
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

    // Teams notifications for bulk assignment (batched via teamsNotificationService)
    if (safeUpdates.assignedTo) {
      for (const t of updatedTasks) {
        if (t.status !== 'done' && !t.isArchived && safeUpdates.assignedTo !== req.user.id) {
          teamsNotif.notifyTaskAssigned(t.id, [safeUpdates.assignedTo], 'assignee', req.user.id).catch(err =>
            logger.warn('[Task] Teams bulk assign notification failed:', err.message)
          );
        }
      }
    }
    // Teams notifications for bulk archive
    if (safeUpdates.isArchived === true) {
      for (const t of updatedTasks) {
        teamsNotif.notifyTaskArchived(t.id).catch(err =>
          logger.warn('[Task] Teams bulk archive cancel failed:', err.message)
        );
      }
    }

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
      statusConfig: original.statusConfig,
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

/**
 * PUT /api/tasks/:id/members
 * Body: { assignees: [userId, ...], supervisors: [userId, ...] }
 * Add/remove assignees and supervisors. Only assistant_manager and above.
 */
const manageTaskMembers = async (req, res) => {
  try {
    const task = await Task.findByPk(req.params.id, {
      include: [
        { model: Board, as: 'board', attributes: ['id', 'name'] },
        { model: TaskAssignee, as: 'taskAssignees' },
      ],
    });

    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    const { assignees, supervisors } = req.body;
    const board = task.board ? await Board.findByPk(task.boardId) : null;

    // Hierarchy-based assignment validation
    const allTargetIds = [...(Array.isArray(assignees) ? assignees : []), ...(Array.isArray(supervisors) ? supervisors : [])];
    if (allTargetIds.length > 0) {
      const { canAssignTo } = require('../services/hierarchyService');
      for (const targetId of allTargetIds) {
        const allowed = await canAssignTo(req.user, targetId);
        if (!allowed) {
          return res.status(403).json({ success: false, message: 'You can only assign tasks to users in your reporting subtree.' });
        }
      }
    }

    // Sync assignees
    if (Array.isArray(assignees)) {
      // Remove assignees not in the new list
      await TaskAssignee.destroy({
        where: { taskId: task.id, role: 'assignee', userId: { [Op.notIn]: assignees } },
      });
      // Add new assignees
      for (const uid of assignees) {
        await TaskAssignee.findOrCreate({
          where: { taskId: task.id, userId: uid, role: 'assignee' },
          defaults: { assignedAt: new Date() },
        });
      }
      // Update legacy assignedTo field to first assignee
      await task.update({ assignedTo: assignees.length > 0 ? assignees[0] : null });

      // Auto-add as board members
      if (board) {
        for (const uid of assignees) {
          try { await board.addMember(uid); } catch (e) { /* already a member */ }
        }
      }

      // Notify new assignees
      const existingAssigneeIds = task.taskAssignees
        .filter(ta => ta.role === 'assignee')
        .map(ta => ta.userId);
      const newAssigneeIds = assignees.filter(uid => !existingAssigneeIds.includes(uid) && uid !== req.user.id);
      const removedAssigneeIds = existingAssigneeIds.filter(uid => !assignees.includes(uid));
      for (const uid of newAssigneeIds) {
        const notification = await Notification.create({
          type: 'task_assigned',
          message: `${req.user.name} assigned you to "${task.title}"`,
          entityType: 'task',
          entityId: task.id,
          userId: uid,
        });
        emitToUser(uid, 'notification:new', { notification });
      }

      // Teams notifications for assignee changes
      if (task.status !== 'done' && !task.isArchived) {
        if (newAssigneeIds.length > 0) {
          teamsNotif.notifyTaskAssigned(task.id, newAssigneeIds, 'assignee', req.user.id).catch(err =>
            logger.warn('[Task] Teams new assignee notification failed:', err.message)
          );
        }
        if (removedAssigneeIds.length > 0) {
          teamsNotif.notifyMemberRemoved(task.id, removedAssigneeIds).catch(err =>
            logger.warn('[Task] Teams removed assignee notification failed:', err.message)
          );
        }
      }
    }

    // Sync supervisors
    if (Array.isArray(supervisors)) {
      await TaskAssignee.destroy({
        where: { taskId: task.id, role: 'supervisor', userId: { [Op.notIn]: supervisors } },
      });
      for (const uid of supervisors) {
        await TaskAssignee.findOrCreate({
          where: { taskId: task.id, userId: uid, role: 'supervisor' },
          defaults: { assignedAt: new Date() },
        });
      }

      if (board) {
        for (const uid of supervisors) {
          try { await board.addMember(uid); } catch (e) { /* already a member */ }
        }
      }

      // Notify new supervisors
      const existingSupervisorIds = task.taskAssignees
        .filter(ta => ta.role === 'supervisor')
        .map(ta => ta.userId);
      const newSupervisorIds = supervisors.filter(uid => !existingSupervisorIds.includes(uid) && uid !== req.user.id);
      const removedSupervisorIds = existingSupervisorIds.filter(uid => !supervisors.includes(uid));
      for (const uid of newSupervisorIds) {
        const notification = await Notification.create({
          type: 'task_assigned',
          message: `${req.user.name} added you as supervisor on "${task.title}"`,
          entityType: 'task',
          entityId: task.id,
          userId: uid,
        });
        emitToUser(uid, 'notification:new', { notification });
      }

      // Teams notifications for supervisor changes
      if (task.status !== 'done' && !task.isArchived) {
        if (newSupervisorIds.length > 0) {
          teamsNotif.notifyTaskAssigned(task.id, newSupervisorIds, 'supervisor', req.user.id).catch(err =>
            logger.warn('[Task] Teams new supervisor notification failed:', err.message)
          );
        }
        if (removedSupervisorIds.length > 0) {
          teamsNotif.notifyMemberRemoved(task.id, removedSupervisorIds).catch(err =>
            logger.warn('[Task] Teams removed supervisor notification failed:', err.message)
          );
        }
      }
    }

    // Re-fetch with full includes
    const fullTask = await Task.findByPk(task.id, {
      include: [
        ...TASK_INCLUDES,
        { model: Board, as: 'board', attributes: ['id', 'name'] },
      ],
    });

    logActivity({
      action: 'task_members_updated',
      description: `${req.user.name} updated members on "${task.title}"`,
      entityType: 'task',
      entityId: task.id,
      taskId: task.id,
      boardId: task.boardId,
      userId: req.user.id,
    });

    emitToBoard(task.boardId, 'task:updated', { task: fullTask });

    res.json({
      success: true,
      message: 'Task members updated successfully.',
      data: { task: fullTask },
    });
  } catch (error) {
    logger.error('[Task] ManageMembers error:', error);
    res.status(500).json({ success: false, message: 'Server error managing task members.' });
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
  manageTaskMembers,
};
