const express = require('express');
const { authenticate } = require('../middleware/auth');
const {
  saveSubscription,
  deactivateSubscription,
  vapidPublicKey,
  pushConfigured,
} = require('../services/pushService');

const router = express.Router();

// GET /api/push/vapid-key — INTENTIONALLY PUBLIC
// The VAPID public key must be available without auth so the browser can register
// a push subscription before/during login. It is a public key by design and
// exposes no secrets.
router.get('/vapid-key', (req, res) => {
  res.json({ success: true, data: { publicKey: vapidPublicKey, configured: pushConfigured } });
});

// POST /api/push/subscribe — save push subscription for authenticated user.
// The endpoint is a globally-unique browser identifier (per VAPID public key).
// If the same browser was previously signed in as a different user, saveSubscription
// re-links the row to the new userId — preventing cross-account push delivery.
router.post('/subscribe', authenticate, async (req, res) => {
  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    return res.status(400).json({ success: false, message: 'Valid subscription with endpoint and keys required.' });
  }
  const meta = {
    userAgent: req.headers['user-agent']?.slice(0, 500),
    deviceId: req.body.deviceId || null,
  };
  const row = await saveSubscription(req.user.id, subscription, meta);
  if (!row) {
    return res.status(500).json({ success: false, message: 'Failed to save push subscription.' });
  }
  res.json({ success: true, message: 'Push subscription saved.' });
});

// POST /api/push/unsubscribe — deactivate the current device's subscription.
// Scoped to req.user.id so a user cannot deactivate another user's subscription
// even with a forged endpoint. This is the path called by the frontend logout
// flow — the row is kept (isActive=false) for re-activation on next login.
router.post('/unsubscribe', authenticate, async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint || typeof endpoint !== 'string') {
    return res.status(400).json({ success: false, message: 'endpoint required.' });
  }
  const count = await deactivateSubscription(req.user.id, endpoint);
  res.json({ success: true, message: 'Push subscription deactivated.', data: { count } });
});

module.exports = router;
