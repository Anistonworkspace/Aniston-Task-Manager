const { Notification } = require('../models');
const { Op } = require('sequelize');
const { emitToUser } = require('../services/socketService');

/**
 * GET /api/notifications
 * Query params: page, limit, unreadOnly
 */
const getNotifications = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const offset = (page - 1) * limit;

    const where = { userId: req.user.id };

    if (req.query.unreadOnly === 'true') {
      where.isRead = false;
    }

    const { rows: notifications, count: total } = await Notification.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      limit,
      offset,
    });

    res.json({
      success: true,
      data: {
        notifications,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error('[Notification] GetNotifications error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching notifications.' });
  }
};

/**
 * PUT /api/notifications/:id/read
 */
const markAsRead = async (req, res) => {
  try {
    const notification = await Notification.findOne({
      where: { id: req.params.id, userId: req.user.id },
    });

    if (!notification) {
      return res.status(404).json({ success: false, message: 'Notification not found.' });
    }

    await notification.update({ isRead: true });

    // Emit socket event so header updates unread count without polling
    emitToUser(req.user.id, 'notification:read', { notificationId: notification.id });

    res.json({
      success: true,
      message: 'Notification marked as read.',
      data: { notification },
    });
  } catch (error) {
    console.error('[Notification] MarkAsRead error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * PUT /api/notifications/read-all
 */
const markAllRead = async (req, res) => {
  try {
    const [updatedCount] = await Notification.update(
      { isRead: true },
      { where: { userId: req.user.id, isRead: false } }
    );

    emitToUser(req.user.id, 'notification:read', { all: true });

    res.json({
      success: true,
      message: `${updatedCount} notifications marked as read.`,
      data: { updatedCount },
    });
  } catch (error) {
    console.error('[Notification] MarkAllRead error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * GET /api/notifications/unread-count
 */
const getUnreadCount = async (req, res) => {
  try {
    const count = await Notification.count({
      where: { userId: req.user.id, isRead: false },
    });

    res.json({ success: true, data: { unreadCount: count } });
  } catch (error) {
    console.error('[Notification] GetUnreadCount error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

module.exports = { getNotifications, markAsRead, markAllRead, getUnreadCount };
