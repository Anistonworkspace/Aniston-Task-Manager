/**
 * Cron — missed Daily Work / Recurring Work escalation.
 *
 * Runs every 10 minutes. Finds recurring task instances that are past their
 * dueAt timestamp (occurrenceDate at template.dueTime in template.timezone),
 * are still not 'done', and whose template has `escalateIfMissed = true`.
 * Each missed instance gets one notification per escalation target — never
 * spammed — and is marked `missedEscalationSent = true` so subsequent ticks
 * skip it.
 *
 * Idempotency:
 *   - The `missedEscalationSent` flag on each task is the durable per-task
 *     "did we send this already?" marker.
 *   - The DB UPDATE that flips the flag is part of the same `findAll` cycle;
 *     if two replicas race, the second one's UPDATE is a no-op (the row
 *     already has missedEscalationSent=TRUE — no-op SET) but more importantly
 *     the next pass's WHERE filter won't pick it up again.
 *   - Even in the worst case (two replicas both hit a row before either has
 *     UPDATEd), the worst outcome is a duplicate notification — never lost
 *     state. We treat that as acceptable for v1; a stronger guarantee would
 *     require a row-level lock (`SELECT ... FOR UPDATE`).
 *
 * Per-target rules:
 *   - 'assignee'  → notify the task's primary assignee.
 *   - 'manager'   → notify EACH of the assignee's managers, both legacy
 *                   User.managerId and the ManagerRelation junction (active
 *                   employees only). Deduped by user id.
 *   - 'admin'     → notify all admin/super-admin users. Capped at 5 to avoid
 *                   blast-radius mistakes from a fat-finger config.
 */

const cron = require('node-cron');
const { Op } = require('sequelize');
const {
  Task,
  RecurringTaskTemplate,
  User,
  ManagerRelation,
} = require('../models');
const { sendNotification } = require('../services/notificationService');
const recurringTaskService = require('../services/recurringTaskService');
const logger = require('../utils/logger');

const CRON_EXPR = '*/10 * * * *';

// Statuses that count as "completed" — `done` is the canonical case. Custom
// status configs may add per-task done-equivalents in the future, but until
// the platform formalises a "completion" flag we anchor on 'done'.
const COMPLETED_STATUSES = ['done'];

// ─── Manager lookup ─────────────────────────────────────────────────────────

/**
 * Return a deduped list of active manager user ids for a given user — the
 * union of the legacy `User.managerId` column and the `ManagerRelation`
 * junction (multi-manager). Inactive managers are filtered out so we never
 * notify a deactivated account.
 */
async function getActiveManagerIds(userId) {
  if (!userId) return [];
  const ids = new Set();

  try {
    const u = await User.findByPk(userId, { attributes: ['managerId'] });
    if (u && u.managerId) {
      const mgr = await User.findOne({
        where: { id: u.managerId, isActive: true },
        attributes: ['id'],
      });
      if (mgr) ids.add(mgr.id);
    }
  } catch (e) {
    logger.warn('[MissedRecurringJob] legacy managerId lookup failed', { msg: e.message });
  }

  // ManagerRelation junction — may not exist on very old installs.
  try {
    const relations = await ManagerRelation.findAll({
      where: { employeeId: userId },
      attributes: ['managerId'],
      raw: true,
    });
    if (relations.length > 0) {
      const candidateIds = relations.map((r) => r.managerId);
      const active = await User.findAll({
        where: { id: { [Op.in]: candidateIds }, isActive: true },
        attributes: ['id'],
        raw: true,
      });
      for (const u of active) ids.add(u.id);
    }
  } catch (e) {
    // Junction table absent — already covered by legacy path above.
  }

  return [...ids];
}

/**
 * Return active admin / super-admin user ids. Capped to a small number for
 * defensive blast-radius control.
 */
async function getEscalationAdminIds(limit = 5) {
  try {
    const admins = await User.findAll({
      where: {
        isActive: true,
        [Op.or]: [{ role: 'admin' }, { isSuperAdmin: true }],
      },
      attributes: ['id'],
      order: [['createdAt', 'ASC']],
      limit,
    });
    return admins.map((u) => u.id);
  } catch (e) {
    logger.warn('[MissedRecurringJob] admin lookup failed', { msg: e.message });
    return [];
  }
}

// ─── Per-task escalation ────────────────────────────────────────────────────

/**
 * Decide which user ids should be notified for a missed task, based on the
 * template's `escalationTargets`. Always deduped; the assignee is never
 * double-notified if they happen to also appear in another category.
 */
async function buildRecipients(template, task) {
  const targets = Array.isArray(template.escalationTargets) ? template.escalationTargets : ['assignee', 'manager'];
  const recipients = new Set();

  if (targets.includes('assignee') && task.assignedTo) {
    recipients.add(task.assignedTo);
  }
  if (targets.includes('manager') && task.assignedTo) {
    const managerIds = await getActiveManagerIds(task.assignedTo);
    for (const id of managerIds) recipients.add(id);
  }
  if (targets.includes('admin')) {
    const adminIds = await getEscalationAdminIds();
    for (const id of adminIds) recipients.add(id);
  }

  return [...recipients];
}

function escalationMessage(template, task) {
  const dueTimeHuman = recurringTaskService.parseDueTime
    ? humanTime(template.dueTime)
    : template.dueTime;
  return `Daily Work missed: "${template.title}" for ${task.occurrenceDate} was not completed by ${dueTimeHuman}.`;
}

function humanTime(dueTime) {
  if (!dueTime) return '6:00 PM';
  const m = String(dueTime).match(/^(\d{1,2}):(\d{1,2})/);
  if (!m) return dueTime;
  let h = parseInt(m[1], 10);
  const mm = m[2];
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = ((h + 11) % 12) + 1;
  return `${h}:${mm} ${ampm}`;
}

// ─── Main tick ──────────────────────────────────────────────────────────────

/**
 * Process all missed recurring instances since the last tick.
 *
 * Implementation note: we cannot push the dueAt comparison into Postgres
 * directly (dueDate is DATEONLY and dueTime lives on the template), so we
 * fetch a candidate set with a coarse filter — `occurrenceDate <= today` and
 * the per-task flags — then refine with `dueAtUtc(...)` per row. The candidate
 * set is naturally bounded by the partial index
 * `tasks_recurring_instance_idx`.
 */
async function tickOnce(now = new Date()) {
  // Coarse filter:
  //   - is a recurring instance
  //   - escalation hasn't fired yet
  //   - status not yet completed
  //   - not archived
  //   - dueDate is in the past (or today, in some timezone — refined below)
  const todayUtc = new Date(now.toISOString().slice(0, 10));
  const candidates = await Task.findAll({
    where: {
      isRecurringInstance: true,
      missedEscalationSent: false,
      status: { [Op.notIn]: COMPLETED_STATUSES },
      isArchived: false,
      occurrenceDate: { [Op.ne]: null, [Op.lte]: todayUtc },
      recurringTemplateId: { [Op.ne]: null },
    },
    include: [
      {
        model: RecurringTaskTemplate,
        as: 'recurringTemplate',
        attributes: ['id', 'title', 'dueTime', 'timezone', 'escalateIfMissed', 'escalationTargets'],
      },
    ],
    limit: 500, // batch cap; subsequent ticks drain the rest
  });

  if (candidates.length === 0) {
    return { processed: 0, escalated: 0, skipped: 0, errors: 0 };
  }

  let escalated = 0;
  let skipped = 0;
  let errors = 0;

  for (const task of candidates) {
    try {
      const tpl = task.recurringTemplate;
      // If the template was hard-deleted (FK SET NULL), skip — there's no
      // configuration to escalate against.
      if (!tpl) { skipped += 1; continue; }
      // Escalation toggle is the consent gate. If false, the missed task
      // simply remains overdue without anyone being paged.
      if (!tpl.escalateIfMissed) { skipped += 1; continue; }

      // Refine: real dueAt = occurrenceDate at dueTime in template tz.
      const dueAt = recurringTaskService.dueAtUtc(task.occurrenceDate, tpl.dueTime, tpl.timezone);
      if (dueAt > now) { skipped += 1; continue; }

      const recipients = await buildRecipients(tpl, task);
      if (recipients.length === 0) {
        // No-one to notify (assignee deactivated, no managers, etc.). Still
        // flip the flag so we don't reconsider this row every tick.
        await task.update({ missedEscalationSent: true, missedEscalationSentAt: new Date() });
        skipped += 1;
        continue;
      }

      const message = escalationMessage(tpl, task);
      // Send sequentially per recipient. notificationService is fire-and-
      // forget on the email side, so the loop is fast.
      for (const userId of recipients) {
        try {
          await sendNotification(
            userId,
            'Recurring task missed',
            message,
            'recurring_missed',
            task.id
          );
        } catch (e) {
          logger.warn('[MissedRecurringJob] notify failed', {
            taskId: task.id, userId, msg: e.message,
          });
        }
      }

      await task.update({
        missedEscalationSent: true,
        missedEscalationSentAt: new Date(),
      });
      escalated += 1;
      logger.info('[RecurringMiss] escalated', {
        event: 'recurring_missed',
        recurringTemplateId: tpl.id,
        boardId: task.boardId,
        groupId: task.groupId,
        assigneeId: task.assignedTo,
        occurrenceDate: task.occurrenceDate,
        generatedTaskId: task.id,
        recipients: recipients.length,
        source: 'missedRecurringTaskJob',
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      errors += 1;
      logger.error('[MissedRecurringJob] task processing failed', {
        taskId: task.id, msg: err.message, stack: err.stack,
      });
    }
  }

  return { processed: candidates.length, escalated, skipped, errors };
}

function startMissedRecurringTaskJob() {
  cron.schedule(CRON_EXPR, async () => {
    const start = Date.now();
    try {
      const result = await tickOnce(new Date());
      if (result.processed > 0 || result.errors > 0) {
        logger.info(
          `[MissedRecurringJob] tick: processed=${result.processed} escalated=${result.escalated} `
          + `skipped=${result.skipped} errors=${result.errors} (${Date.now() - start}ms)`
        );
      }
    } catch (err) {
      logger.error('[MissedRecurringJob] tick failed', { msg: err.message, stack: err.stack });
    }
  });

  logger.info(`[MissedRecurringJob] Scheduled (${CRON_EXPR})`);
}

module.exports = {
  startMissedRecurringTaskJob,
  _tickOnce: tickOnce,
  _getActiveManagerIds: getActiveManagerIds,
};
