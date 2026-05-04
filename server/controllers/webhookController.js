const crypto = require('crypto');
const { Webhook, WebhookDelivery, ApiKey } = require('../models');

const SUPPORTED_EVENTS = [
  'task.created',
  'task.updated',
  'task.deleted',
  'task.*',
];

function isValidUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

// ─── POST /api/outbound-webhooks ──────────────────────────────
const createWebhook = async (req, res) => {
  try {
    const { apiKeyId, name, url, events } = req.body;
    if (!apiKeyId || !name?.trim() || !url?.trim()) {
      return res.status(400).json({ success: false, message: 'apiKeyId, name and url are required.' });
    }
    if (!isValidUrl(url)) {
      return res.status(400).json({ success: false, message: 'url must be a valid http(s) URL.' });
    }
    const apiKey = await ApiKey.findByPk(apiKeyId);
    if (!apiKey) {
      return res.status(404).json({ success: false, message: 'Linked API key not found.' });
    }

    const eventList = Array.isArray(events) && events.length
      ? events.filter((e) => SUPPORTED_EVENTS.includes(e))
      : ['task.created', 'task.updated', 'task.deleted'];

    const secret = 'whsec_' + crypto.randomBytes(32).toString('hex');

    const hook = await Webhook.create({
      apiKeyId,
      name: name.trim(),
      url: url.trim(),
      secret,
      events: eventList,
      createdBy: req.user.id,
    });

    res.status(201).json({
      success: true,
      message: 'Webhook created. Copy the secret now — it will not be shown again.',
      data: {
        id: hook.id,
        apiKeyId: hook.apiKeyId,
        name: hook.name,
        url: hook.url,
        events: hook.events,
        secret, // only returned at creation
        isActive: hook.isActive,
        createdAt: hook.createdAt,
      },
    });
  } catch (error) {
    console.error('[Webhook] create error:', error);
    res.status(500).json({ success: false, message: 'Failed to create webhook.' });
  }
};

// ─── GET /api/outbound-webhooks?apiKeyId=...  ────────────────
const listWebhooks = async (req, res) => {
  try {
    const where = {};
    if (req.query.apiKeyId) where.apiKeyId = req.query.apiKeyId;
    const hooks = await Webhook.findAll({
      where,
      include: [{ model: ApiKey, as: 'apiKey', attributes: ['id', 'name', 'keyPrefix', 'isActive'] }],
      order: [['createdAt', 'DESC']],
    });
    res.json({
      success: true,
      data: hooks.map((h) => ({
        id: h.id,
        apiKeyId: h.apiKeyId,
        apiKey: h.apiKey ? { id: h.apiKey.id, name: h.apiKey.name, keyPrefix: h.apiKey.keyPrefix, isActive: h.apiKey.isActive } : null,
        name: h.name,
        url: h.url,
        events: h.events,
        isActive: h.isActive,
        lastDeliveredAt: h.lastDeliveredAt,
        lastErrorAt: h.lastErrorAt,
        lastErrorMessage: h.lastErrorMessage,
        createdAt: h.createdAt,
      })),
    });
  } catch (error) {
    console.error('[Webhook] list error:', error);
    res.status(500).json({ success: false, message: 'Failed to load webhooks.' });
  }
};

// ─── PATCH /api/outbound-webhooks/:id/toggle ─────────────────
const toggleWebhook = async (req, res) => {
  try {
    const hook = await Webhook.findByPk(req.params.id);
    if (!hook) return res.status(404).json({ success: false, message: 'Webhook not found.' });
    hook.isActive = !hook.isActive;
    await hook.save();
    res.json({ success: true, data: { id: hook.id, isActive: hook.isActive } });
  } catch (error) {
    console.error('[Webhook] toggle error:', error);
    res.status(500).json({ success: false, message: 'Failed to toggle webhook.' });
  }
};

// ─── DELETE /api/outbound-webhooks/:id ───────────────────────
const deleteWebhook = async (req, res) => {
  try {
    const hook = await Webhook.findByPk(req.params.id);
    if (!hook) return res.status(404).json({ success: false, message: 'Webhook not found.' });
    await hook.destroy();
    res.json({ success: true, message: 'Webhook deleted.' });
  } catch (error) {
    console.error('[Webhook] delete error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete webhook.' });
  }
};

// ─── GET /api/outbound-webhooks/:id/deliveries ───────────────
const listDeliveries = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const deliveries = await WebhookDelivery.findAll({
      where: { webhookId: req.params.id },
      order: [['createdAt', 'DESC']],
      limit,
    });
    res.json({
      success: true,
      data: deliveries.map((d) => ({
        id: d.id,
        event: d.event,
        status: d.status,
        responseStatus: d.responseStatus,
        attempts: d.attempts,
        lastAttemptAt: d.lastAttemptAt,
        nextRetryAt: d.nextRetryAt,
        errorMessage: d.errorMessage,
        createdAt: d.createdAt,
      })),
    });
  } catch (error) {
    console.error('[Webhook] deliveries error:', error);
    res.status(500).json({ success: false, message: 'Failed to load deliveries.' });
  }
};

// ─── POST /api/outbound-webhooks/:id/test ────────────────────
// Manually fire a synthetic test event so users can verify the receiver.
const testWebhook = async (req, res) => {
  try {
    const hook = await Webhook.findByPk(req.params.id);
    if (!hook) return res.status(404).json({ success: false, message: 'Webhook not found.' });
    const webhookService = require('../services/webhookService');
    const delivery = await WebhookDelivery.create({
      webhookId: hook.id,
      event: 'webhook.test',
      payload: {
        eventId: crypto.randomUUID(),
        event: 'webhook.test',
        timestamp: new Date().toISOString(),
        data: { message: 'This is a test event from Aniston Task Manager.' },
      },
      status: 'pending',
      attempts: 0,
    });
    await webhookService.sendAndRecord(hook, delivery);
    const refreshed = await WebhookDelivery.findByPk(delivery.id);
    res.json({
      success: true,
      data: {
        deliveryId: refreshed.id,
        status: refreshed.status,
        responseStatus: refreshed.responseStatus,
        errorMessage: refreshed.errorMessage,
      },
    });
  } catch (error) {
    console.error('[Webhook] test error:', error);
    res.status(500).json({ success: false, message: 'Failed to send test event.' });
  }
};

module.exports = {
  createWebhook,
  listWebhooks,
  toggleWebhook,
  deleteWebhook,
  listDeliveries,
  testWebhook,
  SUPPORTED_EVENTS,
};
