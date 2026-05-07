const { AccessRequest, User, Notification, PermissionGrant } = require('../models');
const { sequelize } = require('../config/db');
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

    // Check if pending request already exists. We do this BEFORE the
    // transaction so the early-out 400 doesn't hold a row lock for nothing.
    const existing = await AccessRequest.findOne({
      where: { userId: req.user.id, resourceType, resourceId: resourceId || null, status: 'pending' },
    });
    if (existing) {
      return res.status(400).json({ success: false, message: 'You already have a pending request for this resource.' });
    }

    // Pre-fetch admins outside the transaction. The list rarely changes and
    // there's no benefit to reading it within the lock window — keeps the
    // transaction tight to just the writes.
    const admins = await User.findAll({ where: { role: 'admin', isActive: true } });
    const safeName = sanitizeNotificationField(req.user.name);
    const safeRequestType = sanitizeNotificationField(requestType, 32);
    const safeResourceType = sanitizeNotificationField(resourceType, 64);
    const adminMsg = sanitizeNotificationMessage(
      `${safeName} requested ${safeRequestType} access to ${safeResourceType}`
    );

    // ── Atomic create-and-notify block ────────────────────────────────────
    // Pre-fix: the AccessRequest.create succeeded, then a per-admin
    // Notification.create loop. If the loop failed mid-way (e.g. one admin
    // had a stale FK row, or DB hiccuped after admin #2) the request was
    // visible to early-notified admins but not the rest, and the API still
    // returned 500 to the requester — they'd retry, hitting the
    // already-pending guard above and showing a confusing error. We bundle
    // the create + bulk notification insert so the request is only visible
    // once every admin has been queued for notification.
    //
    // Realtime emits stay OUTSIDE the transaction. Sockets are best-effort
    // and we don't want a socket failure to roll back the persistent state.
    let request;
    let createdNotifications = [];
    try {
      const result = await sequelize.transaction(async (t) => {
        const created = await AccessRequest.create({
          userId: req.user.id,
          resourceType,
          resourceId: resourceId || null,
          requestType,
          reason: reason || null,
          expiresAt: expiresAt || null,
          isTemporary: isTemporary || false,
        }, { transaction: t });

        // Bulk insert: one round trip instead of N, and atomic with the
        // request creation. If any admin row is invalid the whole batch
        // (and the request) rolls back.
        const notifPayloads = admins.map((admin) => ({
          type: 'access_requested',
          message: adminMsg,
          entityType: 'access_request',
          entityId: created.id,
          userId: admin.id,
        }));
        const notifs = notifPayloads.length > 0
          ? await Notification.bulkCreate(notifPayloads, { transaction: t, returning: true })
          : [];

        return { request: created, notifications: notifs };
      });
      request = result.request;
      createdNotifications = result.notifications;
    } catch (txErr) {
      console.error('[AccessRequest] createAccessRequest transaction failed:', txErr.message);
      return res.status(500).json({ success: false, message: 'Failed to create access request.' });
    }

    // Best-effort realtime fan-out post-commit. Wrapped per-emit so a single
    // socket failure doesn't suppress the rest.
    for (const notif of createdNotifications) {
      try {
        emitToUser(notif.userId, 'notification:new', { notification: notif });
      } catch (emitErr) {
        console.warn('[AccessRequest] notify emit failed (non-fatal):', emitErr && emitErr.message);
      }
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
    // Pre-flight check (cheap) BEFORE the transaction so we 404 / 400 / 403
    // without holding row locks. The authoritative status check happens again
    // inside the transaction with FOR UPDATE so two concurrent approvers
    // don't both succeed.
    const preReq = await AccessRequest.findByPk(req.params.id, {
      include: [{ model: User, as: 'requester', attributes: ['id', 'name'] }],
    });
    if (!preReq) return res.status(404).json({ success: false, message: 'Request not found.' });
    if (preReq.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Request is not pending.' });
    }

    // Phase 5e — closes audit P0-2. Verify the approver is actually
    // entitled to grant the permission they're about to issue. Without
    // this, a manager (T2) could approve a member's request for
    // permissionLevel='admin' on admin_settings/roles/api_keys and
    // create the underlying PermissionGrant directly. canGrantPermission
    // enforces the canonical anti-escalation rules (managers cannot grant
    // administrative permissions, etc.).
    const { canGrantPermission } = require('../services/permissionEngine');
    const grantCheck = await canGrantPermission(
      req.user,
      preReq.resourceType,
      preReq.requestType,
      'grant'
    );
    if (!grantCheck.allowed) {
      return res.status(403).json({
        success: false,
        message: grantCheck.reason || 'You are not authorized to grant this permission.',
      });
    }

    const { reviewNote } = req.body;

    // ── Atomic approval block ────────────────────────────────────────────
    // Two writes must succeed together: (1) flip the request to 'approved',
    // (2) issue the corresponding PermissionGrant. Pre-fix, a failure on (2)
    // (e.g. FK constraint, deactivated user, transient DB error) left the
    // request showing 'approved' to the requester but with NO grant — the
    // user thought they had access and the request was marked done.
    //
    // FOR UPDATE locks the request row so a parallel approver finds it
    // already moved out of 'pending' and gets a clean 409 instead of
    // both approvals succeeding.
    let request;
    try {
      request = await sequelize.transaction(async (t) => {
        const locked = await AccessRequest.findByPk(req.params.id, {
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
        if (!locked) {
          const e = new Error('Request not found.');
          e.statusCode = 404;
          throw e;
        }
        if (locked.status !== 'pending') {
          const e = new Error('Request is no longer pending (concurrent decision).');
          e.statusCode = 409;
          throw e;
        }

        await locked.update({
          status: 'approved',
          reviewedBy: req.user.id,
          reviewedAt: new Date(),
          reviewNote: reviewNote || null,
        }, { transaction: t });

        await PermissionGrant.create({
          userId: locked.userId,
          resourceType: locked.resourceType,
          resourceId: locked.resourceId,
          permissionLevel: locked.requestType,
          grantedBy: req.user.id,
          expiresAt: locked.expiresAt || null,
        }, { transaction: t });

        return locked;
      });
    } catch (txErr) {
      const code = txErr.statusCode || 500;
      return res.status(code).json({
        success: false,
        message: code === 500 ? 'Failed to approve request.' : txErr.message,
      });
    }

    // Re-attach the requester association for the response shape callers
    // expect. The locked instance from inside the transaction won't have it.
    request.requester = preReq.requester;

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
    const preReq = await AccessRequest.findByPk(req.params.id, {
      include: [{ model: User, as: 'requester', attributes: ['id', 'name'] }],
    });
    if (!preReq) return res.status(404).json({ success: false, message: 'Request not found.' });
    if (preReq.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Request is not pending.' });
    }

    const { reviewNote } = req.body;

    // Lock-then-update so two concurrent rejecters can't both succeed and
    // double-fire the reject notification. Same pattern as approveRequest;
    // simpler because there is no PermissionGrant to issue on reject.
    let request;
    try {
      request = await sequelize.transaction(async (t) => {
        const locked = await AccessRequest.findByPk(req.params.id, {
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
        if (!locked) {
          const e = new Error('Request not found.');
          e.statusCode = 404;
          throw e;
        }
        if (locked.status !== 'pending') {
          const e = new Error('Request is no longer pending (concurrent decision).');
          e.statusCode = 409;
          throw e;
        }
        await locked.update({
          status: 'rejected',
          reviewedBy: req.user.id,
          reviewedAt: new Date(),
          reviewNote: reviewNote || null,
        }, { transaction: t });
        return locked;
      });
    } catch (txErr) {
      const code = txErr.statusCode || 500;
      return res.status(code).json({
        success: false,
        message: code === 500 ? 'Failed to reject request.' : txErr.message,
      });
    }
    request.requester = preReq.requester;

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
