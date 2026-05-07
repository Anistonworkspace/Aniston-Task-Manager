/**
 * Cron — Daily Work / Recurring Work generation engine.
 *
 * Runs every 10 minutes. Picks up every active, non-archived template whose
 * `nextRunAt` has elapsed and asks the service layer to generate today's
 * instance (in the template's timezone) if it doesn't already exist.
 *
 * Why every 10 minutes when the natural cadence is per-day-at-00:05?
 *   The service is keyed on a UTC `nextRunAt` timestamp. A 10-minute poll
 *   ensures that a missed cron tick (server restart, deploy, etc.) only
 *   delays generation by ~10 minutes, not a full day. The DB unique
 *   partial index on (recurringTemplateId, occurrenceDate) makes this safe:
 *   even if two replicas pick up the same template in the same window, only
 *   one row will materialise.
 *
 * NB: The legacy `recurringTaskJob.js` (Phase 8 #53) still runs hourly at
 * `:15` against the legacy `Task.recurrence` JSONB field — we leave that
 * untouched so existing recurring tasks created via the old UI continue to
 * fire. New work goes through THIS job.
 */

const cron = require('node-cron');
const { Op } = require('sequelize');
const { RecurringTaskTemplate } = require('../models');
const recurringTaskService = require('../services/recurringTaskService');
const { withCronLock } = require('./cronLock');
const logger = require('../utils/logger');

// Cron expression: every 10 minutes, on minutes 0, 10, 20, 30, 40, 50.
// Avoids the top of the hour where many other cron jobs already cluster.
const CRON_EXPR = '*/10 * * * *';

/**
 * Find templates that are due to run, and process each one.
 *
 * Two-phase design:
 *   1) Identify candidates with a single SELECT bounded by `nextRunAt <= now`.
 *      Postgres uses the partial index `recurring_task_templates_next_run_idx`
 *      (where isActive=TRUE AND archivedAt IS NULL) — fast even with many rows.
 *   2) For each candidate, call the service which handles its own transaction
 *      and idempotency. Errors on one template do not block the others.
 */
async function tickOnce(now = new Date()) {
  const candidates = await RecurringTaskTemplate.findAll({
    where: {
      isActive: true,
      archivedAt: null,
      nextRunAt: { [Op.ne]: null, [Op.lte]: now },
    },
    order: [['nextRunAt', 'ASC']],
    // Defensive cap. If somehow we accumulate thousands of "due" templates
    // (e.g. the cron was off for a week), we drain them in batches across
    // subsequent ticks rather than holding a long transaction here.
    limit: 200,
  });

  if (candidates.length === 0) return { processed: 0, generated: 0, skipped: 0, errors: 0 };

  let generated = 0;
  let skipped = 0;
  let errors = 0;
  for (const tpl of candidates) {
    try {
      const result = await recurringTaskService.runTemplateOnce(tpl, {
        fromDate: now,
        source: 'recurringTemplateGenerationJob',
      });
      if (result.error) {
        errors += 1;
        logger.warn('[RecurringGenJob] Template error', { templateId: tpl.id, msg: result.error });
        continue;
      }
      if (result.generated) generated += 1;
      else skipped += 1;
    } catch (err) {
      // Defensive: runTemplateOnce already swallows errors; this catch is a
      // belt-and-braces guard so an unexpected throw doesn't kill the loop.
      errors += 1;
      logger.error('[RecurringGenJob] Unhandled template failure', {
        templateId: tpl.id,
        msg: err.message,
        stack: err.stack,
      });
    }
  }

  return { processed: candidates.length, generated, skipped, errors };
}

function startRecurringTemplateGenerationJob() {
  cron.schedule(CRON_EXPR, async () => {
    // The unique partial index on (recurringTemplateId, occurrenceDate) makes
    // duplicate generation impossible at the data layer, but multiple replicas
    // would still each fetch + iterate the candidate set, doubling DB load
    // and producing confusing duplicate "generated"/"skipped" log lines. The
    // advisory lock skips the entire tick on N-1 replicas — see jobs/cronLock.js.
    await withCronLock('recurringTemplateGeneration', async () => {
      const start = Date.now();
      try {
        const result = await tickOnce(new Date());
        if (result.processed > 0 || result.errors > 0) {
          // Only log when there's signal — keeps quiet days quiet.
          logger.info(
            `[RecurringGenJob] tick: processed=${result.processed} generated=${result.generated} `
            + `skipped=${result.skipped} errors=${result.errors} (${Date.now() - start}ms)`
          );
        }
      } catch (err) {
        logger.error('[RecurringGenJob] tick failed', { msg: err.message, stack: err.stack });
      }
    }).catch((err) => {
      logger.error('[RecurringGenJob] lock-wrapped tick failed', { msg: err && err.message });
    });
  });

  logger.info(`[RecurringGenJob] Scheduled (${CRON_EXPR}) — replica-safe via advisory lock.`);
}

module.exports = {
  startRecurringTemplateGenerationJob,
  // Exported for tests so we can drive a single tick manually.
  _tickOnce: tickOnce,
};
