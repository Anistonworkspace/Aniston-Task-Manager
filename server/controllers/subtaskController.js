const { validationResult } = require('express-validator');
const { Subtask, Task, User } = require('../models');
const { logActivity } = require('../services/activityService');
const realtime = require('../services/realtimeService');
const { canAssignTo } = require('../services/hierarchyService');
const taskVisibility = require('../services/taskVisibilityService');
const { sanitizeInput } = require('../utils/sanitize');

// ── helpers ────────────────────────────────────────────────────────────────

const SUBTASK_STATUS_VALUES = ['not_started', 'working_on_it', 'stuck', 'done'];
const SUBTASK_PRIORITY_VALUES = ['low', 'medium', 'high', 'critical'];

const SUBTASK_INCLUDES = () => ([
  { model: User, as: 'creator', attributes: ['id', 'name', 'avatar'] },
  { model: User, as: 'assignee', attributes: ['id', 'name', 'avatar'] },
]);

/**
 * A user can view/access a parent task's subtasks if they could view the
 * parent task itself. Delegates to the centralized
 * `taskVisibilityService.canViewTask` so the subtask access rule is
 * IDENTICAL to the rule used by the board list query, the task detail
 * middleware, and comment/approval controllers — one source of truth.
 *
 * Why this matters: the previous inline check only matched direct linkage
 * (assignedTo / createdBy / TaskAssignee / TaskOwner) and ignored the
 * hierarchy subtree. A Tier 3 manager could see a descendant's task in the
 * board listing (visibility filter is hierarchy-aware) but the modal's
 * /subtasks load returned 403, surfacing the "You do not have access to
 * this task" toast despite legitimate visibility.
 *
 * Tier semantics are entirely encapsulated by `canViewTask`:
 *   - Tier 1 / Tier 2 (admin, super_admin) → unrestricted
 *   - Tier 3 / Tier 4 → self ∪ descendants subtree match against
 *     assignedTo / createdBy / task_assignees / task_owners
 *
 * The dependency-owner read path is preserved separately so that a user
 * assigned to a DependencyRequest on this parent still gets read access
 * to the parent's subtasks even when the canonical visibility check
 * returns false. Mutation gates (canMemberMutateSubtask) still enforce
 * the stricter write rules below.
 */
async function userCanAccessParentTask(user, task) {
  if (!user || !task) return false;

  if (await taskVisibility.canViewTask(user, task)) return true;

  try {
    const { DependencyRequest } = require('../models');
    const depCount = await DependencyRequest.count({
      where: { parentTaskId: task.id, assignedToUserId: user.id },
    });
    if (depCount > 0) return true;
  } catch { /* dependency_requests table may not exist on very old DBs */ }

  return false;
}

/**
 * Members can act on a subtask only when they own the parent task or are
 * already assigned to the subtask itself. Managers/admins/asst-mgrs always
 * can; this short-circuits before the field-level check.
 */
function canMemberMutateSubtask(user, task, subtask) {
  // Phase 7 — Tier-aware mutation gate. Tier 1/2 always pass; Tier 3 used
  // to also short-circuit `true` (audit P0-5) and could mutate subtasks on
  // unrelated tasks. Tier 3 now must be linked to the parent or the
  // subtask itself, just like Tier 4.
  const { resolveTier, TIER_1, TIER_2 } = require('../config/tiers');
  const t = resolveTier(user);
  if (t === TIER_1 || t === TIER_2) return true;
  if (!task) return false;
  if (task.assignedTo === user.id || task.createdBy === user.id) return true;
  if (subtask && subtask.assignedTo === user.id) return true;
  if (subtask && subtask.createdBy === user.id) return true;
  return false;
}

function pickAllowedFields(role, body, isSuperAdmin = false) {
  // Members get a narrow whitelist — they can move their own subtask through
  // the workflow (status, progress) and edit its title/description, but they
  // cannot reassign it or change priority/due date (matches the parent-task
  // member rules in taskPermissions.checkTaskAction).
  // Managers / admins / assistant managers / super admin get the full set.
  const isPrivileged = isSuperAdmin || ['admin', 'manager', 'assistant_manager'].includes(role);
  const FIELDS = isPrivileged
    ? ['title', 'description', 'status', 'priority', 'progress', 'assignedTo', 'dueDate', 'position']
    : ['title', 'description', 'status', 'progress'];

  const updates = {};
  for (const f of FIELDS) {
    if (body[f] === undefined) continue;
    if (f === 'title') {
      const t = sanitizeInput(String(body[f] || '')).trim();
      if (t.length === 0 || t.length > 300) continue;
      updates.title = t;
    } else if (f === 'description') {
      updates.description = body[f] === null ? null : sanitizeInput(String(body[f] || ''));
    } else if (f === 'status') {
      if (SUBTASK_STATUS_VALUES.includes(body[f])) updates.status = body[f];
    } else if (f === 'priority') {
      if (body[f] === null || SUBTASK_PRIORITY_VALUES.includes(body[f])) updates.priority = body[f];
    } else if (f === 'progress') {
      const n = Number(body[f]);
      if (Number.isFinite(n)) updates.progress = Math.max(0, Math.min(100, Math.round(n)));
    } else if (f === 'assignedTo') {
      updates.assignedTo = body[f] === '' ? null : body[f];
    } else if (f === 'dueDate') {
      updates.dueDate = body[f] || null;
    } else if (f === 'position') {
      const n = parseInt(body[f], 10);
      if (Number.isFinite(n)) updates.position = n;
    }
  }
  return updates;
}

// ── handlers ───────────────────────────────────────────────────────────────

// POST /api/subtasks
const createSubtask = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { taskId } = req.body;
    const title = sanitizeInput(String(req.body.title || '')).trim();
    if (!title) {
      return res.status(400).json({ success: false, message: 'Title is required.' });
    }

    const task = await Task.findByPk(taskId);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Parent task not found.' });
    }
    if (task.isArchived) {
      return res.status(400).json({ success: false, message: 'Cannot add subtasks to an archived task.' });
    }

    const canAccess = await userCanAccessParentTask(req.user, task);
    if (!canAccess) {
      return res.status(403).json({ success: false, message: 'You do not have access to this task.' });
    }
    if (!canMemberMutateSubtask(req.user, task, null)) {
      return res.status(403).json({ success: false, message: 'You can only add subtasks to tasks assigned to you.' });
    }

    // Resolve assignee:
    //   - Members without `tasks.assign_others`: silently force to self.
    //   - Anyone else: validate against hierarchyService.canAssignTo.
    let assignedTo = req.body.assignedTo === '' ? null : (req.body.assignedTo || null);
    if (assignedTo) {
      const allowed = await canAssignTo(req.user, assignedTo);
      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: 'You cannot assign this subtask to that user.',
        });
      }
      // Ensure the assignee actually exists and is active.
      const assignee = await User.findOne({ where: { id: assignedTo, isActive: true } });
      if (!assignee) {
        return res.status(400).json({ success: false, message: 'Assignee not found or inactive.' });
      }
    }

    const priority = SUBTASK_PRIORITY_VALUES.includes(req.body.priority) ? req.body.priority : null;
    const description = req.body.description ? sanitizeInput(String(req.body.description)) : null;

    let dueDate = null;
    if (req.body.dueDate) {
      const d = new Date(req.body.dueDate);
      if (!isNaN(d.getTime())) dueDate = d;
    }

    const maxPos = await Subtask.max('position', { where: { taskId } });
    const position = (Number.isFinite(maxPos) ? maxPos : 0) + 1;

    const subtask = await Subtask.create({
      title,
      description,
      taskId,
      assignedTo,
      priority,
      progress: 0,
      dueDate,
      createdBy: req.user.id,
      position,
    });

    const fullSubtask = await Subtask.findByPk(subtask.id, { include: SUBTASK_INCLUDES() });

    logActivity({
      action: 'subtask_added',
      description: `${req.user.name} added subtask "${title}"`,
      entityType: 'subtask',
      entityId: subtask.id,
      taskId,
      boardId: task.boardId,
      userId: req.user.id,
    });

    // Fan out to board + parent task's affected users (assignees,
    // supervisors, watchers, owners) so subtask changes also reach users
    // who don't have the board open.
    realtime.emitSubtaskChanged('created', taskId, { subtask: fullSubtask, taskId }, { actorId: req.user.id });
    res.status(201).json({ success: true, data: { subtask: fullSubtask } });
  } catch (error) {
    console.error('Create subtask error:', error);
    res.status(500).json({ success: false, message: 'Server error creating subtask.' });
  }
};

// GET /api/subtasks?taskId=xxx
const getSubtasks = async (req, res) => {
  try {
    const { taskId } = req.query;
    if (!taskId) {
      return res.status(400).json({ success: false, message: 'taskId query parameter is required.' });
    }

    const task = await Task.findByPk(taskId);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Parent task not found.' });
    }

    const canAccess = await userCanAccessParentTask(req.user, task);
    if (!canAccess) {
      return res.status(403).json({ success: false, message: 'You do not have access to this task.' });
    }

    const subtasks = await Subtask.findAll({
      where: { taskId },
      include: SUBTASK_INCLUDES(),
      order: [['position', 'ASC'], ['createdAt', 'ASC']],
    });

    res.json({ success: true, data: { subtasks } });
  } catch (error) {
    console.error('Get subtasks error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching subtasks.' });
  }
};

// PUT /api/subtasks/:id
const updateSubtask = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const subtask = await Subtask.findByPk(req.params.id, {
      include: [{ model: Task, as: 'task' }],
    });
    if (!subtask) {
      return res.status(404).json({ success: false, message: 'Subtask not found.' });
    }
    const task = subtask.task;
    if (!task) {
      return res.status(404).json({ success: false, message: 'Parent task missing.' });
    }

    const canAccess = await userCanAccessParentTask(req.user, task);
    if (!canAccess) {
      return res.status(403).json({ success: false, message: 'You do not have access to this task.' });
    }
    if (!canMemberMutateSubtask(req.user, task, subtask)) {
      return res.status(403).json({ success: false, message: 'You cannot modify this subtask.' });
    }

    const updates = pickAllowedFields(req.user.role, req.body, !!req.user.isSuperAdmin);

    // Reassignment must respect canAssignTo (mirrors how main task assignment
    // is enforced in taskController). `null` is allowed (clear assignee).
    if ('assignedTo' in updates && updates.assignedTo) {
      const allowed = await canAssignTo(req.user, updates.assignedTo);
      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: 'You cannot reassign this subtask to that user.',
        });
      }
      const assignee = await User.findOne({ where: { id: updates.assignedTo, isActive: true } });
      if (!assignee) {
        return res.status(400).json({ success: false, message: 'Assignee not found or inactive.' });
      }
    }

    // Auto-bump progress on status flip to done; keep at 0 on revert if user
    // didn't explicitly set it. Mirrors the main-task UX.
    if (updates.status === 'done' && updates.progress === undefined) {
      updates.progress = 100;
    }

    if (Object.keys(updates).length === 0) {
      // Nothing to do — return current state.
      const fresh = await Subtask.findByPk(subtask.id, { include: SUBTASK_INCLUDES() });
      return res.json({ success: true, data: { subtask: fresh } });
    }

    await subtask.update(updates);

    if (updates.status) {
      logActivity({
        action: 'subtask_status_changed',
        description: `${req.user.name} changed subtask "${subtask.title}" to "${updates.status}"`,
        entityType: 'subtask',
        entityId: subtask.id,
        taskId: subtask.taskId,
        boardId: task.boardId,
        userId: req.user.id,
        meta: { status: updates.status },
      });
    }

    const fullSubtask = await Subtask.findByPk(subtask.id, { include: SUBTASK_INCLUDES() });

    realtime.emitSubtaskChanged(
      'updated',
      subtask.taskId,
      { subtask: fullSubtask, taskId: subtask.taskId },
      { actorId: req.user.id }
    );
    res.json({ success: true, data: { subtask: fullSubtask } });
  } catch (error) {
    console.error('Update subtask error:', error);
    res.status(500).json({ success: false, message: 'Server error updating subtask.' });
  }
};

// DELETE /api/subtasks/:id
const deleteSubtask = async (req, res) => {
  try {
    const subtask = await Subtask.findByPk(req.params.id, {
      include: [{ model: Task, as: 'task' }],
    });
    if (!subtask) {
      return res.status(404).json({ success: false, message: 'Subtask not found.' });
    }
    const task = subtask.task;
    const canAccess = await userCanAccessParentTask(req.user, task);
    if (!canAccess) {
      return res.status(403).json({ success: false, message: 'You do not have access to this task.' });
    }

    // Members may only delete their own self-created subtask. Mgrs/admins
    // are gated at the route level via requireRole.
    const role = req.user.role;
    const isPrivileged = req.user.isSuperAdmin || ['admin', 'manager', 'assistant_manager'].includes(role);
    if (!isPrivileged && subtask.createdBy !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Only the creator can delete a subtask.' });
    }

    // Phase 5d — destructive-action gate. T2 cannot delete subtasks (even
    // own); T3/T4 may delete their own; T1 always.
    {
      const { assertCanDelete } = require('../services/tierEnforcement');
      const { sendIfTierError } = require('../utils/tierResponseHelpers');
      const isOwnResource = subtask.createdBy === req.user.id;
      if (sendIfTierError(res, () => assertCanDelete(req.user, 'subtask', { isOwnResource }))) return;
    }

    const subtaskId = subtask.id;
    const taskId = subtask.taskId;
    const boardId = task?.boardId;
    const title = subtask.title;

    await subtask.destroy();

    logActivity({
      action: 'subtask_deleted',
      description: `${req.user.name} deleted subtask "${title}"`,
      entityType: 'subtask',
      entityId: subtaskId,
      taskId,
      boardId,
      userId: req.user.id,
    });

    realtime.emitSubtaskChanged('deleted', taskId, { subtaskId, taskId }, { actorId: req.user.id });
    res.json({ success: true, message: 'Subtask deleted.' });
  } catch (error) {
    console.error('Delete subtask error:', error);
    res.status(500).json({ success: false, message: 'Server error deleting subtask.' });
  }
};

module.exports = { createSubtask, getSubtasks, updateSubtask, deleteSubtask };
