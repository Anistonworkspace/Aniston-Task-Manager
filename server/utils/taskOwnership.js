'use strict';

/**
 * Task-ownership helpers shared between controllers and tests.
 *
 * These predicates answer "is this task wholly owned by `userId`?" — used by
 * the priority gate to grant Tier 4 (member) actors permission to set priority
 * on tasks they created and self-assigned, while keeping the global
 * `tasks.set_priority` denial intact for tasks delegated to them by others.
 *
 * Design notes:
 *   - "Sole owner" = creator AND no foreign role='assignee' rows. Supervisors
 *     do NOT count as assignees, but a task with a foreign supervisor is still
 *     considered self-owned (supervisors are oversight, not ownership).
 *   - Returns false on missing data — fail-closed.
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

module.exports = {
  isSelfOwnedTask,
  isSelfOwnedCreate,
};
