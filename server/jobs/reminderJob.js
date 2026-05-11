const cron = require('node-cron');
const { Op } = require('sequelize');
const { Task, User, Board } = require('../models');
const { withCronLock } = require('./cronLock');
const {
  createNotification,
  buildIdempotencyKey,
} = require('../services/notificationService');
const {
  isTaskEligibleForOverdueNotification,
  AWAITING_REVIEW_STATUSES,
} = require('../utils/taskOverdueEligibility');
const { getTaskNotificationRecipients } = require('../utils/taskNotificationRecipients');
const logger = require('../utils/logger');

// Socket emission + DB insert are now handled inside
// `notificationService.createNotification`. We deliberately no longer import
// `Notification` or `emitToUser` here — every notification row this job
// creates must go through the central service so idempotency, sanitisation,
// and the socket/push fan-out stay consistent with the rest of the codebase.

// Statuses excluded at the SQL layer for the due-soon / overdue / 3-day
// queries. We pre-filter these in the DB to avoid pulling thousands of
// already-done or already-submitted tasks out of Postgres only to throw
// them away in the loop. Per-task `isTaskEligibleForOverdueNotification`
// is still applied below as defence in depth (catches `approvalStatus`
// fields and any custom board statuses we couldn't pre-filter).
const EXCLUDED_STATUSES_FOR_NOTIFY = ['done', ...AWAITING_REVIEW_STATUSES];

// Date-key helpers — used both for SQL bounds and for idempotency keys so
// "two cron ticks on the same calendar day → one notification" is enforced
// by the partial unique index on (userId, idempotencyKey), not by a fragile
// message `LIKE` scan.
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Start the reminder cron job.
 * Runs every hour to check for:
 * - Tasks due in the next 24 hours → notify assignee
 * - Overdue tasks → notify assignee + task creator/manager
 * - Tasks due in 3 days → soft reminder (once per day at 9 AM)
 *
 * Multi-replica safety: each tick is wrapped in `withCronLock` so exactly
 * one backend replica runs the work per tick. Without this, two replicas
 * would both pass the "did I notify today?" dedup check before either has
 * inserted a row, producing duplicate notifications + emails.
 */
function startReminderJob() {
  // Run every hour at minute 0
  cron.schedule('0 * * * *', async () => {
    try {
      await withCronLock('reminderJob:hourly', async () => {
        console.log('[Reminder] Running reminder check...');
        await checkDueSoon();
        await checkOverdue();
      });
    } catch (err) {
      console.error('[Reminder] Job error:', err);
    }
  });

  // Run daily at 9 AM for 3-day reminders
  cron.schedule('0 9 * * *', async () => {
    try {
      await withCronLock('reminderJob:daily9am', async () => {
        await checkDueIn3Days();
      });
    } catch (err) {
      console.error('[Reminder] 3-day check error:', err);
    }
  });

  console.log('[Reminder] Cron jobs started (hourly due-soon + overdue, daily 3-day reminder)');
}

/**
 * Notify assignees of tasks due within the next 24 hours.
 *
 * Eligibility is checked twice — once in SQL via EXCLUDED_STATUSES_FOR_NOTIFY
 * and `approvalStatus IS NULL OR approvalStatus = 'changes_requested'`, and
 * once per task via `isTaskEligibleForOverdueNotification`. The second check
 * catches edge cases the SQL filter cannot (custom board status keys, status
 * drift between the index scan and row read, etc.).
 */
async function checkDueSoon() {
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const today = now.toISOString().slice(0, 10);
  const tomorrow = in24h.toISOString().slice(0, 10);

  const tasks = await Task.findAll({
    where: {
      status: { [Op.notIn]: EXCLUDED_STATUSES_FOR_NOTIFY },
      [Op.or]: [
        { approvalStatus: null },
        { approvalStatus: 'changes_requested' },
      ],
      isArchived: false,
      assignedTo: { [Op.ne]: null },
      dueDate: { [Op.in]: [today, tomorrow] },
    },
    include: [
      { model: User, as: 'assignee', attributes: ['id', 'name'] },
      { model: Board, as: 'board', attributes: ['id', 'name'] },
    ],
  });

  let sent = 0;
  let skipped = 0;
  for (const task of tasks) {
    try {
      const eligibility = isTaskEligibleForOverdueNotification(task);
      if (!eligibility.eligible) {
        skipped += 1;
        logger.info('[Reminder] checkDueSoon skip', {
          taskId: task.id,
          status: task.status,
          approvalStatus: task.approvalStatus,
          reason: eligibility.reason,
        });
        continue;
      }

      // Multi-assignee fan-out: every user in TaskAssignee + the legacy
      // `assignedTo` fallback (deduped). A task with two TaskAssignee rows
      // notifies both, not just the legacy primary.
      const recipients = await getTaskNotificationRecipients(task);
      if (recipients.size === 0) { skipped += 1; continue; }

      const isToday = task.dueDate === today;
      const message = `Task "${task.title}" is due ${isToday ? 'today' : 'tomorrow'}` +
        `${task.board ? ` on board "${task.board.name}"` : ''}`;

      for (const [userId] of recipients) {
        try {
          const notification = await createNotification({
            userId,
            type: 'due_date',
            message,
            entityType: 'task',
            entityId: task.id,
            boardId: task.boardId || null,
            // Stable key: same (taskId, userId, day) yields the same row,
            // so a mid-day cron re-tick or process restart cannot duplicate.
            idempotencyKey: buildIdempotencyKey('due-soon', task.id, userId, today),
          });
          if (notification) sent += 1;
        } catch (err) {
          logger.warn(`[Reminder] checkDueSoon notify failed for user ${userId} on task ${task.id}: ${err && err.message}`);
        }
      }
    } catch (err) {
      // Per-task isolation: a single bad row (e.g. enum violation, FK race)
      // must not abort the whole batch. Log and continue.
      console.error(`[Reminder] checkDueSoon row failed for task ${task?.id}:`, err?.message || err);
    }
  }

  if (tasks.length > 0) {
    console.log(`[Reminder] Due-soon: ${sent} sent, ${skipped} skipped (of ${tasks.length} candidate task(s))`);
  }
}

/**
 * Notify assignees and creators of overdue tasks.
 *
 * Eligibility: tasks that are done/completed, archived, awaiting review,
 * pending approval, or already approved are SKIPPED — the assignee has done
 * their part and shouldn't be pinged again. The SQL `where` filters the
 * obvious ones; `isTaskEligibleForOverdueNotification` is the authoritative
 * per-task check that also catches `approvalStatus='approved'` drift and any
 * custom board status keys.
 *
 * Idempotency: notifications use `overdue:<taskId>:<userId>:<YYYY-MM-DD>` so
 * the partial unique index on (userId, idempotencyKey) collapses any retry,
 * replay, or second cron tick within the same day to exactly one row per
 * recipient. This replaces the prior fragile `message LIKE '%overdue%'`
 * dedup that could be broken by any wording change.
 */
async function checkOverdue() {
  const today = todayKey();

  const tasks = await Task.findAll({
    where: {
      status: { [Op.notIn]: EXCLUDED_STATUSES_FOR_NOTIFY },
      [Op.or]: [
        { approvalStatus: null },
        { approvalStatus: 'changes_requested' },
      ],
      isArchived: false,
      assignedTo: { [Op.ne]: null },
      dueDate: { [Op.lt]: today },
    },
    include: [
      { model: User, as: 'assignee', attributes: ['id', 'name'] },
      { model: User, as: 'creator', attributes: ['id', 'name'] },
      { model: Board, as: 'board', attributes: ['id', 'name'] },
    ],
  });

  let sent = 0;
  let skipped = 0;
  for (const task of tasks) {
    try {
      const eligibility = isTaskEligibleForOverdueNotification(task);
      if (!eligibility.eligible) {
        skipped += 1;
        logger.info('[Reminder] checkOverdue skip', {
          taskId: task.id,
          status: task.status,
          approvalStatus: task.approvalStatus,
          reason: eligibility.reason,
        });
        continue;
      }

      // Multi-assignee fan-out: every user in TaskAssignee + the legacy
      // `assignedTo` fallback (deduped).
      const recipients = await getTaskNotificationRecipients(task);
      if (recipients.size === 0) { skipped += 1; continue; }

      // Pick a "primary" name for the manager-facing message. Prefer the
      // legacy assignee's name (matches prior behaviour) when present,
      // otherwise fall back to the first recipient.
      const primaryName = task.assignee?.name
        || recipients.get(task.assignedTo)?.name
        || [...recipients.values()][0]?.name
        || 'A user';

      // Notify each assignee/supervisor
      const assigneeMsg =
        `Task "${task.title}" is overdue (due ${task.dueDate})` +
        `${task.board ? ` on board "${task.board.name}"` : ''}`;
      for (const [userId] of recipients) {
        try {
          const notification = await createNotification({
            userId,
            type: 'task_updated',
            message: assigneeMsg,
            entityType: 'task',
            entityId: task.id,
            boardId: task.boardId || null,
            idempotencyKey: buildIdempotencyKey('overdue', task.id, userId, today),
          });
          if (notification) sent += 1;
        } catch (err) {
          logger.warn(`[Reminder] checkOverdue notify failed for user ${userId} on task ${task.id}: ${err && err.message}`);
        }
      }

      // Also notify creator/manager if different from every assignee.
      // Separate idempotency-key tuple → cannot collide with the assignee
      // notifications above.
      if (task.creator && !recipients.has(task.creator.id)) {
        const creatorMsg =
          `${primaryName}'s task "${task.title}" is overdue (due ${task.dueDate})`;
        await createNotification({
          userId: task.creator.id,
          type: 'task_updated',
          message: creatorMsg,
          entityType: 'task',
          entityId: task.id,
          boardId: task.boardId || null,
          idempotencyKey: buildIdempotencyKey('overdue', task.id, task.creator.id, today),
        });
      }
    } catch (err) {
      console.error(`[Reminder] checkOverdue row failed for task ${task?.id}:`, err?.message || err);
    }
  }

  if (tasks.length > 0) {
    console.log(`[Reminder] Overdue: ${sent} sent, ${skipped} skipped (of ${tasks.length} candidate task(s))`);
  }
}

/**
 * Soft reminder for tasks due in 3 days.
 *
 * Same eligibility rules as overdue / due-soon — a task already submitted
 * for review shouldn't generate a "due in 3 days" ping for the user who
 * already finished their part.
 */
async function checkDueIn3Days() {
  const now = new Date();
  const in3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);

  const tasks = await Task.findAll({
    where: {
      status: { [Op.notIn]: EXCLUDED_STATUSES_FOR_NOTIFY },
      [Op.or]: [
        { approvalStatus: null },
        { approvalStatus: 'changes_requested' },
      ],
      isArchived: false,
      assignedTo: { [Op.ne]: null },
      dueDate: in3Days,
    },
    include: [
      { model: User, as: 'assignee', attributes: ['id', 'name'] },
      { model: Board, as: 'board', attributes: ['id', 'name'] },
    ],
  });

  let sent = 0;
  let skipped = 0;
  for (const task of tasks) {
    try {
      const eligibility = isTaskEligibleForOverdueNotification(task);
      if (!eligibility.eligible) {
        skipped += 1;
        logger.info('[Reminder] checkDueIn3Days skip', {
          taskId: task.id,
          status: task.status,
          approvalStatus: task.approvalStatus,
          reason: eligibility.reason,
        });
        continue;
      }

      const recipients = await getTaskNotificationRecipients(task);
      if (recipients.size === 0) { skipped += 1; continue; }

      const message = `Heads up: "${task.title}" is due in 3 days (${task.dueDate})`;
      for (const [userId] of recipients) {
        try {
          const notification = await createNotification({
            userId,
            type: 'due_date',
            message,
            entityType: 'task',
            entityId: task.id,
            boardId: task.boardId || null,
            idempotencyKey: buildIdempotencyKey('due-3day', task.id, userId, today),
          });
          if (notification) sent += 1;
        } catch (err) {
          logger.warn(`[Reminder] checkDueIn3Days notify failed for user ${userId} on task ${task.id}: ${err && err.message}`);
        }
      }
    } catch (err) {
      console.error(`[Reminder] checkDueIn3Days row failed for task ${task?.id}:`, err?.message || err);
    }
  }

  if (tasks.length > 0) {
    console.log(`[Reminder] 3-day: ${sent} sent, ${skipped} skipped (of ${tasks.length} candidate task(s))`);
  }
}

module.exports = {
  startReminderJob,
  // Exported for tests — direct invocation lets us exercise the eligibility
  // path without scheduling a real cron.
  checkOverdue,
  checkDueSoon,
  checkDueIn3Days,
  EXCLUDED_STATUSES_FOR_NOTIFY,
};
