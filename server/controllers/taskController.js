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
const { safeUUID } = require('../utils/safeSql');
const { sanitizeInput } = require('../utils/sanitize');
const calendarService = require('../services/calendarService');
const { checkConflicts: detectConflicts, autoReschedule: rescheduleTask, getScheduleSummary } = require('../services/conflictDetectionService');
const { buildTaskVisibilityFilter, checkTaskAction } = require('../middleware/taskPermissions');
const { scheduleReminders, cancelReminders, rescheduleReminders } = require('../services/reminderService');
const { notifyNewAssignments, diffAndNotify } = require('../services/assignmentNotificationService');
const teamsNotif = require('../services/teamsNotificationService');
const { isValidStatus, isValidStatusForTask } = require('../utils/statusConfig');
const { buildPendingPriorityOrder, findGroupForStatus } = require('../utils/taskPrioritization');
const boardMembershipService = require('../services/boardMembershipService');

// ── Table existence cache ────────────────────────────────────────────────
// Checks once per process lifetime whether a table exists. Prevents every
// query from crashing when a migration hasn't run on production yet.
const _tableCache = {};
async function tableExists(tableName) {
  if (_tableCache[tableName] !== undefined) return _tableCache[tableName];
  try {
    await sequelize.query(`SELECT 1 FROM "${tableName}" LIMIT 0`);
    _tableCache[tableName] = true;
  } catch (e) {
    logger.warn(`[Task] Table "${tableName}" not available — queries will skip it`);
    _tableCache[tableName] = false;
  }
  return _tableCache[tableName];
}

// Convenience aliases
const hasTaskAssigneesTable = () => tableExists('task_assignees');
const hasTaskOwnersTable = () => tableExists('task_owners');
const hasTaskLabelsTable = () => tableExists('task_labels');

// Reusable include block — built dynamically to handle missing tables gracefully.
const TASK_INCLUDES_CORE = [
  { model: User, as: 'assignee', attributes: ['id', 'name', 'email', 'avatar'] },
  { model: User, as: 'creator', attributes: ['id', 'name', 'email', 'avatar', 'role'] },
];

async function getTaskIncludes() {
  const includes = [...TASK_INCLUDES_CORE];
  if (await hasTaskOwnersTable()) {
    includes.push({ model: User, as: 'owners', attributes: ['id', 'name', 'email', 'avatar'], through: { attributes: ['isPrimary'] } });
  }
  if (await hasTaskAssigneesTable()) {
    includes.push({ model: TaskAssignee, as: 'taskAssignees', include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'avatar', 'role'] }] });
  }
  return includes;
}

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
      plannedStartTime, plannedEndTime, estimatedHours,
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

    // Authorized users who can assign tasks to others:
    // Strict RBAC: only management roles can assign others
    const isManagementRole = ['admin', 'manager', 'assistant_manager'].includes(req.user.role);
    const canAssignOthers = isManagementRole;
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

    // Auto-assign group based on status if no explicit groupId provided
    let effectiveGroupId = groupId || 'new';
    if (!groupId && status) {
      const targetGroup = findGroupForStatus(status, board.groups);
      if (targetGroup) effectiveGroupId = targetGroup;
    }

    const task = await Task.create({
      title: sanitizeInput(title),
      description: sanitizeInput(description) || '',
      status: status || 'not_started',
      statusConfig: safeStatusConfig,
      priority: isMemberRole ? 'medium' : (priority || 'medium'),
      groupId: effectiveGroupId,
      dueDate: dueDate || null,
      startDate: startDate || null,
      plannedStartTime: plannedStartTime || null,
      plannedEndTime: plannedEndTime || null,
      estimatedHours: estimatedHours != null ? estimatedHours : 0,
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
        await boardMembershipService.autoAddMember(board.id, uid);
      }
    }

    const fullTask = await Task.findByPk(task.id, {
      include: [
        ...(await getTaskIncludes()),
        { model: Board, as: 'board', attributes: ['id', 'name'] },
      ],
    });

    // Auto-add all assignees and supervisors as board members
    const allUserIds = [...new Set([...assigneeIds, ...supervisorIds])];
    for (const uid of allUserIds) {
      await boardMembershipService.autoAddMember(board.id, uid);
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

    // Ownership filter — checks all sources where a user can be linked to a task.
    // Each subquery is guarded: if the table doesn't exist yet, it's simply skipped.
    const uid = safeUUID(req.user.id, 'req.user.id');
    const ownershipFilter = [
      { assignedTo: req.user.id },
    ];
    if (await hasTaskOwnersTable()) {
      ownershipFilter.push(
        sequelize.literal(`"Task"."id" IN (SELECT "taskId" FROM task_owners WHERE "userId" = ${uid})`)
      );
    }
    if (await hasTaskAssigneesTable()) {
      ownershipFilter.push(
        sequelize.literal(`"Task"."id" IN (SELECT "taskId" FROM task_assignees WHERE "userId" = ${uid})`)
      );
    }

    // Support "me" shorthand for current user's tasks across all boards
    if (assignedTo === 'me') {
      if (!where[Op.and]) where[Op.and] = [];
      where[Op.and].push({ [Op.or]: ownershipFilter });
    } else if (assignedTo) {
      // Filter by specific assignee — validate UUID before embedding in SQL
      const assigneeUid = safeUUID(assignedTo, 'assignedTo');
      if (!where[Op.and]) where[Op.and] = [];
      const assigneeOrFilter = [
        { assignedTo: assignedTo },
      ];
      if (await hasTaskOwnersTable()) {
        assigneeOrFilter.push(
          sequelize.literal(`"Task"."id" IN (SELECT "taskId" FROM task_owners WHERE "userId" = ${assigneeUid})`)
        );
      }
      if (await hasTaskAssigneesTable()) {
        assigneeOrFilter.push(
          sequelize.literal(`"Task"."id" IN (SELECT "taskId" FROM task_assignees WHERE "userId" = ${assigneeUid} AND role = 'assignee')`)
        );
      }
      where[Op.and].push({ [Op.or]: assigneeOrFilter });
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

    const taskIncludes = await getTaskIncludes();
    const extraIncludes = [
      { model: Subtask, as: 'subtasks', attributes: ['id', 'status'] },
      { model: Board, as: 'board', attributes: ['id', 'name', 'color'] },
    ];
    if (await hasTaskLabelsTable()) {
      extraIncludes.push({ model: Label, as: 'labels', through: { attributes: [] }, attributes: ['id', 'name', 'color'] });
    }
    const queryOpts = {
      where,
      include: [...taskIncludes, ...extraIncludes],
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
    // Log full error chain for production debugging
    logger.error('[Task] GetTasks error:', {
      message: error.message,
      name: error.name,
      sql: error.sql || error.parent?.sql || undefined,
      original: error.original?.message || error.parent?.message || undefined,
      stack: error.stack?.split('\n').slice(0, 5).join('\n'),
    });
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
        ...(await getTaskIncludes()),
        { model: Board, as: 'board', attributes: ['id', 'name', 'color'] },
      ],
    });

    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    // Attach permission info for frontend to know what the user can do
    const taskAssignees = task.taskAssignees || [];
    const viewCheck = checkTaskAction('view', req.user, task, taskAssignees, req);
    const editCheck = checkTaskAction('edit', req.user, task, taskAssignees, req);
    const reassignCheck = checkTaskAction('reassign', req.user, task, taskAssignees, req);
    const deleteCheck = checkTaskAction('delete', req.user, task, taskAssignees, req);

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
    const editPermission = checkTaskAction('edit', req.user, task, taskAssignees, req);

    // If user can't edit at all, check if they can at least update status
    if (!editPermission.allowed) {
      const statusPermission = checkTaskAction('edit_status', req.user, task, taskAssignees, req);
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
    const previousIsArchived = task.isArchived;

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

    // Hierarchy validation: ensure assignment targets are in the actor's subtree (BEFORE save)
    const allAssignmentTargets = [
      ...(Array.isArray(req.body.assignedTo) ? req.body.assignedTo : (updates.assignedTo && typeof updates.assignedTo === 'string' ? [updates.assignedTo] : [])),
      ...(Array.isArray(req.body.ownerIds) ? req.body.ownerIds : []),
      ...(Array.isArray(req.body.supervisors) ? req.body.supervisors : []),
    ];
    if (allAssignmentTargets.length > 0) {
      const { canAssignTo } = require('../services/hierarchyService');
      for (const targetId of allAssignmentTargets) {
        const allowed = await canAssignTo(req.user, targetId);
        if (!allowed) {
          return res.status(403).json({ success: false, message: 'You can only assign tasks to users in your reporting subtree.' });
        }
      }
    }

    await task.update(updates);

    // ── Auto-group assignment: move task to matching group when status changes ──
    if (updates.status && updates.status !== previousStatus) {
      try {
        const board = task.board || await Board.findByPk(task.boardId, { attributes: ['id', 'groups'] });
        if (board && Array.isArray(board.groups) && board.groups.length > 0) {
          const targetGroupId = findGroupForStatus(updates.status, board.groups);
          if (targetGroupId && targetGroupId !== task.groupId) {
            await task.update({ groupId: targetGroupId });
          }
        }
      } catch (e) {
        logger.warn('[Task] Auto-group assignment failed:', e.message);
      }
    }

    // Sync task_assignees if assignedTo (array) or supervisors or ownerIds provided
    const canManageMembers = isAdmin || isManager || isAssistantManager || !!req.user.isSuperAdmin;
    const membersChanged = canManageMembers && (Array.isArray(req.body.assignedTo) || Array.isArray(req.body.supervisors));
    const ownerIdsChanged = canManageMembers && Array.isArray(req.body.ownerIds);

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
        // Capture removed assignees BEFORE destroying rows (for board membership cleanup)
        const removedAssigneeIds = oldAssigneeIds.filter(uid => !newAssigneeIds.includes(uid));
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
        // Auto-add new assignees as board members
        for (const uid of newAssigneeIds) {
          await boardMembershipService.autoAddMember(task.boardId, uid);
        }
        // Cleanup board membership for removed assignees (awaited to avoid race with response)
        if (removedAssigneeIds.length > 0) {
          try { await boardMembershipService.cleanupMultiple(removedAssigneeIds, task.boardId); }
          catch (err) { logger.warn('[Task] Board membership cleanup failed:', err.message); }
        }
      } else if (updates.assignedTo && typeof updates.assignedTo === 'string') {
        // Single assignedTo string — sync into task_assignees (remove old assignees, add new one)
        const removedSingleAssignees = oldAssigneeIds.filter(uid => uid !== updates.assignedTo);
        try {
          await TaskAssignee.destroy({
            where: { taskId: task.id, role: 'assignee', userId: { [Op.ne]: updates.assignedTo } },
          });
          await TaskAssignee.findOrCreate({
            where: { taskId: task.id, userId: updates.assignedTo, role: 'assignee' },
            defaults: { assignedAt: new Date() },
          });
        } catch (e) { /* task_assignees table may not exist yet */ }
        await boardMembershipService.autoAddMember(task.boardId, updates.assignedTo);
        // Cleanup board membership for previously assigned users
        if (removedSingleAssignees.length > 0) {
          try { await boardMembershipService.cleanupMultiple(removedSingleAssignees, task.boardId); }
          catch (err) { logger.warn('[Task] Board membership cleanup failed:', err.message); }
        }
      } else if (updates.assignedTo === null) {
        // Explicitly unassigned — remove all assignee entries from task_assignees
        try {
          await TaskAssignee.destroy({ where: { taskId: task.id, role: 'assignee' } });
        } catch (e) { /* task_assignees table may not exist yet */ }
        // Cleanup board membership for all previously assigned users
        if (oldAssigneeIds.length > 0) {
          try { await boardMembershipService.cleanupMultiple(oldAssigneeIds, task.boardId); }
          catch (err) { logger.warn('[Task] Board membership cleanup failed:', err.message); }
        }
        // Also cleanup for the legacy assignedTo user (previousAssignee)
        if (previousAssignee && !oldAssigneeIds.includes(previousAssignee)) {
          try { await boardMembershipService.cleanupIfNoTasksRemain(previousAssignee, task.boardId); }
          catch (err) { logger.warn('[Task] Board membership cleanup failed:', err.message); }
        }
      }

      // Handle supervisors array → sync supervisor rows in task_assignees
      if (Array.isArray(req.body.supervisors)) {
        const newSupervisorIds = req.body.supervisors;
        const removedSupervisorIds = oldSupervisorIds.filter(uid => !newSupervisorIds.includes(uid));
        await TaskAssignee.destroy({ where: { taskId: task.id, role: 'supervisor', userId: { [Op.notIn]: newSupervisorIds } } });
        for (const uid of newSupervisorIds) {
          await TaskAssignee.findOrCreate({
            where: { taskId: task.id, userId: uid, role: 'supervisor' },
            defaults: { assignedAt: new Date() },
          });
        }
        // Auto-add new supervisors as board members
        for (const uid of newSupervisorIds) {
          await boardMembershipService.autoAddMember(task.boardId, uid);
        }
        // Cleanup board membership for removed supervisors
        if (removedSupervisorIds.length > 0) {
          try { await boardMembershipService.cleanupMultiple(removedSupervisorIds, task.boardId); }
          catch (err) { logger.warn('[Task] Board membership cleanup (supervisors) failed:', err.message); }
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

    // Capture old owner IDs before sync (for notification diffing)
    let previousOwnerUserIds = [];
    if (ownerIdsChanged) {
      try {
        const prevOwners = await TaskOwner.findAll({ where: { taskId: task.id }, attributes: ['userId'], raw: true });
        previousOwnerUserIds = prevOwners.map(o => o.userId);
      } catch (e) { /* ignore */ }
    }

    // Sync multi-owner records if ownerIds provided (backward compat)
    if (Array.isArray(req.body.ownerIds) && canManageMembers) {
      const newOwnerIds = req.body.ownerIds;
      const removedOwnerIds = previousOwnerUserIds.filter(uid => !newOwnerIds.includes(uid));
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
      // Auto-add new owners as board members
      for (const uid of newOwnerIds) {
        await boardMembershipService.autoAddMember(task.boardId, uid);
      }
      // Cleanup board membership for removed owners (awaited to avoid race)
      if (removedOwnerIds.length > 0) {
        try { await boardMembershipService.cleanupMultiple(removedOwnerIds, task.boardId); }
        catch (err) { logger.warn('[Task] Board membership cleanup (owners) failed:', err.message); }
      }

      // Notify newly added owners (skip self-assignment and already-assigned)
      const prevAssigneeIds = (taskAssignees || []).filter(ta => ta.role === 'assignee').map(ta => ta.userId);
      const alreadyKnown = new Set([...previousOwnerUserIds, ...prevAssigneeIds]);
      const newlyAdded = newOwnerIds.filter(uid => !alreadyKnown.has(uid) && uid !== req.user.id);
      if (newlyAdded.length > 0) {
        notifyNewAssignments(task.id, newlyAdded, 'assignee', req.user.id).catch(err =>
          logger.warn('[Task] Owner-assignment notification failed:', err.message)
        );
      }
    }

    const fullTask = await Task.findByPk(task.id, {
      include: [
        ...(await getTaskIncludes()),
        { model: Board, as: 'board', attributes: ['id', 'name'] },
      ],
    });

    // Auto-add new assignee as board member
    if (updates.assignedTo && task.boardId) {
      await boardMembershipService.autoAddMember(task.boardId, updates.assignedTo);
    }

    // Notification: new assignee (only for single-string assignedTo, not array — array is handled by diffAndNotify above)
    if (!membersChanged && updates.assignedTo && updates.assignedTo !== previousAssignee && updates.assignedTo !== req.user.id) {
      notifyNewAssignments(task.id, [updates.assignedTo], 'assignee', req.user.id).catch(err =>
        logger.warn('[Task] Single-assignee notification failed:', err.message)
      );
    }

    // Notification: task completed
    if (updates.status === 'done' && previousStatus !== 'done') {
      // [DONE] prefix is applied inside calendarService.updateTaskEvent() based on
      // task.status === 'done'. The calendar sync block further down handles the
      // actual Graph PATCH, so no separate call is needed here.

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

    // Sync to Teams calendar (fire-and-forget).
    //
    // Archive-as-delete:
    //   The board UI treats "delete" as "archive" — it sends PUT {isArchived:true}
    //   instead of DELETE. Previously this path only PATCHed the event, leaving
    //   an orphan on the user's calendar. Treat archive transitions as lifecycle
    //   events: archive=true → remove remote event; archive=false (restore) →
    //   recreate it. We handle archive FIRST so the delete takes precedence over
    //   any other field change in the same PUT.
    const mailboxForArchive = task.teamsCalendarUserId ? task.assignedTo : (task.assignedTo || previousAssignee);
    if (updates.isArchived === true && previousIsArchived !== true) {
      if (mailboxForArchive) {
        calendarService.deleteTaskEvent(task.id, mailboxForArchive).catch(err =>
          logger.warn('[Task] Calendar delete (archive) failed:', err.message)
        );
      }
    } else if (updates.isArchived === false && previousIsArchived === true) {
      if (task.assignedTo) {
        calendarService.createTaskEvent(task.id, task.assignedTo).catch(err =>
          logger.warn('[Task] Calendar create (unarchive) failed:', err.message)
        );
      }
    } else if (updates.assignedTo !== undefined && updates.assignedTo !== previousAssignee) {
      // Assignee changed — remove event from previous mailbox (if any),
      // then create on the new mailbox. Service handles old-task attach internally.
      if (previousAssignee) {
        calendarService.deleteTaskEvent(task.id, previousAssignee).catch(err =>
          logger.warn('[Task] Calendar delete (reassign) failed:', err.message)
        );
      }
      if (updates.assignedTo) {
        calendarService.createTaskEvent(task.id, updates.assignedTo).catch(err =>
          logger.warn('[Task] Calendar create (reassign) failed:', err.message)
        );
      }
    } else if (task.assignedTo && !task.isArchived && Object.keys(changes).length > 0) {
      // Task details changed (and it's still active) — sync. Service falls
      // back to create-or-attach if unmapped.
      calendarService.updateTaskEvent(task.id, task.assignedTo).catch(err =>
        logger.warn('[Task] Calendar update failed:', err.message)
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
      // Remove Teams calendar event on archive (service safely skips if no mapping / no remote event)
      if (task.assignedTo) {
        calendarService.deleteTaskEvent(task.id, task.assignedTo).catch(err =>
          logger.warn('[Task] Calendar delete (archive) failed:', err.message)
        );
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
      // Cleanup board membership — archived tasks don't count for visibility
      if (task.assignedTo) {
        try { await boardMembershipService.cleanupIfNoTasksRemain(task.assignedTo, task.boardId); }
        catch (err) { logger.warn('[Task] Board membership cleanup (archive) failed:', err.message); }
      }
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

    // Remove Teams calendar event before deleting the local task.
    // Awaited so the local delete only proceeds after the remote attempt completes,
    // preventing a race where the task row is gone before the service can look up
    // its mailbox mapping. Service internally tolerates missing mappings + 404s.
    if (task.assignedTo) {
      try {
        await calendarService.deleteTaskEvent(task.id, task.assignedTo);
      } catch (err) {
        logger.warn('[Task] Calendar delete (destroy) failed:', err.message);
      }
    }

    await task.destroy();

    // Cleanup board membership for users who were assigned to this now-deleted task
    const allAffected = [...new Set([...assignedUserIds, ...(task.assignedTo ? [task.assignedTo] : [])])];
    if (allAffected.length > 0) {
      try { await boardMembershipService.cleanupMultiple(allAffected, boardId); }
      catch (err) { logger.warn('[Task] Board membership cleanup (delete) failed:', err.message); }
    }

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
      include: [...(await getTaskIncludes())],
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

    // Capture pre-update state — used by both board-membership cleanup and
    // calendar sync (we need to know each task's previous assignee to safely
    // delete events from the old mailbox before creating in the new one).
    let oldAssigneeMap = {};
    const preUpdateById = new Map(); // taskId -> { assignedTo, teamsEventId, teamsCalendarUserId }
    {
      const tasksBeforeUpdate = await Task.findAll({
        where: { id: { [Op.in]: taskIds } },
        attributes: ['id', 'boardId', 'assignedTo', 'teamsEventId', 'teamsCalendarUserId'],
        raw: true,
      });
      for (const t of tasksBeforeUpdate) {
        preUpdateById.set(t.id, {
          assignedTo: t.assignedTo,
          teamsEventId: t.teamsEventId,
          teamsCalendarUserId: t.teamsCalendarUserId,
        });
        if (safeUpdates.assignedTo !== undefined && t.assignedTo) {
          if (!oldAssigneeMap[t.boardId]) oldAssigneeMap[t.boardId] = new Set();
          oldAssigneeMap[t.boardId].add(t.assignedTo);
        }
      }
    }

    await Task.update(safeUpdates, {
      where: { id: { [Op.in]: taskIds } },
    });

    // Board membership cleanup for bulk assignment changes
    if (safeUpdates.assignedTo !== undefined) {
      const newAssignee = safeUpdates.assignedTo; // could be a userId or null
      // Auto-add new assignee as board member
      if (newAssignee) {
        const boardIds = [...new Set(Object.keys(oldAssigneeMap))];
        // Also get boardIds from tasks that had no previous assignee
        const allTasks = await Task.findAll({ where: { id: { [Op.in]: taskIds } }, attributes: ['boardId'], raw: true });
        const allBoardIds = [...new Set(allTasks.map(t => t.boardId))];
        for (const bid of allBoardIds) {
          await boardMembershipService.autoAddMember(bid, newAssignee);
        }
      }
      // Cleanup removed assignees per board
      for (const [boardId, oldUsers] of Object.entries(oldAssigneeMap)) {
        const removedUsers = [...oldUsers].filter(uid => uid !== newAssignee);
        if (removedUsers.length > 0) {
          try { await boardMembershipService.cleanupMultiple(removedUsers, boardId); }
          catch (err) { logger.warn('[Task] Bulk update board membership cleanup failed:', err.message); }
        }
      }
    }

    // Auto-group assignment for bulk status changes
    if (safeUpdates.status) {
      try {
        const tasksForGroup = await Task.findAll({
          where: { id: { [Op.in]: taskIds } },
          attributes: ['id', 'boardId', 'groupId'],
          include: [{ model: Board, as: 'board', attributes: ['id', 'groups'] }],
        });
        for (const t of tasksForGroup) {
          if (t.board && Array.isArray(t.board.groups)) {
            const targetGroupId = findGroupForStatus(safeUpdates.status, t.board.groups);
            if (targetGroupId && targetGroupId !== t.groupId) {
              await t.update({ groupId: targetGroupId });
            }
          }
        }
      } catch (e) {
        logger.warn('[Task] Bulk auto-group assignment failed:', e.message);
      }
    }

    const updatedTasks = await Task.findAll({
      where: { id: { [Op.in]: taskIds } },
      include: [...(await getTaskIncludes())],
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

    // Calendar sync for bulk operations.
    // Each task's sync runs serially within its own Promise chain so delete +
    // create can't race on the same row's teamsCalendarUserId. The overall
    // dispatch is fire-and-forget relative to the HTTP response.
    const calendarTouching = ['status', 'priority', 'dueDate', 'assignedTo', 'isArchived']
      .some(f => safeUpdates[f] !== undefined);
    if (calendarTouching) {
      for (const t of updatedTasks) {
        const prev = preUpdateById.get(t.id) || {};
        (async () => {
          try {
            if (safeUpdates.isArchived === true) {
              if (prev.assignedTo || t.assignedTo) {
                await calendarService.deleteTaskEvent(t.id, prev.assignedTo || t.assignedTo);
              }
              return;
            }
            if (safeUpdates.assignedTo !== undefined && prev.assignedTo !== t.assignedTo) {
              if (prev.assignedTo) {
                await calendarService.deleteTaskEvent(t.id, prev.assignedTo);
              }
              if (t.assignedTo) {
                await calendarService.createTaskEvent(t.id, t.assignedTo);
              }
              return;
            }
            if (t.assignedTo) {
              await calendarService.updateTaskEvent(t.id, t.assignedTo);
            }
          } catch (err) {
            logger.warn('[Task] Bulk calendar sync failed', { taskId: t.id, err: err.message });
          }
        })();
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
        ...(await getTaskIncludes()),
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

    // Members can only check their own schedule — strict RBAC
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
        ...(await getTaskIncludes()),
        { model: Board, as: 'board', attributes: ['id', 'name'] },
      ],
    });

    if (fullTask) {
      emitToBoard(fullTask.boardId, 'task:updated', { task: fullTask });
      if (fullTask.assignedTo) emitToUser(fullTask.assignedTo, 'task:updated', { task: fullTask });

      // Sync rescheduled task to Teams calendar (service falls back to create-or-attach if unmapped).
      if (fullTask.assignedTo) {
        calendarService.updateTaskEvent(fullTask.id, fullTask.assignedTo).catch(err =>
          logger.warn('[Task] Calendar sync (reschedule) failed:', err.message)
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

    // Members can only check their own schedule — strict RBAC
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
          await boardMembershipService.autoAddMember(board.id, uid);
        }
      }

      // Notify new assignees
      const existingAssigneeIds = task.taskAssignees
        .filter(ta => ta.role === 'assignee')
        .map(ta => ta.userId);
      const newAssigneeIds = assignees.filter(uid => !existingAssigneeIds.includes(uid) && uid !== req.user.id);
      const removedAssigneeIds = existingAssigneeIds.filter(uid => !assignees.includes(uid));

      // Cleanup board membership for removed assignees (awaited to avoid race)
      if (removedAssigneeIds.length > 0 && board) {
        try { await boardMembershipService.cleanupMultiple(removedAssigneeIds, board.id); }
        catch (err) { logger.warn('[Task] Board membership cleanup (updateTaskMembers) failed:', err.message); }
      }
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
          await boardMembershipService.autoAddMember(board.id, uid);
        }
      }

      // Notify new supervisors
      const existingSupervisorIds = task.taskAssignees
        .filter(ta => ta.role === 'supervisor')
        .map(ta => ta.userId);
      const newSupervisorIds = supervisors.filter(uid => !existingSupervisorIds.includes(uid) && uid !== req.user.id);
      const removedSupervisorIds = existingSupervisorIds.filter(uid => !supervisors.includes(uid));

      // Cleanup board membership for removed supervisors (awaited to avoid race)
      if (removedSupervisorIds.length > 0 && board) {
        try { await boardMembershipService.cleanupMultiple(removedSupervisorIds, board.id); }
        catch (err) { logger.warn('[Task] Board membership cleanup (supervisors/updateTaskMembers) failed:', err.message); }
      }
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
        ...(await getTaskIncludes()),
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
