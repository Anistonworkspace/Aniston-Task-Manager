/**
 * Deadline Reminder Service
 *
 * Manages automated 2-day and 2-hour deadline reminders for tasks.
 *
 * Approach: Cron-based polling (Option A).
 *   - When a task is created/updated, rows are upserted into task_reminders.
 *   - A cron job calls processReminders() every 15 minutes.
 *   - processReminders() finds pending reminders whose scheduledFor <= now,
 *     sends notifications to all task assignees/supervisors, and marks them sent.
 *
 * Timezone convention: ALL timestamps are stored and compared in UTC.
 * dueDate (DATEONLY) is interpreted as end-of-day UTC (23:59:59).
 */

const { Op } = require('sequelize');
const { sequelize } = require('../config/db');
const logger = require('../utils/logger');

// Lazy-load models to avoid circular-dependency issues at startup
let _models = null;
function models() {
  if (!_models) _models = require('../models');
  return _models;
}

const { sendNotification } = require('./notificationService');

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Convert a DATEONLY string (e.g. '2026-04-10') into a UTC deadline timestamp.
 * We treat the deadline as end-of-day: 2026-04-10T23:59:59.000Z
 */
function dueDateToDeadline(dueDate) {
  if (!dueDate) return null;
  return new Date(`${dueDate}T23:59:59.000Z`);
}

/**
 * Calculate the two reminder timestamps from a deadline.
 * Returns { twoDayBefore, twoHourBefore }.
 */
function calcReminderTimes(deadline) {
  const twoDayBefore = new Date(deadline.getTime() - 48 * 60 * 60 * 1000);
  const twoHourBefore = new Date(deadline.getTime() - 2 * 60 * 60 * 1000);
  return { twoDayBefore, twoHourBefore };
}

// ─── Schedule / Cancel / Reschedule ──────────────────────────────

/**
 * Create (or reset) reminder rows for a task.
 * Skips reminders whose scheduled time is already in the past.
 */
async function scheduleReminders(taskId, dueDate) {
  const deadline = dueDateToDeadline(dueDate);
  if (!deadline) return;

  const { TaskReminder } = models();
  const now = new Date();
  const { twoDayBefore, twoHourBefore } = calcReminderTimes(deadline);

  const reminders = [];

  if (twoDayBefore > now) {
    reminders.push({ taskId, reminderType: '2_day', scheduledFor: twoDayBefore });
  }
  if (twoHourBefore > now) {
    reminders.push({ taskId, reminderType: '2_hour', scheduledFor: twoHourBefore });
  }

  for (const r of reminders) {
    await TaskReminder.upsert(
      {
        taskId: r.taskId,
        reminderType: r.reminderType,
        scheduledFor: r.scheduledFor,
        sentAt: null,
        cancelled: false,
      },
      {
        conflictFields: ['taskId', 'reminderType'],
      }
    );
  }

  // If a reminder time is already past, mark it cancelled so it never fires
  const typesToCancel = [];
  if (twoDayBefore <= now) typesToCancel.push('2_day');
  if (twoHourBefore <= now) typesToCancel.push('2_hour');
  if (typesToCancel.length > 0) {
    await TaskReminder.update(
      { cancelled: true },
      {
        where: {
          taskId,
          reminderType: { [Op.in]: typesToCancel },
          sentAt: null,
        },
      }
    );
  }
}

/**
 * Cancel all pending (unsent) reminders for a task.
 * Called when a task is completed or deleted.
 */
async function cancelReminders(taskId) {
  const { TaskReminder } = models();
  await TaskReminder.update(
    { cancelled: true },
    {
      where: {
        taskId,
        sentAt: null,
        cancelled: false,
      },
    }
  );
}

/**
 * Reschedule reminders when a task's deadline changes.
 * Cancels old unsent reminders, then creates new ones.
 */
async function rescheduleReminders(taskId, newDueDate) {
  await cancelReminders(taskId);
  if (newDueDate) {
    await scheduleReminders(taskId, newDueDate);
  }
}

// ─── Process pending reminders (called by cron) ─────────────────

/**
 * Find all reminders whose scheduledFor <= now, that have not been sent
 * or cancelled, and send notifications to every assignee/supervisor.
 */
async function processReminders() {
  const { TaskReminder, Task, Board, TaskAssignee, User } = models();
  const now = new Date();

  // Find pending reminders that are due
  const pendingReminders = await TaskReminder.findAll({
    where: {
      scheduledFor: { [Op.lte]: now },
      sentAt: null,
      cancelled: false,
    },
    limit: 200, // process in batches
  });

  if (pendingReminders.length === 0) return;

  console.log(`[DeadlineReminder] Processing ${pendingReminders.length} pending reminder(s)...`);

  for (const reminder of pendingReminders) {
    try {
      // Load the task with board info
      const task = await Task.findByPk(reminder.taskId, {
        include: [{ model: Board, as: 'board', attributes: ['id', 'name'] }],
      });

      // Task deleted or already done — cancel this reminder
      if (!task || task.status === 'done' || task.isArchived) {
        await reminder.update({ cancelled: true });
        continue;
      }

      // Verify deadline hasn't changed (guard against stale reminders)
      const currentDeadline = dueDateToDeadline(task.dueDate);
      if (!currentDeadline) {
        await reminder.update({ cancelled: true });
        continue;
      }
      const expected = calcReminderTimes(currentDeadline);
      const expectedTime = reminder.reminderType === '2_day'
        ? expected.twoDayBefore
        : expected.twoHourBefore;

      // If the scheduled time no longer matches the current deadline, cancel (stale)
      if (Math.abs(reminder.scheduledFor.getTime() - expectedTime.getTime()) > 60000) {
        await reminder.update({ cancelled: true });
        continue;
      }

      // Get all assignees and supervisors for this task
      const taskAssignees = await TaskAssignee.findAll({
        where: { taskId: task.id },
        include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }],
      });

      // Also include the legacy single assignedTo user if not already in taskAssignees
      const recipientMap = new Map();
      for (const ta of taskAssignees) {
        if (ta.user) recipientMap.set(ta.user.id, ta.user);
      }
      if (task.assignedTo && !recipientMap.has(task.assignedTo)) {
        const legacyUser = await User.findByPk(task.assignedTo, {
          attributes: ['id', 'name', 'email'],
        });
        if (legacyUser) recipientMap.set(legacyUser.id, legacyUser);
      }

      if (recipientMap.size === 0) {
        await reminder.update({ cancelled: true });
        continue;
      }

      // Build notification content
      const boardName = task.board ? task.board.name : 'Unknown Board';
      const deadlineStr = task.dueDate; // e.g. '2026-04-10'
      const is2Day = reminder.reminderType === '2_day';
      const notifType = is2Day ? 'due_date' : 'due_date';

      for (const [userId, user] of recipientMap) {
        const title = is2Day
          ? `Reminder: ${task.title} is due in 2 days`
          : `Urgent: ${task.title} is due in 2 hours`;

        const message = is2Day
          ? `Hi ${user.name}, the task "${task.title}" on board "${boardName}" is due on ${deadlineStr}. You have 2 days remaining. Please review your progress.`
          : `Hi ${user.name}, the task "${task.title}" on board "${boardName}" is due on ${deadlineStr}. Only 2 hours remaining — please ensure everything is complete.`;

        await sendNotification(userId, title, message, notifType, task.id, {
          email: user.email,
          userName: user.name,
        });
      }

      // Mark as sent
      await reminder.update({ sentAt: new Date() });
      console.log(`[DeadlineReminder] Sent ${reminder.reminderType} reminder for task "${task.title}" to ${recipientMap.size} user(s)`);
    } catch (err) {
      logger.error(`[DeadlineReminder] Error processing reminder ${reminder.id}:`, err);
    }
  }
}

module.exports = {
  scheduleReminders,
  cancelReminders,
  rescheduleReminders,
  processReminders,
};