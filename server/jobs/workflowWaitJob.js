const cron = require('node-cron');
const { Op } = require('sequelize');
const { withCronLock } = require('./cronLock');

/**
 * Resume workflow waits whose `resumeAt` has elapsed.
 * Runs every minute. Each pass processes up to BATCH_SIZE rows so a
 * sudden burst of due waits (e.g. after a server restart that delayed
 * the cron for hours) doesn't starve other jobs.
 *
 * Wrapped in withCronLock — duplicate ticks across replicas would each
 * try to resume the same wait, producing duplicate workflow runs.
 *
 * The cron itself ticks every minute; the engine's `resumeFromWait`
 * deletes the wait row on every outcome (success, engine throw,
 * structural failure), so a poison row never blocks the queue.
 */

const BATCH_SIZE = 20;

async function tick() {
  const { WorkflowWait } = require('../models');
  const { resumeFromWait } = require('../services/workflowEngine');
  const safeLogger = require('../utils/safeLogger');

  const due = await WorkflowWait.findAll({
    where: { resumeAt: { [Op.lte]: new Date() } },
    order: [['resumeAt', 'ASC']],
    limit: BATCH_SIZE,
  });
  if (due.length === 0) return 0;

  let resumed = 0;
  // Serial — workflow runs can be expensive (DB writes, external Teams POSTs,
  // etc.) and the underlying processWorkflows is already fire-and-forget on
  // other code paths. Parallel resume across replicas is blocked by the cron
  // lock above; parallel resume WITHIN a single tick is intentionally avoided
  // to keep DB pressure flat.
  for (const wait of due) {
    try {
      await resumeFromWait(wait.id);
      resumed += 1;
    } catch (err) {
      safeLogger.error('[WorkflowWaitJob] resume failed (non-fatal)', { err, waitId: wait.id });
    }
  }
  return resumed;
}

function startWorkflowWaitJob() {
  cron.schedule('* * * * *', async () => {
    try {
      await withCronLock('workflowWaitJob:1min', async () => {
        const count = await tick();
        if (count > 0) {
          console.log(`[WorkflowWait] resumed ${count} wait(s)`);
        }
      });
    } catch (err) {
      console.error('[WorkflowWait] cron error:', err.message);
    }
  });
  console.log('[WorkflowWait] resume cron started (every minute)');
}

module.exports = { startWorkflowWaitJob, _tickForTests: tick };
