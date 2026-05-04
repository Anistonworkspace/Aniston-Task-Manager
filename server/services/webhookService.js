/**
 * Outbound webhook service.
 *
 * Other applications register a Webhook (URL + events + shared secret) bound
 * to one of their API keys. Whenever a task lifecycle event happens we POST
 * the JSON payload to their URL, signed with HMAC-SHA256 in the
 * `X-Aniston-Signature` header (sha256=<hex>).
 *
 * Design:
 *   - dispatch() is fire-and-forget: it queues a WebhookDelivery row and
 *     POSTs it. If the POST fails, the row stays in `pending` with a
 *     scheduled `nextRetryAt`. The retry cron (jobs/webhookRetryJob.js)
 *     drains it later.
 *   - We never block the API request that triggered an event.
 *   - Replay protection: an `eventId` is included in every payload so the
 *     receiver can de-duplicate retries.
 */

const crypto = require('crypto');
const { Webhook, WebhookDelivery, ApiKey } = require('../models');
const { Op } = require('sequelize');

const MAX_ATTEMPTS = 5;
// Exponential backoff (in seconds): 30s, 2m, 10m, 30m, 2h
const BACKOFF_SCHEDULE = [30, 120, 600, 1800, 7200];

function sign(body, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function nextRetryDelay(attemptCount) {
  const idx = Math.min(attemptCount - 1, BACKOFF_SCHEDULE.length - 1);
  return BACKOFF_SCHEDULE[idx] * 1000;
}

/**
 * Find every active webhook (with a non-disabled, non-expired API key) that
 * subscribes to `event` and dispatch a delivery.
 */
async function dispatch(event, data) {
  try {
    const hooks = await Webhook.findAll({
      where: { isActive: true },
      include: [{
        model: ApiKey,
        as: 'apiKey',
        required: true,
        where: { isActive: true },
      }],
    });

    const subscribers = hooks.filter((h) => {
      const events = Array.isArray(h.events) ? h.events : [];
      // Allow exact match OR wildcard prefix (e.g. 'task.*' matches 'task.created')
      return events.some((e) => {
        if (e === event) return true;
        if (e.endsWith('.*')) return event.startsWith(e.slice(0, -1));
        return false;
      });
    }).filter((h) => {
      const exp = h.apiKey?.expiresAt;
      return !exp || new Date(exp) > new Date();
    });

    if (!subscribers.length) return;

    const payload = {
      eventId: crypto.randomUUID(),
      event,
      timestamp: new Date().toISOString(),
      data,
    };

    await Promise.all(subscribers.map((hook) => deliver(hook, payload)));
  } catch (err) {
    console.error('[webhook] dispatch failed:', err.message);
  }
}

/**
 * Send a single delivery. Records the result in webhook_deliveries and
 * schedules a retry if the receiver returns non-2xx or the request errors.
 */
async function deliver(hook, payload) {
  const delivery = await WebhookDelivery.create({
    webhookId: hook.id,
    event: payload.event,
    payload,
    status: 'pending',
    attempts: 0,
  });
  await sendAndRecord(hook, delivery);
}

async function sendAndRecord(hook, delivery) {
  const body = JSON.stringify(delivery.payload);
  const signature = sign(body, hook.secret);
  const attemptNum = (delivery.attempts || 0) + 1;

  try {
    const controller = new AbortController();
    // 10s timeout — receivers should ack fast and process async
    const timer = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Aniston-Webhook/1.0',
        'X-Aniston-Event': delivery.event,
        'X-Aniston-Signature': signature,
        'X-Aniston-Delivery': delivery.id,
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    const responseBody = await res.text().catch(() => '');
    const truncated = responseBody.slice(0, 500);

    if (res.ok) {
      await delivery.update({
        status: 'success',
        responseStatus: res.status,
        responseBody: truncated,
        attempts: attemptNum,
        lastAttemptAt: new Date(),
        nextRetryAt: null,
      });
      await hook.update({ lastDeliveredAt: new Date(), lastErrorAt: null, lastErrorMessage: null });
    } else {
      await scheduleRetryOrFail(hook, delivery, attemptNum, `HTTP ${res.status}`, res.status, truncated);
    }
  } catch (err) {
    await scheduleRetryOrFail(hook, delivery, attemptNum, err.message, null, null);
  }
}

async function scheduleRetryOrFail(hook, delivery, attemptNum, errorMessage, responseStatus, responseBody) {
  const exhausted = attemptNum >= MAX_ATTEMPTS;
  await delivery.update({
    status: exhausted ? 'dead' : 'failed',
    responseStatus,
    responseBody,
    attempts: attemptNum,
    lastAttemptAt: new Date(),
    nextRetryAt: exhausted ? null : new Date(Date.now() + nextRetryDelay(attemptNum)),
    errorMessage: errorMessage?.slice(0, 500),
  });
  await hook.update({ lastErrorAt: new Date(), lastErrorMessage: errorMessage?.slice(0, 500) });
  if (exhausted) {
    console.warn(`[webhook] delivery ${delivery.id} exhausted after ${attemptNum} attempts: ${errorMessage}`);
  }
}

/**
 * Process all due retries. Called by jobs/webhookRetryJob.js every few mins.
 */
async function retryFailedDeliveries() {
  const due = await WebhookDelivery.findAll({
    where: {
      status: 'failed',
      nextRetryAt: { [Op.lte]: new Date() },
      attempts: { [Op.lt]: MAX_ATTEMPTS },
    },
    include: [{
      model: Webhook,
      as: 'webhook',
      required: true,
      where: { isActive: true },
      include: [{ model: ApiKey, as: 'apiKey', required: true, where: { isActive: true } }],
    }],
    limit: 50,
  });
  for (const delivery of due) {
    await sendAndRecord(delivery.webhook, delivery);
  }
  return due.length;
}

module.exports = {
  dispatch,
  retryFailedDeliveries,
  // exported for tests + hand-triggered redelivery from the UI
  sendAndRecord,
};
