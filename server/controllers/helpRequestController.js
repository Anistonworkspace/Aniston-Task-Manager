const { HelpRequest, Task, User, Notification } = require('../models');
const { Op } = require('sequelize');
const { logActivity } = require('../services/activityService');
const { emitToUser } = require('../services/socketService');
const { canPermanentlyDelete, getProtectionInfo } = require('../utils/archiveHelpers');
const { sanitizeNotificationField, sanitizeNotificationMessage } = require('../utils/sanitize');
const taskVisibility = require('../services/taskVisibilityService');
const { isTier4 } = require('../config/tiers');
const { createNotification, buildIdempotencyKey } = require('../services/notificationService');

// POST /api/help-requests
exports.createHelpRequest = async (req, res) => {
  try {
    const { taskId, requestedTo, description, urgency, preferredTime } = req.body;
    if (!taskId || !requestedTo || !description) {
      return res.status(400).json({ success: false, message: 'taskId, requestedTo, description required.' });
    }

    const task = await Task.findByPk(taskId);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });

    // RBAC: helper must be authorized to see the parent task. Without this
    // check a member can leak a task title to any user by picking them as
    // the helper — the helper would receive the title in the notification
    // body even though they cannot otherwise access the task.
    const authorized = await taskVisibility.getAuthorizedRealtimeRecipients(task);
    if (!authorized.includes(requestedTo)) {
      return res.status(403).json({
        success: false,
        message: 'Selected helper does not have access to this task.',
      });
    }

    const hr = await HelpRequest.create({
      taskId, requestedBy: req.user.id, requestedTo, description,
      urgency: urgency || 'medium', preferredTime: preferredTime || null,
    });

    // Notify helper. Idempotent on the help request id.
    const helperMsg = sanitizeNotificationMessage(
      `${sanitizeNotificationField(req.user.name)} needs help with "${sanitizeNotificationField(task.title)}" ` +
      `(${sanitizeNotificationField(urgency || 'medium', 16)} urgency)`
    );
    await createNotification({
      userId: requestedTo,
      type: 'help_requested',
      message: helperMsg,
      entityType: 'task',
      entityId: taskId,
      boardId: task.boardId,
      idempotencyKey: buildIdempotencyKey('help-requested', hr.id),
      sanitize: false,
    });

    logActivity({ action: 'help_requested', description: `${req.user.name} requested help on "${task.title}"`, entityType: 'task', entityId: taskId, taskId, boardId: task.boardId, userId: req.user.id, meta: { urgency, requestedTo } });

    const full = await HelpRequest.findByPk(hr.id, {
      include: [
        { model: User, as: 'requester', attributes: ['id', 'name', 'avatar'] },
        { model: User, as: 'helper', attributes: ['id', 'name', 'avatar'] },
        { model: Task, as: 'task', attributes: ['id', 'title'] },
      ],
    });
    res.status(201).json({ success: true, data: { helpRequest: full } });
  } catch (err) {
    console.error('[HelpRequest] create error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create help request.' });
  }
};

// GET /api/help-requests
exports.getHelpRequests = async (req, res) => {
  try {
    const where = { [Op.or]: [{ isArchived: false }, { isArchived: null }] };
    if (req.query.status) where.status = req.query.status;
    if (req.query.taskId) where.taskId = req.query.taskId;
    // Members see their own requests; managers see requests sent to them + all
    if (isTier4(req.user)) {
      const { Op } = require('sequelize');
      where[Op.or] = [{ requestedBy: req.user.id }, { requestedTo: req.user.id }];
    }

    const requests = await HelpRequest.findAll({
      where,
      include: [
        { model: User, as: 'requester', attributes: ['id', 'name', 'avatar', 'email'] },
        { model: User, as: 'helper', attributes: ['id', 'name', 'avatar', 'email'] },
        { model: Task, as: 'task', attributes: ['id', 'title', 'status', 'boardId'] },
      ],
      order: [['createdAt', 'DESC']],
    });
    res.json({ success: true, data: { helpRequests: requests } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch help requests.' });
  }
};

// PUT /api/help-requests/:id/status
// Authorization: only the helper (requestedTo), the requester, or manager+ can update status
exports.updateStatus = async (req, res) => {
  try {
    const hr = await HelpRequest.findByPk(req.params.id);
    if (!hr) return res.status(404).json({ success: false, message: 'Not found.' });

    const isHelper = hr.requestedTo === req.user.id;
    const isRequester = hr.requestedBy === req.user.id;
    const isManagerPlus = ['admin', 'manager', 'assistant_manager'].includes(req.user.role) || !!req.user.isSuperAdmin;
    if (!isHelper && !isRequester && !isManagerPlus) {
      return res.status(403).json({ success: false, message: 'Not authorized to update this help request.' });
    }

    const { status, meetingLink, meetingScheduledAt } = req.body;
    const updates = { status };
    if (meetingLink) updates.meetingLink = meetingLink;
    if (meetingScheduledAt) updates.meetingScheduledAt = meetingScheduledAt;
    if (status === 'resolved') updates.resolvedAt = new Date();

    await hr.update(updates);

    // Notify requester. Idempotent per (helpRequest, status) so the user
    // can move from pending → in_review → resolved and each transition
    // notifies once, but a retried PUT to the same status does not.
    const respondedMsg = sanitizeNotificationMessage(
      `Your help request status updated to "${sanitizeNotificationField(status, 32)}"`
    );
    await createNotification({
      userId: hr.requestedBy,
      type: 'help_responded',
      message: respondedMsg,
      entityType: 'help_request',
      entityId: hr.id,
      idempotencyKey: buildIdempotencyKey('help-responded', hr.id, status),
      sanitize: false,
    });

    res.json({ success: true, data: { helpRequest: hr } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update help request.' });
  }
};

// GET /api/help-requests/my-pending — help requests sent TO current user
exports.getMyPendingHelp = async (req, res) => {
  try {
    const { Op } = require('sequelize');
    const requests = await HelpRequest.findAll({
      where: { requestedTo: req.user.id, status: { [Op.in]: ['pending', 'in_review'] }, [Op.or]: [{ isArchived: false }, { isArchived: null }] },
      include: [
        { model: User, as: 'requester', attributes: ['id', 'name', 'avatar'] },
        { model: Task, as: 'task', attributes: ['id', 'title', 'status', 'boardId'] },
      ],
      order: [
        [require('sequelize').literal(`CASE WHEN urgency = 'critical' THEN 0 WHEN urgency = 'high' THEN 1 WHEN urgency = 'medium' THEN 2 ELSE 3 END`), 'ASC'],
        ['createdAt', 'ASC'],
      ],
    });
    res.json({ success: true, data: { helpRequests: requests } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch pending help.' });
  }
};

// PUT /api/help-requests/:id/archive
exports.archiveHelpRequest = async (req, res) => {
  try {
    const hr = await HelpRequest.findByPk(req.params.id);
    if (!hr) return res.status(404).json({ success: false, message: 'Not found.' });

    if (hr.status !== 'resolved') {
      return res.status(400).json({ success: false, message: 'Only resolved help requests can be archived.' });
    }

    const isManager = ['manager', 'admin', 'assistant_manager'].includes(req.user.role);
    const isInvolved = hr.requestedBy === req.user.id || hr.requestedTo === req.user.id;
    if (!isManager && !isInvolved) {
      return res.status(403).json({ success: false, message: 'Not authorized.' });
    }

    await hr.update({ isArchived: true, archivedAt: new Date(), archivedBy: req.user.id });
    logActivity({ action: 'help_request_archived', description: `${req.user.name} archived a help request`, entityType: 'help_request', entityId: hr.id, userId: req.user.id });

    res.json({ success: true, message: 'Help request archived.' });
  } catch (err) {
    console.error('[HelpRequest] archive error:', err);
    res.status(500).json({ success: false, message: 'Failed to archive help request.' });
  }
};

// GET /api/archive/help-requests
exports.getArchivedHelpRequests = async (req, res) => {
  try {
    const { search, dateFrom, dateTo } = req.query;
    const where = { isArchived: true };

    if (dateFrom || dateTo) {
      where.archivedAt = {};
      if (dateFrom) where.archivedAt[Op.gte] = new Date(dateFrom);
      if (dateTo) where.archivedAt[Op.lte] = new Date(dateTo + 'T23:59:59Z');
    }

    const requests = await HelpRequest.findAll({
      where,
      include: [
        { model: User, as: 'requester', attributes: ['id', 'name', 'avatar'] },
        { model: User, as: 'helper', attributes: ['id', 'name', 'avatar'] },
        {
          model: Task, as: 'task', attributes: ['id', 'title', 'status', 'boardId'],
          ...(search ? { where: { title: { [Op.iLike]: `%${search}%` } } } : {}),
          required: !!search,
        },
        { model: User, as: 'archiver', attributes: ['id', 'name'] },
      ],
      order: [['archivedAt', 'DESC']],
    });

    const data = requests.map(r => {
      const plain = r.toJSON();
      plain.protectionInfo = getProtectionInfo(plain.archivedAt);
      return plain;
    });

    res.json({ success: true, data: { helpRequests: data } });
  } catch (err) {
    console.error('[HelpRequest] getArchived error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch archived help requests.' });
  }
};

// DELETE /api/archive/help-requests/:id
exports.permanentDeleteHelpRequest = async (req, res) => {
  try {
    const hr = await HelpRequest.findByPk(req.params.id);
    if (!hr) return res.status(404).json({ success: false, message: 'Not found.' });
    if (!hr.isArchived) return res.status(400).json({ success: false, message: 'Only archived help requests can be permanently deleted.' });

    const { allowed, daysRemaining } = canPermanentlyDelete(req.user, hr.archivedAt);
    if (!allowed) {
      return res.status(403).json({ success: false, message: `Protected for ${daysRemaining} more days. Only Super Admin can delete before 90 days.` });
    }

    await hr.destroy();
    res.json({ success: true, message: 'Help request permanently deleted.' });
  } catch (err) {
    console.error('[HelpRequest] permanentDelete error:', err);
    res.status(500).json({ success: false, message: 'Failed to delete.' });
  }
};

// PUT /api/archive/help-requests/:id/restore
exports.restoreHelpRequest = async (req, res) => {
  try {
    const hr = await HelpRequest.findByPk(req.params.id);
    if (!hr) return res.status(404).json({ success: false, message: 'Not found.' });

    await hr.update({ isArchived: false, archivedAt: null, archivedBy: null });
    res.json({ success: true, message: 'Help request restored.' });
  } catch (err) {
    console.error('[HelpRequest] restore error:', err);
    res.status(500).json({ success: false, message: 'Failed to restore.' });
  }
};
