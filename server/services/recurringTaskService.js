/**
 * Recurring Task Service — generation engine for the Daily Work / Recurring Work
 * workflow.
 *
 * Responsibilities:
 *   1. Compute a template's NEXT eligible occurrence date in its local timezone
 *      based on frequency (daily / weekdays / weekly / monthly / custom).
 *   2. Generate a concrete Task instance for a given (template, occurrenceDate)
 *      pair — idempotent, transactional, safe under concurrent invocation.
 *   3. Advance template bookkeeping (lastGeneratedDate, nextRunAt) atomically.
 *
 * IMPORTANT — idempotency contract:
 *   The DB partial unique index `tasks_recurring_template_occurrence_unique`
 *   on (recurringTemplateId, occurrenceDate) WHERE recurringTemplateId IS NOT
 *   NULL is THE source of truth. Two concurrent calls to generateInstance for
 *   the same (template, occurrenceDate) are guaranteed to produce exactly one
 *   row — the second call's INSERT raises SequelizeUniqueConstraintError which
 *   we catch and convert into a "skipped (already exists)" result.
 *
 * Timezone handling:
 *   We never trust the host's local timezone. Every date computation goes
 *   through the template's `timezone` field (IANA name, e.g. "Asia/Kolkata",
 *   default "UTC"). Native `Intl.DateTimeFormat` is used to extract Y/M/D/H/M
 *   in the target zone — no luxon/moment dependency required.
 */

const { Op } = require('sequelize');
const { sequelize } = require('../config/db');
const {
  Task,
  RecurringTaskTemplate,
  TaskAssignee,
  TaskOwner,
  Board,
  User,
} = require('../models');
const { sendNotification, buildIdempotencyKey } = require('./notificationService');
const { logActivity } = require('./activityService');
const realtime = require('./realtimeService');
const boardMembershipService = require('./boardMembershipService');
const logger = require('../utils/logger');

// Lazy requires for two services that we want to invoke fire-and-forget from
// the post-commit side-effect path. Hoisting them to top-of-file would create
// a circular import risk (reminderService imports models() which imports the
// barrel that imports this service via the cron job graph); requiring inside
// the side-effect keeps the dependency one-way.
function _reminderService() {
  try { return require('./reminderService'); } catch (_) { return null; }
}
function _calendarService() {
  try { return require('./calendarService'); } catch (_) { return null; }
}

// ─── Structured per-template logging ────────────────────────────────────────
//
// Every generation attempt — success, skip, or error — emits a single line
// through `logger` so prod operators can grep
// `[RecurringGen]` and reconstruct exactly what happened to a given template
// on a given day. Keep this stable; downstream log parsers depend on the
// field names. `source` is the job/controller that triggered the call.
function emitGenLog(level, status, template, fields = {}) {
  const tplId = template?.id || fields.recurringTemplateId || null;
  const payload = {
    event: 'recurring_generation',
    status,
    recurringTemplateId: tplId,
    boardId: fields.boardId ?? template?.boardId ?? null,
    groupId: fields.groupId ?? template?.groupId ?? null,
    assigneeId: fields.assigneeId ?? template?.assigneeId ?? null,
    frequency: fields.frequency ?? template?.frequency ?? null,
    occurrenceDate: fields.occurrenceDate ?? null,
    generatedTaskId: fields.generatedTaskId ?? null,
    reason: fields.reason ?? null,
    source: fields.source ?? null,
    timestamp: new Date().toISOString(),
  };
  const fn = logger[level] || logger.info;
  fn(`[RecurringGen] ${status}`, payload);
}

// ─── Timezone-safe date helpers ─────────────────────────────────────────────

/**
 * Return { year, month, day, weekday, hour, minute } for `date` rendered in
 * the IANA `timezone`. Pure: does not mutate `date`. Falls back to UTC if the
 * timezone string is invalid.
 *
 * Weekday is 0=Sunday … 6=Saturday (ISO-style would be 1=Monday, but we use the
 * JS getDay() convention because it matches `template.weekdays` semantics
 * established by the schema).
 */
function partsInZone(date, timezone) {
  let tz = timezone || 'UTC';
  try {
    // Touch the formatter once to validate the zone; if invalid, this throws.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch (e) {
    tz = 'UTC';
  }
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const lookup = {};
  for (const part of fmt.formatToParts(date)) {
    lookup[part.type] = part.value;
  }
  // Intl reports hour=24 for midnight in some locales — normalise to 0.
  let hour = parseInt(lookup.hour, 10);
  if (hour === 24) hour = 0;
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: parseInt(lookup.year, 10),
    month: parseInt(lookup.month, 10),
    day: parseInt(lookup.day, 10),
    hour,
    minute: parseInt(lookup.minute, 10),
    weekday: weekdayMap[lookup.weekday] ?? 0,
  };
}

/** Format a Y/M/D as "YYYY-MM-DD" (DATEONLY-compatible). */
function formatDateOnly(year, month, day) {
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${year}-${m}-${d}`;
}

/**
 * Convert a wall-clock moment in `timezone` (year/month/day at hh:mm:ss) into
 * a UTC Date instance.
 *
 * Algorithm:
 *   1. Pretend the requested wall clock IS UTC → ts0.
 *   2. Ask Intl what `timezone` says at ts0; the gap between the requested
 *      wall clock and the rendered wall clock IS the timezone offset.
 *   3. Subtract that offset from ts0 — done in one shot for non-DST cases.
 *   4. DST safety: re-render at the result; if the rendered wall clock
 *      doesn't match the request (DST flip moved us across a discontinuity),
 *      recompute using the offset at the result and apply once more.
 *
 * Returning a wall-clock time that doesn't exist (the spring-forward gap) or
 * is ambiguous (the fall-back overlap) is left to the caller — for our use
 * case (00:05 in tz, plus user-chosen due times) those edge cases are
 * exceptional and the result is "best effort consistent with the rendered
 * wall clock".
 */
function zonedTimeToUtc(year, month, day, hour, minute, second, timezone) {
  const tz = timezone || 'UTC';
  const sec = second || 0;
  const ts0 = Date.UTC(year, month - 1, day, hour, minute, sec, 0);

  const p0 = partsInZone(new Date(ts0), tz);
  const offset0 = Date.UTC(p0.year, p0.month - 1, p0.day, p0.hour, p0.minute, sec, 0) - ts0;
  let result = ts0 - offset0;

  // DST refinement — only kicks in when the offset at ts0 differs from the
  // offset at result (twice-yearly transitions in zones that observe DST).
  const p1 = partsInZone(new Date(result), tz);
  if (p1.hour !== hour || p1.minute !== minute || p1.day !== day) {
    const offset1 = Date.UTC(p1.year, p1.month - 1, p1.day, p1.hour, p1.minute, sec, 0) - result;
    result = ts0 - offset1;
  }
  return new Date(result);
}

/** Parse "HH:mm[:ss]" → { hour, minute, second }. Defensive against null. */
function parseDueTime(dueTime) {
  if (!dueTime) return { hour: 18, minute: 0, second: 0 };
  // Postgres TIME comes back as "HH:mm:ss"; controller input may be "HH:mm".
  const m = String(dueTime).match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return { hour: 18, minute: 0, second: 0 };
  return {
    hour: Math.min(23, parseInt(m[1], 10) || 0),
    minute: Math.min(59, parseInt(m[2], 10) || 0),
    second: m[3] ? Math.min(59, parseInt(m[3], 10) || 0) : 0,
  };
}

/** Last day of (year, month). month is 1-12. */
function lastDayOfMonth(year, month) {
  // new Date(y, m, 0) returns the last day of month (m). m is 1-12 here, JS is
  // 0-11 internally, so passing m directly + day 0 lands on month-1's last day.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Add `days` to a Y/M/D triple, returning a new Y/M/D triple. */
function addDays(year, month, day, days) {
  const ts = Date.UTC(year, month - 1, day) + days * 24 * 60 * 60 * 1000;
  const d = new Date(ts);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Normalise a template's monthly day configuration into a sorted, deduped
 * integer array (1–31).
 *
 * Backward compatibility: prefers the modern `daysOfMonth` JSONB array. Falls
 * back to the legacy `dayOfMonth` integer when the array is missing/empty so
 * pre-migration templates keep working without a data backfill on the read
 * path. Returns [] when neither is set.
 */
function getMonthlyDays(template) {
  const arr = Array.isArray(template.daysOfMonth) ? template.daysOfMonth : [];
  const cleaned = arr
    .map((d) => parseInt(d, 10))
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 31);
  if (cleaned.length > 0) {
    return [...new Set(cleaned)].sort((a, b) => a - b);
  }
  const legacy = parseInt(template.dayOfMonth, 10);
  if (Number.isInteger(legacy) && legacy >= 1 && legacy <= 31) return [legacy];
  return [];
}

/**
 * Does this template generate an instance for the calendar date represented by
 * { year, month, day, weekday } in its own timezone?
 *
 * - daily         → always yes
 * - weekdays      → Mon–Sat (weekday in 1..6)
 * - weekly        → weekday must appear in template.weekdays array
 * - monthly       → day must equal one of getMonthlyDays(template), with each
 *                   target day capped at the month's last day (31 collapses to
 *                   28/29/30). Multiple configured days that collapse to the
 *                   same effective day yield ONE eligibility hit per calendar
 *                   day; the partial unique index
 *                   `tasks_recurring_template_occurrence_unique` is the final
 *                   guard against duplicate task rows.
 * - custom        → same semantics as `weekly`
 */
function isOccurrenceEligible(template, parts) {
  switch (template.frequency) {
    case 'daily':
      return true;
    case 'weekdays':
      return parts.weekday >= 1 && parts.weekday <= 6;
    case 'weekly':
    case 'custom': {
      const list = Array.isArray(template.weekdays) ? template.weekdays : [];
      if (list.length === 0) return false;
      return list.includes(parts.weekday);
    }
    case 'monthly': {
      const days = getMonthlyDays(template);
      if (days.length === 0) return false;
      const lastDay = lastDayOfMonth(parts.year, parts.month);
      // Collapse out-of-range days (e.g. 31 in Feb) onto the last day of the
      // month. A Set handles the 30+31 case in Feb both collapsing to 28.
      const effectiveSet = new Set(days.map((d) => Math.min(d, lastDay)));
      return effectiveSet.has(parts.day);
    }
    default:
      return false;
  }
}

// ─── Public: occurrence-date / nextRunAt math ───────────────────────────────

/**
 * Compute the next eligible occurrenceDate (YYYY-MM-DD) for `template`,
 * starting from `fromDate` (default: now). "Next" means the earliest date >=
 * `fromDate` (in template tz) that satisfies the frequency rule and falls
 * within [startDate, endDate].
 *
 * Returns null if no such date exists (e.g. endDate already past).
 *
 * Bound: searches at most 366 days ahead (safety net for misconfigured custom
 * recurrences with empty weekday arrays — those return null harmlessly).
 */
function nextOccurrenceDate(template, fromDate = new Date()) {
  const tz = template.timezone || 'UTC';
  const startStr = String(template.startDate);
  const endStr = template.endDate ? String(template.endDate) : null;

  // Anchor: max(fromDate today in tz, template.startDate).
  const todayParts = partsInZone(fromDate, tz);
  let cur = { year: todayParts.year, month: todayParts.month, day: todayParts.day };
  const curStr = formatDateOnly(cur.year, cur.month, cur.day);
  if (curStr < startStr) {
    const [y, m, d] = startStr.split('-').map(Number);
    cur = { year: y, month: m, day: d };
  }

  for (let i = 0; i < 366; i += 1) {
    const dateStr = formatDateOnly(cur.year, cur.month, cur.day);
    if (endStr && dateStr > endStr) return null;

    // Use noon-UTC of the candidate date as a cheap weekday probe in the
    // template tz — same calendar day in any reasonable zone.
    const probe = new Date(Date.UTC(cur.year, cur.month - 1, cur.day, 12, 0, 0));
    const parts = partsInZone(probe, tz);
    const candidate = { ...parts, year: cur.year, month: cur.month, day: cur.day };
    if (isOccurrenceEligible(template, candidate)) return dateStr;

    cur = addDays(cur.year, cur.month, cur.day, 1);
  }
  return null;
}

/**
 * For an `occurrenceDate` string ("YYYY-MM-DD"), compute the UTC timestamp at
 * which the cron should generate this instance (i.e. 00:05 in the template
 * timezone on that date).
 *
 * Returning a UTC Date allows the cron job to do a simple `nextRunAt <= now`
 * comparison without ever dealing with timezone arithmetic again.
 */
function generationRunAtUtc(occurrenceDate, timezone) {
  const [y, m, d] = String(occurrenceDate).split('-').map(Number);
  return zonedTimeToUtc(y, m, d, 0, 5, 0, timezone || 'UTC');
}

/**
 * For an `occurrenceDate` + the template's `dueTime`, compute the actual
 * deadline UTC timestamp. Used by the missed-escalation job.
 */
function dueAtUtc(occurrenceDate, dueTime, timezone) {
  const [y, m, d] = String(occurrenceDate).split('-').map(Number);
  const t = parseDueTime(dueTime);
  return zonedTimeToUtc(y, m, d, t.hour, t.minute, t.second, timezone || 'UTC');
}

/**
 * Recompute and persist the template's nextRunAt based on its current state.
 * Called after a successful generation, after pause/resume, and after edits.
 *
 * If the template has no future eligible date (passed endDate, or invalid
 * config), nextRunAt is set to null — the cron will simply ignore the row.
 */
async function recomputeNextRunAt(template, options = {}) {
  const fromDate = options.fromDate || new Date();
  // The next *future* occurrence is anchored to "tomorrow in tz" if today's
  // already been generated (lastGeneratedDate matches today), otherwise to
  // today. Concretely: we pick max(today, lastGeneratedDate+1) as the search
  // anchor, then nextOccurrenceDate finds the first eligible date >= anchor.
  const tz = template.timezone || 'UTC';
  const todayParts = partsInZone(fromDate, tz);
  let anchor = { year: todayParts.year, month: todayParts.month, day: todayParts.day };

  if (template.lastGeneratedDate) {
    const [ly, lm, ld] = String(template.lastGeneratedDate).split('-').map(Number);
    const tomorrow = addDays(ly, lm, ld, 1);
    const anchorStr = formatDateOnly(anchor.year, anchor.month, anchor.day);
    const tomorrowStr = formatDateOnly(tomorrow.year, tomorrow.month, tomorrow.day);
    if (tomorrowStr > anchorStr) anchor = tomorrow;
  }

  // Build a probe date in UTC that, when rendered in tz, lands on `anchor`.
  // Using noon avoids DST edge cases at the day boundary.
  const probe = zonedTimeToUtc(anchor.year, anchor.month, anchor.day, 12, 0, 0, tz);
  const occurrenceDate = nextOccurrenceDate(template, probe);

  if (!occurrenceDate) {
    if (template.nextRunAt !== null) {
      await template.update({ nextRunAt: null }, { transaction: options.transaction });
    }
    return null;
  }

  const nextRunAt = generationRunAtUtc(occurrenceDate, tz);
  await template.update({ nextRunAt }, { transaction: options.transaction });
  return { occurrenceDate, nextRunAt };
}

// ─── Public: instance generation ────────────────────────────────────────────

/**
 * Pre-flight validation before generation. Verifies that the template's
 * referenced board / assignee / group are still in a state where we can
 * safely insert a Task row. Returns { ok: true } when generation can proceed,
 * else { ok: false, reason } so the caller can log and skip rather than
 * half-creating data.
 *
 * NB: We deliberately do these checks OUTSIDE the transaction. They're pure
 * reads, they're cheap, and a failure here means we don't want to even open a
 * tx — keeps the abort surface small.
 */
async function validateTemplateForGeneration(template) {
  if (!template) return { ok: false, reason: 'template-missing' };
  if (!template.isActive) return { ok: false, reason: 'template-paused' };
  if (template.archivedAt) return { ok: false, reason: 'template-archived' };
  if (!template.boardId) return { ok: false, reason: 'template-missing-boardId' };
  if (!template.assigneeId) return { ok: false, reason: 'template-missing-assigneeId' };
  if (!template.createdBy) return { ok: false, reason: 'template-missing-createdBy' };

  const board = await Board.findByPk(template.boardId, {
    attributes: ['id', 'isArchived', 'groups'],
  });
  if (!board) return { ok: false, reason: 'board-missing' };
  if (board.isArchived) return { ok: false, reason: 'board-archived' };

  // groupId is a string referencing a group inside `board.groups` JSONB.
  // Convention from CreateBoardModal: `'new'` is the implicit "default group"
  // and is allowed even if it doesn't appear explicitly in `board.groups` —
  // matches taskController.createTask which also accepts 'new' as a fallback.
  const gid = template.groupId || 'new';
  const groups = Array.isArray(board.groups) ? board.groups : [];
  if (gid !== 'new' && groups.length > 0 && !groups.some((g) => g && g.id === gid)) {
    return { ok: false, reason: 'group-missing-on-board' };
  }

  const assignee = await User.findOne({
    where: { id: template.assigneeId },
    attributes: ['id', 'isActive'],
  });
  if (!assignee) return { ok: false, reason: 'assignee-missing' };
  if (assignee.isActive === false) return { ok: false, reason: 'assignee-inactive' };

  return { ok: true };
}

/**
 * Idempotently generate a Task instance for the given (template, occurrenceDate).
 *
 * Returns one of:
 *   { ok: true, created: true, task }     — instance created this call
 *   { ok: true, created: false, task }    — instance already existed (no-op)
 *   { ok: false, reason: '...' }          — pre-condition failed (e.g. paused)
 *
 * Transaction model:
 *   The Task row + the task_assignees row + the task_owners row all live in a
 *   SINGLE Sequelize transaction. If ANY of them fails (FK violation, schema
 *   drift, unique conflict, etc.) the entire write is rolled back — we never
 *   leave a half-created instance. The DB partial unique index
 *   (recurringTemplateId, occurrenceDate) guarantees at-most-once on retry.
 *
 * Why this is safer than the earlier "log-and-continue inside the tx":
 *   In Postgres, a single failed statement aborts the whole transaction; any
 *   later statement (including COMMIT) raises "current transaction is aborted".
 *   Catch-and-continue inside a tx is a footgun. We let the error bubble out
 *   so the caller sees a clean "this attempt failed" signal and the cron will
 *   retry on the next tick (idempotency-protected).
 */
async function generateInstance(template, occurrenceDate, options = {}) {
  const source = options.source || null;

  if (!template) {
    emitGenLog('warn', 'error', null, { reason: 'template-missing', source });
    return { ok: false, reason: 'Template missing.' };
  }
  if (!occurrenceDate) {
    emitGenLog('warn', 'error', template, { reason: 'occurrenceDate-missing', source });
    return { ok: false, reason: 'occurrenceDate missing.' };
  }

  // Date-window guard: caller may have computed a date outside [start, end].
  if (String(occurrenceDate) < String(template.startDate)) {
    emitGenLog('info', 'skipped', template, { occurrenceDate, reason: 'before-start-date', source });
    return { ok: false, reason: 'occurrenceDate is before template.startDate.' };
  }
  if (template.endDate && String(occurrenceDate) > String(template.endDate)) {
    emitGenLog('info', 'skipped', template, { occurrenceDate, reason: 'after-end-date', source });
    return { ok: false, reason: 'occurrenceDate is after template.endDate.' };
  }

  // Pre-flight validation outside the tx — keeps the abort surface tight.
  const pre = await validateTemplateForGeneration(template);
  if (!pre.ok) {
    // P1-8 — surface deactivated-assignee skips as a structured warn so log
    // pipelines can alert on it (the cron loop continues with the next template).
    if (pre.reason === 'assignee-inactive' || pre.reason === 'assignee-missing') {
      console.warn(
        `[RecurringTask] Skipping template ${template.id} — assignee ${template.assigneeId} inactive`
      );
    }
    emitGenLog('warn', 'skipped', template, { occurrenceDate, reason: pre.reason, source });
    return { ok: false, reason: pre.reason };
  }

  // Fast-path: instance already exists — avoid the unique-violation path
  // (Sequelize's SequelizeUniqueConstraintError aborts the entire tx, which
  // would clobber sibling work in an external tx and leave us re-rolling).
  const externalTx = options.transaction;
  try {
    const existing = await Task.findOne({
      where: { recurringTemplateId: template.id, occurrenceDate },
      transaction: externalTx,
    });
    if (existing) {
      emitGenLog('info', 'skipped', template, {
        occurrenceDate,
        generatedTaskId: existing.id,
        reason: 'already-exists',
        source,
      });
      return { ok: true, created: false, task: existing };
    }
  } catch (err) {
    emitGenLog('error', 'error', template, {
      occurrenceDate,
      reason: `fast-path-failed: ${err.message}`,
      source,
    });
    throw err;
  }

  // Open the write transaction. Everything Task-side is one atomic unit so a
  // failure anywhere inside leaves the DB clean and lets cron retry.
  const t = externalTx || (await sequelize.transaction());

  try {
    let task;
    try {
      task = await Task.create(
        {
          title: template.title,
          description: template.description || '',
          status: 'not_started',
          priority: template.priority,
          groupId: template.groupId || 'new',
          dueDate: occurrenceDate,
          progress: 0,
          isArchived: false,
          boardId: template.boardId,
          assignedTo: template.assigneeId,
          createdBy: template.createdBy,
          recurringTemplateId: template.id,
          occurrenceDate,
          isRecurringInstance: true,
          missedEscalationSent: false,
        },
        { transaction: t }
      );
    } catch (err) {
      const isUniqueViolation = err.name === 'SequelizeUniqueConstraintError'
        || /unique/i.test(err.message)
        || /duplicate key/i.test(err?.parent?.message || '');
      if (!isUniqueViolation) throw err;
      // Concurrent worker won the race. Roll back this tx (Postgres has
      // already aborted it) and re-fetch the canonical winner row.
      if (!externalTx) {
        try { await t.rollback(); } catch (_) { /* ignore */ }
      }
      const winner = await Task.findOne({
        where: { recurringTemplateId: template.id, occurrenceDate },
      });
      emitGenLog('info', 'skipped', template, {
        occurrenceDate,
        generatedTaskId: winner?.id || null,
        reason: 'race-lost-unique',
        source,
      });
      // External-tx callers must NOT see a committed/rolled-back signal — let
      // them know it was a no-op via raceLost so they can carry on.
      if (externalTx) {
        return { ok: true, created: false, task: null, raceLost: true };
      }
      return { ok: true, created: false, task: winner };
    }

    // task_assignees row — used by TaskModal, dashboard queries, the workflow
    // page, etc. Failures here ROLL BACK the parent tx (no half-created Task).
    // `assignedAt`, `assignerId` are nullable / defaulted at the model level
    // so a minimal payload is safe.
    await TaskAssignee.create(
      {
        taskId: task.id,
        userId: template.assigneeId,
        role: 'assignee',
        assignedAt: new Date(),
        assignerId: template.createdBy,
      },
      { transaction: t }
    );

    // task_owners row — parity with normal task creation
    // (taskController.createTask). PersonCell, exports, dashboards that read
    // ownership from `task_owners` need this. isPrimary=true so the assignee
    // is rendered with the star indicator like a normal task.
    if (TaskOwner) {
      await TaskOwner.create(
        {
          taskId: task.id,
          userId: template.assigneeId,
          isPrimary: true,
        },
        { transaction: t }
      );
    }

    if (!externalTx) await t.commit();

    // Side-effects (notification + activity) happen OUTSIDE the tx so a
    // notification failure can never roll back the generated instance.
    await afterInstanceCreated(template, task);

    emitGenLog('info', 'success', template, {
      occurrenceDate,
      generatedTaskId: task.id,
      source,
    });

    return { ok: true, created: true, task };
  } catch (err) {
    if (!externalTx) {
      try { await t.rollback(); } catch (_) { /* ignore double-rollback */ }
    }
    emitGenLog('error', 'error', template, {
      occurrenceDate,
      reason: err.message,
      source,
    });
    throw err;
  }
}

/**
 * Side-effects to run AFTER the instance row is committed. Fire-and-forget;
 * each individual side-effect is wrapped in its own try/catch so one failure
 * doesn't suppress the others.
 *
 * Side-effect ordering matters once: autoAddMember must run BEFORE
 * emitTaskCreated. emitTaskCreated targets users authorised to view the task,
 * which is computed via taskVisibilityService — that path consults
 * BoardMembers, so the assignee being a board member is what makes the event
 * actually reach them. Without the membership row, the realtime event would
 * fan out to nobody on a board the assignee was never explicitly added to.
 */
async function afterInstanceCreated(template, task) {
  // 1. Mirror normal task creation: ensure the assignee is a board member.
  //    taskController.createTask does this exact call after each new
  //    assignment; without it, an assignee who isn't already on the board
  //    won't see the task in their sidebar / list. The call is idempotent
  //    (ON CONFLICT DO NOTHING) so re-running on existing memberships is safe.
  try {
    if (task.assignedTo && task.boardId) {
      await boardMembershipService.autoAddMember(task.boardId, task.assignedTo);
    }
  } catch (e) {
    logger.warn('[recurringTaskService] autoAddMember failed', {
      templateId: template.id, taskId: task.id, msg: e.message,
    });
  }

  // 2. Realtime fan-out — same event shape as normal task creation
  //    (taskController.createTask emits realtime.emitTaskCreated). The
  //    eventRouter on the client invalidates `tasks.board.<boardId>`,
  //    `tasks.id.<taskId>`, `tasks.assignedTo.me`, and `dashboard.stats`
  //    automatically — no client-side change required.
  //
  //    actorId = template.createdBy because the human who set up the
  //    recurrence is the closest analogue to "the user who just created
  //    this task". Some receivers use it to suppress self-echo.
  //
  //    extraUserIds (F-6 fix): pre-seed the recipient set with the assignee
  //    and creator so getAuthorizedRealtimeRecipients can short-circuit the
  //    junction-table lookup. The just-created task isn't hydrated with
  //    taskAssignees / owners associations, so without this hint the resolver
  //    issues 2-3 extra SELECTs against a row we already know about.
  try {
    realtime.emitTaskCreated(task, {
      actorId: template.createdBy,
      extraUserIds: [template.assigneeId, template.createdBy].filter(Boolean),
    });
  } catch (e) {
    // emitTaskCreated is itself fire-and-forget; this catch is belt+braces.
    logger.warn('[recurringTaskService] emitTaskCreated threw', {
      templateId: template.id, taskId: task.id, msg: e.message,
    });
  }

  // 2b. Schedule pre-deadline reminders (F-1 — parity with normal task
  //    creation). Mirror taskController.createTask: scheduleReminders is
  //    upsert-style and skips reminder times already in the past, so it's
  //    safe to call for instances seeded later in the day. Fire-and-forget.
  try {
    const rs = _reminderService();
    if (rs && task.dueDate) {
      rs.scheduleReminders(task.id, task.dueDate).catch((err) =>
        logger.warn('[recurringTaskService] scheduleReminders failed', {
          taskId: task.id, msg: err.message,
        })
      );
    }
  } catch (e) {
    logger.warn('[recurringTaskService] scheduleReminders threw', {
      templateId: template.id, taskId: task.id, msg: e.message,
    });
  }

  // 2c. Sync to Teams/Outlook calendar (F-2 — parity with normal task
  //    creation). Mirrors taskController.createTask. Service no-ops when the
  //    assignee has no Teams integration; fire-and-forget.
  try {
    const cs = _calendarService();
    if (cs && task.assignedTo) {
      cs.createTaskEvent(task.id, task.assignedTo).catch((err) =>
        logger.warn('[recurringTaskService] calendar createTaskEvent failed', {
          taskId: task.id, msg: err.message,
        })
      );
    }
  } catch (e) {
    logger.warn('[recurringTaskService] calendar sync threw', {
      templateId: template.id, taskId: task.id, msg: e.message,
    });
  }

  // 3. In-app + push notification to the assignee.
  //
  // Idempotency: a duplicate cron tick (process restart mid-tick, replica
  // race, manual generate-now retry) must not create a second "your
  // recurring task is ready" notification. The (taskId, assigneeId) tuple
  // is unique per generated instance — the DB partial unique index on
  // (userId, idempotencyKey) collapses any retry to a SELECT of the
  // already-existing row.
  try {
    await sendNotification(
      template.assigneeId,
      'Daily Work assigned',
      `Today's "${template.title}" is ready. Due ${task.dueDate} at ${formatDueTimeForHumans(template.dueTime)}.`,
      'recurring_generated',
      task.id,
      {
        idempotencyKey: buildIdempotencyKey(
          'recurring-generated',
          task.id,
          template.assigneeId,
        ),
      }
    );
  } catch (e) {
    logger.warn('[recurringTaskService] notification failed', { templateId: template.id, taskId: task.id, msg: e.message });
  }

  // 4. Activity log (audit trail). Fire-and-forget per project convention.
  try {
    logActivity({
      action: 'created',
      description: `Generated recurring instance "${template.title}" for ${task.occurrenceDate}`,
      entityType: 'task',
      entityId: task.id,
      taskId: task.id,
      boardId: task.boardId,
      userId: template.createdBy,
      meta: { recurringTemplateId: template.id, occurrenceDate: task.occurrenceDate },
    });
  } catch (e) {
    // logActivity is already fire-and-forget but defensive.
  }
}

// F-11 — process-local idempotency cache for "preflight failed" notifications.
// Keyed by `${templateId}:${reason}` and TTL'd implicitly by process lifetime
// (a process restart resends the notification, which is acceptable: a fresh
// process means an op event and re-pinging the template owner is fine).
const _preflightNoticeSent = new Set();

/**
 * Surface a recurring-template preflight failure (assignee inactive,
 * board archived, group missing) to the template's creator exactly once
 * per process, then clear `nextRunAt` so the cron stops re-evaluating it.
 *
 * Why "creator" rather than "assignee" or "admin":
 *   - The creator set up the rule; they're the most likely to act on the
 *     "your template stopped generating" signal (reassign, restore board,
 *     update startDate, etc.).
 *   - Notifying the assignee on `assignee-inactive` would be moot — the
 *     account is deactivated.
 *
 * Reasons that warrant a user-facing notice. Anything outside this list is
 * either transient (race-lost, fast-path-failed) or expected (before-start-
 * date, after-end-date) and gets filtered out.
 */
const ACTIONABLE_PREFLIGHT_REASONS = new Set([
  'assignee-inactive',
  'assignee-missing',
  'board-archived',
  'board-missing',
  'group-missing-on-board',
]);

async function notifyPreflightFailureOnce(template, reason) {
  if (!template || !reason) return;
  if (!ACTIONABLE_PREFLIGHT_REASONS.has(reason)) return;
  const key = `${template.id}:${reason}`;
  if (_preflightNoticeSent.has(key)) return;
  _preflightNoticeSent.add(key);

  // Stop the cron loop from rechecking this template until the operator
  // intervenes. recomputeNextRunAt would otherwise keep re-scheduling it.
  try {
    if (template.nextRunAt !== null) {
      await template.update({ nextRunAt: null });
    }
  } catch (e) {
    logger.warn('[recurringTaskService] preflight-failure nextRunAt clear failed', {
      templateId: template.id, msg: e.message,
    });
  }

  const friendly = {
    'assignee-inactive': 'the assignee account is deactivated',
    'assignee-missing': 'the assignee account no longer exists',
    'board-archived': 'the board is archived',
    'board-missing': 'the board no longer exists',
    'group-missing-on-board': 'the configured group no longer exists on the board',
  }[reason] || reason;

  try {
    await sendNotification(
      template.createdBy,
      'Recurring template paused',
      `Your recurring template "${template.title}" has stopped generating because ${friendly}. Edit the template to fix the configuration or reassign it.`,
      'recurring_generated',
      template.id
    );
  } catch (e) {
    logger.warn('[recurringTaskService] preflight-failure notification failed', {
      templateId: template.id, msg: e.message,
    });
  }
}

function formatDueTimeForHumans(dueTime) {
  const t = parseDueTime(dueTime);
  const ampm = t.hour >= 12 ? 'PM' : 'AM';
  const h12 = ((t.hour + 11) % 12) + 1;
  const mm = String(t.minute).padStart(2, '0');
  return `${h12}:${mm} ${ampm}`;
}

// ─── Public: seed the NEXT UPCOMING instance ────────────────────────────────

/**
 * Generate the NEXT eligible occurrence (today or any future day) immediately.
 *
 * Called from `createTemplate`, `updateTemplate` (when schedule changes), and
 * `resumeTemplate` so the assignee sees a concrete task in their board the
 * moment a recurring rule is set up — even when the actual due date is in the
 * future. The dueDate / occurrenceDate on the generated row reflect the
 * scheduled day (e.g. "next Tuesday" for a weekly Tue template created on
 * Thursday), and the cron later skips that day because the partial unique
 * index `(recurringTemplateId, occurrenceDate)` rejects a second insert.
 *
 * Distinct from `runTemplateOnce` (cron path) which only generates for TODAY
 * when today is eligible. Both paths share `generateInstance` so the
 * idempotency / transaction / autoAddMember / realtime emit story is one place.
 *
 * Effects on `lastGeneratedDate` / `nextRunAt`:
 *   - On success, `lastGeneratedDate` is advanced to the seeded occurrence
 *     date. `recomputeNextRunAt` then anchors on `lastGeneratedDate + 1`,
 *     pointing the cron at the FOLLOWING occurrence (e.g. the Tue after the
 *     one we just seeded).
 *   - On no-future-occurrence (endDate already past, empty weekdays, etc.)
 *     `nextRunAt` is set to NULL via `recomputeNextRunAt` so the cron never
 *     reconsiders the row.
 *
 * Never throws — errors are caught and surfaced as `{ ok:false, error }`.
 */
async function seedNextUpcomingInstance(template, options = {}) {
  const fromDate = options.fromDate || new Date();
  const source = options.source || 'seedNextUpcomingInstance';

  if (!template) {
    return { ok: false, reason: 'template-missing' };
  }
  if (template.archivedAt) {
    return { ok: false, reason: 'template-archived' };
  }
  if (!template.isActive) {
    return { ok: false, reason: 'template-paused' };
  }

  // Compute the next eligible occurrence — today wins if eligible, otherwise
  // the earliest future eligible day inside [startDate, endDate].
  let occurrenceDate = nextOccurrenceDate(template, fromDate);

  // F-10: avoid creating an instantly-overdue task. If the seed picked
  // "today" but the configured dueTime has already passed in the template
  // timezone, skip ahead to TOMORROW and re-run nextOccurrenceDate from
  // there. Two-step skip rather than a loop because consecutive eligible
  // days never both fall before "now" (we only just transitioned through
  // midnight). Caller can still opt into "I know, do it anyway" via
  // options.allowSameDayOverdue when this is being invoked from a context
  // (e.g. backfill / generate-now) where past-due is the desired outcome.
  if (occurrenceDate && !options.allowSameDayOverdue) {
    const tz = template.timezone || 'UTC';
    const todayParts = partsInZone(fromDate, tz);
    const todayStr = formatDateOnly(todayParts.year, todayParts.month, todayParts.day);
    if (occurrenceDate === todayStr) {
      const dueAt = dueAtUtc(occurrenceDate, template.dueTime, tz);
      if (dueAt.getTime() <= fromDate.getTime()) {
        const tomorrow = addDays(todayParts.year, todayParts.month, todayParts.day, 1);
        const probe = zonedTimeToUtc(tomorrow.year, tomorrow.month, tomorrow.day, 12, 0, 0, tz);
        const next = nextOccurrenceDate(template, probe);
        if (next) {
          emitGenLog('info', 'skipped', template, {
            occurrenceDate: todayStr,
            reason: 'same-day-due-time-passed-skipping-to-next',
            source,
          });
          occurrenceDate = next;
        }
        // If no future eligible date exists, leave occurrenceDate as today —
        // the user explicitly asked for a recurring rule with no upcoming
        // eligible date, and creating today's overdue row is still the
        // closest match to their intent.
      }
    }
  }

  if (!occurrenceDate) {
    // endDate in the past, or schedule that yields no eligible day in the
    // 366-day search window. Make sure nextRunAt reflects "nothing to do".
    try { await recomputeNextRunAt(template, { fromDate }); }
    catch (e) { /* non-fatal — the cron will re-evaluate next tick */ }
    emitGenLog('info', 'skipped', template, {
      reason: 'no-future-occurrence', source,
    });
    return {
      ok: true,
      generated: false,
      alreadyExisted: false,
      occurrenceDate: null,
      nextRunAt: null,
      reason: 'no-future-occurrence',
    };
  }

  let result;
  try {
    result = await generateInstance(template, occurrenceDate, { source });
  } catch (err) {
    emitGenLog('error', 'error', template, {
      occurrenceDate, reason: err.message, source,
    });
    return { ok: false, reason: err.message, error: err.message, occurrenceDate };
  }

  if (!result.ok) {
    // Pre-flight failed (board archived, assignee inactive, group missing).
    // Still recompute nextRunAt so the cron has a coherent view.
    try { await recomputeNextRunAt(template, { fromDate }); }
    catch (e) { /* non-fatal */ }
    return {
      ok: false,
      generated: false,
      alreadyExisted: false,
      occurrenceDate,
      reason: result.reason,
    };
  }

  // Success (created OR already-existed). Advance lastGeneratedDate so
  // recomputeNextRunAt anchors past this date — the cron will then skip the
  // seeded day and pick up the FOLLOWING occurrence.
  //
  // Forward-only: if lastGeneratedDate is already further in the future
  // (e.g. caller seeded twice with different fromDates), don't regress it.
  const cur = template.lastGeneratedDate ? String(template.lastGeneratedDate) : null;
  if (!cur || occurrenceDate >= cur) {
    if (template.lastGeneratedDate !== occurrenceDate) {
      try { await template.update({ lastGeneratedDate: occurrenceDate }); }
      catch (e) {
        emitGenLog('warn', 'error', template, {
          occurrenceDate, reason: `lastGeneratedDate update failed: ${e.message}`, source,
        });
      }
    }
  }

  let nextRunAt = null;
  try {
    const next = await recomputeNextRunAt(template, { fromDate });
    nextRunAt = next ? next.nextRunAt : null;
  } catch (e) {
    emitGenLog('warn', 'error', template, {
      occurrenceDate, reason: `recomputeNextRunAt failed: ${e.message}`, source,
    });
  }

  return {
    ok: true,
    generated: !!result.created,
    alreadyExisted: !!(result.task && !result.created),
    occurrenceDate,
    nextRunAt,
    taskId: result.task?.id || null,
  };
}

// ─── Public: orchestrator used by the cron job ──────────────────────────────

/**
 * Process a single template:
 *   1. Compute today's occurrenceDate in template tz.
 *   2. If eligible and not already generated, call generateInstance.
 *   3. Recompute nextRunAt for the next eligible day.
 *
 * Returns { templateId, generated, occurrenceDate, nextRunAt, error? } for
 * structured logging. Never throws — errors are caught and surfaced in the
 * return value.
 */
async function runTemplateOnce(template, options = {}) {
  const fromDate = options.fromDate || new Date();
  const source = options.source || null;
  const tz = template.timezone || 'UTC';
  const todayParts = partsInZone(fromDate, tz);
  const todayStr = formatDateOnly(todayParts.year, todayParts.month, todayParts.day);

  // F-3: Cap how many missed eligible days we'll backfill in one tick. A
  // misconfigured monthly template that fires on day 31 in February 30+ years
  // ago must not produce hundreds of rows. Daily templates with a one-week
  // outage stay well under this. Per-tick generated-count is also bounded by
  // the cron's own batch (200 templates × 31 = a wide cap).
  const BACKFILL_CAP = Math.max(1, Math.min(31, parseInt(options.backfillCap, 10) || 31));

  try {
    // Skip if outside [startDate, endDate] window.
    if (todayStr < String(template.startDate)) {
      // Not yet started — schedule nextRunAt to startDate@00:05.
      await recomputeNextRunAt(template, { fromDate });
      emitGenLog('info', 'skipped', template, {
        occurrenceDate: todayStr, reason: 'before-start-date', source,
      });
      return { templateId: template.id, generated: false, reason: 'before-start-date' };
    }
    if (template.endDate && todayStr > String(template.endDate)) {
      await template.update({ nextRunAt: null });
      emitGenLog('info', 'skipped', template, {
        occurrenceDate: todayStr, reason: 'after-end-date', source,
      });
      return { templateId: template.id, generated: false, reason: 'after-end-date' };
    }

    // F-3 (bounded backfill): if cron was offline across one or more eligible
    // days, walk forward from max(startDate, lastGeneratedDate+1) up to today
    // and generate each missing eligible occurrence. The DB partial unique
    // index `tasks_recurring_template_occurrence_unique` makes the inner
    // generateInstance call idempotent, so a concurrent replica or a re-run
    // can't produce duplicates. We cap the walk to BACKFILL_CAP iterations.
    //
    // Why prefer this over a single forward jump: monthly templates can lose
    // an entire month if the cron is off across the 15th. Daily templates
    // would otherwise need an explicit "missed days" admin tool. This is the
    // smallest change that closes the gap without rewriting the cron.
    const startStr = String(template.startDate);
    const endStr = template.endDate ? String(template.endDate) : null;
    let walkStart;
    if (template.lastGeneratedDate) {
      const [ly, lm, ld] = String(template.lastGeneratedDate).split('-').map(Number);
      const next = addDays(ly, lm, ld, 1);
      const nextStr = formatDateOnly(next.year, next.month, next.day);
      walkStart = nextStr > startStr ? nextStr : startStr;
    } else {
      walkStart = startStr;
    }
    // Don't walk into the future.
    if (walkStart > todayStr) walkStart = todayStr;

    const generated = [];
    const skipped = [];
    let lastTouchedDate = null;

    let cursorParts = walkStart.split('-').map(Number);
    let cursor = { year: cursorParts[0], month: cursorParts[1], day: cursorParts[2] };
    let iterations = 0;
    while (iterations < BACKFILL_CAP) {
      const dateStr = formatDateOnly(cursor.year, cursor.month, cursor.day);
      if (dateStr > todayStr) break;
      if (endStr && dateStr > endStr) break;

      const probe = new Date(Date.UTC(cursor.year, cursor.month - 1, cursor.day, 12, 0, 0));
      const parts = partsInZone(probe, tz);
      const candidate = { ...parts, year: cursor.year, month: cursor.month, day: cursor.day };

      if (isOccurrenceEligible(template, candidate)) {
        const result = await generateInstance(template, dateStr, { source });
        if (result.ok) {
          if (result.created) generated.push({ dateStr, taskId: result.task?.id });
          else skipped.push({ dateStr, reason: 'already-exists' });
          lastTouchedDate = dateStr;
        } else {
          // Pre-flight failed (e.g. assignee inactive). Log and stop walking
          // — there's no point hammering subsequent days with the same
          // condition.
          emitGenLog('warn', 'skipped', template, {
            occurrenceDate: dateStr, reason: result.reason, source,
          });
          // F-11: surface persistent generation failures to the template's
          // creator and clear nextRunAt so the cron stops thrashing. Notify
          // only on actionable reasons, idempotent via a flag we attach to
          // the template (see notifyPreflightFailureOnce below).
          await notifyPreflightFailureOnce(template, result.reason).catch(() => {});
          break;
        }
      }

      const next = addDays(cursor.year, cursor.month, cursor.day, 1);
      cursor = next;
      iterations += 1;
    }

    // Advance lastGeneratedDate to the most recent eligible date we touched.
    // Forward-only — never regress.
    if (lastTouchedDate && lastTouchedDate !== template.lastGeneratedDate
        && (!template.lastGeneratedDate || lastTouchedDate > String(template.lastGeneratedDate))) {
      await template.update({ lastGeneratedDate: lastTouchedDate });
    }

    // Always recompute nextRunAt — covers (a) generated something, advance to
    // the next eligible day after the last touched date; (b) nothing
    // eligible in the walk, advance past `today` to the next eligible date.
    const next = await recomputeNextRunAt(template, { fromDate });

    if (generated.length === 0 && skipped.length === 0) {
      emitGenLog('info', 'skipped', template, {
        occurrenceDate: todayStr, reason: 'no-eligible-day-in-window', source,
      });
    }

    return {
      templateId: template.id,
      generated: generated.length > 0,
      generatedCount: generated.length,
      backfilled: generated.length > 1,
      alreadyExisted: skipped.length > 0,
      occurrenceDate: lastTouchedDate,
      nextRunAt: next ? next.nextRunAt : null,
      details: { generated, skipped },
    };
  } catch (err) {
    logger.error('[recurringTaskService] runTemplateOnce failed', {
      templateId: template.id,
      msg: err.message,
      stack: err.stack,
    });
    emitGenLog('error', 'error', template, {
      occurrenceDate: todayStr, reason: err.message, source,
    });
    return { templateId: template.id, generated: false, error: err.message };
  }
}

// ─── Public: reassign open instances when template assignee changes ─────────

/**
 * Reassign every OPEN generated instance of `template` from `oldAssigneeId`
 * to `newAssigneeId`. "Open" = not archived, status not 'done'. Historical
 * (completed / archived) rows are intentionally untouched per spec — they
 * are the audit trail of who did the work.
 *
 * Per-task atomic write inside a single transaction:
 *   - tasks.assignedTo                 → newAssigneeId
 *   - task_assignees role='assignee'   → delete OLD, upsert NEW
 *   - task_owners (primary)            → delete OLD, upsert NEW with isPrimary
 *
 * Side-effects (post-commit, fire-and-forget per row):
 *   - boardMembershipService.autoAddMember(boardId, newAssigneeId)
 *   - boardMembershipService.cleanupIfNoTasksRemain(oldAssigneeId, boardId)
 *   - reminderService.rescheduleReminders(taskId, newDueDate)
 *   - calendarService.deleteTaskEvent(taskId, oldAssigneeId)
 *     + calendarService.createTaskEvent(taskId, newAssigneeId)
 *   - realtime.emitTaskUpdated(task, { extraUserIds: [oldAssigneeId, newAssigneeId] })
 *   - sendNotification(newAssigneeId, 'task_assigned')
 *
 * Idempotent: re-running with the same arguments is a no-op once everything
 * is in sync. The TaskAssignee/TaskOwner unique-on-(taskId,userId,role) /
 * (taskId,userId) indexes guarantee no duplicate rows.
 *
 * Returns:
 *   { ok: true, reassigned: N, alreadyConsistent: M, errors: [{ taskId, msg }] }
 *
 * Never throws — controller can surface `errors` to the user as a partial
 * success warning.
 */
async function reassignOpenInstances(template, oldAssigneeId, newAssigneeId, options = {}) {
  if (!template) return { ok: false, reason: 'template-missing' };
  if (!oldAssigneeId || !newAssigneeId) {
    return { ok: false, reason: 'missing-assignee-ids' };
  }
  if (String(oldAssigneeId) === String(newAssigneeId)) {
    return { ok: true, reassigned: 0, alreadyConsistent: 0, errors: [], reason: 'no-op' };
  }

  // Open = not archived AND not completed. We intentionally exclude rows
  // already pointing at newAssigneeId — they're already in sync (e.g. from a
  // prior partial reassignment or an admin who already touched them).
  const openInstances = await Task.findAll({
    where: {
      recurringTemplateId: template.id,
      isRecurringInstance: true,
      isArchived: false,
      status: { [Op.ne]: 'done' },
    },
    attributes: ['id', 'boardId', 'assignedTo', 'dueDate', 'occurrenceDate', 'status'],
    order: [['occurrenceDate', 'DESC']],
  });

  if (openInstances.length === 0) {
    return { ok: true, reassigned: 0, alreadyConsistent: 0, errors: [] };
  }

  const actorId = options.actorId || newAssigneeId;
  let reassigned = 0;
  let alreadyConsistent = 0;
  const errors = [];
  const touchedBoards = new Set();
  const touchedTasks = [];

  for (const inst of openInstances) {
    const t = await sequelize.transaction();
    try {
      // 1. Pivot the legacy scalar column. Only writes when the row actually
      //    needs to change so a re-run is a no-op.
      let didChange = false;
      if (String(inst.assignedTo) !== String(newAssigneeId)) {
        await inst.update({ assignedTo: newAssigneeId }, { transaction: t });
        didChange = true;
      }

      // 2. task_assignees row — replace OLD assignee role row with NEW. Use
      //    findOrCreate to absorb the case where NEW already has a row
      //    (e.g. previous reassignment that crashed mid-flight).
      await TaskAssignee.destroy({
        where: { taskId: inst.id, role: 'assignee', userId: { [Op.ne]: newAssigneeId } },
        transaction: t,
      });
      const [taRow, taCreated] = await TaskAssignee.findOrCreate({
        where: { taskId: inst.id, userId: newAssigneeId, role: 'assignee' },
        defaults: {
          assignedAt: new Date(),
          assignerId: actorId,
        },
        transaction: t,
      });
      if (taCreated) didChange = true;
      // Touch unused var to satisfy linter without changing semantics.
      void taRow;

      // 3. task_owners row — clear all owners pointing at someone other than
      //    NEW, then upsert NEW as primary.
      await TaskOwner.destroy({
        where: { taskId: inst.id, userId: { [Op.ne]: newAssigneeId } },
        transaction: t,
      });
      const [toRow, toCreated] = await TaskOwner.findOrCreate({
        where: { taskId: inst.id, userId: newAssigneeId },
        defaults: { isPrimary: true },
        transaction: t,
      });
      if (toCreated) {
        didChange = true;
      } else if (!toRow.isPrimary) {
        await toRow.update({ isPrimary: true }, { transaction: t });
        didChange = true;
      }

      await t.commit();

      if (didChange) {
        reassigned += 1;
        touchedTasks.push(inst);
        touchedBoards.add(inst.boardId);
      } else {
        alreadyConsistent += 1;
      }
    } catch (err) {
      try { await t.rollback(); } catch (_) { /* ignore */ }
      errors.push({ taskId: inst.id, msg: err.message });
      logger.error('[recurringTaskService] reassign tx failed', {
        templateId: template.id,
        taskId: inst.id,
        oldAssigneeId,
        newAssigneeId,
        msg: err.message,
      });
    }
  }

  // Post-commit side-effects. Each block is its own try/catch so one failure
  // never suppresses the others.

  // Auto-add NEW assignee to every touched board (idempotent ON CONFLICT).
  for (const bid of touchedBoards) {
    try {
      await boardMembershipService.autoAddMember(bid, newAssigneeId);
    } catch (e) {
      logger.warn('[recurringTaskService] reassign autoAddMember failed', {
        boardId: bid, userId: newAssigneeId, msg: e.message,
      });
    }
  }

  // Cleanup OLD assignee from each touched board IF they have no other
  // visibility into it. Helper checks creator / explicit / remaining task
  // membership before deleting — safe.
  for (const bid of touchedBoards) {
    try {
      await boardMembershipService.cleanupIfNoTasksRemain(oldAssigneeId, bid);
    } catch (e) {
      logger.warn('[recurringTaskService] reassign cleanupIfNoTasksRemain failed', {
        boardId: bid, userId: oldAssigneeId, msg: e.message,
      });
    }
  }

  // Per-task realtime + reminder + calendar updates.
  for (const inst of touchedTasks) {
    // Reminders — old reminders still reference taskId (which doesn't move),
    // but rescheduleReminders cancels + recreates. Safe.
    try {
      const rs = _reminderService();
      if (rs && inst.dueDate) {
        rs.rescheduleReminders(inst.id, inst.dueDate).catch(() => {});
      }
    } catch (_) { /* fire-and-forget */ }

    // Calendar — delete from OLD mailbox, create on NEW mailbox.
    try {
      const cs = _calendarService();
      if (cs) {
        cs.deleteTaskEvent(inst.id, oldAssigneeId).catch(() => {});
        cs.createTaskEvent(inst.id, newAssigneeId).catch(() => {});
      }
    } catch (_) { /* fire-and-forget */ }

    // Realtime — emit task:updated to BOTH old (so they drop the row from
    // MyWork) and new (so they pick it up) plus all other authorized
    // recipients computed from the task's own associations.
    try {
      // Reload to capture the updated assignedTo + freshly-written junction
      // rows so getAuthorizedRealtimeRecipients sees the new state. Cheap
      // single-row fetch.
      const fresh = await Task.findByPk(inst.id, {
        include: [
          { model: TaskAssignee, as: 'taskAssignees', attributes: ['userId', 'role'], required: false },
          { model: TaskOwner, as: 'owners', through: { attributes: ['isPrimary'] }, required: false },
        ],
      });
      if (fresh) {
        realtime.emitTaskUpdated(fresh, {
          actorId,
          changedFields: ['assignedTo'],
          extraUserIds: [oldAssigneeId, newAssigneeId].filter(Boolean),
        });
      }
    } catch (e) {
      logger.warn('[recurringTaskService] reassign emitTaskUpdated failed', {
        taskId: inst.id, msg: e.message,
      });
    }

    // Notification to NEW assignee, unless they're the actor (e.g. admin
    // reassigned to themselves — no point pinging themselves).
    try {
      if (String(newAssigneeId) !== String(actorId)) {
        await sendNotification(
          newAssigneeId,
          'Recurring task assigned',
          `You've been assigned the recurring task "${template.title}" for ${inst.occurrenceDate || inst.dueDate}.`,
          'recurring_generated',
          inst.id
        );
      }
    } catch (e) {
      logger.warn('[recurringTaskService] reassign notification failed', {
        taskId: inst.id, userId: newAssigneeId, msg: e.message,
      });
    }
  }

  // Activity log — one summary entry per reassignment (per template, not per
  // instance), so the audit trail is readable.
  try {
    logActivity({
      action: 'recurring_template_reassigned',
      description: `Reassigned ${reassigned} open instance(s) of "${template.title}" to new assignee`,
      entityType: 'recurring_template',
      entityId: template.id,
      taskId: null,
      boardId: template.boardId,
      userId: actorId,
      meta: {
        oldAssigneeId,
        newAssigneeId,
        reassigned,
        alreadyConsistent,
        errors: errors.length,
      },
    });
  } catch (_) { /* fire-and-forget */ }

  return { ok: true, reassigned, alreadyConsistent, errors };
}

// ─── Public: mirror a renamed recurring instance into its template ─────────

/**
 * When a generated recurring instance is renamed (via the task modal), the
 * Recurring Work page would otherwise keep showing the original template
 * title — that page reads `recurring_task_templates.title`, not
 * `tasks.title`. This helper mirrors the new title onto the template so:
 *
 *   - The Recurring Work list reflects the latest user-intent title.
 *   - Future generated occurrences inherit the new title at generation
 *     time (`generateInstance` copies `template.title` into the new task).
 *
 * Scope (deliberately narrow):
 *   - Updates ONLY the parent template's `title` column.
 *   - Does NOT mass-rename other open instances — preserves work-in-progress
 *     on different occurrence dates.
 *   - Does NOT touch historical / done / archived instances — preserves
 *     audit trail.
 *
 * Idempotent — re-running with the same `newTitle` short-circuits when the
 * template already matches.
 *
 * Permission: this helper trusts that the caller has already authorized the
 * rename (taskController's title-lock gate restricts task title edits to
 * Tier 1). Calling it from a context that bypasses that gate is the
 * caller's bug.
 *
 * Side-effects (post-update, fire-and-forget — failures are logged but
 * never thrown):
 *   - Realtime: `recurring_template:updated` to assignee + creator +
 *     ancestors + admins (minus actor).
 *   - Activity log: `recurring_template_title_mirrored`.
 *
 * @returns {Promise<{ ok: boolean, mirrored: boolean, reason?: string,
 *                     templateId?: string, previousTitle?: string,
 *                     newTitle?: string }>}
 */
async function mirrorRecurringInstanceTitle({ task, newTitle, previousTitle, actorId }) {
  if (!task || !task.id) return { ok: false, mirrored: false, reason: 'task-missing' };
  if (!task.isRecurringInstance) return { ok: true, mirrored: false, reason: 'not-recurring-instance' };
  if (!task.recurringTemplateId) return { ok: true, mirrored: false, reason: 'no-template-id' };
  if (typeof newTitle !== 'string') return { ok: true, mirrored: false, reason: 'non-string-title' };
  if (newTitle === previousTitle) return { ok: true, mirrored: false, reason: 'unchanged' };

  let tpl;
  try {
    tpl = await RecurringTaskTemplate.findByPk(task.recurringTemplateId);
  } catch (e) {
    logger.warn('[recurringTaskService.mirrorRecurringInstanceTitle] template lookup failed', {
      taskId: task.id, templateId: task.recurringTemplateId, msg: e.message,
    });
    return { ok: false, mirrored: false, reason: `lookup-failed: ${e.message}` };
  }
  if (!tpl) return { ok: true, mirrored: false, reason: 'template-missing' };
  if (tpl.title === newTitle) {
    return { ok: true, mirrored: false, reason: 'template-already-matches', templateId: tpl.id };
  }

  try {
    await tpl.update({ title: newTitle });
  } catch (e) {
    logger.warn('[recurringTaskService.mirrorRecurringInstanceTitle] template update failed', {
      taskId: task.id, templateId: tpl.id, msg: e.message,
    });
    return { ok: false, mirrored: false, reason: `update-failed: ${e.message}`, templateId: tpl.id };
  }

  // Post-commit fan-out. Each side effect runs in its own try/catch so a
  // socket / hierarchy / activity-log failure can never bubble back into
  // the caller's response path.
  try {
    const socketService = require('./socketService');
    const hierarchyService = require('./hierarchyService');
    const { User } = require('../models');
    const { Op: SeqOp } = require('sequelize');
    const userIds = new Set();
    if (tpl.assigneeId) userIds.add(String(tpl.assigneeId));
    if (tpl.createdBy) userIds.add(String(tpl.createdBy));
    try {
      let cursor = tpl.assigneeId;
      const visited = new Set();
      while (cursor && !visited.has(cursor)) {
        visited.add(cursor);
        const parent = await hierarchyService.getPrimaryManagerId(cursor);
        if (!parent) break;
        userIds.add(String(parent));
        cursor = parent;
      }
    } catch { /* hierarchy walk is best-effort */ }
    try {
      const admins = await User.findAll({
        where: { isActive: true, [SeqOp.or]: [{ role: 'admin' }, { isSuperAdmin: true }] },
        attributes: ['id'],
        raw: true,
      });
      for (const a of admins) userIds.add(String(a.id));
    } catch { /* defensive */ }
    if (actorId) userIds.delete(String(actorId));
    const recipients = Array.from(userIds);
    if (recipients.length > 0) {
      socketService.emitToUsers('recurring_template:updated', {
        template: typeof tpl.toJSON === 'function' ? tpl.toJSON() : tpl,
        actorId: actorId || null,
        source: 'mirrorRecurringInstanceTitle',
        timestamp: Date.now(),
      }, recipients);
    }
  } catch (emitErr) {
    logger.warn('[recurringTaskService.mirrorRecurringInstanceTitle] emit failed', {
      taskId: task.id, templateId: tpl.id, msg: emitErr.message,
    });
  }

  try {
    logActivity({
      action: 'recurring_template_title_mirrored',
      description: `Mirrored task title rename onto recurring template: "${previousTitle}" → "${newTitle}"`,
      entityType: 'recurring_template',
      entityId: tpl.id,
      taskId: task.id,
      boardId: task.boardId,
      userId: actorId,
      meta: { previousTitle, newTitle, recurringTemplateId: tpl.id },
    });
  } catch { /* fire-and-forget */ }

  return { ok: true, mirrored: true, templateId: tpl.id, previousTitle, newTitle };
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  // Time math
  partsInZone,
  formatDateOnly,
  zonedTimeToUtc,
  parseDueTime,
  isOccurrenceEligible,
  getMonthlyDays,
  nextOccurrenceDate,
  generationRunAtUtc,
  dueAtUtc,

  // Persistence
  recomputeNextRunAt,
  generateInstance,
  runTemplateOnce,
  seedNextUpcomingInstance,
  reassignOpenInstances,
  mirrorRecurringInstanceTitle,

  // Diagnostics (read-only)
  validateTemplateForGeneration,
};
