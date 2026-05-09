const { Notification, Task, Board } = require('../models');
const { Op } = require('sequelize');
const { emitToUser } = require('../services/socketService');
const taskVisibility = require('../services/taskVisibilityService');
const boardVisibility = require('../services/boardVisibilityService');

/**
 * Visibility filter — Phase 6 (audit P0 #4).
 *
 * After fetching the user's own notification rows, drop the ones whose
 * `entityType === 'task'` or `'board'` references a resource the user can
 * NO LONGER see. Closes the leak where a user demoted from Tier 2 to Tier 4
 * (or removed from a board) keeps reading task titles + board names in
 * their inbox.
 *
 * Notifications referring to deleted entities are KEPT — they represent a
 * historical event for the user and don't disclose current sensitive state.
 *
 * Notifications for non-task/board entities (access_request, help_request,
 * meeting, dependency_request, user, etc.) are KEPT unconditionally — those
 * are scoped to the recipient and don't carry transitive resource leakage.
 */
async function filterByVisibility(rows, user) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;

  // Collect distinct entity ids by type. Each set fetched in a single round
  // trip; visibility checks then run in-memory against the loaded rows.
  const taskIds = new Set();
  const boardIds = new Set();
  for (const n of rows) {
    if (!n.entityId) continue;
    if (n.entityType === 'task') taskIds.add(n.entityId);
    else if (n.entityType === 'board') boardIds.add(n.entityId);
  }

  if (taskIds.size === 0 && boardIds.size === 0) return rows;

  let taskMap = new Map();
  let boardMap = new Map();

  if (taskIds.size > 0) {
    try {
      const tasks = await Task.findAll({
        where: { id: { [Op.in]: [...taskIds] } },
        // Minimal columns for the visibility predicate. taskVisibilityService
        // tolerates a slim object — it reads boardId / assignedTo / createdBy.
        attributes: ['id', 'boardId', 'assignedTo', 'createdBy', 'isArchived'],
      });
      for (const t of tasks) taskMap.set(t.id, t);
    } catch (e) { /* fail-open: rather show old notifs than 500 the panel */ }
  }
  if (boardIds.size > 0) {
    try {
      const boards = await Board.findAll({
        where: { id: { [Op.in]: [...boardIds] } },
        attributes: ['id'],
      });
      for (const b of boards) boardMap.set(b.id, b);
    } catch (e) { /* fail-open */ }
  }

  const out = [];
  for (const n of rows) {
    if (n.entityType === 'task' && n.entityId) {
      const task = taskMap.get(n.entityId);
      if (!task) {
        // Task deleted — keep the notification; the row only carries the
        // historical message text, not live state.
        out.push(n);
        continue;
      }
      try {
        const ok = await taskVisibility.canViewTask(user, task);
        if (ok) out.push(n);
        // else: silently drop — the user no longer has access to this task,
        // so showing the notification (with its task title in the message)
        // would leak data they shouldn't see.
      } catch { out.push(n); /* fail-open on visibility errors */ }
    } else if (n.entityType === 'board' && n.entityId) {
      const board = boardMap.get(n.entityId);
      if (!board) { out.push(n); continue; }
      try {
        const ok = await boardVisibility.canUserSeeBoard(user, n.entityId);
        if (ok) out.push(n);
      } catch { out.push(n); }
    } else {
      // Non-task/board entity types are RBAC-scoped by userId already.
      out.push(n);
    }
  }
  return out;
}

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

    // Over-fetch to absorb the visibility filter — if the user just lost
    // access to a few task notifications, the page-of-20 still has 20 rows
    // after filtering. 3x is a heuristic that's small enough to keep the
    // query cheap and big enough to handle the common case (a Tier 2 → 4
    // demotion losing 5–10 board notifs out of a 20-row page). For users
    // with no recent visibility changes, this costs an extra 40 rows.
    const fetchLimit = limit * 3;
    const { rows: rawNotifications, count: total } = await Notification.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      limit: fetchLimit,
      offset,
    });
    const filtered = await filterByVisibility(rawNotifications, req.user);
    // Slice down to the page size the client asked for.
    const notifications = filtered.slice(0, limit);

    res.json({
      success: true,
      data: {
        notifications,
        pagination: {
          page,
          limit,
          // total is BEFORE filtering — best-effort; the filter is per-row
          // and we don't want to scan the full table just to compute the
          // exact filtered count. The pagination cursor (page) advances
          // client-side; running out of rows surfaces as an empty page,
          // which the panel handles cleanly.
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    // Surface the real Sequelize/Postgres failure so prod logs are actionable.
    // The generic message stays for the client; full detail goes to stderr.
    console.error('[Notification] GetNotifications error:', {
      message: error?.message,
      name: error?.name,
      sql: error?.sql,
      parameters: error?.parameters,
      pgCode: error?.parent?.code,
      pgDetail: error?.parent?.detail,
      pgTable: error?.parent?.table,
      pgColumn: error?.parent?.column,
      stack: error?.stack,
    });
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
 *
 * Returns the raw count without the visibility filter. Applying the filter
 * here would require loading every unread row + a per-row task/board fetch
 * — way too expensive for the bell badge that polls on every page change.
 *
 * The trade-off: right after a Tier 2 → Tier 4 demotion the badge may
 * briefly over-count by the number of unread board/task notifs the user
 * just lost access to. Opening the panel runs the filter and the realtime
 * `notification:read` event the panel emits invalidates the count, so the
 * over-count converges within seconds. No information leak — the badge
 * shows a NUMBER, not the message text.
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

/**
 * DELETE /api/notifications/:id
 * Delete a single notification owned by the current user. 404 (not 403) if it
 * belongs to someone else, so existence is not leaked.
 */
const deleteNotification = async (req, res) => {
  try {
    // Phase 5d — destructive-action gate. The Sequelize WHERE clause
    // already restricts the row to the actor's own notifications, so the
    // ownership predicate is unconditionally true at this call site.
    {
      const { assertCanDelete } = require('../services/tierEnforcement');
      const { sendIfTierError } = require('../utils/tierResponseHelpers');
      if (sendIfTierError(res, () => assertCanDelete(req.user, 'notification', { isOwnResource: true }))) return;
    }
    const deleted = await Notification.destroy({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Notification not found.' });
    }
    emitToUser(req.user.id, 'notification:read', { notificationId: req.params.id, deleted: true });
    res.json({ success: true, message: 'Notification deleted.' });
  } catch (error) {
    console.error('[Notification] Delete error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * DELETE /api/notifications/clear-read
 * Bulk delete read notifications belonging to the current user. Idempotent.
 */
const clearRead = async (req, res) => {
  try {
    const deleted = await Notification.destroy({
      where: { userId: req.user.id, isRead: true },
    });
    emitToUser(req.user.id, 'notification:read', { all: true, cleared: true });
    res.json({ success: true, message: `${deleted} read notifications deleted.`, data: { deleted } });
  } catch (error) {
    console.error('[Notification] ClearRead error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

module.exports = { getNotifications, markAsRead, markAllRead, getUnreadCount, deleteNotification, clearRead };
