'use strict';

/**
 * Central caps for any cron job that fans out notifications.
 *
 * Why these exist
 * ---------------
 * On 12 May 2026 a ~6:30 PM "notification storm" was traced to the
 * `missedRecurringTaskJob` tick: every Daily Work recurring template
 * defaults to `dueTime = '18:00:00'`, so at 6 PM in each template's
 * timezone every uncompleted instance for the day flips to "missed".
 * The first "every-10-minutes" ticks after 18:00 then escalated all of them at once
 * — assignee + every manager + up to 5 admins — with no per-user cap.
 * One unlucky admin would receive dozens of notifications in a single
 * tick, the frontend would fan that into hundreds of socket events +
 * badge refetches + toasts, and the tab would lock up.
 *
 * These caps make the worst case predictable:
 *
 *   - At most `MAX_TASKS_PER_CRON_RUN` rows scanned per tick.
 *   - At most `MAX_NOTIFICATIONS_PER_USER_PER_RUN` notifications to any
 *     one user in one tick. Remaining notifications are DEFERRED — the
 *     per-task "claim" flag is not flipped, so the next tick (10 min
 *     later for missed; one hour for overdue) drains the backlog.
 *   - At most `MAX_NOTIFICATIONS_PER_JOB_RUN` notifications emitted in
 *     one tick across all users — defends a smaller-org install from a
 *     single fat-finger misconfiguration.
 *
 * Deterministic ordering
 * ----------------------
 * Every job that consumes these caps should `ORDER BY` something stable
 * (usually the oldest due date / scheduled time) so deferred work makes
 * forward progress instead of starving.
 *
 * Tuning
 * ------
 * Conservative defaults chosen for a single-EC2 production install. Bigger
 * installs can raise them, but the per-user cap should stay small: the
 * frontend (toasts, badge refetches) is the real bottleneck, not the DB.
 *
 * Environment overrides
 * ---------------------
 * Operators can override at boot via env var; invalid values fall back
 * to the default. We deliberately do NOT recompute on every call — these
 * are read once at module load.
 */

function readEnvInt(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return defaultValue;
  return n;
}

const MAX_TASKS_PER_CRON_RUN = readEnvInt('NOTIFY_MAX_TASKS_PER_CRON_RUN', 100);
const MAX_REMINDERS_PER_CRON_RUN = readEnvInt('NOTIFY_MAX_REMINDERS_PER_CRON_RUN', 100);
const MAX_NOTIFICATIONS_PER_JOB_RUN = readEnvInt('NOTIFY_MAX_NOTIFICATIONS_PER_JOB_RUN', 200);
const MAX_NOTIFICATIONS_PER_USER_PER_RUN = readEnvInt('NOTIFY_MAX_NOTIFICATIONS_PER_USER_PER_RUN', 5);

/**
 * Per-tick budget tracker. Construct one at the start of a cron tick and
 * call `tryReserve(userId, count = 1)` before issuing the notification(s).
 *
 *   - Returns `true` when the budget allows the notification — the caller
 *     proceeds and the slot is reserved.
 *   - Returns `false` when EITHER the per-user OR the per-job cap is
 *     exhausted — the caller skips and the work is deferred to a later
 *     tick.
 *
 * Callers should treat a `false` result as "do not flip my claim flag"
 * so the same row gets reconsidered next tick. The tracker also exposes
 * a `summary()` for the per-tick log line.
 */
function createBudget(opts = {}) {
  const perUserCap = Number.isFinite(opts.perUserCap) && opts.perUserCap > 0
    ? opts.perUserCap
    : MAX_NOTIFICATIONS_PER_USER_PER_RUN;
  const perJobCap = Number.isFinite(opts.perJobCap) && opts.perJobCap > 0
    ? opts.perJobCap
    : MAX_NOTIFICATIONS_PER_JOB_RUN;

  const perUser = new Map(); // userId -> count
  let totalEmitted = 0;
  let userLimited = 0;
  let jobLimited = 0;

  return {
    perUserCap,
    perJobCap,

    /**
     * Can a notification for `userId` be emitted right now?
     * Cheap predicate — does not reserve. Use this to peek before the
     * call site does irreversible work.
     */
    canEmit(userId) {
      if (totalEmitted >= perJobCap) return false;
      const used = perUser.get(userId) || 0;
      return used < perUserCap;
    },

    /**
     * Try to reserve one notification slot for `userId`. Returns true on
     * success (caller MUST proceed with the send). Returns false on
     * exhaustion — caller MUST skip and leave the source row unclaimed.
     */
    tryReserve(userId) {
      if (totalEmitted >= perJobCap) {
        jobLimited += 1;
        return false;
      }
      const used = perUser.get(userId) || 0;
      if (used >= perUserCap) {
        userLimited += 1;
        return false;
      }
      perUser.set(userId, used + 1);
      totalEmitted += 1;
      return true;
    },

    /** Total notifications emitted under this budget. */
    totalEmitted() { return totalEmitted; },

    /** Per-tick counters suitable for a structured log line. */
    summary() {
      return {
        totalEmitted,
        uniqueUsers: perUser.size,
        userLimitedCount: userLimited,
        jobLimitedCount: jobLimited,
      };
    },
  };
}

module.exports = {
  MAX_TASKS_PER_CRON_RUN,
  MAX_REMINDERS_PER_CRON_RUN,
  MAX_NOTIFICATIONS_PER_JOB_RUN,
  MAX_NOTIFICATIONS_PER_USER_PER_RUN,
  createBudget,
};
