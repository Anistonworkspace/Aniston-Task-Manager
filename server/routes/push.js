const express = require('express');
const { authenticate } = require('../middleware/auth');
const { saveSubscription, removeSubscription, vapidPublicKey, pushConfigured } = require('../services/pushService');

const router = express.Router();

// GET /api/push/vapid-key — return public VAPID key for client subscription
router.get('/vapid-key', (req, res) => {
  res.json({ success: true, data: { publicKey: vapidPublicKey, configured: pushConfigured } });
});

// POST /api/push/subscribe — save push subscription for authenticated user
router.post('/subscribe', authenticate, (req, res) => {
  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ success: false, message: 'subscription with endpoint required.' });
  }
  saveSubscription(req.user.id, subscription);
  res.json({ success: true, message: 'Push subscription saved.' });
});

// POST /api/push/unsubscribe — remove push subscription
router.post('/unsubscribe', authenticate, (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) {
    return res.status(400).json({ success: false, message: 'endpoint required.' });
  }
  removeSubscription(req.user.id, endpoint);
  res.json({ success: true, message: 'Push subscription removed.' });
});

module.exports = router;
