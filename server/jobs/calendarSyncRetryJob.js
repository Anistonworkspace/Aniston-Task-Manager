/**
 * Calendar Sync Retry Job
 *
 * Scans for tasks whose last Graph calendar sync attempt failed and re-runs it.
 * Lives as a cron job (every 15 min) because we deliberately avoid a persistent
 * queue system here — a single dedicated job keeps the surface small and
 * visibility centralized.
 *
 * Retry policy:
 *   - Only retries syncStatus in ('failed', 'pending')
 *   - Stops after MAX_RETRY_ATTEMPTS (see calendarService.MAX_RETRY_ATTEMPTS)
 *   - Skips archived tasks
 *   - Skips unassigned tasks (no mailbox to target)
 *   - Processes at most BATCH_SIZE tasks per tick to bound Graph API pressure
 *
 * Duplicate-event safety:
 *   calendarService.createTaskEvent() is idempotent — it first checks for a
 *   stored mapping, then attempts attach via the AnistonTaskId extended
 *   property, and only creates if neither is found.
 */
const cron = require('node-cron');
const { Op } = require('sequelize');
const { Task } = require('../models');
const calendarService = require('../services/calendarService');
const logger = require('../utils/logger');

const BATCH_SIZE = 20;

async function runRetryPass() {
  const candidates = await Task.findAll({
    where: {
      syncStatus: { [Op.in]: ['failed', 'pending'] },
      syncAttempts: { [Op.lt]: calendarService.MAX_RETRY_ATTEMPTS },
      isArchived: false,
      assignedTo: { [Op.ne]: null },
    },
    attributes: ['id', 'syncStatus', 'syncAttempts', 'assignedTo'],
    order: [['lastSyncedAt', 'ASC NULLS FIRST']],
    limit: BATCH_SIZE,
  });

  if (candidates.length === 0) return { attempted: 0, succeeded: 0 };

  let succeeded = 0;
  for (const task of candidates) {
    try {
      const ok = await calendarService.ensureSynced(task.id);
      if (ok) succeeded++;
    } catch (err) {
      logger.warn('[CalendarSyncRetry] task error', { taskId: task.id, err: err.message });
    }
  }
  logger.info('[CalendarSyncRetry] pass complete', {
    attempted: candidates.length,
    succeeded,
  });
  return { attempted: candidates.length, succeeded };
}

function startCalendarSyncRetryJob() {
  // Every 15 minutes, offset to :07 so it doesn't collide with recurringTaskJob (:15).
  cron.schedule('7,22,37,52 * * * *', async () => {
    try {
      await runRetryPass();
    } catch (err) {
      logger.error('[CalendarSyncRetry] pass failed', { err: err.message });
    }
  });
  console.log('[CalendarSyncRetry] Scheduled (every 15 min at :07/:22/:37/:52)');
}

module.exports = { startCalendarSyncRetryJob, runRetryPass };
