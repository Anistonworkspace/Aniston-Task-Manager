const cron = require('node-cron');
const webhookService = require('../services/webhookService');
const { withCronLock } = require('./cronLock');

/**
 * Drain failed webhook deliveries whose `nextRetryAt` has elapsed.
 * Runs every 5 minutes. Each pass processes up to 50 deliveries
 * (limit defined in webhookService.retryFailedDeliveries).
 *
 * Wrapped in withCronLock — duplicate ticks across replicas would otherwise
 * each attempt the same deliveries, causing duplicate webhook POSTs.
 */
function startWebhookRetryJob() {
  cron.schedule('*/5 * * * *', async () => {
    try {
      await withCronLock('webhookRetryJob:5min', async () => {
        const count = await webhookService.retryFailedDeliveries();
        if (count > 0) {
          console.log(`[Webhook] retried ${count} delivery(ies)`);
        }
      });
    } catch (err) {
      console.error('[Webhook] retry job error:', err.message);
    }
  });
  console.log('[Webhook] retry cron started (every 5 minutes)');
}

module.exports = { startWebhookRetryJob };
