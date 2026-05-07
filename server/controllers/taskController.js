const { Task, Board, User, Notification, Subtask, Label, TaskOwner, TaskAssignee, TaskDependency, TaskApprovalFlow, DependencyRequest } = require('../models');
const { sequelize } = require('../config/db');
const { validationResult } = require('express-validator');
const logger = require('../utils/logger');
const { Op } = require('sequelize');
const { emitToBoard, emitToUser, emitToBoardAndUsers } = require('../services/socketService');
const socketService = require('../services/socketService');
const taskVisibility = require('../services/taskVisibilityService');
const realtime = require('../services/realtimeService');
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
const receiptService = require('../services/taskReceiptService');
const teamsNotif = require('../services/teamsNotificationService');
const { isValidStatus, isValidStatusForTask } = require('../utils/statusConfig');
const { buildPendingPriorityOrder, findGroupForStatus } = require('../utils/taskPrioritization');
const boardMembershipService = require('../services/boardMembershipService');
const { hasPermission: enginePermission } = require('../services/permissionEngine');
const { isSelfOwnedTask, isSelfOwnedCreate } = require('../utils/taskOwnership');

/**
 * Centralized check: can this user assign a task to the given target user IDs?
 *
 * Rules:
 *   1. Self-only assignment (every targetId === user.id) is allowed for anyone
 *      who has the base `tasks.assign` permission (true for all roles by
 *      default, unless an admin denied it).
 *   2. Assigning to others requires `tasks.assign_others` (deny override
 *      blocks even if the role normally has it).
 *   3. For roles whose `assign_others` is hierarchy-scoped (assistant manager,
 *      manager), the additional `hierarchyService.canAssignTo` check still
 *      applies on top.
 *
 * Returns { allowed: true } or { allowed: false, status, message }.
 */
async function checkAssignmentAuthority(user, targetUserIds = []) {
  const targets = (targetUserIds || []).filter(Boolean);
  if (targets.length === 0) return { allowed: true };

  const isSelfOnly = targets.every((id) => id === user.id);

  if (isSelfOnly) {
    const canAssignSelf = await enginePermission(user, 'tasks', 'assign');
    if (!canAssignSelf) {
      return { allowed: false, status: 403, message: 'You do not have permission to self-assign tasks.' };
    }
    return { allowed: true };
  }

  const canAssignOthers = await enginePermission(user, 'tasks', 'assign_others');
  if (!canAssignOthers) {
    return {
      allowed: false,
      status: 403,
      message: 'You do not have permission to assign tasks to other users.',
    };
  }

  // Hierarchy subtree check (manager / assistant manager). Admins and super
  // admins are short-circuited inside hierarchyService.
  if (user.role === 'manager' || user.role === 'assistant_manager') {
    const { canAssignTo } = require('../services/hierarchyService');
    for (const id of targets) {
      const ok = await canAssignTo(user, id);
      if (!ok) {
        return {
          allowed: false,
          status: 403,
          message: 'You can only assign tasks to users in your reporting subtree.',
        };
      }
    }
  }

  return { allowed: true };
}

/**
 * Due-date gate helper.
 *
 * The product rule (post-fix): "a task cannot be assigned to anyone — including
 * yourself — without a due date." The previous self-exemption was the bypass
 * vector that let users put work on their own plate with no deadline; product
 * now wants the same forcing function for self and other assignees, so the
 * gate fires the moment the resulting assignee/supervisor set is non-empty
 * and there is no due date.
 *
 * Pure removals (empty arrays / null) are still allowed — taking work *off*
 * a plate doesn't need a deadline.
 *
 * `actorId` is kept in the signature so callers can still distinguish self
 * vs. others for messaging/UI purposes, but it does NOT change the result.
 *
 * Returns true when the request needs a due date but doesn't have one.
 */
function needsDueDateForAssignment(actorId, assigneeIds = [], supervisorIds = [], dueDate) {
  if (dueDate) return false;
  const targets = [...(assigneeIds || []), ...(supervisorIds || [])].filter(Boolean);
  return targets.length > 0;
}

/**
 * Returns true if the given userId list contains anyone other than the actor.
 * Used purely to refine error messaging — "assigning this task to another
 * user" reads better when an "other" is actually involved; the self-only
 * variant says "before assigning this task" without "to another user".
 */
function assignmentTargetsOther(actorId, assigneeIds = [], supervisorIds = []) {
  const targets = [...(assigneeIds || []), ...(supervisorIds || [])].filter(Boolean);
  return targets.some((id) => id !== actorId);
}

/**
 * Due-date gate error message — single source of truth so frontend toasts and
 * tests can match the same string. Mirrors the message used in the React
 * cells / TaskModal.
 */
function dueDateRequiredMessage(actorId, assigneeIds = [], supervisorIds = []) {
  return assignmentTargetsOther(actorId, assigneeIds, supervisorIds)
    ? 'Please set a due date before assigning this task to another user.'
    : 'Please set a due date before assigning this task.';
}

/**
 * Approval-required gate for task completion.
 *
 * Rule: Non-super-admin users cannot transition a task to status='done' (or
 * progress=100) directly. They must go through the approval chain — submit
 * for approval, then a senior reviewer marks it done by approving the chain.
 * The chain itself sets status='done' inside `approvalController.approveTask`,
 * which never traverses this controller.
 *
 * Allowed direct transitions:
 *   - actor is a Super Admin (top of the org — final authority)
 *   - task.approvalStatus === 'approved' (chain already completed; this is a
 *     legitimate write from approveTask, or a manual re-flip after approval)
 *   - the transition is not toward done/100% (any other status/progress edit)
 *
 * Self-assigned tasks are NOT exempt — that was the bypass the old rule
 * allowed and is the bug we are fixing. The approvalChainService routes a
 * self-task through the standard hierarchy walk and auto-approves only when
 * no senior reviewer exists at all.
 *
 * Returns { blocked: true, message } when the request should be denied,
 * otherwise { blocked: false }.
 */
function approvalGateForCompletion(task, user, updates) {
  const goingToDone = updates.status === 'done' && task.status !== 'done';
  // Direct progress=100 with no status change is the secondary bypass vector
  // — block it too. (Status flipping to non-done resets progress in
  // taskController, so a partial-progress update never trips this.)
  const goingToFullProgress = updates.progress === 100
    && task.progress !== 100
    && updates.status !== 'done'
    && task.status !== 'done';

  if (!goingToDone && !goingToFullProgress) {
    return { blocked: false };
  }
  if (user?.isSuperAdmin) return { blocked: false };
  if (task.approvalStatus === 'approved') return { blocked: false };

  return {
    blocked: true,
    message: 'This task requires manager approval before it can be marked Done.',
    code: task.approvalStatus === 'pending_approval' ? 'approval_pending' : 'approval_required',
  };
}

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
const hasTaskApprovalFlowsTable = () => tableExists('task_approval_flows');

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
  if (await hasTaskApprovalFlowsTable()) {
    // separate:true issues a single grouped query for all task ids — avoids N+1
    // when listing many tasks. `stage` is required by the frontend's logical
    // grouping (parallel final stage = Manager+Admin+SuperAdmin under one stage
    // value); the User join exposes isSuperAdmin so the indicator can place
    // super admins last in the final stage and label them correctly.
    includes.push({
      model: TaskApprovalFlow,
      as: 'approvalFlows',
      separate: true,
      order: [['level', 'ASC']],
      attributes: ['id', 'level', 'stage', 'status', 'userId', 'userName', 'role', 'actionAt', 'comment', 'attachmentUrl'],
      include: [{
        model: User,
        as: 'user',
        attributes: ['id', 'name', 'avatar', 'role', 'isSuperAdmin'],
        required: false,
      }],
    });
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

    // Phase 7 — Board visibility gate. Tier 1/2 retain unrestricted access;
    // Tier 3/4 must be able to see the board before they can plant a task
    // on it. Closes audit P0-7 (createTask did not enforce board access,
    // letting members POST tasks onto stranger boards via guessed IDs).
    {
      const { resolveTier, hasTierAtLeast, TIER_2 } = require('../config/tiers');
      if (!hasTierAtLeast(req.user, TIER_2)) {
        const boardVisibility = require('../services/boardVisibilityService');
        const reachable = await boardVisibility.canUserSeeBoard(req.user, board.id);
        if (!reachable) {
          return res.status(403).json({
            success: false,
            message: 'You do not have access to this board.',
            code: 'BOARD_NOT_VISIBLE',
          });
        }
      }
    }

    // Validate status against task-level config (if provided), then board config
    if (status) {
      const tempTask = statusConfig ? { statusConfig } : {};
      if (!isValidStatusForTask(status, tempTask, board)) {
        return res.status(400).json({ success: false, message: `Invalid status "${status}" for this task.` });
      }
    }

    // Permission resolution via the central engine — honors role defaults,
    // grant overrides, and DENY overrides.
    const canCreate = await enginePermission(req.user, 'tasks', 'create');
    if (!canCreate) {
      return res.status(403).json({ success: false, message: 'You do not have permission to create tasks.' });
    }

    const canAssignOthers = await enginePermission(req.user, 'tasks', 'assign_others');
    // We treat anyone WITHOUT assign_others as a "self-only assigner" for the
    // purpose of normalizing input — even managers who had the perm denied.
    const restrictToSelf = !canAssignOthers;

    // Member-style restriction: cannot configure task-level status options or
    // override priority. (Mirrors the previous behavior; field-level whitelist
    // for full edits is enforced in updateTask via taskPermissions middleware.)
    const isMemberRole = req.user.role === 'member';
    const safeStatusConfig = (!isMemberRole && Array.isArray(statusConfig) && statusConfig.length > 0)
      ? statusConfig : null;

    // Normalize assigneeIds. Anyone restricted to self gets forced to [self];
    // we DO NOT silently drop other IDs — instead we 403 below if the request
    // tried to assign someone else, so a malicious client can't bypass via the
    // API. Empty array is fine and falls through.
    const requestedAssignees = Array.isArray(assignedTo)
      ? assignedTo
      : (assignedTo ? [assignedTo] : []);
    const requestedSupervisors = Array.isArray(supervisors) ? supervisors : [];

    let assigneeIds = requestedAssignees.filter(Boolean);
    let supervisorIds = requestedSupervisors.filter(Boolean);

    if (restrictToSelf) {
      const triedToAssignOthers = assigneeIds.some((id) => id !== req.user.id);
      const triedToSupervise   = supervisorIds.length > 0;
      if (triedToAssignOthers || triedToSupervise) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to assign tasks to other users.',
        });
      }
      // Auto-self-assign convenience: when a self-only actor creates a task
      // without picking an assignee, default to self — but ONLY if a due date
      // is already set. Without a due date, the task is created unassigned
      // (the user can set the due date and self-assign later). This honors
      // the "no assignment without a due date" rule end-to-end without
      // breaking the "+ Add task" quick-create flow (the task still gets
      // created; assignment happens on a follow-up edit).
      if (assigneeIds.length === 0 && dueDate) assigneeIds = [req.user.id];
    }

    // Cross-target authorization: assign + hierarchy subtree check.
    const allTargets = [...new Set([...assigneeIds, ...supervisorIds])];
    const authCheck = await checkAssignmentAuthority(req.user, allTargets);
    if (!authCheck.allowed) {
      return res.status(authCheck.status).json({ success: false, message: authCheck.message });
    }

    // Due-date gate. Fires whenever the resulting task would have any
    // assignee or supervisor and no due date. Self-assignment is no longer
    // exempt — see the helper docstring for the product rationale. The
    // auto-self-assign branch above is gated on `dueDate`, so a self-only
    // actor creating an undated quick task simply gets an unassigned row
    // instead of a 400.
    if (needsDueDateForAssignment(req.user.id, assigneeIds, supervisorIds, dueDate)) {
      return res.status(400).json({
        success: false,
        message: dueDateRequiredMessage(req.user.id, assigneeIds, supervisorIds),
      });
    }

    // Priority permission gate. The `tasks.set_priority` action lets
    // organizations restrict who can set priority — members default to
    // `false` (priority is a planning concern owned by leads). We only
    // 403 when the supplied priority is NON-DEFAULT — passing the default
    // ('medium') is treated as "no opinion" and is allowed for any actor,
    // because clients legitimately serialize the default into their POST
    // payloads even on the quick-create path where the user never picked a
    // value. The result is the same task row (priority='medium') either
    // way, so a 403 here would just be theatre. Mirrors the principle in
    // updateTask: only block ACTUAL changes from the default.
    //
    // Self-owned exemption: a Tier 4 actor creating a task they're keeping
    // for themselves (no foreign assignees) IS the de-facto owner — the
    // engine's coarse `set_priority=false` would otherwise lock them out of
    // setting priority on their own work. The exemption is scoped strictly
    // to the "creator + self/empty assignee set" shape so a member who tries
    // to assign to anyone else still hits the 403.
    const DEFAULT_PRIORITY = 'medium';
    if (priority !== undefined && priority !== null && priority !== DEFAULT_PRIORITY) {
      const selfOwned = isSelfOwnedCreate(req.user.id, assigneeIds);
      const canSetPriority = selfOwned
        || (await enginePermission(req.user, 'tasks', 'set_priority'));
      if (!canSetPriority) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to set task priority.',
        });
      }
    }

    // Keep backward compat: set assignedTo to first assignee
    const primaryAssignee = assigneeIds.length > 0 ? assigneeIds[0] : null;

    // Approval gate at creation: a non-super-admin cannot create a task that
    // is already status='done'. This closes the secondary bypass where a
    // member could POST { status: 'done', assignedTo: self } and skip the
    // chain. Members must create the task at a non-done status, work on it,
    // then submit for approval. Super Admins are exempt (final authority).
    if (status === 'done' && !req.user?.isSuperAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Tasks cannot be created in the Done state. Submit for approval after completing the work.',
        code: 'approval_required',
      });
    }

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
      priority: priority || 'medium',
      groupId: effectiveGroupId,
      dueDate: dueDate || null,
      startDate: startDate || null,
      plannedStartTime: plannedStartTime || null,
      plannedEndTime: plannedEndTime || null,
      estimatedHours: estimatedHours != null ? estimatedHours : 0,
      progress: status === 'done' ? 100 : 0,
      completedAt: status === 'done' ? new Date() : null,
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
        assignerId: req.user.id,
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
        assignerId: req.user.id,
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

    // Realtime fan-out — assignees / supervisors / owners / creator + the
    // board room. realtimeService also pulls in watchers and dedupes against
    // sockets already in the board room. This is the path that fixes the
    // "Sunny doesn't see JOKER without refresh" bug.
    realtime.emitTaskCreated(fullTask, {
      actorId: req.user.id,
      extraUserIds: [...supervisorIds, ...(Array.isArray(ownerIds) ? ownerIds : [])],
    });

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

    // Attach receipt summary so the creator sees the initial "single tick"
    // state immediately on their own create response.
    const createdTaskJSON = fullTask ? fullTask.toJSON() : null;
    if (createdTaskJSON) {
      createdTaskJSON._receipt = receiptService.buildSummary(createdTaskJSON, req.user.id);
    }

    res.status(201).json({
      success: true,
      message: 'Task created successfully.',
      data: { task: createdTaskJSON || fullTask },
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
    }

    // ── CP-3 Strict RBAC: visibility filter is ALWAYS applied for non-admins ─
    // Hierarchy-scoped users (manager / assistant_manager / member) only see
    // tasks where assignee / creator / owner / task_assignees user is in
    // their { self ∪ descendants } set. Admin / super_admin pass through
    // unfiltered.
    //
    // We apply this on top of any explicit assignedTo filter so that a
    // request like ?assignedTo=<some-stranger-id> still returns nothing when
    // the stranger isn't in the viewer's subtree. Combined with the [Op.and]
    // shape returned by buildTaskVisibilityWhere, the two AND together
    // correctly.
    const visibilityFilter = await buildTaskVisibilityFilter(req.user, boardId);
    if (visibilityFilter && visibilityFilter[Op.and]) {
      if (!where[Op.and]) where[Op.and] = [];
      for (const frag of visibilityFilter[Op.and]) where[Op.and].push(frag);
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

    // Add subtask counts, Board info, and receipt summary to each task
    const tasksWithCounts = tasks.map(t => {
      const plain = t.toJSON();
      const subs = plain.subtasks || [];
      plain.subtaskTotal = subs.length;
      plain.subtaskDone = subs.filter(s => s.status === 'done').length;
      plain.Board = plain.board || null;
      delete plain.subtasks;
      // Attach receipt summary for the viewer (only set when viewer is the
      // assigner/creator and not also an assignee — see taskReceiptService).
      plain._receipt = receiptService.buildSummary(plain, req.user.id);
      return plain;
    });

    // Fire-and-forget: mark fetched tasks as delivered for this user. The
    // service is idempotent — only transitions rows where deliveredAt IS NULL.
    // We then emit `task:receipt` so the assigner's open board updates live.
    (async () => {
      try {
        const taskIds = tasksWithCounts.map(t => t.id);
        const transitioned = await receiptService.markDelivered(req.user.id, taskIds);
        if (transitioned.length === 0) return;
        for (const tid of transitioned) {
          const tObj = tasksWithCounts.find(t => t.id === tid);
          if (!tObj || !tObj.createdBy) continue;
          const summary = await receiptService.fetchSummary(tid, tObj.createdBy);
          if (!summary) continue;
          const payload = { taskId: tid, boardId: tObj.boardId, createdBy: tObj.createdBy, summary };
          try { emitToBoard(tObj.boardId, 'task:receipt', payload); } catch {}
          try { emitToUser(tObj.createdBy, 'task:receipt', payload); } catch {}
        }
      } catch (e) {
        logger.warn('[TaskReceipt] deferred delivery mark failed:', e.message);
      }
    })();

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
    const viewCheck = await checkTaskAction('view', req.user, task, taskAssignees, req);
    const editCheck = await checkTaskAction('edit', req.user, task, taskAssignees, req);
    const reassignCheck = await checkTaskAction('reassign', req.user, task, taskAssignees, req);
    const deleteCheck = await checkTaskAction('delete', req.user, task, taskAssignees, req);

    const taskJSON = task.toJSON();
    taskJSON._permissions = {
      canView: viewCheck.allowed,
      canEdit: editCheck.allowed,
      canEditAllFields: editCheck.allowed && !editCheck.allowedFields,
      allowedFields: editCheck.allowedFields || null,
      canReassign: reassignCheck.allowed,
      canDelete: deleteCheck.allowed,
    };
    taskJSON._receipt = receiptService.buildSummary(taskJSON, req.user.id);

    // Approval capability flags for the calling user. Same source of truth the
    // approval action endpoints use server-side, so the modal can render the
    // Approve / Reject / Request Changes buttons without ever guessing.
    if (taskJSON.approvalStatus) {
      const { computeApprovalCapabilities } = require('../services/approvalCapabilityService');
      taskJSON.myApprovalCapabilities = computeApprovalCapabilities({
        task: taskJSON,
        flows: taskJSON.approvalFlows || [],
        user: req.user,
      });
    }

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
        // `groups` is needed by the status→group auto-move below; without it the
        // sync silently no-ops because Array.isArray(undefined) is false.
        { model: Board, as: 'board', attributes: ['id', 'name', 'columns', 'groups'] },
        { model: User, as: 'creator', attributes: ['id', 'role'] },
        { model: TaskAssignee, as: 'taskAssignees' },
      ],
    });

    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    // Layer 3: Check action permission using the new system
    const taskAssignees = task.taskAssignees || [];
    const editPermission = await checkTaskAction('edit', req.user, task, taskAssignees, req);

    // Title set-once lock. Once a task exists, only Tier 1 / Super Admin may
    // rename it. Tier 2/3/4 — including the task's creator and assignees —
    // can no longer change the title via PUT. A no-op resend (incoming ===
    // existing) is allowed for everyone so optimistic clients that include
    // `title` in PATCH-style payloads don't 403. Title creation happens in
    // POST /tasks (createTask), which is unaffected by this gate.
    if (req.body.title !== undefined) {
      const incomingTitle = typeof req.body.title === 'string' ? req.body.title : '';
      const sameAsExisting = incomingTitle === task.title;
      if (!sameAsExisting) {
        const { resolveTier, TIER_1 } = require('../config/tiers');
        if (resolveTier(req.user) !== TIER_1) {
          return res.status(403).json({
            success: false,
            message: 'Task title can only be edited by Super Admin (Tier 1) after creation.',
            code: 'title_locked',
          });
        }
      }
    }

    // Archive-as-delete gate: PUT { isArchived: true|false } is the board UI's
    // way of soft-deleting / restoring. It must be authorized by tasks.delete
    // (deny-aware), not silently filtered, so a member that bypasses the UI
    // and POSTs the field directly receives a clear 403 instead of a no-op.
    //
    // CP-3 regression fix: archive must work for managers acting on tasks
    // inside their subtree, even when they're not the assignee/creator. We
    // gate by tasks.delete (engine permission) AND inSubtree — both must
    // hold. A manager outside the subtree still can't archive (no read =
    // no write). req._taskInSubtree was populated by the editPermission
    // check above (or by the canViewTask middleware on read paths).
    if (req.body.isArchived !== undefined) {
      // Archive (soft-delete) is now a SEPARATE action from permanent delete.
      // Tier 1 (Super Admin) and Tier 2 (Admin/Manager) may archive any task
      // they have visibility on. Tier 3/4 still need the matrix `tasks.delete`
      // permission (which defaults to false but can be granted as an
      // override). Permanent deletion remains gated by `assertCanDelete`
      // in deleteTask — Tier 2 cannot reach that path.
      const { resolveTier, hasTierAtLeast: hasTierAtLeastFn, TIER_2 } = require('../config/tiers');
      const userTier = resolveTier(req.user);
      const canArchive = hasTierAtLeastFn(req.user, TIER_2)
        || (await enginePermission(req.user, 'tasks', 'delete'));
      const isAdminLike = req.user.isSuperAdmin || req.user.role === 'admin';
      const archiveInScope = isAdminLike
        || req._taskInSubtree === true
        || task.assignedTo === req.user.id
        || task.createdBy === req.user.id
        || taskAssignees.some((ta) => ta.userId === req.user.id);
      if (!canArchive || !archiveInScope) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to archive or restore this task.',
        });
      }
      // Allow the archive even when the broader edit permission would block
      // the rest of the body — common case is "manager toggles isArchived
      // on a subtree task that nobody on it is themselves". We synthesize
      // an edit permission that only whitelists isArchived (+ archive
      // metadata) to avoid widening the surface.
      if (!editPermission.allowed) {
        editPermission.allowed = true;
        editPermission.allowedFields = ['isArchived'];
      }
    }

    // If user can't edit at all, check if they can at least update status
    if (!editPermission.allowed) {
      const statusPermission = await checkTaskAction('edit_status', req.user, task, taskAssignees, req);
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

    // Phase 7 — Approval-snapshot tamper protection. Reserved keys inside
    // `customFields` (today: `_approvalSnapshot`) are written/cleared
    // exclusively by the approval lifecycle helpers. If a user PUT-tries to
    // set them via /api/tasks/:id, the rejected/changes-requested path would
    // restore the task to whatever fake state they injected — a full bypass
    // of the approval gate. Strip every `_`-prefixed reserved key from
    // incoming customFields before merge. Closes audit P0-8.
    if (req.body.customFields !== undefined && allowedFields.includes('customFields')) {
      const cf = req.body.customFields;
      if (cf && typeof cf === 'object' && !Array.isArray(cf)) {
        const cleaned = {};
        for (const [key, val] of Object.entries(cf)) {
          // Reserved-key namespace: leading underscore == internal/system.
          // Today this is just `_approvalSnapshot`; future reserved keys
          // declared by approvalLifecycleService follow the same shape, so
          // a single underscore-prefix filter covers them all.
          if (typeof key === 'string' && key.startsWith('_')) continue;
          cleaned[key] = val;
        }
        req.body.customFields = cleaned;
      } else if (cf !== null && cf !== undefined) {
        // Non-object payloads (string, number, etc.) cannot carry reserved
        // keys, but they're meaningless for customFields — reject them
        // outright so we don't accidentally drop the JSONB column entirely.
        return res.status(400).json({
          success: false,
          message: 'customFields must be an object.',
          code: 'invalid_custom_fields',
        });
      }
    }

    // Description set-once lock. Tier 3/Tier 4 may add a description only when
    // empty; once non-empty it is immutable for them. Tier 1 + Tier 2 may
    // override at any time (matches matrix entry `tasks.edit_locked_description`,
    // decision #10 revised — T1+T2 always editable). A no-op resend
    // (incoming === existing) is allowed for everyone so optimistic clients
    // that include the field in PATCH payloads don't break.
    if (req.body.description !== undefined && allowedFields.includes('description')) {
      const existingDesc = typeof task.description === 'string' ? task.description.trim() : '';
      const incomingRaw = req.body.description == null ? '' : String(req.body.description);
      const incomingDesc = incomingRaw.trim();
      if (existingDesc && incomingDesc !== existingDesc) {
        // Phase 7 — Tier 1 + Tier 2 override per product matrix flag
        // `tasks.edit_locked_description`. Read the matrix directly so the
        // controller never drifts from the engine / frontend. Closes audit P1-10.
        const { resolveTier } = require('../config/tiers');
        const { isTierBasePermission } = require('../config/permissionMatrix');
        const actorTier = resolveTier(req.user);
        if (!isTierBasePermission(actorTier, 'tasks', 'edit_locked_description')) {
          return res.status(403).json({
            success: false,
            message: 'Task description cannot be edited after it has been added.',
            code: 'description_locked',
          });
        }
        // Override path (Tier 1 / Tier 2): sanitize the incoming value and let
        // the normal field-merge below persist it.
        req.body.description = sanitizeInput(incomingRaw);
      }
      // Sanitize on first set so the persisted value matches createTask's
      // hygiene. Whitespace-only incoming on an empty task is dropped to
      // avoid "locking" the description to a blank string.
      if (!existingDesc) {
        if (incomingDesc) {
          req.body.description = sanitizeInput(incomingRaw);
        } else {
          delete req.body.description;
        }
      }
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

    // Completion → progress 100. Applies whether status is being changed to
    // 'done' here or the task is already 'done' (server is the source of truth
    // for this invariant). Status changes away from 'done' do not reset progress.
    const willBeDone = updates.status === 'done' || (updates.status === undefined && task.status === 'done');
    if (willBeDone && updates.progress !== 100) {
      updates.progress = 100;
      if (task.progress !== 100) changes.progress = 100;
    }

    // Phase 10 — guard: don't let a task be completed while it has active
    // blocking dependencies. Non-elevated users get a hard 400. Elevated
    // users (admin / manager / super-admin) can override by passing
    // `?force=true` (or body.force=true), which gets recorded as an
    // adminOverride in the activity log a few hundred lines down.
    let _depAdminOverride = false;
    let _depBlockingCount = 0;
    if (updates.status === 'done' && task.status !== 'done') {
      // Phase-fix: dep-owner-but-not-parent-owner cannot mark the parent
      // task done. They reach the parent modal via "Open Parent" on the
      // dependencies page; their assistant_manager / manager-ish edit power
      // would otherwise bypass the approval intercept (which is gated on
      // parent ownership in the UI). Block the direct done transition so
      // the dependency owner can't end-run Sunny's approval workflow.
      //
      // Real elevated users (admin / super-admin) keep their existing
      // ability to close any task. Only assistant_manager / member dep
      // owners are caught by this gate.
      const taskAssigneeRow = await TaskAssignee.findOne({
        where: { taskId: task.id, userId: req.user.id },
      }).catch(() => null);
      const isTaskParticipant = (
        task.assignedTo === req.user.id ||
        task.createdBy === req.user.id ||
        !!taskAssigneeRow
      );
      const isElevatedUser = !!req.user?.isSuperAdmin || ['admin', 'manager'].includes(req.user?.role);
      if (!isTaskParticipant && !isElevatedUser) {
        const depAssigneeCount = await DependencyRequest.count({
          where: { parentTaskId: task.id, assignedToUserId: req.user.id },
        });
        if (depAssigneeCount > 0) {
          return res.status(403).json({
            success: false,
            message: 'Dependency owners cannot complete the parent task. Ask the parent task owner to mark it Done.',
            meta: { reason: 'dep_owner_cannot_complete_parent' },
          });
        }
      }

      _depBlockingCount = await DependencyRequest.count({
        where: {
          parentTaskId: task.id,
          status: { [Op.in]: ['pending', 'accepted', 'working_on_it', 'rejected'] },
          archivedAt: null,
        },
      });
      if (_depBlockingCount > 0) {
        const isElevated = !!req.user?.isSuperAdmin || ['admin', 'manager'].includes(req.user?.role);
        const force = req.body?.force === true || req.query?.force === 'true';
        if (!isElevated) {
          return res.status(400).json({
            success: false,
            message: 'Cannot complete parent task while active dependencies exist.',
            meta: { blockingDepCount: _depBlockingCount },
          });
        }
        if (!force) {
          return res.status(409).json({
            success: false,
            message: `This task has ${_depBlockingCount} active dependenc${_depBlockingCount === 1 ? 'y' : 'ies'}. Re-send with force=true to override and mark done.`,
            meta: { blockingDepCount: _depBlockingCount, requiresOverride: true },
          });
        }
        // Elevated user passed force=true — proceed but flag for audit.
        _depAdminOverride = true;
      }
    }

    // ── Approval gate ───────────────────────────────────────────────────
    // Non-super-admin users cannot mark a task done (or push progress to
    // 100%) without an approved approval chain. This blocks the direct
    // PUT /api/tasks/:id { status: 'done' } bypass that previously let
    // members self-complete self-assigned tasks. The /task-extras/.../approve
    // path is unaffected because it never goes through updateTask — it
    // mutates the task row directly inside approvalController.approveTask.
    const approvalGate = approvalGateForCompletion(task, req.user, updates);
    if (approvalGate.blocked) {
      return res.status(403).json({
        success: false,
        message: approvalGate.message,
        code: approvalGate.code,
      });
    }

    // completedAt invariant: stamp on transition INTO 'done', clear on
    // transition OUT of 'done'. We use `task.completedAt` as the prior state
    // so that a no-op resave (status='done' twice) doesn't overwrite the
    // original completion timestamp.
    if (updates.status !== undefined && updates.status !== task.status) {
      if (updates.status === 'done' && task.status !== 'done' && !task.completedAt) {
        updates.completedAt = new Date();
      } else if (updates.status !== 'done' && task.status === 'done') {
        updates.completedAt = null;
      }
    }

    // Centralized assignment authority check — covers role default, grant
    // override, deny override, and hierarchy subtree (where applicable).
    const allAssignmentTargets = [
      ...(Array.isArray(req.body.assignedTo) ? req.body.assignedTo : (updates.assignedTo && typeof updates.assignedTo === 'string' ? [updates.assignedTo] : [])),
      ...(Array.isArray(req.body.ownerIds) ? req.body.ownerIds : []),
      ...(Array.isArray(req.body.supervisors) ? req.body.supervisors : []),
    ].filter(Boolean);
    if (allAssignmentTargets.length > 0) {
      const auth = await checkAssignmentAuthority(req.user, allAssignmentTargets);
      if (!auth.allowed) {
        return res.status(auth.status).json({ success: false, message: auth.message });
      }
    }

    // Due-date gate for assignment changes. Fires only when the request is
    // actually adding or replacing assignees / supervisors / owners — pure
    // removals (empty array, null) are allowed even without a due date because
    // the resulting task has nobody on the hook for it. Existing tasks with
    // assignees-but-no-due-date are not retro-blocked unless the caller tries
    // to edit who's assigned.
    const isAssigneeMutation = req.body.assignedTo !== undefined ||
      Array.isArray(req.body.supervisors) ||
      Array.isArray(req.body.ownerIds);
    if (isAssigneeMutation) {
      const existingTaskAssignees = task.taskAssignees || [];
      const currentAssigneeIds = existingTaskAssignees.filter(ta => ta.role === 'assignee').map(ta => ta.userId);
      const currentSupervisorIds = existingTaskAssignees.filter(ta => ta.role === 'supervisor').map(ta => ta.userId);

      let nextAssigneeIds = currentAssigneeIds;
      if (Array.isArray(req.body.assignedTo)) nextAssigneeIds = req.body.assignedTo;
      else if (typeof req.body.assignedTo === 'string' && req.body.assignedTo) nextAssigneeIds = [req.body.assignedTo];
      else if (req.body.assignedTo === null) nextAssigneeIds = [];
      if (Array.isArray(req.body.ownerIds)) nextAssigneeIds = req.body.ownerIds;

      const nextSupervisorIds = Array.isArray(req.body.supervisors) ? req.body.supervisors : currentSupervisorIds;

      const willHaveMembers = nextAssigneeIds.length > 0 || nextSupervisorIds.length > 0;
      if (willHaveMembers) {
        // dueDate may be sent in this same payload — honor that as the effective value.
        const effectiveDueDate = updates.dueDate !== undefined ? updates.dueDate : task.dueDate;
        // Updated rule: ANY assignment (including self-assignment) requires a
        // due date. The error string distinguishes "to another user" vs the
        // self-only case for clearer UX.
        if (needsDueDateForAssignment(req.user.id, nextAssigneeIds, nextSupervisorIds, effectiveDueDate)) {
          return res.status(400).json({
            success: false,
            message: dueDateRequiredMessage(req.user.id, nextAssigneeIds, nextSupervisorIds),
          });
        }
      }
    }

    // Priority permission gate. Mirrors createTask. We only check when the
    // request actually mutates priority (changes[priority] != null) so a PUT
    // that includes priority for echo purposes (same value as before) doesn't
    // 403 a member who's editing OTHER fields on their own task. Backend is
    // the source of truth; the frontend renders priority read-only when the
    // user lacks the perm, but a forged direct PUT will still hit this gate.
    //
    // Self-owned exemption: a Tier 4 actor who created the task AND is its
    // sole assignee may set priority on it even though `tasks.set_priority`
    // is false at the matrix level. This matches the product rule that
    // priority is a planning concern owned by the task's owner — when the
    // owner IS the actor, denying them is just frustrating noise. Tasks
    // delegated to a member by anyone else (different creator OR another
    // assignee on the row) still hit the 403.
    if (changes.priority !== undefined && changes.priority !== task.priority) {
      const selfOwned = isSelfOwnedTask(req.user.id, task, taskAssignees);
      const canSetPriority = selfOwned
        || (await enginePermission(req.user, 'tasks', 'set_priority'));
      if (!canSetPriority) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to change task priority.',
        });
      }
    }

    // When `assignedTo` arrives as an array, it's a multi-assignee signal —
    // the scalar Task.assignedTo column is updated later by the array-handling
    // block below. Writing the array through the generic `task.update(updates)`
    // call would try to shove an array into a UUID column and 500.
    if (Array.isArray(updates.assignedTo)) {
      delete updates.assignedTo;
      delete changes.assignedTo;
    }

    await task.update(updates);

    // ── Auto-group assignment: move task to matching group when status changes ──
    // Skipped when the same request also sets groupId explicitly (e.g. drag-drop
    // that intentionally lands the task in a chosen group) — the caller's choice wins.
    if (updates.status && updates.status !== previousStatus && updates.groupId === undefined) {
      try {
        // task.board may not have `groups` if a future include change drops it;
        // fall back to a fresh fetch so the sync can't silently no-op again.
        let board = task.board;
        if (!board || !Array.isArray(board.groups)) {
          board = await Board.findByPk(task.boardId, { attributes: ['id', 'groups'] });
        }
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

    // Sync task_assignees if assignedTo (array) or supervisors or ownerIds provided.
    // canManageMembers is gated on the central engine (assign_others) so that:
    //   - members with assign_others granted can mutate assignees
    //   - managers/asst-mgrs with assign_others denied cannot
    //   - super admin always passes (engine short-circuits)
    const canManageMembers = await enginePermission(req.user, 'tasks', 'assign_others');
    const membersChanged = canManageMembers && (Array.isArray(req.body.assignedTo) || Array.isArray(req.body.supervisors));
    const ownerIdsChanged = canManageMembers && Array.isArray(req.body.ownerIds);

    // Capture old members BEFORE syncing so we can diff later. We need this
    // for both the multi-array path (gated on canManageMembers) AND the
    // single-string path (which now runs for member self-assign), so it's
    // captured unconditionally whenever there's any assignee mutation.
    let oldAssigneeIds = [];
    let oldSupervisorIds = [];
    const isAnyAssigneeMutation = req.body.assignedTo !== undefined || Array.isArray(req.body.supervisors);
    if (isAnyAssigneeMutation) {
      const currentAssignees = taskAssignees || [];
      oldAssigneeIds = currentAssignees.filter(ta => ta.role === 'assignee').map(ta => ta.userId);
      oldSupervisorIds = currentAssignees.filter(ta => ta.role === 'supervisor').map(ta => ta.userId);
    }

    // Single-string `assignedTo` (and explicit null) ALWAYS sync — these are
    // legacy fields and the preceding gates (`checkTaskAction('edit')` field
    // whitelist + `checkAssignmentAuthority` + `needsDueDateForAssignment`)
    // have already authorized the change. Without this, a member-creator who
    // self-assigns their own task gets `task.assignedTo` updated but the
    // `task_assignees` row never created — leaving the two tables out of
    // sync and the visibility filters confused.
    if (typeof updates.assignedTo === 'string' && updates.assignedTo) {
      const removedSingleAssignees = oldAssigneeIds.filter(uid => uid !== updates.assignedTo);
      try {
        await TaskAssignee.destroy({
          where: { taskId: task.id, role: 'assignee', userId: { [Op.ne]: updates.assignedTo } },
        });
        await TaskAssignee.findOrCreate({
          where: { taskId: task.id, userId: updates.assignedTo, role: 'assignee' },
          defaults: { assignedAt: new Date(), assignerId: req.user.id },
        });
      } catch (e) { /* task_assignees table may not exist yet */ }
      await boardMembershipService.autoAddMember(task.boardId, updates.assignedTo);
      if (removedSingleAssignees.length > 0) {
        try { await boardMembershipService.cleanupMultiple(removedSingleAssignees, task.boardId); }
        catch (err) { logger.warn('[Task] Board membership cleanup failed:', err.message); }
      }
    } else if (updates.assignedTo === null) {
      try {
        await TaskAssignee.destroy({ where: { taskId: task.id, role: 'assignee' } });
      } catch (e) { /* task_assignees table may not exist yet */ }
      if (oldAssigneeIds.length > 0) {
        try { await boardMembershipService.cleanupMultiple(oldAssigneeIds, task.boardId); }
        catch (err) { logger.warn('[Task] Board membership cleanup failed:', err.message); }
      }
      if (previousAssignee && !oldAssigneeIds.includes(previousAssignee)) {
        try { await boardMembershipService.cleanupIfNoTasksRemain(previousAssignee, task.boardId); }
        catch (err) { logger.warn('[Task] Board membership cleanup failed:', err.message); }
      }
    }

    if (canManageMembers) {
      // Handle assignedTo as array → sync assignee rows in task_assignees
      if (Array.isArray(req.body.assignedTo)) {
        const newAssigneeIds = req.body.assignedTo;
        // Capture removed assignees BEFORE destroying rows (for board membership cleanup)
        const removedAssigneeIds = oldAssigneeIds.filter(uid => !newAssigneeIds.includes(uid));
        // Remove assignees not in the new list
        await TaskAssignee.destroy({ where: { taskId: task.id, role: 'assignee', userId: { [Op.notIn]: newAssigneeIds } } });
        // Upsert new assignees. Only stamp assignerId on brand-new rows so we
        // don't overwrite history when an existing assignee is re-listed.
        for (const uid of newAssigneeIds) {
          await TaskAssignee.findOrCreate({
            where: { taskId: task.id, userId: uid, role: 'assignee' },
            defaults: { assignedAt: new Date(), assignerId: req.user.id },
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
      }
      // Single-string assignedTo and null are handled above (always-on path).

      // Handle supervisors array → sync supervisor rows in task_assignees
      if (Array.isArray(req.body.supervisors)) {
        const newSupervisorIds = req.body.supervisors;
        const removedSupervisorIds = oldSupervisorIds.filter(uid => !newSupervisorIds.includes(uid));
        await TaskAssignee.destroy({ where: { taskId: task.id, role: 'supervisor', userId: { [Op.notIn]: newSupervisorIds } } });
        for (const uid of newSupervisorIds) {
          await TaskAssignee.findOrCreate({
            where: { taskId: task.id, userId: uid, role: 'supervisor' },
            defaults: { assignedAt: new Date(), assignerId: req.user.id },
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
              defaults: { assignedAt: new Date(), assignerId: req.user.id },
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

    // Phase 10 — audit the admin override path. When an elevated user
    // forces a 'done' transition past active blocking dependencies, log a
    // dedicated row so the timeline shows it was an override, not a clean
    // completion. Separate from the standard task_updated rows so it's
    // searchable.
    if (_depAdminOverride) {
      logActivity({
        action: 'task_done_override',
        description: `${req.user.name} marked "${task.title}" done while ${_depBlockingCount} active dependenc${_depBlockingCount === 1 ? 'y was' : 'ies were'} still open`,
        entityType: 'task',
        entityId: task.id,
        taskId: task.id,
        boardId: task.boardId,
        userId: req.user.id,
        meta: { adminOverride: true, blockingDepCount: _depBlockingCount },
      });
    }

    // Phase 10 — when a task is archived, cascade-cancel its active
    // dependency requests so the assignees stop seeing rows for work that
    // can never complete (the parent is archived). DependencyRequest rows
    // are NOT deleted — they get status='cancelled' + cancellationReason
    // so the audit trail survives.
    if (updates.isArchived === true && previousIsArchived !== true) {
      try {
        const orphanedReqs = await DependencyRequest.findAll({
          where: {
            parentTaskId: task.id,
            status: { [Op.in]: ['pending', 'accepted', 'working_on_it', 'rejected'] },
            archivedAt: null,
          },
        });
        for (const dep of orphanedReqs) {
          dep.status = 'cancelled';
          dep.cancelledAt = new Date();
          dep.cancellationReason = `Parent task "${task.title}" was archived by ${req.user.name}.`;
          await dep.save();
          await depService.dispatchDependencyEvent('cancelled', dep, req.user);
          logActivity({
            action: 'dependency_request_cancelled',
            description: `Auto-cancelled dependency "${dep.title}" (parent task archived)`,
            entityType: 'dependency_request',
            entityId: dep.id,
            taskId: task.id,
            boardId: task.boardId,
            userId: req.user.id,
            meta: { reason: 'parent_archived', adminOverride: false },
          });
        }
      } catch (cascadeErr) {
        // Non-fatal — never block a task archive on dep cleanup. The
        // dependencies remain dangling but the parent is archived; a
        // re-archive or admin sweep will catch them later.
        logger.warn('[Task] Dependency-request cascade cancel failed:', cascadeErr.message);
      }
    }

    // Process automations
    if (updates.status && updates.status !== previousStatus) {
      processAutomations('status_changed', { task: fullTask, previousStatus, newStatus: updates.status, userId: req.user.id });
    }
    if (updates.assignedTo && updates.assignedTo !== previousAssignee) {
      processAutomations('task_assigned', { task: fullTask, userId: req.user.id });
    }

    // Realtime — fans out to board + assignees / supervisors / owners /
    // watchers, plus the previous assignee (so their MyWork drops the row)
    // when the task was reassigned.
    realtime.emitTaskUpdated(fullTask, {
      actorId: req.user.id,
      changedFields: Object.keys(changes || {}),
      extraUserIds: previousAssignee && previousAssignee !== fullTask.assignedTo ? [previousAssignee] : [],
    });

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

    const updatedTaskJSON = fullTask ? fullTask.toJSON() : null;
    if (updatedTaskJSON) {
      updatedTaskJSON._receipt = receiptService.buildSummary(updatedTaskJSON, req.user.id);
    }

    res.json({
      success: true,
      message: 'Task updated successfully.',
      data: { task: updatedTaskJSON || fullTask },
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
      // Phase 5d — destructive-action gate. T2 cannot archive even own tasks.
      // T1 always passes. T3/T4 + own → allowed. Wired here so the legacy
      // member-archive branch is captured even for users that bypass the
      // route-level matrix (e.g. via PermissionGrant elevation).
      const { assertCanDelete } = require('../services/tierEnforcement');
      const { sendIfTierError } = require('../utils/tierResponseHelpers');
      if (sendIfTierError(res, () => assertCanDelete(req.user, 'task', { isOwnResource: true }))) return;
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
      // Archive fires task:updated so the row disappears from any list
      // viewing un-archived tasks (board, MyWork, dashboard). Fan-out
      // includes assignees / watchers so it disappears from THEIR lists too.
      realtime.emitTaskUpdated(
        { ...task.toJSON(), isArchived: true },
        { actorId: req.user.id, changedFields: ['isArchived'] }
      );
      return res.json({ success: true, message: 'Task archived successfully. Only managers can permanently delete tasks.' });
    }

    // Phase 5d — destructive-action gate (privileged delete path).
    // T1 always passes. T2 always blocked (decision #4 strict). T3 reaching
    // this code (legacy asst-manager pre-migration) is also blocked because
    // we pass isOwnResource: false — this is the permanent-delete path,
    // not own-archive.
    const { assertCanDelete } = require('../services/tierEnforcement');
    const { sendIfTierError } = require('../utils/tierResponseHelpers');
    if (sendIfTierError(res, () => assertCanDelete(req.user, 'task', { isOwnResource: false }))) return;

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

    // Realtime fan-out for deletion. We MUST pass affectedUserIds explicitly
    // here because the task row is already destroyed — realtimeService can no
    // longer derive assignees from it. We captured them above (allAffected).
    realtime.emitTaskDeleted(
      { taskId, boardId, affectedUserIds: allAffected },
      { actorId: req.user.id }
    );

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

    // Move is intra-board (groupId / position change). Frontend has no
    // 'task:moved' handler — it relied on a generic refetch. Emit
    // 'task:updated' instead so BoardPage's existing patcher repositions
    // the row in the new group without a full refetch.
    realtime.emitTaskUpdated(fullTask, {
      actorId: req.user.id,
      changedFields: ['groupId', 'position'],
    });

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
    let { taskIds } = req.body;
    const { updates } = req.body;

    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return res.status(400).json({ success: false, message: 'taskIds array is required.' });
    }

    const allowedFields = [
      'status', 'priority', 'groupId', 'assignedTo',
      'dueDate', 'isArchived', 'progress',
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

    // Archive-as-soft-delete gate for bulk. Archive is now a SEPARATE action
    // from permanent delete: Tier 1 + Tier 2 (Admin/Manager) may bulk archive,
    // Tier 3/4 still require the matrix `tasks.delete` (default false). The
    // `assertCanDelete` gate previously wired here for the archive direction
    // is removed because it would block Tier 2 — and Tier 2 is now allowed
    // to archive. Permanent deletion is still gated by `assertCanDelete` in
    // `deleteTask`, so Tier 2 still cannot truly delete.
    if (safeUpdates.isArchived !== undefined) {
      const { hasTierAtLeast: hasTierAtLeastFn, TIER_2 } = require('../config/tiers');
      const canArchive = hasTierAtLeastFn(req.user, TIER_2)
        || (await enginePermission(req.user, 'tasks', 'delete'));
      if (!canArchive) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to archive or restore tasks.',
        });
      }
    }

    // Phase 7 — Tier 3/4 IDOR gate on bulk taskIds. Filter the supplied
    // task-ID list down to ids the actor can actually see, so a Tier 3/4
    // user with `tasks.edit` cannot mutate stranger tasks via a single
    // bulk request. Tier 1/2 bypass this filter (broad org access).
    {
      const { resolveTier, hasTierAtLeast, TIER_2 } = require('../config/tiers');
      if (!hasTierAtLeast(req.user, TIER_2)) {
        const taskVisibility = require('../services/taskVisibilityService');
        let visibleIds = taskIds;
        try {
          const where = await taskVisibility.buildTaskVisibilityWhere(req.user);
          const visibleTasks = await Task.findAll({
            where: { id: { [Op.in]: taskIds }, ...(where || {}) },
            attributes: ['id'],
            raw: true,
          });
          visibleIds = visibleTasks.map(t => t.id);
        } catch (err) {
          // Visibility helper failed — fail closed for non-management tiers.
          console.error('[Tasks.bulk] visibility filter error:', err.message);
          return res.status(403).json({ success: false, message: 'Visibility check failed.' });
        }
        if (visibleIds.length === 0) {
          return res.status(403).json({
            success: false,
            message: 'You do not have access to any of the requested tasks.',
            code: 'TIER_SCOPE_DENIED',
          });
        }
        if (visibleIds.length !== taskIds.length) {
          // Drop the strangers silently — caller still gets a 200 for the
          // visible subset. Mutating the local taskIds means every later
          // query (assignment auth, completion targets, calendar sync,
          // Task.update) runs against the trimmed set.
          taskIds = visibleIds;
        }
      }
    }

    // Bulk assignment authority. If the bulk update changes assignees and the
    // target is anyone other than the requester, the requester must hold
    // tasks.assign_others (and pass the hierarchy check for managers/asst-mgrs).
    if (safeUpdates.assignedTo !== undefined && safeUpdates.assignedTo !== null) {
      const targets = Array.isArray(safeUpdates.assignedTo)
        ? safeUpdates.assignedTo
        : [safeUpdates.assignedTo];
      const auth = await checkAssignmentAuthority(req.user, targets);
      if (!auth.allowed) {
        return res.status(auth.status).json({ success: false, message: auth.message });
      }
    }

    // Bulk priority gate — same rule as the single PUT. We check before
    // mutating so a denied user can't slip a priority change in alongside an
    // otherwise-allowed bulk update (e.g. status change). The self-owned
    // exemption (Tier 4 owner-creator may set priority on their own task)
    // applies per-row: every selected task in the bulk must be self-owned
    // for the bulk to proceed without `tasks.set_priority`. A single
    // foreign task in the selection collapses the entire bulk back to the
    // 403 path so the actor cannot piggy-back priority changes on stranger
    // rows alongside their own.
    if (safeUpdates.priority !== undefined) {
      let canSetPriority = await enginePermission(req.user, 'tasks', 'set_priority');
      if (!canSetPriority) {
        const ownershipRows = await Task.findAll({
          where: { id: { [Op.in]: taskIds } },
          attributes: ['id', 'createdBy', 'assignedTo'],
          include: [{ model: TaskAssignee, as: 'taskAssignees', attributes: ['userId', 'role'] }],
        });
        const allSelfOwned = ownershipRows.length === taskIds.length
          && ownershipRows.every((t) => isSelfOwnedTask(req.user.id, t, t.taskAssignees || []));
        canSetPriority = allSelfOwned;
      }
      if (!canSetPriority) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to change task priority.',
        });
      }
    }

    // Completion → progress 100 (mirrors single-update invariant).
    if (safeUpdates.status === 'done') {
      safeUpdates.progress = 100;
      // Bulk path can't cheaply read each row's prior completedAt to preserve
      // it on a no-op done-to-done. Acceptable trade-off: bulk-marking a
      // batch as done resets completedAt to "now" for all of them. UI doesn't
      // expose a bulk done-to-done re-stamp, so this is harmless in practice.
      safeUpdates.completedAt = new Date();
    } else if (safeUpdates.status !== undefined) {
      // Bulk-setting to any non-done status clears completedAt so previously-
      // done rows in the batch don't keep a stale completion timestamp.
      safeUpdates.completedAt = null;
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

    // Bulk approval gate. Mirrors the single-update guard — non-super-admin
    // users cannot bulk-set status='done' or progress=100 unless every row
    // already has approvalStatus='approved'. Otherwise the bulk path
    // becomes a fast-track for the same self-completion bypass.
    const wantsBulkComplete = safeUpdates.status === 'done' || safeUpdates.progress === 100;
    if (wantsBulkComplete && !req.user?.isSuperAdmin) {
      const completionTargets = await Task.findAll({
        where: { id: { [Op.in]: taskIds } },
        attributes: ['id', 'status', 'progress', 'approvalStatus'],
        raw: true,
      });
      const blocked = completionTargets.filter((t) => {
        const gate = approvalGateForCompletion(t, req.user, safeUpdates);
        return gate.blocked;
      });
      if (blocked.length > 0) {
        return res.status(403).json({
          success: false,
          message: blocked.length === completionTargets.length
            ? 'These tasks require manager approval before they can be marked Done.'
            : `${blocked.length} of ${completionTargets.length} task(s) require manager approval before they can be marked Done.`,
          code: 'approval_required',
          meta: { blockedCount: blocked.length, totalCount: completionTargets.length },
        });
      }
    }

    // Due-date gate for bulk assignment. Updated rule applies to self-claim
    // too — bulk-assigning a backlog of undated tasks to yourself is the same
    // bypass we just plugged on the single-task path. The gate is satisfied
    // for any task whose existing OR newly-supplied due date is non-null.
    if (safeUpdates.assignedTo) {
      const tasksMissingDue = await Task.findAll({
        where: { id: { [Op.in]: taskIds } },
        attributes: ['id', 'title', 'dueDate'],
      });
      const blocking = safeUpdates.dueDate
        ? []
        : tasksMissingDue.filter(t => !t.dueDate);
      if (blocking.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Please set a due date before assigning. ${blocking.length} task(s) in the selection have no due date.`,
        });
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

    // CP-3 RBAC: do NOT emit the bulk task array to the entire board room —
    // that was leaking unauthorized rows to subtree-scoped subscribers.
    // Instead, emit a payload-free "tasks:bulkUpdated" hint to each task's
    // authorized recipients, and rely on per-task realtime.emitTaskUpdated
    // (which is already authorized) to push the row-level data. The
    // hint lets BoardPage coalesce a single refetch via /api/tasks (which
    // applies the visibility filter) instead of thrashing on N events.
    const boardRecipientMap = new Map(); // boardId → Set of authorized userIds
    for (const t of updatedTasks) {
      const userIds = await taskVisibility.getAuthorizedRealtimeRecipients(t);
      const set = boardRecipientMap.get(t.boardId) || new Set();
      for (const uid of userIds) set.add(uid);
      boardRecipientMap.set(t.boardId, set);
    }
    for (const [boardId, recipients] of boardRecipientMap.entries()) {
      socketService.emitToUsers('tasks:bulkUpdated', { boardId }, Array.from(recipients));
    }
    // Per-task updates so MyWork / HomePage / Dashboard listeners refresh.
    // realtime.emitTaskUpdated now uses CP-3 visibility recipients only.
    for (const t of updatedTasks) {
      realtime.emitTaskUpdated(t, {
        actorId: req.user.id,
        changedFields: Object.keys(safeUpdates || {}),
      });
    }

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

    // CP-3 RBAC: don't broadcast reorder items to the whole board room — that
    // exposes task IDs of unauthorized rows. Compute the union of authorized
    // recipients across the affected tasks and emit only to them. Frontend
    // refetches via /api/tasks (visibility-filtered), so it's enough to nudge.
    const recipientUnion = new Set();
    for (const item of items) {
      if (!item?.id) continue;
      const userIds = await taskVisibility.getAuthorizedRealtimeRecipients(item.id);
      for (const uid of userIds) recipientUnion.add(uid);
    }
    socketService.emitToUsers('tasks:reordered', { boardId }, Array.from(recipientUnion));

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

    realtime.emitTaskCreated(fullTask, { actorId: req.user.id });

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
      realtime.emitTaskUpdated(fullTask, {
        actorId: req.user.id,
        changedFields: ['dueDate', 'plannedStartTime', 'plannedEndTime'],
      });

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

    // Centralized assignment authority (engine + hierarchy).
    const allTargetIds = [
      ...(Array.isArray(assignees) ? assignees : []),
      ...(Array.isArray(supervisors) ? supervisors : []),
    ].filter(Boolean);
    if (allTargetIds.length > 0) {
      const auth = await checkAssignmentAuthority(req.user, allTargetIds);
      if (!auth.allowed) {
        return res.status(auth.status).json({ success: false, message: auth.message });
      }
    }

    // Due-date gate: refuse to register any assignee/supervisor (including
    // self) on a task that has no due date. Pure removals (empty arrays) are
    // still allowed without a deadline.
    const nextAssignees = Array.isArray(assignees) ? assignees.filter(Boolean) : [];
    const nextSupervisors = Array.isArray(supervisors) ? supervisors.filter(Boolean) : [];
    if (needsDueDateForAssignment(req.user.id, nextAssignees, nextSupervisors, task.dueDate)) {
      return res.status(400).json({
        success: false,
        message: dueDateRequiredMessage(req.user.id, nextAssignees, nextSupervisors),
      });
    }

    // Hoisted to function scope so the realtime emit at the end can include
    // users who were REMOVED from the task — the hydrated fullTask only
    // tells us who's CURRENTLY on it, but we want a removed assignee to
    // see the row drop out of their MyWork too.
    let removedAssigneeIds = [];
    let removedSupervisorIds = [];
    let newAssigneeIds = [];
    let newSupervisorIds = [];

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
          defaults: { assignedAt: new Date(), assignerId: req.user.id },
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
      newAssigneeIds = assignees.filter(uid => !existingAssigneeIds.includes(uid) && uid !== req.user.id);
      removedAssigneeIds = existingAssigneeIds.filter(uid => !assignees.includes(uid));

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
          defaults: { assignedAt: new Date(), assignerId: req.user.id },
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
      newSupervisorIds = supervisors.filter(uid => !existingSupervisorIds.includes(uid) && uid !== req.user.id);
      removedSupervisorIds = existingSupervisorIds.filter(uid => !supervisors.includes(uid));

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

    // Membership changes affect added + removed users on top of the usual
    // fan-out — so a user who was just removed gets the row out of MyWork,
    // and a user who was just added sees it appear there.
    realtime.emitTaskUpdated(fullTask, {
      actorId: req.user.id,
      changedFields: ['assignees', 'supervisors'],
      extraUserIds: [
        ...(Array.isArray(removedAssigneeIds) ? removedAssigneeIds : []),
        ...(Array.isArray(removedSupervisorIds) ? removedSupervisorIds : []),
        ...(Array.isArray(newAssigneeIds) ? newAssigneeIds : []),
        ...(Array.isArray(newSupervisorIds) ? newSupervisorIds : []),
      ],
    });

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
