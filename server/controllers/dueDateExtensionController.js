const { DueDateExtension, Task, User, Notification } = require('../models');
const { logActivity } = require('../services/activityService');
const { emitToUser } = require('../services/socketService');

// POST /api/extensions — request due date extension
exports.requestExtension = async (req, res) => {
  try {
    const { taskId, proposedDueDate, reason } = req.body;
    if (!taskId || !proposedDueDate || !reason) {
      return res.status(400).json({ success: false, message: 'taskId, proposedDueDate, and reason are required.' });
    }
    const task = await Task.findByPk(taskId);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });

    const ext = await DueDateExtension.create({
      taskId, requestedBy: req.user.id, currentDueDate: task.dueDate, proposedDueDate, reason,
    });

    // Notify managers
    const managers = await User.findAll({ where: { role: ['admin', 'manager'], isActive: true } });
    for (const mgr of managers) {
      await Notification.create({
        type: 'task_updated', message: `${req.user.name} requested due date extension for "${task.title}"`,
        entityType: 'task', entityId: taskId, userId: mgr.id,
      });
      emitToUser(mgr.id, 'notification:new', { message: `Due date extension requested for "${task.title}"` });
    }

    logActivity({ action: 'extension_requested', description: `${req.user.name} requested due date extension for "${task.title}"`, entityType: 'task', entityId: taskId, taskId, boardId: task.boardId, userId: req.user.id });

    const full = await DueDateExtension.findByPk(ext.id, {
      include: [{ model: User, as: 'requester', attributes: ['id', 'name', 'avatar'] }, { model: Task, as: 'task', attributes: ['id', 'title'] }],
    });
    res.status(201).json({ success: true, data: { extension: full } });
  } catch (err) {
    console.error('[Extension] request error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to request extension.' });
  }
};

// GET /api/extensions?status=pending
exports.getExtensions = async (req, res) => {
  try {
    const where = {};
    if (req.query.status) where.status = req.query.status;
    if (req.query.taskId) where.taskId = req.query.taskId;
    if (req.user.role === 'member') where.requestedBy = req.user.id;

    const extensions = await DueDateExtension.findAll({
      where,
      include: [
        { model: User, as: 'requester', attributes: ['id', 'name', 'avatar'] },
        { model: User, as: 'reviewer', attributes: ['id', 'name'] },
        { model: Task, as: 'task', attributes: ['id', 'title', 'dueDate', 'boardId'] },
      ],
      order: [['createdAt', 'DESC']],
    });
    res.json({ success: true, data: { extensions } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch extensions.' });
  }
};

// PUT /api/extensions/:id/approve
exports.approveExtension = async (req, res) => {
  try {
    const ext = await DueDateExtension.findByPk(req.params.id, { include: [{ model: Task, as: 'task' }] });
    if (!ext) return res.status(404).json({ success: false, message: 'Not found.' });

    const { reviewNote, suggestedDate } = req.body;
    const newDate = suggestedDate || ext.proposedDueDate;

    await ext.update({ status: 'approved', reviewedBy: req.user.id, reviewedAt: new Date(), reviewNote, suggestedDate: suggestedDate || null });
    // Update task due date
    await ext.task.update({ dueDate: newDate });

    await Notification.create({
      type: 'task_updated', message: `Your due date extension for "${ext.task.title}" was approved`,
      entityType: 'task', entityId: ext.taskId, userId: ext.requestedBy,
    });
    emitToUser(ext.requestedBy, 'notification:new', { message: `Due date extension approved for "${ext.task.title}"` });

    res.json({ success: true, data: { extension: ext } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to approve extension.' });
  }
};

// PUT /api/extensions/:id/reject
exports.rejectExtension = async (req, res) => {
  try {
    const ext = await DueDateExtension.findByPk(req.params.id, { include: [{ model: Task, as: 'task' }] });
    if (!ext) return res.status(404).json({ success: false, message: 'Not found.' });

    await ext.update({ status: 'rejected', reviewedBy: req.user.id, reviewedAt: new Date(), reviewNote: req.body.reviewNote, suggestedDate: req.body.suggestedDate || null });

    await Notification.create({
      type: 'task_updated', message: `Your due date extension for "${ext.task.title}" was rejected`,
      entityType: 'task', entityId: ext.taskId, userId: ext.requestedBy,
    });
    emitToUser(ext.requestedBy, 'notification:new', { message: `Due date extension rejected for "${ext.task.title}"` });

    res.json({ success: true, data: { extension: ext } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to reject extension.' });
  }
};
