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

/**
 * Compute the absolute UTC `scheduledFor` for a reminder spec given a
 * deadline. Returns null if the spec doesn't depend on a deadline (custom
 * type) or if the deadline is missing.
 *
 * @param {object} reminder Either a TaskReminder row or a normalized spec.
 * @param {Date}   deadline UTC deadline timestamp.
 */
function computeScheduledFor(reminder, deadline) {
  const type = reminder.reminderType;
  if (type === 'custom') {
    // For custom type, scheduledFor === customReminderAt — independent
    // of dueDate. Returning null here lets callers detect and skip the
    // recomputation path.
    const at = reminder.customReminderAt;
    return at instanceof Date ? at : (at ? new Date(at) : null);
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

  // 1. Cancel any existing user-set rows whose spec is no longer requested.
  //    We do this BEFORE inserting so a race where the row briefly missing
  //    is acceptable — the cron wakes every 15 min anyway.
  const existing = await TaskReminder.findAll({
    where: {
      taskId,
      sentAt: null,
      cancelled: false,
      reminderType: { [Op.in]: ['offset', 'at_due', 'custom'] },
    },
  });
  const desiredKeys = new Set(safeSpecs.map(specKey));
  for (const row of existing) {
    if (!desiredKeys.has(specKey(row))) {
      await row.update({ cancelled: true });
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
    const scheduledFor = computeScheduledFor(s, deadline);
    if (!scheduledFor || scheduledFor <= now) continue;

    const where = {
      taskId,
      reminderType: s.reminderType,
      offsetMinutes: s.offsetMinutes ?? null,
      customReminderAt: s.customReminderAt ?? null,
    };

    let row = await TaskReminder.findOne({ where });
    if (row) {
      // Reactivate / refresh. A cancelled row gets uncancelled. A sent row
      // is left alone — once sent, the user's spec re-selection produces a
      // fresh row only after the next dueDate change (legitimate behavior:
      // we don't re-fire historical reminders).
      if (!row.sentAt) {
        await row.update({ scheduledFor, cancelled: false });
      }
      continue;
    }

    try {
      await TaskReminder.create({
        ...where,
        scheduledFor,
        sentAt: null,
        cancelled: false,
      });
    } catch (err) {
      if (err && (err.name === 'SequelizeUniqueConstraintError'
                  || err.parent?.code === '23505')) {
        // Lost the race; re-fetch + update.
        row = await TaskReminder.findOne({ where });
        if (row && !row.sentAt) {
          await row.update({ scheduledFor, cancelled: false });
        }
      } else {
        // Surface non-uniqueness errors so the caller can decide. The
        // taskController logs at warn-level and continues — the task
        // update itself still succeeds.
        throw err;
      }
    }
  }
}

/** Stable string key identifying a single reminder spec — same shape for a
 *  TaskReminder row and a normalized spec. Used to diff existing vs desired. */
function specKey(rowOrSpec) {
  const t = rowOrSpec.reminderType;
  if (t === 'offset') return `offset:${rowOrSpec.offsetMinutes}`;
  if (t === 'custom') {
    const at = rowOrSpec.customReminderAt;
    const iso = at instanceof Date ? at.toISOString() : (at ? new Date(at).toISOString() : 'null');
    return `custom:${iso}`;
  }
  return t; // at_due, 2_day, 2_hour
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
 */
async function getUserReminderSpecs(taskId) {
  const { TaskReminder } = models();
  const rows = await TaskReminder.findAll({
    where: {
      taskId,
      cancelled: false,
      reminderType: { [Op.in]: ['offset', 'at_due', 'custom'] },
    },
    order: [['scheduledFor', 'ASC']],
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.reminderType,
    offsetMinutes: r.offsetMinutes,
    customReminderAt: r.customReminderAt,
    scheduledFor: r.scheduledFor,
    sent: !!r.sentAt,
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
        try {
          const title = reminderCopy.title(user.name);
          const message = reminderCopy.body(user.name);
          await sendNotification(userId, title, message, notifType, task.id, {
            email: user.email,
            userName: user.name,
          });
        } catch (err) {
          // Per-recipient isolation — one user's send must not block the others.
          logger.warn(
            `[DeadlineReminder] send failed (reminder=${reminder.id}, user=${userId}): ${err?.message || err}`
          );
        }
      }

      console.log(`[DeadlineReminder] Sent ${reminder.reminderType} reminder for task "${task.title}" to ${recipientMap.size} user(s)`);
    } catch (err) {
      logger.error(`[DeadlineReminder] Error processing reminder ${reminder.id}:`, err);
    }
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
};