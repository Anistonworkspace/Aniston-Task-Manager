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
const {
  sendNotification,
  buildIdempotencyKey,
} = require('../services/notificationService');
const recurringTaskService = require('../services/recurringTaskService');
const logger = require('../utils/logger');
const { withCronLock } = require('./cronLock');
const {
  isTaskEligibleForOverdueNotification,
  AWAITING_REVIEW_STATUSES,
} = require('../utils/taskOverdueEligibility');
const {
  MAX_TASKS_PER_CRON_RUN,
  createBudget,
} = require('../config/notificationLimits');

const CRON_EXPR = '*/10 * * * *';

// Statuses excluded at the SQL layer. `done` plus every awaiting-review key
// from the central eligibility module — this is the same union the
// reminderJob / priorityEscalationJob use, so the missed cron stops paging
// users for tasks they've already handed off for review. Per-row
// `isTaskEligibleForOverdueNotification` runs again below as defence in
// depth (it catches `approvalStatus` flips and any custom board statuses).
const COMPLETED_STATUSES = ['done'];
const EXCLUDED_STATUSES_FOR_MISSED = ['done', ...AWAITING_REVIEW_STATUSES];

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
 * Return active Tier 1 + Tier 2 user ids — i.e. every "admin" target by the
 * canonical tier model (super admin, admin, manager). Capped to a small
 * number for defensive blast-radius control.
 *
 * Phase 6 fix (audit P0): the previous filter was `role:'admin' OR
 * isSuperAdmin`, which excluded Tier-2 managers (`role:'manager'`). Under the
 * tier model, Tier 2 is "admin + manager combined" — both should escalate.
 * The OR over both legacy fields and the future-friendly is-supervisor flag
 * keeps this correct whether or not a given user has been backfilled to the
 * `tier` column.
 */
async function getEscalationAdminIds(limit = 5) {
  try {
    const admins = await User.findAll({
      where: {
        isActive: true,
        [Op.or]: [
          { isSuperAdmin: true },
          { role: { [Op.in]: ['admin', 'manager'] } },
        ],
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
  //   - status not yet completed AND not handed off for review
  //   - approvalStatus null or 'changes_requested' (back on assignee)
  //   - not archived
  //   - dueDate is in the past (or today, in some timezone — refined below)
  //
  // Hard cap: MAX_TASKS_PER_CRON_RUN. Was 500. Ordering by occurrenceDate so
  // the oldest missed instances escalate first and any overflow drains in the
  // next tick (10 min later) instead of being starved.
  const todayUtc = new Date(now.toISOString().slice(0, 10));
  const candidates = await Task.findAll({
    where: {
      isRecurringInstance: true,
      missedEscalationSent: false,
      status: { [Op.notIn]: EXCLUDED_STATUSES_FOR_MISSED },
      [Op.or]: [
        { approvalStatus: null },
        { approvalStatus: 'changes_requested' },
      ],
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
    order: [['occurrenceDate', 'ASC'], ['createdAt', 'ASC']],
    limit: MAX_TASKS_PER_CRON_RUN,
  });

  if (candidates.length === 0) {
    return { processed: 0, escalated: 0, skipped: 0, errors: 0, deferred: 0 };
  }

  // Per-tick budget — caps the storm potential. Defaults from
  // notificationLimits config (overridable via env). When a candidate's
  // recipient set can't all be served, we DEFER the whole row by NOT
  // flipping `missedEscalationSent`; the next tick (10 min) tries again.
  const budget = createBudget();

  let escalated = 0;
  let skipped = 0;
  let errors = 0;
  let deferred = 0;

  for (const task of candidates) {
    try {
      const tpl = task.recurringTemplate;
      // If the template was hard-deleted (FK SET NULL), skip — there's no
      // configuration to escalate against.
      if (!tpl) { skipped += 1; continue; }
      // Escalation toggle is the consent gate. If false, the missed task
      // simply remains overdue without anyone being paged.
      if (!tpl.escalateIfMissed) { skipped += 1; continue; }

      // Defence-in-depth eligibility — catches `approvalStatus='approved'`
      // drift between the SQL scan and the row read, plus any custom board
      // status the IN-list above didn't enumerate. Logged + the row's flag is
      // FLIPPED so we never reconsider an ineligible row every 10 minutes
      // (the audit's "reprocesses the same task forever" finding).
      const eligibility = isTaskEligibleForOverdueNotification(task);
      if (!eligibility.eligible) {
        logger.info('[MissedRecurringJob] skip + close (ineligible)', {
          taskId: task.id,
          status: task.status,
          approvalStatus: task.approvalStatus,
          reason: eligibility.reason,
        });
        try {
          await Task.update(
            { missedEscalationSent: true, missedEscalationSentAt: new Date() },
            { where: { id: task.id, missedEscalationSent: false } }
          );
        } catch (_) { /* best-effort */ }
        skipped += 1;
        continue;
      }

      // Refine: real dueAt = occurrenceDate at dueTime in template tz.
      const dueAt = recurringTaskService.dueAtUtc(task.occurrenceDate, tpl.dueTime, tpl.timezone);
      if (dueAt > now) { skipped += 1; continue; }

      // Resolve recipients BEFORE claiming so we can apply the per-user cap
      // and defer the row (no flag flip) if the budget can't cover this
      // recipient set. Order: assignee first, then managers, then admins —
      // that way overflow tends to drop low-priority broadcast targets
      // before paging the actual assignee.
      const recipients = await buildRecipients(tpl, task);
      if (recipients.length === 0) {
        // No actionable recipient — claim the row so we don't keep
        // resurveying it every 10 minutes for the rest of the day.
        try {
          await Task.update(
            { missedEscalationSent: true, missedEscalationSentAt: new Date() },
            { where: { id: task.id, missedEscalationSent: false } }
          );
        } catch (_) { /* best-effort */ }
        skipped += 1;
        continue;
      }

      // Allow-list under the budget — defers the entire row if any of the
      // recipients would be capped, so the next tick can re-attempt the
      // same notification set without "this user got their assignee ping
      // but not their manager ping" partial fan-outs.
      const allowed = recipients.filter((uid) => budget.canEmit(uid));
      if (allowed.length < recipients.length) {
        deferred += 1;
        logger.info('[MissedRecurringJob] defer (budget)', {
          taskId: task.id,
          recipients: recipients.length,
          allowed: allowed.length,
        });
        continue; // do NOT flip the flag — pick up next tick
      }

      // Race-safe claim: a conditional UPDATE that only succeeds while the
      // flag is still FALSE. The Task model's update() returns
      // [affectedRowCount] — we send notifications ONLY when this worker won
      // the row. If a sibling replica already claimed it, our affectedCount
      // is 0 and we skip without sending.
      //
      // Why this beats the "find → notify → set flag" sequence: in the
      // original code two replicas could both pass the WHERE filter, both
      // send notifications, and only THEN flip the flag. With this conditional
      // UPDATE the flag flip is the lock — exactly one replica notifies.
      const claim = await Task.update(
        { missedEscalationSent: true, missedEscalationSentAt: new Date() },
        { where: { id: task.id, missedEscalationSent: false } }
      );
      const claimed = Array.isArray(claim) ? claim[0] : claim;
      if (!claimed) {
        // Another worker already claimed this row. No-op.
        skipped += 1;
        continue;
      }

      const message = escalationMessage(tpl, task);
      let notifiedThisRow = 0;
      // Send sequentially per recipient. notificationService is fire-and-
      // forget on the email side, so the loop is fast. Each recipient gets
      // an idempotency key — a partial-unique-index dedup on the DB side —
      // so a duplicate cron tick or a process restart cannot produce a
      // second notification for the same (task, user) pair.
      for (const userId of recipients) {
        if (!budget.tryReserve(userId)) {
          // Budget exhausted mid-row (shouldn't happen given the canEmit
          // check above, but guards against a concurrent emitter). Stop —
          // missedEscalationSent is already flipped so the residual
          // recipients won't be retried; better to log than to flood.
          logger.warn('[MissedRecurringJob] budget exhausted mid-row', {
            taskId: task.id, userId, notifiedThisRow,
          });
          break;
        }
        try {
          await sendNotification(
            userId,
            'Recurring task missed',
            message,
            'recurring_missed',
            task.id,
            {
              idempotencyKey: buildIdempotencyKey(
                'recurring-missed',
                task.id,
                userId,
                task.occurrenceDate || ''
              ),
            }
          );
          notifiedThisRow += 1;
        } catch (e) {
          logger.warn('[MissedRecurringJob] notify failed', {
            taskId: task.id, userId, msg: e.message,
          });
        }
      }

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
        notified: notifiedThisRow,
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

  return {
    processed: candidates.length,
    escalated,
    skipped,
    errors,
    deferred,
    budget: budget.summary(),
  };
}

function startMissedRecurringTaskJob() {
  cron.schedule(CRON_EXPR, async () => {
    const start = Date.now();
    try {
      // Wrap in cronLock so only one replica scans the candidate set per
      // tick. The per-row conditional UPDATE inside tickOnce is still the
      // hard guarantee against duplicate notifications, but the lock saves
      // the multi-replica scan cost (5xx queries per tick × N replicas).
      const result = await withCronLock('missedRecurringTaskJob', () => tickOnce(new Date()));
      if (result && (result.processed > 0 || result.errors > 0)) {
        const b = result.budget || {};
        logger.info(
          `[MissedRecurringJob] tick: processed=${result.processed} escalated=${result.escalated} `
          + `skipped=${result.skipped} deferred=${result.deferred || 0} `
          + `notifications=${b.totalEmitted || 0} userLimited=${b.userLimitedCount || 0} `
          + `jobLimited=${b.jobLimitedCount || 0} errors=${result.errors} (${Date.now() - start}ms)`
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
