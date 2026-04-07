/**
 * Deadline Reminder Cron Job
 *
 * Runs every 15 minutes to process pending deadline reminders.
 * Uses the existing node-cron package already in the project.
 */

const cron = require('node-cron');
const { processReminders } = require('../services/reminderService');

function startDeadlineReminderJob() {
  // Every 15 minutes: */15 * * * *
  cron.schedule('*/15 * * * *', async () => {
    try {
      await processReminders();
    } catch (err) {
      console.error('[DeadlineReminder] Cron job error:', err.message);
    }
  });

  console.log('[DeadlineReminder] Cron job started (every 15 minutes)');
}

module.exports = { startDeadlineReminderJob };