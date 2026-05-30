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
const {
  DEFAULT_TIMEZONE,
  isValidHHMM,
  normalizeTimezone,
  nextDailyTimeFire,
} = require('../utils/timezone');

// Lazy-load models to avoid circular-dependency issues at startup
let _models = null;
function models() {
  if (!_models) _models = require('../models');
  return _models;
}

const { sendNotification, buildIdempotencyKey } = require('./notificationService');
const {
  isTaskEligibleForOverdueNotification,
} = require('../utils/taskOverdueEligibility');
const { isCompletedStatus } = require('../utils/taskPrioritization');
const {
  MAX_REMINDERS_PER_CRON_RUN,
  createBudget,
} = require('../config/notificationLimits');

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
 *
 * Preserves any user-set offset / at_due / custom reminders by recomputing
 * their `scheduledFor` from the new dueDate. Legacy 2_day/2_hour rows are
 * dropped and recreated by scheduleReminders. Custom-timestamp rows
 * (reminderType='custom') don't depend on dueDate so they're left alone.
 */
async function rescheduleReminders(taskId, newDueDate) {
  const { TaskReminder } = models();

  // First, recompute scheduledFor for offset / at_due rows that survive a
  // due-date change. We do this BEFORE cancelling the legacy 2_day/2_hour
  // rows because cancelReminders() flags ALL pending rows.
  if (newDueDate) {
    const newDeadline = dueDateToDeadline(newDueDate);
    if (newDeadline) {
      const survivors = await TaskReminder.findAll({
        where: {
          taskId,
          sentAt: null,
          cancelled: false,
          reminderType: { [Op.in]: ['offset', 'at_due'] },
        },
      });
      const now = new Date();
      for (const r of survivors) {
        const newScheduled = computeScheduledFor(r, newDeadline);
        if (!newScheduled) continue;
        // If the new scheduled time is now in the past, cancel — we don't
        // want to pop a "1 day before" reminder when the task was just moved
        // to tomorrow at 2pm.
        if (newScheduled <= now) {
          await r.update({ cancelled: true });
        } else {
          await r.update({ scheduledFor: newScheduled });
        }
      }
    }
  }

  // Now cancel legacy 2_day / 2_hour rows so scheduleReminders below can
  // recreate them against the new deadline.
  await TaskReminder.update(
    { cancelled: true },
    {
      where: {
        taskId,
        sentAt: null,
        cancelled: false,
        reminderType: { [Op.in]: ['2_day', '2_hour'] },
      },
    }
  );

  if (newDueDate) {
    await scheduleReminders(taskId, newDueDate);
  } else {
    // Due date was cleared — cancel everything that depended on it.
    await TaskReminder.update(
      { cancelled: true },
      {
        where: {
          taskId,
          sentAt: null,
          cancelled: false,
          reminderType: { [Op.in]: ['offset', 'at_due'] },
        },
      }
    );
  }
}

// ─── Phase 5: user-configured task reminders ──────────────────────

/** Allowed reminder offset values, in minutes. Mirrors the dropdown the
 *  client renders. Anything else gets rejected by `normalizeReminderSpecs`. */
const ALLOWED_OFFSET_MINUTES = new Set([5, 15, 30, 60, 120, 360, 720, 1440, 2880, 4320, 10080]);

/** Recurring-interval bounds. 15 min ≤ N ≤ 7 days (10080 min). */
const MIN_INTERVAL_MINUTES = 15;
const MAX_INTERVAL_MINUTES = 10080;
/** Max distinct HH:MM slots per `daily_times` reminder. Bounds notification volume. */
const MAX_DAILY_TIMES = 12;

/**
 * Compute the absolute UTC `scheduledFor` for a reminder spec given a
 * deadline. Returns null if the spec doesn't depend on a deadline (custom
 * type) or if the deadline is missing.
 *
 * Recurring types (interval / daily_times) are independent of `deadline`:
 *   - interval: first fire is `now + intervalMinutes` (never immediate, so
 *               the user isn't pinged the moment they save).
 *   - daily_times: first fire is the next HH:MM slot in `timezone` after now.
 *
 * @param {object} reminder Either a TaskReminder row or a normalized spec.
 * @param {Date}   deadline UTC deadline timestamp.
 * @param {Date}   [now]    Reference instant — defaults to `new Date()`.
 *                          Injectable for tests.
 */
function computeScheduledFor(reminder, deadline, now) {
  const type = reminder.reminderType;
  const ref = now || new Date();
  if (type === 'custom') {
    // For custom type, scheduledFor === customReminderAt — independent
    // of dueDate. Returning null here lets callers detect and skip the
    // recomputation path.
    const at = reminder.customReminderAt;
    return at instanceof Date ? at : (at ? new Date(at) : null);
  }
  if (type === 'interval') {
    const m = Number(reminder.intervalMinutes);
    if (!Number.isFinite(m) || m < MIN_INTERVAL_MINUTES) return null;
    return new Date(ref.getTime() + m * 60 * 1000);
  }
  if (type === 'daily_times') {
    const times = Array.isArray(reminder.timesOfDay) ? reminder.timesOfDay : null;
    if (!times || times.length === 0) return null;
    return nextDailyTimeFire(times, reminder.timezone || DEFAULT_TIMEZONE, ref);
  }
  if (!deadline) return null;
  if (type === 'at_due') return new Date(deadline.getTime());
  if (type === 'offset') {
    const m = Number(reminder.offsetMinutes);
    if (!Number.isFinite(m) || m < 0) return null;
    return new Date(deadline.getTime() - m * 60 * 1000);
  }
  if (type === '2_day') return new Date(deadline.getTime() - 48 * 60 * 60 * 1000);
  if (type === '2_hour') return new Date(deadline.getTime() - 2 * 60 * 60 * 1000);
  return null;
}

/**
 * Validate + normalize an array of user-supplied reminder specs.
 *
 * Accepted shapes:
 *   { kind: 'at_due' }
 *   { kind: 'offset', offsetMinutes: <int> }   // values in ALLOWED_OFFSET_MINUTES
 *   { kind: 'custom', at: '<ISO 8601>' }       // future timestamp only
 *
 * Returns { specs: normalized[], errors: string[] }. Invalid specs are
 * dropped with a corresponding error message — callers can choose to
 * 400 on any error or accept the partially-normalized list.
 */
function normalizeReminderSpecs(rawSpecs) {
  const errors = [];
  const specs = [];
  if (!Array.isArray(rawSpecs)) return { specs, errors };

  const seen = new Set(); // dedupe within a single request
  for (const raw of rawSpecs) {
    if (!raw || typeof raw !== 'object') continue;
    const kind = raw.kind || raw.reminderType;
    if (kind === 'at_due') {
      const key = 'at_due';
      if (seen.has(key)) continue;
      seen.add(key);
      specs.push({ reminderType: 'at_due', offsetMinutes: null, customReminderAt: null });
    } else if (kind === 'offset') {
      const m = Number(raw.offsetMinutes);
      if (!Number.isFinite(m) || m <= 0) {
        errors.push(`Invalid offsetMinutes: ${raw.offsetMinutes}`);
        continue;
      }
      if (!ALLOWED_OFFSET_MINUTES.has(m)) {
        errors.push(`Unsupported offsetMinutes: ${m}`);
        continue;
      }
      const key = `offset:${m}`;
      if (seen.has(key)) continue;
      seen.add(key);
      specs.push({ reminderType: 'offset', offsetMinutes: m, customReminderAt: null });
    } else if (kind === 'custom') {
      const at = raw.at || raw.customReminderAt;
      if (!at) {
        errors.push('Custom reminder requires `at` (ISO timestamp).');
        continue;
      }
      const d = new Date(at);
      if (Number.isNaN(d.getTime())) {
        errors.push(`Invalid custom reminder timestamp: ${at}`);
        continue;
      }
      if (d.getTime() <= Date.now()) {
        errors.push('Custom reminder must be in the future.');
        continue;
      }
      const key = `custom:${d.toISOString()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      specs.push({ reminderType: 'custom', offsetMinutes: null, customReminderAt: d });
    } else if (kind === 'interval') {
      const m = Number(raw.intervalMinutes);
      if (!Number.isInteger(m) || m < MIN_INTERVAL_MINUTES || m > MAX_INTERVAL_MINUTES) {
        errors.push(
          `Invalid intervalMinutes: ${raw.intervalMinutes} (must be integer ${MIN_INTERVAL_MINUTES}-${MAX_INTERVAL_MINUTES}).`
        );
        continue;
      }
      // Only one `interval` spec per task (DB unique constraint enforces too).
      if (seen.has('interval')) continue;
      seen.add('interval');
      specs.push({
        reminderType: 'interval',
        offsetMinutes: null,
        customReminderAt: null,
        intervalMinutes: m,
        timesOfDay: null,
        timezone: null,
      });
    } else if (kind === 'daily_times') {
      const rawTimes = Array.isArray(raw.times) ? raw.times : raw.timesOfDay;
      if (!Array.isArray(rawTimes) || rawTimes.length === 0) {
        errors.push('daily_times reminder requires `times` (array of HH:MM strings).');
        continue;
      }
      const cleaned = [];
      let bad = false;
      for (const t of rawTimes) {
        if (!isValidHHMM(t)) {
          errors.push(`Invalid time-of-day: ${t} (must be HH:MM, 24-hour).`);
          bad = true;
          break;
        }
        cleaned.push(t);
      }
      if (bad) continue;
      // Dedupe + sort for stable storage / matching.
      const unique = [...new Set(cleaned)].sort();
      if (unique.length === 0) {
        errors.push('daily_times reminder requires at least one valid time.');
        continue;
      }
      if (unique.length > MAX_DAILY_TIMES) {
        errors.push(`daily_times reminder accepts at most ${MAX_DAILY_TIMES} times (got ${unique.length}).`);
        continue;
      }
      const tz = normalizeTimezone(raw.timezone);
      // Only one `daily_times` spec per task.
      if (seen.has('daily_times')) continue;
      seen.add('daily_times');
      specs.push({
        reminderType: 'daily_times',
        offsetMinutes: null,
        customReminderAt: null,
        intervalMinutes: null,
        timesOfDay: unique,
        timezone: tz,
      });
    } else {
      errors.push(`Unknown reminder kind: ${kind}`);
    }
  }
  return { specs, errors };
}

/**
 * Replace the user-set reminder specs for a task. Cancels rows whose specs
 * are NOT in the new list and upserts the rest.
 *
 * Spec semantics:
 *   - The 2_day / 2_hour legacy rows are NOT touched here. They live
 *     alongside user-set reminders (created/updated via scheduleReminders /
 *     rescheduleReminders).
 *   - For 'at_due' / 'offset': scheduledFor is recomputed from the task's
 *     current dueDate.
 *   - For 'custom': scheduledFor === customReminderAt.
 *   - Specs whose computed scheduledFor is already in the past are SKIPPED
 *     (not inserted) — they would never fire and would clutter the table.
 *
 * @param {string}  taskId
 * @param {object[]} specs Output of normalizeReminderSpecs (or [] to clear).
 * @param {object}  [opts]
 * @param {string}  [opts.dueDate] Task's current dueDate (DATEONLY string).
 *                                 Required when specs include offset/at_due
 *                                 types, ignored for custom-only lists.
 */
async function applyReminderSpecs(taskId, specs, opts = {}) {
  const { TaskReminder } = models();
  const safeSpecs = Array.isArray(specs) ? specs : [];
  const deadline = opts.dueDate ? dueDateToDeadline(opts.dueDate) : null;
  const now = new Date();

  // ── Atomicity / concurrency ──────────────────────────────────────────
  // The reminder picker auto-saves on every chip/toggle click, so a single
  // user gesture (turn "Repeat" on → pick "Specific times") fires two PUT
  // /tasks/:id requests back-to-back. Each lands here and does a read-then-
  // write (cancel rows not in the desired set, then create the desired ones).
  // Without serialization those two requests interleave: request B's "cancel"
  // scan runs before request A's insert has committed, so neither cancels the
  // other and the task ends up with BOTH an `interval` and a `daily_times`
  // row active — or the wrong one active when the order flips. (Observed in
  // prod: tasks with two mutually-exclusive recurring rows created ~1s apart.)
  //
  // Fix: run the whole apply inside ONE transaction and take a per-task
  // Postgres transaction-level advisory lock first. Concurrent calls for the
  // SAME task block at the lock until the first commits, so the second sees
  // the committed state and behaves exactly as it would in isolation. The
  // lock auto-releases at transaction end (commit OR rollback) — no leak.
  // Different tasks hash to different keys and never contend.
  await sequelize.transaction(async (tx) => {
    // Namespaced so we don't collide with the cron advisory locks. hashtext
    // returns int4; cast to bigint for the single-arg lock signature.
    await sequelize.query(
      "SELECT pg_advisory_xact_lock(hashtext($key)::bigint)",
      { bind: { key: `task_reminders:${taskId}` }, transaction: tx }
    );

    // 1. Cancel any existing user-set rows whose spec is no longer requested.
    //    Recurring rows (interval / daily_times) are included here so toggling
    //    the recurring section off in the UI cancels the row instead of
    //    silently leaving it firing forever.
    const existing = await TaskReminder.findAll({
      where: {
        taskId,
        sentAt: null,
        cancelled: false,
        reminderType: { [Op.in]: ['offset', 'at_due', 'custom', 'interval', 'daily_times'] },
      },
      transaction: tx,
    });
    const desiredKeys = new Set(safeSpecs.map(specKey));
    for (const row of existing) {
      if (!desiredKeys.has(specKey(row))) {
        await row.update({ cancelled: true }, { transaction: tx });
      }
    }

    // 2. Create or update each requested spec.
  //
  //    BUG FIX: an earlier version used `TaskReminder.upsert(row, {
  //    conflictFields: ['taskId','reminderType','offsetMinutes','customReminderAt'] })`
  //    against the partial unique index defined in the boot migration:
  //
  //      CREATE UNIQUE INDEX idx_task_reminder_dedup ON task_reminders (
  //        "taskId", "reminderType",
  //        COALESCE("offsetMinutes", -1),
  //        COALESCE("customReminderAt", '1970-01-01 00:00:00+00'::timestamptz)
  //      )
  //
  //    Postgres's ON CONFLICT clause must match an EXISTING unique index by
  //    its index expression list. Sequelize's `conflictFields` only emits
  //    plain column targets — Postgres doesn't have a plain unique on
  //    those four columns, so the upsert threw
  //    `no unique or exclusion constraint matching the ON CONFLICT
  //    specification`. The taskController catch swallowed the error, the
  //    user saw the cancellation phase succeed, no new rows were inserted,
  //    and selecting any chip silently nuked their reminders.
  //
  //    Replacement: explicit findOne by the four-field tuple (Sequelize
  //    correctly emits `IS NULL` for null-valued columns), then update or
  //    create. Reactivates a previously-cancelled row (e.g. user toggles
  //    "15 min before" off and back on) by clearing `cancelled`. Past-due
  //    reminders are skipped — they would never fire.
  //
  //    Concurrency: a SELECT-then-INSERT can race; two callers could both
  //    miss the SELECT and both try to INSERT. The DB unique index then
  //    rejects the second INSERT — we catch the resulting
  //    SequelizeUniqueConstraintError and re-fetch the winning row to
  //    update it. Same shape as the centralised `notificationService.createNotification`
  //    pattern.
    for (const s of safeSpecs) {
      const scheduledFor = computeScheduledFor(s, deadline, now);
      if (!scheduledFor || scheduledFor <= now) continue;

      // The dedup `where` only uses the columns that participate in the
      // partial unique index — (taskId, reminderType, offsetMinutes,
      // customReminderAt). For interval / daily_times both index-coalesced
      // columns are null, so the index already enforces "one such row per
      // task" via the COALESCE sentinels. The extra recurring config
      // (intervalMinutes, timesOfDay, timezone) is written but not part of
      // the dedup key — re-applying with a new interval value updates the
      // existing row in the `if (row)` branch below.
      const where = {
        taskId,
        reminderType: s.reminderType,
        offsetMinutes: s.offsetMinutes ?? null,
        customReminderAt: s.customReminderAt ?? null,
      };

      // Recurring-type extras that need to land on every write.
      const recurringExtras = {
        intervalMinutes: s.intervalMinutes ?? null,
        timesOfDay: s.timesOfDay ?? null,
        timezone: s.timezone ?? null,
      };

      let row = await TaskReminder.findOne({ where, transaction: tx });
      if (row) {
        // Reactivate / refresh. A cancelled row gets uncancelled. A sent row
        // is left alone — once sent, the user's spec re-selection produces a
        // fresh row only after the next dueDate change (legitimate behavior:
        // we don't re-fire historical reminders).
        //
        // For recurring rows we also overwrite the schedule config — the
        // user may have changed "every 2h" → "every 3h", or edited the
        // HH:MM list. Those edits should take effect on the next fire.
        if (!row.sentAt) {
          await row.update({ scheduledFor, cancelled: false, ...recurringExtras }, { transaction: tx });
        }
        continue;
      }

      try {
        // Nested transaction → SAVEPOINT. The per-task advisory lock above
        // already serializes this path, so a unique violation here is only
        // possible from a different code path inserting the same tuple
        // concurrently. Isolating the INSERT in a savepoint means that
        // violation rolls back only this insert, not the whole apply (a bare
        // INSERT failure would otherwise abort the outer transaction and make
        // the recovery query below fail with "current transaction is aborted").
        await sequelize.transaction({ transaction: tx }, async (sp) => {
          await TaskReminder.create({
            ...where,
            ...recurringExtras,
            scheduledFor,
            sentAt: null,
            cancelled: false,
          }, { transaction: sp });
        });
      } catch (err) {
        if (err && (err.name === 'SequelizeUniqueConstraintError'
                    || err.parent?.code === '23505')) {
          // Lost the race; re-fetch + update.
          row = await TaskReminder.findOne({ where, transaction: tx });
          if (row && !row.sentAt) {
            await row.update({ scheduledFor, cancelled: false, ...recurringExtras }, { transaction: tx });
          }
        } else {
          // Surface non-uniqueness errors so the caller can decide. The
          // taskController logs at warn-level and continues — the task
          // update itself still succeeds.
          throw err;
        }
      }
    }
  });
}

/** Stable string key identifying a single reminder spec — same shape for a
 *  TaskReminder row and a normalized spec. Used to diff existing vs desired.
 *
 *  For recurring types we deliberately do NOT include the per-row config
 *  (intervalMinutes / timesOfDay) in the key. Reason: the user updating
 *  "every 2h" → "every 3h" should be an in-place edit of the same logical
 *  reminder, not "cancel the old one + insert a new one". The dedup writer
 *  in applyReminderSpecs handles the config update in the `if (row)` branch.
 */
function specKey(rowOrSpec) {
  const t = rowOrSpec.reminderType;
  if (t === 'offset') return `offset:${rowOrSpec.offsetMinutes}`;
  if (t === 'custom') {
    const at = rowOrSpec.customReminderAt;
    const iso = at instanceof Date ? at.toISOString() : (at ? new Date(at).toISOString() : 'null');
    return `custom:${iso}`;
  }
  return t; // at_due, 2_day, 2_hour, interval, daily_times
}

/**
 * Compact "is there a reminder, and when?" summary for the alarm icon on
 * the board task row. Cheap (one indexed query); intended for use in the
 * board task list response so each row can render a bell without an extra
 * round trip per task.
 *
 * Returns { hasActiveReminder, nextReminderAt, activeReminderCount }.
 *   - hasActiveReminder is true iff at least one row exists with
 *     sentAt IS NULL AND cancelled = false (regardless of reminderType,
 *     so legacy 2_day/2_hour rows also light up the icon).
 *   - nextReminderAt is the earliest scheduledFor across all active rows.
 *   - activeReminderCount is the row count, used for the tooltip.
 *
 * Filters: only returns active reminders. Sent or cancelled reminders are
 * intentionally ignored — the icon should disappear once a reminder has
 * fired or been cancelled (e.g. task completed/archived).
 */
async function getReminderSummary(taskId) {
  const { TaskReminder } = models();
  try {
    const rows = await TaskReminder.findAll({
      where: { taskId, sentAt: null, cancelled: false },
      attributes: ['scheduledFor'],
      order: [['scheduledFor', 'ASC']],
      raw: true,
    });
    if (!rows.length) {
      return { hasActiveReminder: false, nextReminderAt: null, activeReminderCount: 0 };
    }
    return {
      hasActiveReminder: true,
      nextReminderAt: rows[0].scheduledFor,
      activeReminderCount: rows.length,
    };
  } catch {
    return { hasActiveReminder: false, nextReminderAt: null, activeReminderCount: 0 };
  }
}

/**
 * Bulk version of getReminderSummary for the board task list. One query
 * for N tasks instead of N queries — avoids the N+1 problem on large
 * boards.
 *
 * Returns Map<taskId, { hasActiveReminder, nextReminderAt, activeReminderCount }>.
 * Tasks with no active reminders are absent from the map.
 */
async function getReminderSummaryBulk(taskIds) {
  const { TaskReminder } = models();
  if (!Array.isArray(taskIds) || taskIds.length === 0) return new Map();
  try {
    const rows = await TaskReminder.findAll({
      where: {
        taskId: { [Op.in]: taskIds },
        sentAt: null,
        cancelled: false,
      },
      attributes: ['taskId', 'scheduledFor'],
      raw: true,
    });
    const map = new Map();
    for (const r of rows) {
      const cur = map.get(r.taskId);
      if (!cur) {
        map.set(r.taskId, {
          hasActiveReminder: true,
          nextReminderAt: r.scheduledFor,
          activeReminderCount: 1,
        });
      } else {
        cur.activeReminderCount += 1;
        if (r.scheduledFor < cur.nextReminderAt) cur.nextReminderAt = r.scheduledFor;
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * List the user-set reminder specs for a task, in a shape the frontend
 * Create/Edit modal can render directly. Excludes legacy 2_day/2_hour
 * because those are auto-managed and not user-configurable.
 *
 * Returns ONLY active reminders (sentAt IS NULL, cancelled = false).
 *
 * Why we hide sent reminders: an earlier version returned them too "for
 * historical context", but that produced a delete-persistence bug —
 *
 *   1. A custom reminder fires at 5:11 PM and `sentAt` is set.
 *   2. The modal re-opens and shows the 5:11 PM chip (still cancelled=false).
 *   3. User clicks `×` to remove it. The PUT sends `reminders: [...]`
 *      without that spec.
 *   4. `applyReminderSpecs` filters `sentAt: null` when computing the
 *      "rows to cancel" set, so the sent row is never cancelled.
 *   5. On the next modal open the row is still there → looks like the
 *      delete failed.
 *
 * Fix: hide sent reminders from the modal entirely. They are not
 * actionable (they've already fired) and surfacing them invited the
 * mismatch above. If product later wants to show a "fired" history,
 * that should be a separate UI surface backed by a dedicated query —
 * not the active-reminders array the chip UI binds to.
 */
async function getUserReminderSpecs(taskId) {
  const { TaskReminder } = models();
  const rows = await TaskReminder.findAll({
    where: {
      taskId,
      // Recurring rows can be in the "between fires" state (sentAt=null,
      // scheduledFor in future). They're still active and the modal needs
      // to surface them so the user can edit / disable.
      sentAt: null,
      cancelled: false,
      reminderType: { [Op.in]: ['offset', 'at_due', 'custom', 'interval', 'daily_times'] },
    },
    order: [['scheduledFor', 'ASC']],
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.reminderType,
    offsetMinutes: r.offsetMinutes,
    customReminderAt: r.customReminderAt,
    intervalMinutes: r.intervalMinutes,
    timesOfDay: r.timesOfDay,
    timezone: r.timezone,
    scheduledFor: r.scheduledFor,
    sent: false,
  }));
}

// ─── Process pending reminders (called by cron) ─────────────────

/**
 * Find all reminders whose scheduledFor <= now, that have not been sent
 * or cancelled, and send notifications to every assignee/supervisor.
 *
 * Concurrency model — claim-first:
 *   The naive "find pending → notify → set sentAt" pattern has two failure
 *   modes:
 *     (1) Process crash between notify and update → the same reminder is
 *         picked up again next tick → duplicate notification.
 *     (2) Multi-replica race: two replicas both pass the WHERE filter, both
 *         notify, then both update.
 *
 *   We close both holes with a conditional UPDATE that flips `sentAt` from
 *   NULL → NOW() inside a single SQL statement scoped to the row id. Only
 *   the worker whose update returned `affected=1` proceeds to send. The
 *   `RETURNING` clause is functionally a SELECT-FOR-UPDATE without holding
 *   a row lock — Postgres serialises concurrent updates on the same row.
 *
 *   If sending the notification fails AFTER the claim, the reminder stays
 *   marked sent and we don't retry — that matches the existing behaviour
 *   (sendNotification swallows errors and logs them); the trade-off is
 *   "occasional missed notification on send failure" vs. "occasional
 *   duplicate on crash". Missed-on-error is the safer default for users.
 */
async function processReminders() {
  const { TaskReminder, Task, Board, TaskAssignee, User } = models();
  const now = new Date();

  // Find pending reminders that are due. We don't try to lock here — the
  // per-row conditional UPDATE below is the actual mutex.
  //
  // Hard cap: MAX_REMINDERS_PER_CRON_RUN (default 100, was 200). Ordered by
  // scheduledFor ASC so the oldest due reminders fire first and any overflow
  // drains on the next minute tick — that's effectively immediate from the
  // user's perspective.
  const pendingReminders = await TaskReminder.findAll({
    where: {
      scheduledFor: { [Op.lte]: now },
      sentAt: null,
      cancelled: false,
    },
    order: [['scheduledFor', 'ASC']],
    limit: MAX_REMINDERS_PER_CRON_RUN,
  });

  if (pendingReminders.length === 0) return;

  // Per-tick budget — caps user-level notification flooding for tasks with
  // many assignees/supervisors AND for an unlucky reviewer who's a recipient
  // on many tasks whose reminders all fired in the same minute.
  const budget = createBudget();
  let sent = 0;
  let userLimited = 0;
  let skipped = 0;

  console.log(`[DeadlineReminder] Processing ${pendingReminders.length} pending reminder(s)...`);

  for (const reminder of pendingReminders) {
    try {
      // Load the task with board info
      const task = await Task.findByPk(reminder.taskId, {
        include: [{ model: Board, as: 'board', attributes: ['id', 'name'] }],
      });

      // Task deleted entirely → cancel this reminder
      if (!task) {
        await reminder.update({ cancelled: true });
        continue;
      }

      // Archived tasks: always skip + cancel. Whether the reminder is
      // auto-generated or user-set, an archived task is dead — firing a
      // ping for it is noise.
      if (task.isArchived === true) {
        logger.info('[DeadlineReminder] skip + cancel reminder (archived)', {
          reminderId: reminder.id,
          taskId: task.id,
          reminderType: reminder.reminderType,
        });
        await reminder.update({ cancelled: true });
        continue;
      }

      // Eligibility gate — applies ONLY to the legacy auto reminders
      // (2_day / 2_hour). Those exist to nudge an assignee about an
      // upcoming deadline; if the task is already done, archived, or
      // sitting with a reviewer, the nudge is wrong and we cancel.
      //
      // User-set reminders (offset / at_due / custom) are deliberately
      // exempt: the user EXPLICITLY chose to be pinged at this moment.
      // A task that's currently "waiting_for_review" might still warrant
      // the ping ("check whether the reviewer got back to me"), and a
      // `pending_approval` state can flip to `changes_requested` — at
      // which point the user is back on the hook and grateful for the
      // reminder they themselves set. The prior code unconditionally
      // CANCELLED these (destructive) on the first non-actionable tick,
      // silently losing the user's intent.
      const isAutoLegacyReminder =
        reminder.reminderType === '2_day' || reminder.reminderType === '2_hour';
      if (isAutoLegacyReminder) {
        const eligibility = isTaskEligibleForOverdueNotification(task);
        if (!eligibility.eligible) {
          logger.info('[DeadlineReminder] skip + cancel auto reminder', {
            reminderId: reminder.id,
            taskId: task.id,
            reminderType: reminder.reminderType,
            status: task.status,
            approvalStatus: task.approvalStatus,
            reason: eligibility.reason,
          });
          await reminder.update({ cancelled: true });
          continue;
        }
      } else {
        // For user-set reminders, the only additional skip we still respect
        // is "task is completed". Firing "remind me about X" after X is
        // already done is noise. We CANCEL here (not just skip) because
        // `done` is monotonic in practice — re-opening a done task is
        // rare and going through `changes_requested` for approved tasks.
        if (isCompletedStatus(task.status)) {
          logger.info('[DeadlineReminder] skip + cancel user reminder (task done)', {
            reminderId: reminder.id,
            taskId: task.id,
            reminderType: reminder.reminderType,
            status: task.status,
          });
          await reminder.update({ cancelled: true });
          continue;
        }
      }

      // Verify deadline hasn't changed (guard against stale reminders).
      // For legacy 2_day/2_hour rows we still check; for offset/custom rows
      // (added in Phase B5) the scheduledFor is the source of truth and we
      // rely on the upsert in scheduleReminders to keep it correct.
      if (reminder.reminderType === '2_day' || reminder.reminderType === '2_hour') {
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
      }

      // ── CLAIM ─────────────────────────────────────────────────
      // Atomic flip of sentAt: NULL → NOW(). Only the worker whose UPDATE
      // returns affectedCount=1 proceeds to send. Two replicas hitting the
      // same row will see one win and one no-op (the second reads the same
      // sentAt IS NULL row but its UPDATE matches zero rows after the first
      // commits). This is the line that makes processReminders safe under
      // concurrency.
      const [claimed] = await TaskReminder.update(
        { sentAt: now },
        { where: { id: reminder.id, sentAt: null, cancelled: false } }
      );
      if (!claimed) {
        // Another worker (or a previous tick after a hot restart) already
        // claimed this. Skip without sending.
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
        // Claim already taken; mark cancelled too so no future tick re-picks
        // the row even if claim were ever rolled back.
        await reminder.update({ cancelled: true });
        continue;
      }

      // Build notification content. Different reminder types get different
      // copy; the underlying `due_date` enum is shared.
      const boardName = task.board ? task.board.name : 'Unknown Board';
      const deadlineStr = task.dueDate; // e.g. '2026-04-10'
      const reminderCopy = buildReminderCopy(reminder, task, boardName, deadlineStr);
      const notifType = reminderCopy.type;

      for (const [userId, user] of recipientMap) {
        if (!budget.tryReserve(userId)) {
          userLimited += 1;
          // The reminder is already claimed (sentAt set). We log the skip
          // but do NOT un-claim — un-claiming would risk a duplicate fire
          // on the next minute tick. Idempotency-key dedup at the DB layer
          // is the durable defence against duplicates if we ever DO retry.
          logger.info('[DeadlineReminder] budget-skipped recipient', {
            reminderId: reminder.id, userId, taskId: task.id,
          });
          continue;
        }
        try {
          const title = reminderCopy.title(user.name);
          const message = reminderCopy.body(user.name);
          await sendNotification(userId, title, message, notifType, task.id, {
            email: user.email,
            userName: user.name,
            // Stable per-reminder key — reminder row id is already unique,
            // pair with userId so per-recipient retries collapse. Any
            // duplicate cron tick (or process restart) that re-loads the
            // same reminder row before claim succeeds is then a no-op at
            // the partial unique index.
            idempotencyKey: buildIdempotencyKey('reminder', reminder.id, userId),
          });
          sent += 1;
        } catch (err) {
          // Per-recipient isolation — one user's send must not block the others.
          logger.warn(
            `[DeadlineReminder] send failed (reminder=${reminder.id}, user=${userId}): ${err?.message || err}`
          );
        }
      }

      console.log(`[DeadlineReminder] Sent ${reminder.reminderType} reminder for task "${task.title}" to ${recipientMap.size} user(s)`);

      // ── RE-ARM (recurring types only) ─────────────────────────────────
      // After a successful claim + dispatch on `interval` or `daily_times`,
      // compute the next fire and reset sentAt to NULL so the row gets
      // picked up again. Stop re-arming once the task is done or archived.
      //
      // Race-safety: re-fetch the task status RIGHT BEFORE the UPDATE.
      // cancelReminders() filters on `sentAt IS NULL`, so a complete-task
      // mutation that landed between our claim (sentAt=now) and this point
      // would NOT have flagged the row cancelled. Without this re-check we
      // could re-arm a row whose task just got marked done — leading to a
      // ping the user explicitly silenced.
      const isRecurring =
        reminder.reminderType === 'interval' || reminder.reminderType === 'daily_times';
      if (isRecurring) {
        const fresh = await Task.findByPk(task.id, {
          attributes: ['id', 'status', 'isArchived'],
        });
        const stopRearm =
          !fresh ||
          fresh.isArchived === true ||
          isCompletedStatus(fresh.status);
        if (stopRearm) {
          await reminder.update({ cancelled: true, lastFiredAt: now });
        } else {
          const nextFire = computeScheduledFor(reminder, null, now);
          if (nextFire && nextFire > now) {
            await reminder.update({
              scheduledFor: nextFire,
              sentAt: null,
              lastFiredAt: now,
            });
          } else {
            // Defensive: nextFire couldn't be computed (e.g. corrupted
            // timesOfDay). Cancel so we don't fire-loop on a broken row.
            logger.warn('[DeadlineReminder] recurring re-arm failed; cancelling', {
              reminderId: reminder.id, taskId: task.id, type: reminder.reminderType,
            });
            await reminder.update({ cancelled: true, lastFiredAt: now });
          }
        }
      }
    } catch (err) {
      skipped += 1;
      logger.error(`[DeadlineReminder] Error processing reminder ${reminder.id}:`, err);
    }
  }

  const b = budget.summary();
  logger.info('[DeadlineReminder] tick', {
    candidates: pendingReminders.length,
    sent,
    skipped,
    userLimitedCount: b.userLimitedCount,
    jobLimitedCount: b.jobLimitedCount,
    uniqueUsers: b.uniqueUsers,
  });
  if (userLimited > 0 || pendingReminders.length >= MAX_REMINDERS_PER_CRON_RUN) {
    logger.warn('[DeadlineReminder] hit caps', {
      candidates: pendingReminders.length,
      sent,
      userLimitedCount: b.userLimitedCount,
      nextTickWillDrain: true,
    });
  }
}

/**
 * Map a TaskReminder row to (title, body, notification type). Centralised
 * so 2_day / 2_hour / offset_minutes / custom reminders all produce
 * consistent copy.
 *
 * Returned `title` and `body` are functions of recipient name so the same
 * reminder row can be sent to multiple recipients (assignees + supervisors)
 * with personalised greetings.
 */
function buildReminderCopy(reminder, task, boardName, deadlineStr) {
  const taskTitle = task.title;
  const board = ` on board "${boardName}"`;
  const due = deadlineStr ? ` (due ${deadlineStr})` : '';

  if (reminder.reminderType === '2_day') {
    return {
      type: 'due_date',
      title: () => `Reminder: ${taskTitle} is due in 2 days`,
      body: (name) =>
        `Hi ${name}, the task "${taskTitle}"${board} is due on ${deadlineStr}. ` +
        `You have 2 days remaining. Please review your progress.`,
    };
  }
  if (reminder.reminderType === '2_hour') {
    return {
      type: 'due_date',
      title: () => `Urgent: ${taskTitle} is due in 2 hours`,
      body: (name) =>
        `Hi ${name}, the task "${taskTitle}"${board} is due on ${deadlineStr}. ` +
        `Only 2 hours remaining — please ensure everything is complete.`,
    };
  }
  if (reminder.reminderType === 'custom') {
    return {
      type: 'due_date',
      title: () => `Reminder: ${taskTitle}`,
      body: (name) =>
        `Hi ${name}, this is your reminder for the task "${taskTitle}"${board}${due}.`,
    };
  }
  if (reminder.reminderType === 'interval') {
    const m = Number(reminder.intervalMinutes);
    let every = 'a while';
    if (Number.isFinite(m) && m > 0) {
      if (m >= 1440 && m % 1440 === 0) {
        const d = m / 1440;
        every = `${d} day${d === 1 ? '' : 's'}`;
      } else if (m >= 60 && m % 60 === 0) {
        const h = m / 60;
        every = `${h} hour${h === 1 ? '' : 's'}`;
      } else {
        every = `${m} minute${m === 1 ? '' : 's'}`;
      }
    }
    return {
      type: 'due_date',
      title: () => `Reminder: ${taskTitle}`,
      body: (name) =>
        `Hi ${name}, this is your repeating reminder for "${taskTitle}"${board}. ` +
        `You'll be reminded every ${every} until the task is marked done.`,
    };
  }
  if (reminder.reminderType === 'daily_times') {
    const times = Array.isArray(reminder.timesOfDay) ? reminder.timesOfDay : [];
    const list = times.length > 0 ? times.join(', ') : 'scheduled times';
    return {
      type: 'due_date',
      title: () => `Reminder: ${taskTitle}`,
      body: (name) =>
        `Hi ${name}, this is your daily reminder for "${taskTitle}"${board}. ` +
        `You'll be reminded at ${list} every day until the task is marked done.`,
    };
  }
  // offset_minutes (5/15/30/60/120/1440 etc.) — read from offsetMinutes if
  // available, otherwise derive a friendly description from the timestamps.
  const offset = reminder.offsetMinutes;
  let phrase = 'soon';
  if (typeof offset === 'number' && offset > 0) {
    if (offset >= 1440 && offset % 1440 === 0) {
      const days = offset / 1440;
      phrase = `in ${days} day${days === 1 ? '' : 's'}`;
    } else if (offset >= 60 && offset % 60 === 0) {
      const hours = offset / 60;
      phrase = `in ${hours} hour${hours === 1 ? '' : 's'}`;
    } else {
      phrase = `in ${offset} minute${offset === 1 ? '' : 's'}`;
    }
  } else if (offset === 0) {
    phrase = 'now';
  }
  return {
    type: 'due_date',
    title: () => `Reminder: ${taskTitle} is due ${phrase}`,
    body: (name) =>
      `Hi ${name}, the task "${taskTitle}"${board} is due ${phrase}${due}. Please plan accordingly.`,
  };
}

module.exports = {
  scheduleReminders,
  cancelReminders,
  rescheduleReminders,
  processReminders,
  // Phase 5 — user-configured task reminders.
  applyReminderSpecs,
  normalizeReminderSpecs,
  getUserReminderSpecs,
  getReminderSummary,
  getReminderSummaryBulk,
  ALLOWED_OFFSET_MINUTES,
  // Recurring-reminder bounds (used by validators + tests).
  MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
  MAX_DAILY_TIMES,
};