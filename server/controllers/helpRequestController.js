const { HelpRequest, Task, User, Notification } = require('../models');
const { logActivity } = require('../services/activityService');
const { emitToUser } = require('../services/socketService');

// POST /api/help-requests
exports.createHelpRequest = async (req, res) => {
  try {
    const { taskId, requestedTo, description, urgency, preferredTime } = req.body;
    if (!taskId || !requestedTo || !description) {
      return res.status(400).json({ success: false, message: 'taskId, requestedTo, description required.' });
    }

    const task = await Task.findByPk(taskId);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });

    const hr = await HelpRequest.create({
      taskId, requestedBy: req.user.id, requestedTo, description,
      urgency: urgency || 'medium', preferredTime: preferredTime || null,
    });

    // Notify helper
    await Notification.create({
      type: 'task_updated', message: `${req.user.name} needs help with "${task.title}" (${urgency || 'medium'} urgency)`,
      entityType: 'task', entityId: taskId, userId: requestedTo,
    });
    emitToUser(requestedTo, 'notification:new', { message: `Help requested on "${task.title}"` });

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
    const where = {};
    if (req.query.status) where.status = req.query.status;
    if (req.query.taskId) where.taskId = req.query.taskId;
    // Members see their own requests; managers see requests sent to them + all
    if (req.user.role === 'member') {
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
exports.updateStatus = async (req, res) => {
  try {
    const hr = await HelpRequest.findByPk(req.params.id);
    if (!hr) return res.status(404).json({ success: false, message: 'Not found.' });

    const { status, meetingLink, meetingScheduledAt } = req.body;
    const updates = { status };
    if (meetingLink) updates.meetingLink = meetingLink;
    if (meetingScheduledAt) updates.meetingScheduledAt = meetingScheduledAt;
    if (status === 'resolved') updates.resolvedAt = new Date();

    await hr.update(updates);

    // Notify requester
    await Notification.create({
      type: 'task_updated', message: `Your help request status updated to "${status}"`,
      entityType: 'help_request', entityId: hr.id, userId: hr.requestedBy,
    });
    emitToUser(hr.requestedBy, 'notification:new', { message: `Help request ${status}` });

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
      where: { requestedTo: req.user.id, status: { [Op.in]: ['pending', 'in_review'] } },
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
