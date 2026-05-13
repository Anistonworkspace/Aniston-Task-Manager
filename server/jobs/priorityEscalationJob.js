const cron = require('node-cron');
const { Op } = require('sequelize');
const { Task } = require('../models');
const { logActivity } = require('../services/activityService');
const { sanitizeNotificationField } = require('../utils/sanitize');
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
const {
  MAX_TASKS_PER_CRON_RUN,
  createBudget,
} = require('../config/notificationLimits');

// Statuses excluded at the SQL layer. Same union the reminderJob uses: 'done'
// + every status in AWAITING_REVIEW_STATUSES (waiting_for_review, review,
// pending_deploy, etc.). Per-task `isTaskEligibleForOverdueNotification`
// runs again below as defence in depth — that catches `approvalStatus`
// states and any custom board status the SQL filter cannot enumerate.
const EXCLUDED_STATUSES_FOR_ESCALATION = ['done', ...AWAITING_REVIEW_STATUSES];

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Start the priority escalation cron job.
 *
 * Runs daily at midnight to auto-escalate tasks with progress >= 80%
 * to critical priority (if not already done/review/critical, and the
 * assignee is still the actionable party).
 *
 * Multi-replica safety:
 *  - `withCronLock` ensures one replica owns the tick.
 *  - Per-task race: a conditional UPDATE (`priority='critical' WHERE
 *    priority != 'critical'`) ensures the priority flip + notification
 *    fires at most once even under unlikely lock collisions.
 *  - Per-recipient idempotency key (`priority-escalated:<taskId>:<userId>:
 *    <YYYY-MM-DD>`) is enforced by the partial unique index on
 *    (userId, idempotencyKey) so a same-day re-run cannot duplicate a
 *    notification even if the lock + conditional UPDATE somehow misfired.
 *
 * Eligibility:
 *  - Tasks that are done, archived, awaiting review, pending approval,
 *    or already approved are SKIPPED. A user who already submitted their
 *    work for review should not get a "priority bumped to critical" ping —
 *    they have nothing left to do on the task.
 *
 * Multi-assignee:
 *  - Notifications fan out to every user in the TaskAssignee junction
 *    (assignees + supervisors), plus the legacy `assignedTo` column if not
 *    already covered. Each recipient gets their own idempotency-keyed row.
 */
function startPriorityEscalationJob() {
  cron.schedule('0 0 * * *', async () => {
    try {
      await withCronLock('priorityEscalationJob', async () => {
        await runPriorityEscalation();
      });
    } catch (err) {
      console.error('[PriorityEscalation] Job error:', err);
    }
  });

  console.log('[PriorityEscalation] Cron job started (daily at midnight)');
}

/**
 * The body of the cron tick — exported so tests can drive it directly
 * without spinning up node-cron.
 */
async function runPriorityEscalation() {
  console.log('[PriorityEscalation] Running daily priority escalation check...');
  const today = todayKey();

  // Hard cap per tick (was unbounded). Daily midnight job, but installs
  // with many high-progress tasks would emit dozens of priority-change
  // notifications in one shot — that's the morning version of the 6:30 PM
  // storm. Drain in batches.
  const tasks = await Task.findAll({
    where: {
      progress: { [Op.gte]: 80 },
      status: { [Op.notIn]: EXCLUDED_STATUSES_FOR_ESCALATION },
      [Op.or]: [
        { approvalStatus: null },
        { approvalStatus: 'changes_requested' },
      ],
      priority: { [Op.ne]: 'critical' },
      isArchived: false,
    },
    order: [['progress', 'DESC'], ['createdAt', 'ASC']],
    limit: MAX_TASKS_PER_CRON_RUN,
  });

  const budget = createBudget();
  let escalated = 0;
  let skipped = 0;
  let notified = 0;
  let userLimited = 0;

  for (const task of tasks) {
    try {
      const eligibility = isTaskEligibleForOverdueNotification(task);
      if (!eligibility.eligible) {
        // SQL `where` should have filtered most of these out; this branch
        // catches custom board statuses + approvalStatus='approved' drift
        // between the index scan and the row read.
        skipped += 1;
        logger.info('[PriorityEscalation] skip', {
          taskId: task.id,
          status: task.status,
          approvalStatus: task.approvalStatus,
          reason: eligibility.reason,
        });
        continue;
      }

      const previousPriority = task.priority;

      // Conditional UPDATE: only the worker that flips the row from
      // non-critical → critical proceeds to notify. If two replicas
      // ever hit the same row before either commits, the second one's
      // affectedCount is 0 and we silently skip without sending.
      const [affected] = await Task.update(
        { priority: 'critical' },
        { where: { id: task.id, priority: { [Op.ne]: 'critical' } } }
      );
      if (!affected) continue;

      logActivity({
        action: 'priority_auto_escalated',
        description: `Task "${task.title}" auto-escalated to critical (progress: ${task.progress}%, was: ${previousPriority})`,
        entityType: 'task',
        entityId: task.id,
        taskId: task.id,
        boardId: task.boardId,
        userId: task.assignedTo || task.createdBy,
      });

      // Multi-assignee fan-out: pull every user in TaskAssignee + the
      // legacy `assignedTo` fallback. Each gets their own per-day
      // idempotency key so a same-day re-run cannot duplicate.
      const recipients = await getTaskNotificationRecipients(task);

      const safeTitle = sanitizeNotificationField(task.title);
      const messageBase =
        `Task "${safeTitle}" has been auto-escalated to Critical priority (${task.progress}% complete)`;

      for (const [userId] of recipients) {
        if (!budget.tryReserve(userId)) {
          userLimited += 1;
          continue;
        }
        try {
          const notif = await createNotification({
            userId,
            type: 'priority_change',
            message: messageBase,
            entityType: 'task',
            entityId: task.id,
            boardId: task.boardId || null,
            // Stable key: (task, user, day) tuple. Same key on retry
            // collapses to a SELECT via the partial unique index.
            idempotencyKey: buildIdempotencyKey('priority-escalated', task.id, userId, today),
          });
          if (notif) notified += 1;
        } catch (err) {
          // Per-recipient isolation — one user's send must not block others.
          logger.warn(`[PriorityEscalation] notify failed for user ${userId} on task ${task.id}: ${err && err.message}`);
        }
      }

      escalated += 1;
    } catch (err) {
      // One bad row must not abort the whole batch.
      console.error(`[PriorityEscalation] row failed for task ${task?.id}:`, err?.message || err);
    }
  }

  if (escalated > 0 || skipped > 0) {
    const b = budget.summary();
    logger.info('[PriorityEscalation] tick', {
      candidates: tasks.length,
      escalated,
      notified,
      skipped,
      userLimitedCount: b.userLimitedCount,
      jobLimitedCount: b.jobLimitedCount,
      uniqueUsers: b.uniqueUsers,
    });
    if (userLimited > 0 || tasks.length >= MAX_TASKS_PER_CRON_RUN) {
      logger.warn('[PriorityEscalation] hit caps', {
        candidates: tasks.length,
        notified,
        userLimitedCount: b.userLimitedCount,
        nextTickWillDrain: true,
      });
    }
  }
}

module.exports = {
  startPriorityEscalationJob,
  // Exported for tests — direct invocation lets us exercise the eligibility
  // / idempotency / multi-assignee paths without scheduling a real cron.
  runPriorityEscalation,
  EXCLUDED_STATUSES_FOR_ESCALATION,
};
