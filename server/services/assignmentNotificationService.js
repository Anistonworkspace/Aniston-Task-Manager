/**
 * Assignment Notification Service
 *
 * Handles notifications for task assignment changes:
 *   - New assignments (assignee or supervisor)
 *   - Removals from tasks
 *   - Role changes (assignee ↔ supervisor)
 *
 * Uses the unified notificationService for delivery (in-app + email).
 */

const { Task, Board, User } = require('../models');
const { sendNotification } = require('./notificationService');
const logger = require('../utils/logger');

/**
 * Fetch task context needed for notification messages.
 * Returns { title, boardName, dueDate } or null if task not found.
 */
async function getTaskContext(taskId) {
  const task = await Task.findByPk(taskId, {
    include: [{ model: Board, as: 'board', attributes: ['id', 'name'] }],
    attributes: ['id', 'title', 'dueDate'],
  });
  if (!task) return null;
  return {
    title: task.title,
    boardName: task.board ? task.board.name : 'Unknown Board',
    dueDate: task.dueDate,
  };
}

/**
 * Format a deadline for display in notification messages.
 */
function formatDeadline(dueDate) {
  if (!dueDate) return 'No deadline set';
  const d = new Date(dueDate);
  return d.toLocaleString('en-US', {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Look up a user's name by ID. Returns 'Someone' as fallback.
 */
async function getUserName(userId) {
  if (!userId) return 'Someone';
  const user = await User.findByPk(userId, { attributes: ['id', 'name', 'email'] });
  return user ? user.name : 'Someone';
}

/**
 * Look up a user's email by ID. Returns null if not found.
 */
async function getUserEmail(userId) {
  if (!userId) return null;
  const user = await User.findByPk(userId, { attributes: ['id', 'email'] });
  return user ? user.email : null;
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Send assignment notifications to newly added users.
 *
 * @param {string}   taskId           - Task UUID
 * @param {string[]} userIds          - Array of user UUIDs to notify
 * @param {string}   role             - 'assignee' or 'supervisor'
 * @param {string}   assignedByUserId - Who made the assignment
 */
async function notifyNewAssignments(taskId, userIds, role, assignedByUserId) {
  if (!userIds || userIds.length === 0) return;

  try {
    const ctx = await getTaskContext(taskId);
    if (!ctx) return;

    const assignerName = await getUserName(assignedByUserId);
    const deadline = formatDeadline(ctx.dueDate);

    for (const uid of userIds) {
      const userEmail = await getUserEmail(uid);
      const userName = await getUserName(uid);

      if (role === 'supervisor') {
        const title = `You're supervising: ${ctx.title}`;
        const message = `Hi ${userName}, you have been added as a supervisor on the task "${ctx.title}" on board "${ctx.boardName}". Deadline: ${deadline}. Added by: ${assignerName}.`;
        await sendNotification(uid, title, message, 'task_supervisor_added', taskId, {
          email: userEmail,
          userName,
        });
      } else {
        const title = `New Task Assigned: ${ctx.title}`;
        const message = `Hi ${userName}, you have been assigned to the task "${ctx.title}" on board "${ctx.boardName}". Deadline: ${deadline}. Assigned by: ${assignerName}.`;
        await sendNotification(uid, title, message, 'task_assigned', taskId, {
          email: userEmail,
          userName,
        });
      }
    }
  } catch (err) {
    logger.error('[AssignmentNotification] notifyNewAssignments error:', err);
  }
}

/**
 * Send removal notifications to users who were removed from a task.
 *
 * @param {string}   taskId  - Task UUID
 * @param {string[]} userIds - Array of removed user UUIDs
 */
async function notifyRemovals(taskId, userIds) {
  if (!userIds || userIds.length === 0) return;

  try {
    const ctx = await getTaskContext(taskId);
    if (!ctx) return;

    for (const uid of userIds) {
      const userEmail = await getUserEmail(uid);
      const userName = await getUserName(uid);

      const title = `Removed from Task: ${ctx.title}`;
      const message = `Hi ${userName}, you have been removed from the task "${ctx.title}" on board "${ctx.boardName}". If you believe this is an error, please contact your manager.`;
      await sendNotification(uid, title, message, 'task_removed', taskId, {
        email: userEmail,
        userName,
      });
    }
  } catch (err) {
    logger.error('[AssignmentNotification] notifyRemovals error:', err);
  }
}

/**
 * Send a role-change notification to a user.
 *
 * @param {string} taskId  - Task UUID
 * @param {string} userId  - User UUID
 * @param {string} oldRole - Previous role ('assignee' or 'supervisor')
 * @param {string} newRole - New role ('assignee' or 'supervisor')
 */
async function notifyRoleChange(taskId, userId, oldRole, newRole) {
  if (!userId) return;

  try {
    const ctx = await getTaskContext(taskId);
    if (!ctx) return;

    const userEmail = await getUserEmail(userId);
    const userName = await getUserName(userId);

    const title = `Role Updated: ${ctx.title}`;
    const message = `Hi ${userName}, your role on the task "${ctx.title}" has been changed from ${oldRole} to ${newRole}. Board: ${ctx.boardName}.`;
    await sendNotification(userId, title, message, 'task_role_changed', taskId, {
      email: userEmail,
      userName,
    });
  } catch (err) {
    logger.error('[AssignmentNotification] notifyRoleChange error:', err);
  }
}

/**
 * Compare old vs new member lists and send the appropriate notifications.
 * This is the key function for member-update scenarios.
 *
 * @param {string}   taskId           - Task UUID
 * @param {string[]} oldAssignees     - Previous assignee user IDs
 * @param {string[]} newAssignees     - Updated assignee user IDs
 * @param {string[]} oldSupervisors   - Previous supervisor user IDs
 * @param {string[]} newSupervisors   - Updated supervisor user IDs
 * @param {string}   changedByUserId  - Who made the change
 */
async function diffAndNotify(taskId, oldAssignees, newAssignees, oldSupervisors, newSupervisors, changedByUserId) {
  try {
    const oldAssigneeSet = new Set(oldAssignees);
    const newAssigneeSet = new Set(newAssignees);
    const oldSupervisorSet = new Set(oldSupervisors);
    const newSupervisorSet = new Set(newSupervisors);

    // All old and new members combined
    const allOld = new Set([...oldAssignees, ...oldSupervisors]);
    const allNew = new Set([...newAssignees, ...newSupervisors]);

    // Categorize each user
    const addedAssignees = [];
    const addedSupervisors = [];
    const removed = [];
    const roleChangedToAssignee = [];
    const roleChangedToSupervisor = [];

    // Check every user in old lists — are they removed or role-changed?
    for (const uid of allOld) {
      if (!allNew.has(uid)) {
        // User was removed entirely
        removed.push(uid);
      } else if (oldAssigneeSet.has(uid) && !newAssigneeSet.has(uid) && newSupervisorSet.has(uid)) {
        // Was assignee, now supervisor
        roleChangedToSupervisor.push(uid);
      } else if (oldSupervisorSet.has(uid) && !newSupervisorSet.has(uid) && newAssigneeSet.has(uid)) {
        // Was supervisor, now assignee
        roleChangedToAssignee.push(uid);
      }
      // else: stayed in same role → do nothing
    }

    // Check every user in new lists — are they newly added?
    for (const uid of allNew) {
      if (!allOld.has(uid)) {
        // Newly added — exclude the person who made the change (they already know)
        if (uid === changedByUserId) continue;
        if (newAssigneeSet.has(uid)) {
          addedAssignees.push(uid);
        } else if (newSupervisorSet.has(uid)) {
          addedSupervisors.push(uid);
        }
      }
    }

    // Fire notifications (all fire-and-forget, but awaited for ordering)
    const promises = [];

    if (addedAssignees.length > 0) {
      promises.push(notifyNewAssignments(taskId, addedAssignees, 'assignee', changedByUserId));
    }
    if (addedSupervisors.length > 0) {
      promises.push(notifyNewAssignments(taskId, addedSupervisors, 'supervisor', changedByUserId));
    }
    if (removed.length > 0) {
      promises.push(notifyRemovals(taskId, removed));
    }
    for (const uid of roleChangedToAssignee) {
      promises.push(notifyRoleChange(taskId, uid, 'supervisor', 'assignee'));
    }
    for (const uid of roleChangedToSupervisor) {
      promises.push(notifyRoleChange(taskId, uid, 'assignee', 'supervisor'));
    }

    await Promise.all(promises);
  } catch (err) {
    logger.error('[AssignmentNotification] diffAndNotify error:', err);
  }
}

module.exports = {
  notifyNewAssignments,
  notifyRemovals,
  notifyRoleChange,
  diffAndNotify,
};