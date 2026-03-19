const express = require('express');
const { authenticate } = require('../middleware/auth');
const {
  getNotifications,
  markAsRead,
  markAllRead,
  getUnreadCount,
} = require('../controllers/notificationController');

const router = express.Router();

// All notification routes require authentication
router.use(authenticate);

// ─── GET /api/notifications ──────────────────────────────────
router.get('/', getNotifications);

// ─── GET /api/notifications/unread-count ─────────────────────
router.get('/unread-count', getUnreadCount);

// ─── PUT /api/notifications/read-all ─────────────────────────
router.put('/read-all', markAllRead);

// ─── PUT /api/notifications/:id/read ─────────────────────────
router.put('/:id/read', markAsRead);

module.exports = router;
