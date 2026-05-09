/**
 * Deadline Reminder Cron Job
 *
 * Runs every 15 minutes to process pending deadline reminders.
 * Uses the existing node-cron package already in the project.
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
  // Every 15 minutes: */15 * * * *
  cron.schedule('*/15 * * * *', async () => {
    try {
      await withCronLock('deadlineReminderJob', processReminders);
    } catch (err) {
      console.error('[DeadlineReminder] Cron job error:', err.message);
    }
  });

  console.log('[DeadlineReminder] Cron job started (every 15 minutes)');
}

module.exports = { startDeadlineReminderJob };