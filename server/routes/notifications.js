const express = require('express');
const { authenticate } = require('../middleware/auth');
const {
  getNotifications,
  markAsRead,
  markAllRead,
  getUnreadCount,
  deleteNotification,
  clearRead,
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

// ─── DELETE /api/notifications/clear-read ────────────────────
// Bulk-delete read notifications for the current user. Must be before
// '/:id' so 'clear-read' is not interpreted as an id.
router.delete('/clear-read', clearRead);

// ─── DELETE /api/notifications/:id ───────────────────────────
router.delete('/:id', deleteNotification);

module.exports = router;
