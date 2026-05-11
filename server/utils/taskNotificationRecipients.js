'use strict';

/**
 * Resolve the user set that should receive a task-level notification.
 *
 * Background — why this helper exists:
 *   Tasks support two parallel sources of "who works on this":
 *     1. `task.assignedTo`             (legacy single-assignee column)
 *     2. `task_assignees` junction     (current multi-assignee + supervisor)
 *   The deadline-reminder cron (reminderService.processReminders) already
 *   walks both and unions them. The hourly reminderJob (due-soon / overdue
 *   / 3-day) and the daily priorityEscalationJob historically only looked
 *   at `task.assignedTo`, so a task with two TaskAssignee rows only
 *   notified the legacy primary. This helper centralises the union so any
 *   future notification path inherits the correct fan-out without copy-paste.
 *
 * Returns: `Map<userId, { id, name, email }>` keyed by user id. A Map (not
 * an array) so callers can both iterate AND `.has(userId)` to skip duplicate
 * recipient lookups (e.g. the cron's per-recipient idempotency-key build).
 *
 * Failure mode: returns an empty Map on any DB error. Notifications are
 * best-effort — a broken assignee lookup must not abort the cron tick.
 */

let _models = null;
function models() {
  if (!_models) _models = require('../models');
  return _models;
}

/**
 * @param {object} task Task row (must have `id`; `assignedTo` optional).
 * @returns {Promise<Map<string, {id:string, name:string, email:?string}>>}
 */
async function getTaskNotificationRecipients(task) {
  const recipients = new Map();
  if (!task || !task.id) return recipients;

  const { TaskAssignee, User } = models();

  // 1. Multi-assignee + supervisor table. We include BOTH roles — for
  //    cron-driven reminders the audit confirmed supervisors expect
  //    visibility of overdue / priority-escalated events on their tasks.
  try {
    const rows = await TaskAssignee.findAll({
      where: { taskId: task.id },
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }],
    });
    for (const row of rows) {
      if (row.user && row.user.id) recipients.set(row.user.id, row.user);
    }
  } catch (err) {
    // Surface to logs only — don't abort. The legacy fallback below still
    // gives us the primary assignee.
    // eslint-disable-next-line no-console
    console.warn(`[taskNotificationRecipients] TaskAssignee lookup failed for task ${task.id}: ${err && err.message}`);
  }

  // 2. Legacy `assignedTo` column. Common for older rows that pre-date the
  //    junction table. Only pull the row if we don't already have it.
  if (task.assignedTo && !recipients.has(task.assignedTo)) {
    try {
      const legacy = await User.findByPk(task.assignedTo, {
        attributes: ['id', 'name', 'email'],
      });
      if (legacy) recipients.set(legacy.id, legacy);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[taskNotificationRecipients] legacy assignee lookup failed for task ${task.id}: ${err && err.message}`);
    }
  }

  return recipients;
}

module.exports = {
  getTaskNotificationRecipients,
};
