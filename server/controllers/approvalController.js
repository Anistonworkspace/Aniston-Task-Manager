const { Task, User, Notification, TaskWatcher, DueDateExtension, HelpRequest, Board, Activity } = require('../models');
const { Op } = require('sequelize');
const { logActivity } = require('../services/activityService');
const { emitToBoard, emitToUser } = require('../services/socketService');

// POST /api/tasks/:id/submit-approval
exports.submitForApproval = async (req, res) => {
  try {
    const task = await Task.findByPk(req.params.id, {
      include: [{ model: User, as: 'assignee', attributes: ['id', 'name'] }],
    });
    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });

    const chain = task.approvalChain || [];
    chain.push({
      userId: req.user.id,
      userName: req.user.name,
      action: 'submitted',
      comment: req.body.comment || '',
      timestamp: new Date().toISOString(),
    });

    await task.update({
      approvalStatus: 'pending_approval',
      approvalChain: chain,
    });

    // Notify user's manager + director (hierarchy chain), not all managers
    const reviewerIds = new Set();
    // Walk up the management chain
    let currentUser = await User.findByPk(req.user.id, { attributes: ['id', 'managerId'] });
    while (currentUser?.managerId) {
      reviewerIds.add(currentUser.managerId);
      currentUser = await User.findByPk(currentUser.managerId, { attributes: ['id', 'managerId'] });
    }
    // Also notify any admin users (for CEO/director who may not be in chain)
    const admins = await User.findAll({ where: { role: 'admin', isActive: true }, attributes: ['id'] });
    admins.forEach(a => reviewerIds.add(a.id));
    // Remove self
    reviewerIds.delete(req.user.id);

    for (const reviewerId of reviewerIds) {
      await Notification.create({
        type: 'task_updated',
        message: `"${task.title}" submitted for approval by ${req.user.name}`,
        entityType: 'task',
        entityId: task.id,
        userId: reviewerId,
      });
      emitToUser(reviewerId, 'notification:new', {
        message: `Task "${task.title}" needs approval`,
      });
    }

    // Notify watchers
    const watchers = await TaskWatcher.findAll({ where: { taskId: task.id } });
    for (const w of watchers) {
      if (w.userId !== req.user.id) {
        await Notification.create({
          type: 'task_updated',
          message: `"${task.title}" submitted for approval`,
          entityType: 'task',
          entityId: task.id,
          userId: w.userId,
        });
      }
    }

    logActivity({
      action: 'task_submitted_approval',
      description: `${req.user.name} submitted "${task.title}" for approval`,
      entityType: 'task',
      entityId: task.id,
      taskId: task.id,
      boardId: task.boardId,
      userId: req.user.id,
    });

    emitToBoard(task.boardId, 'task:updated', { task });
    res.json({ success: true, data: { task } });
  } catch (err) {
    console.error('[Approval] submitForApproval error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to submit for approval.' });
  }
};

// POST /api/tasks/:id/approve
exports.approveTask = async (req, res) => {
  try {
    const task = await Task.findByPk(req.params.id, {
      include: [{ model: User, as: 'assignee', attributes: ['id', 'name'] }],
    });
    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });

    const chain = task.approvalChain || [];
    chain.push({
      userId: req.user.id,
      userName: req.user.name,
      action: 'approved',
      comment: req.body.comment || '',
      timestamp: new Date().toISOString(),
    });

    await task.update({
      approvalStatus: 'approved',
      approvalChain: chain,
      status: 'done',
    });

    // Notify task assignee and creator
    const notifyUserIds = new Set([task.assignedTo, task.createdBy].filter(Boolean));
    for (const uid of notifyUserIds) {
      await Notification.create({
        type: 'task_updated',
        message: `"${task.title}" has been approved by ${req.user.name}`,
        entityType: 'task',
        entityId: task.id,
        userId: uid,
      });
      emitToUser(uid, 'notification:new', { message: `Task "${task.title}" approved` });
    }

    logActivity({
      action: 'task_approved',
      description: `${req.user.name} approved "${task.title}"`,
      entityType: 'task',
      entityId: task.id,
      taskId: task.id,
      boardId: task.boardId,
      userId: req.user.id,
    });

    emitToBoard(task.boardId, 'task:updated', { task });
    res.json({ success: true, data: { task } });
  } catch (err) {
    console.error('[Approval] approveTask error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to approve task.' });
  }
};

// POST /api/tasks/:id/request-changes
exports.requestChanges = async (req, res) => {
  try {
    const task = await Task.findByPk(req.params.id);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });

    const chain = task.approvalChain || [];
    chain.push({
      userId: req.user.id,
      userName: req.user.name,
      action: 'changes_requested',
      comment: req.body.comment || '',
      timestamp: new Date().toISOString(),
    });

    await task.update({
      approvalStatus: 'changes_requested',
      approvalChain: chain,
    });

    // Notify assignee
    if (task.assignedTo) {
      await Notification.create({
        type: 'task_updated',
        message: `Changes requested on "${task.title}" by ${req.user.name}`,
        entityType: 'task',
        entityId: task.id,
        userId: task.assignedTo,
      });
      emitToUser(task.assignedTo, 'notification:new', {
        message: `Changes requested on "${task.title}"`,
      });
    }

    logActivity({
      action: 'task_changes_requested',
      description: `${req.user.name} requested changes on "${task.title}"`,
      entityType: 'task',
      entityId: task.id,
      taskId: task.id,
      boardId: task.boardId,
      userId: req.user.id,
    });

    emitToBoard(task.boardId, 'task:updated', { task });
    res.json({ success: true, data: { task } });
  } catch (err) {
    console.error('[Approval] requestChanges error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to request changes.' });
  }
};

// GET /api/tasks/pending-approvals — tasks needing approval
exports.getPendingApprovals = async (req, res) => {
  try {
    const tasks = await Task.findAll({
      where: { approvalStatus: 'pending_approval' },
      include: [
        { model: User, as: 'assignee', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: User, as: 'creator', attributes: ['id', 'name'] },
      ],
      order: [['updatedAt', 'DESC']],
    });
    res.json({ success: true, data: { tasks } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch pending approvals.' });
  }
};

/**
 * GET /api/task-extras/workflow-items
 * Returns all workflow items (approvals, extensions, delegations, help requests) scoped by role.
 */
exports.getWorkflowItems = async (req, res) => {
  try {
    const user = req.user;
    const isMember = user.role === 'member';

    // 1. Approvals — tasks with pending/approved/changes_requested status (exclude archived)
    const approvalWhere = { approvalStatus: { [Op.ne]: null }, isArchived: false };
    if (isMember) approvalWhere.assignedTo = user.id;
    const approvals = await Task.findAll({
      where: approvalWhere,
      include: [
        { model: User, as: 'assignee', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: User, as: 'creator', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: Board, as: 'board', attributes: ['id', 'name', 'color'] },
      ],
      order: [['updatedAt', 'DESC']],
      limit: 100,
    });

    // 2. Extensions — due date extension requests
    const extWhere = {};
    if (isMember) extWhere.requestedBy = user.id;
    const extensions = await DueDateExtension.findAll({
      where: extWhere,
      include: [
        { model: User, as: 'requester', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: User, as: 'reviewer', attributes: ['id', 'name'], required: false },
        { model: Task, as: 'task', attributes: ['id', 'title', 'boardId'], include: [{ model: Board, as: 'board', attributes: ['id', 'name', 'color'] }] },
      ],
      order: [['createdAt', 'DESC']],
      limit: 100,
    });

    // 3. Delegations — recent delegation activities
    const delegationWhere = { action: 'task_delegated' };
    if (isMember) delegationWhere.userId = user.id;
    const delegations = await Activity.findAll({
      where: delegationWhere,
      include: [
        { model: User, as: 'actor', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: Task, as: 'task', attributes: ['id', 'title', 'status', 'assignedTo'], required: false },
      ],
      order: [['createdAt', 'DESC']],
      limit: 50,
    });

    // 4. Help requests
    const helpWhere = {};
    if (isMember) helpWhere[Op.or] = [{ requestedBy: user.id }, { requestedTo: user.id }];
    const helpRequests = await HelpRequest.findAll({
      where: helpWhere,
      include: [
        { model: User, as: 'requester', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: User, as: 'helper', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: Task, as: 'task', attributes: ['id', 'title', 'boardId'], include: [{ model: Board, as: 'board', attributes: ['id', 'name', 'color'] }] },
      ],
      order: [['createdAt', 'DESC']],
      limit: 100,
    });

    res.json({
      success: true,
      data: { approvals, extensions, delegations, helpRequests },
    });
  } catch (err) {
    console.error('[WorkflowItems] Error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch workflow items.' });
  }
};
