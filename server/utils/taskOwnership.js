'use strict';

/**
 * Task-ownership helpers shared between controllers and tests.
 *
 * Two flavours of "ownership" exist:
 *
 *   1. SOLE-OWNER (`isSelfOwnedTask` / `isSelfOwnedCreate`) — the actor
 *      created the task AND no other user is on it as an assignee. Kept for
 *      legacy carve-outs that need the stricter shape.
 *
 *   2. ASSIGNEE (`isAssigneeOnTask`) — the actor is on the task as an
 *      assignee, regardless of who created it or whether co-assignees exist.
 *      Used by the priority gate so a Tier 4 actor can adjust priority on
 *      work that their manager delegated to them — priority is a planning
 *      concern owned by the person doing the work, and the prior strict
 *      "creator + sole assignee" rule generated daily "please change my
 *      priority" friction whenever a manager handed work down.
 *
 * Supervisors are oversight, not ownership — a task with a foreign
 * supervisor is still self-owned for `isSelfOwnedTask`, and a user who is
 * ONLY a supervisor on a task is NOT an assignee for `isAssigneeOnTask`.
 *
 * Returns false on missing data — fail-closed.
 */

/**
 * @param {string} userId
 * @param {object} task           Task row (or createTask payload shape).
 * @param {Array}  [taskAssignees] Optional explicit list (use this when the
 *                                 caller already loaded the join table; the
 *                                 helper otherwise reads task.taskAssignees).
 * @returns {boolean}
 */
function isSelfOwnedTask(userId, task, taskAssignees) {
  if (!userId || !task) return false;
  if (task.createdBy && task.createdBy !== userId) return false;
  if (!task.createdBy) return false; // unknown creator -> fail closed

  const assignedTo = task.assignedTo;
  if (typeof assignedTo === 'string' && assignedTo && assignedTo !== userId) {
    return false;
  }
  if (Array.isArray(assignedTo) && assignedTo.some((id) => id && id !== userId)) {
    return false;
  }

  const arr = Array.isArray(taskAssignees)
    ? taskAssignees
    : (Array.isArray(task.taskAssignees) ? task.taskAssignees : []);
  const foreignAssignee = arr.find((ta) => {
    if (!ta) return false;
    const uid = ta.userId || (ta.user && ta.user.id);
    if (!uid || uid === userId) return false;
    // Only role='assignee' disqualifies. Supervisors are oversight, not ownership.
    return ta.role === 'assignee';
  });
  if (foreignAssignee) return false;

  return true;
}

/**
 * Variant for createTask: the task does not exist yet, so the caller passes
 * the prepared assignee-id array directly. The actor is always the creator
 * at create time, so we only need to verify the assignee set is empty or
 * exclusively self.
 *
 * @param {string} userId
 * @param {string[]} assigneeIds
 * @returns {boolean}
 */
function isSelfOwnedCreate(userId, assigneeIds) {
  if (!userId) return false;
  if (!Array.isArray(assigneeIds) || assigneeIds.length === 0) return true;
  return assigneeIds.every((id) => !id || id === userId);
}

/**
 * Returns true when `userId` is an assignee on the task — via either the
 * scalar `task.assignedTo` column, the legacy `assignedTo` array carrier,
 * or the `task_assignees` join row with role='assignee'. Co-assignees and
 * a foreign creator are both fine; this answers "is the actor on the hook
 * for delivering this task?", not "is the actor the sole owner?".
 *
 * Used by the priority gate (createTask / updateTask / bulkUpdateTasks) so
 * a Tier 4 actor who was handed work by a manager can still raise/lower
 * priority on that work. Supervisors and watchers are NOT assignees and
 * therefore do not get the exemption here.
 *
 * @param {string} userId
 * @param {object} task            Task row or createTask payload shape.
 * @param {Array}  [taskAssignees] Optional explicit list — prefer this when
 *                                 the caller already loaded the join table.
 * @returns {boolean}
 */
function isAssigneeOnTask(userId, task, taskAssignees) {
  if (!userId || !task) return false;

  const assignedTo = task.assignedTo;
  if (typeof assignedTo === 'string' && assignedTo === userId) return true;
  if (Array.isArray(assignedTo) && assignedTo.some((id) => id === userId)) return true;

  const arr = Array.isArray(taskAssignees)
    ? taskAssignees
    : (Array.isArray(task.taskAssignees) ? task.taskAssignees : []);
  return arr.some((ta) => {
    if (!ta) return false;
    const uid = ta.userId || (ta.user && ta.user.id);
    return uid === userId && ta.role === 'assignee';
  });
}

module.exports = {
  isSelfOwnedTask,
  isSelfOwnedCreate,
  isAssigneeOnTask,
};
