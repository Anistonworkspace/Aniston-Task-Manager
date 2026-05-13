/**
 * Deadline / Task-Reminder Cron Job
 *
 * Runs every minute and processes any pending TaskReminder row whose
 * `scheduledFor <= now`.
 *
 * Why every minute (not every 15 minutes):
 *   The legacy schedule was the every-fifteen-minutes cron expression
 *   ("slash-15 star star star star") because the only callers were the
 *   auto-scheduled 2-day / 2-hour deadline reminders — 15-minute
 *   precision was plenty for "2 days before the deadline". Phase 5 added
 *   user-set custom reminders ("remind me at 5:13 PM"), and a 15-minute
 *   tick means those fire up to 14 minutes late — users perceive this
 *   as "the reminder never came". One-minute granularity puts the worst
 *   case at ~60 s late, which feels prompt.
 *
 *   Cost: the WHERE clause is backed by the partial index
 *   "idx_task_reminder_pending (scheduledFor) WHERE sentAt IS NULL AND
 *   cancelled = false", so each empty tick is a single index probe.
 *   processReminders also caps the batch at 200 rows.
 */

const cron = require('node-cron');
const { processReminders } = require('../services/reminderService');
const { withCronLock } = require('./cronLock');

/**
 * Multi-replica safety: every tick is wrapped in `withCronLock`. Combined
 * with the claim-first UPDATE inside processReminders (see reminderService),
 * this gives two layers of protection against duplicate sends:
 *
 *   1. Cron lock — only one replica's tick runs at all per scheduled minute.
 *   2. Claim-first — even if the lock somehow fails (DB outage, lock-key
 *      hash collision), the per-row UPDATE … RETURNING ensures a reminder
 *      is sent at most once.
 */
function startDeadlineReminderJob() {
  // Every minute: * * * * *  (was */15 * * * * — see header comment)
  cron.schedule('* * * * *', async () => {
    try {
      await withCronLock('deadlineReminderJob', processReminders);
    } catch (err) {
      console.error('[DeadlineReminder] Cron job error:', err.message);
    }
  });

  console.log('[DeadlineReminder] Cron job started (every minute)');
}

module.exports = { startDeadlineReminderJob };