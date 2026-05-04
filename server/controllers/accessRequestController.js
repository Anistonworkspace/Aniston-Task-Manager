const { AccessRequest, User, Notification, PermissionGrant } = require('../models');
const { logActivity } = require('../services/activityService');
const { emitToUser } = require('../services/socketService');
const { sanitizeNotificationField, sanitizeNotificationMessage } = require('../utils/sanitize');

// GET /api/access-requests — list requests (admin sees all, user sees own)
exports.getAccessRequests = async (req, res) => {
  try {
    const { status } = req.query;
    const where = {};
    if (status) where.status = status;

    // Non-admin only sees own requests
    if (req.user.role === 'member') {
      where.userId = req.user.id;
    }

    const requests = await AccessRequest.findAll({
      where,
      include: [
        { model: User, as: 'requester', attributes: ['id', 'name', 'email', 'avatar', 'role', 'department'] },
        { model: User, as: 'reviewer', attributes: ['id', 'name', 'email'] },
      ],
      order: [['createdAt', 'DESC']],
    });
    res.json({ success: true, data: { requests } });
  } catch (err) {
    console.error('[AccessRequest] getAccessRequests error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch access requests.' });
  }
};

// POST /api/access-requests — create new request
exports.createAccessRequest = async (req, res) => {
  try {
    const { resourceType, resourceId, requestType, reason, expiresAt, isTemporary } = req.body;

    if (!resourceType || !requestType) {
      return res.status(400).json({ success: false, message: 'resourceType and requestType are required.' });
    }

    // Check if pending request already exists
    const existing = await AccessRequest.findOne({
      where: { userId: req.user.id, resourceType, resourceId: resourceId || null, status: 'pending' },
    });
    if (existing) {
      return res.status(400).json({ success: false, message: 'You already have a pending request for this resource.' });
    }

    const request = await AccessRequest.create({
      userId: req.user.id,
      resourceType,
      resourceId: resourceId || null,
      requestType,
      reason: reason || null,
      expiresAt: expiresAt || null,
      isTemporary: isTemporary || false,
    });

    // Notify admins. Use the dedicated enum + standard payload so the bell
    // toast / push fire correctly (Header.jsx reads data.notification.message).
    const admins = await User.findAll({ where: { role: 'admin', isActive: true } });
    const safeName = sanitizeNotificationField(req.user.name);
    const safeRequestType = sanitizeNotificationField(requestType, 32);
    const safeResourceType = sanitizeNotificationField(resourceType, 64);
    const adminMsg = sanitizeNotificationMessage(
      `${safeName} requested ${safeRequestType} access to ${safeResourceType}`
    );
    for (const admin of admins) {
      const notification = await Notification.create({
        type: 'access_requested',
        message: adminMsg,
        entityType: 'access_request',
        entityId: request.id,
        userId: admin.id,
      });
      emitToUser(admin.id, 'notification:new', { notification });
    }

    logActivity({
      action: 'access_requested',
      description: `${req.user.name} requested ${requestType} access to ${resourceType}`,
      entityType: 'access_request',
      entityId: request.id,
      userId: req.user.id,
      meta: { resourceType, resourceId, requestType },
    });

    res.status(201).json({ success: true, data: { request } });
  } catch (err) {
    console.error('[AccessRequest] createAccessRequest error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create access request.' });
  }
};

// PUT /api/access-requests/:id/approve
exports.approveRequest = async (req, res) => {
  try {
    const request = await AccessRequest.findByPk(req.params.id, {
      include: [{ model: User, as: 'requester', attributes: ['id', 'name'] }],
    });
    if (!request) return res.status(404).json({ success: false, message: 'Request not found.' });
    if (request.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Request is not pending.' });
    }

    const { reviewNote } = req.body;

    await request.update({
      status: 'approved',
      reviewedBy: req.user.id,
      reviewedAt: new Date(),
      reviewNote: reviewNote || null,
    });

    // Auto-create permission grant
    await PermissionGrant.create({
      userId: request.userId,
      resourceType: request.resourceType,
      resourceId: request.resourceId,
      permissionLevel: request.requestType,
      grantedBy: req.user.id,
      expiresAt: request.expiresAt || null,
    });

    // Notify requester
    const approvedMsg = sanitizeNotificationMessage(
      `Your ${sanitizeNotificationField(request.requestType, 32)} access request for ` +
      `${sanitizeNotificationField(request.resourceType, 64)} was approved by ` +
      `${sanitizeNotificationField(req.user.name)}`
    );
    const approvedNotif = await Notification.create({
      type: 'access_approved',
      message: approvedMsg,
      entityType: 'access_request',
      entityId: request.id,
      userId: request.userId,
    });
    emitToUser(request.userId, 'notification:new', { notification: approvedNotif });

    logActivity({
      action: 'access_approved',
      description: `${req.user.name} approved access request from ${request.requester?.name}`,
      entityType: 'access_request',
      entityId: request.id,
      userId: req.user.id,
      meta: { targetUserId: request.userId, resourceType: request.resourceType },
    });

    res.json({ success: true, data: { request } });
  } catch (err) {
    console.error('[AccessRequest] approveRequest error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to approve request.' });
  }
};

// PUT /api/access-requests/:id/reject
exports.rejectRequest = async (req, res) => {
  try {
    const request = await AccessRequest.findByPk(req.params.id, {
      include: [{ model: User, as: 'requester', attributes: ['id', 'name'] }],
    });
    if (!request) return res.status(404).json({ success: false, message: 'Request not found.' });
    if (request.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Request is not pending.' });
    }

    const { reviewNote } = req.body;

    await request.update({
      status: 'rejected',
      reviewedBy: req.user.id,
      reviewedAt: new Date(),
      reviewNote: reviewNote || null,
    });

    // Notify requester
    const rejectedMsg = sanitizeNotificationMessage(
      `Your ${sanitizeNotificationField(request.requestType, 32)} access request for ` +
      `${sanitizeNotificationField(request.resourceType, 64)} was rejected by ` +
      `${sanitizeNotificationField(req.user.name)}`
    );
    const rejectedNotif = await Notification.create({
      type: 'access_rejected',
      message: rejectedMsg,
      entityType: 'access_request',
      entityId: request.id,
      userId: request.userId,
    });
    emitToUser(request.userId, 'notification:new', { notification: rejectedNotif });

    logActivity({
      action: 'access_rejected',
      description: `${req.user.name} rejected access request from ${request.requester?.name}`,
      entityType: 'access_request',
      entityId: request.id,
      userId: req.user.id,
    });

    res.json({ success: true, data: { request } });
  } catch (err) {
    console.error('[AccessRequest] rejectRequest error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to reject request.' });
  }
};

// GET /api/access-requests/pending/count — count pending requests (admin)
exports.getPendingCount = async (req, res) => {
  try {
    const count = await AccessRequest.count({ where: { status: 'pending' } });
    res.json({ success: true, data: { count } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to count pending requests.' });
  }
};
