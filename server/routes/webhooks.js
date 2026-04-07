const express = require('express');
const router = express.Router();
const { Task, Board, User, Notification } = require('../models');
const { sendTeamsNotification } = require('../services/teamsWebhook');
const { getIO } = require('../services/socketService');

// ── Webhook API key authentication ──────────────────────────
// Set WEBHOOK_API_KEY in .env. Requests must send header: x-webhook-key: <key>
const webhookAuth = (req, res, next) => {
  const apiKey = process.env.WEBHOOK_API_KEY;
  if (!apiKey) {
    // If no key configured, reject all webhook requests in production
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ message: 'Webhooks not configured. Set WEBHOOK_API_KEY in .env' });
    }
    // In development, allow without key but log warning
    console.warn('[Webhook] WARNING: WEBHOOK_API_KEY not set — webhooks are unprotected');
    return next();
  }
  const providedKey = req.headers['x-webhook-key'];
  if (!providedKey || providedKey !== apiKey) {
    return res.status(401).json({ message: 'Invalid or missing webhook API key' });
  }
  next();
};

router.use(webhookAuth);

// POST /api/webhooks/n8n/task-created - Webhook when task is created (n8n sends here)
router.post('/n8n/task-created', async (req, res) => {
  try {
    const { title, boardId, assignedTo, priority, status, dueDate, description } = req.body;

    if (!title || !boardId) {
      return res.status(400).json({ message: 'title and boardId are required' });
    }

    const board = await Board.findByPk(boardId);
    if (!board) return res.status(404).json({ message: 'Board not found' });

    const groups = board.groups || [];
    const firstGroup = groups[0];

    const task = await Task.create({
      title,
      description: description || '',
      boardId,
      assignedTo: assignedTo || null,
      priority: priority || 'medium',
      status: status || 'not_started',
      dueDate: dueDate || null,
      groupId: firstGroup?.id || 'new',
      position: 0,
      createdBy: board.createdBy || null,
    });

    // Emit socket event
    try {
      const io = getIO();
      io.to(`board:${boardId}`).emit('task:created', task);
    } catch (e) {}

    // Send Teams notification
    try {
      await sendTeamsNotification({
        type: 'task_created',
        task: { ...task.toJSON(), board: { name: board.name } },
      });
    } catch (e) {}

    res.status(201).json({ success: true, task });
  } catch (err) {
    console.error('n8n task-created webhook error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// POST /api/webhooks/n8n/task-updated - Webhook when task is updated from n8n
router.post('/n8n/task-updated', async (req, res) => {
  try {
    const { taskId, status, priority, assignedTo, dueDate, title, description } = req.body;

    if (!taskId) {
      return res.status(400).json({ message: 'taskId is required' });
    }

    const task = await Task.findByPk(taskId, { include: [{ model: Board, as: 'board' }] });
    if (!task) return res.status(404).json({ message: 'Task not found' });

    const updates = {};
    if (status) updates.status = status;
    if (priority) updates.priority = priority;
    if (assignedTo !== undefined) updates.assignedTo = assignedTo;
    if (dueDate !== undefined) updates.dueDate = dueDate;
    if (title) updates.title = title;
    if (description !== undefined) updates.description = description;

    await task.update(updates);

    try {
      const io = getIO();
      io.to(`board:${task.boardId}`).emit('task:updated', task);
    } catch (e) {}

    res.json({ success: true, task });
  } catch (err) {
    console.error('n8n task-updated webhook error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /api/webhooks/n8n/tasks - n8n polls for tasks (for email followup workflows)
router.get('/n8n/tasks', async (req, res) => {
  try {
    const { boardId, status, priority, assignedTo, overdue } = req.query;

    const where = {};
    if (boardId) where.boardId = boardId;
    if (status) where.status = status;
    if (priority) where.priority = priority;
    if (assignedTo) where.assignedTo = assignedTo;

    if (overdue === 'true') {
      const { Op } = require('sequelize');
      where.dueDate = { [Op.lt]: new Date() };
      where.status = { [Op.ne]: 'done' };
    }

    const tasks = await Task.findAll({
      where,
      include: [
        { model: User, as: 'assignee', attributes: ['id', 'name', 'email'] },
        { model: User, as: 'creator', attributes: ['id', 'name', 'email'] },
        { model: Board, as: 'board', attributes: ['id', 'name'] },
      ],
      order: [['createdAt', 'DESC']],
    });

    res.json({ success: true, tasks });
  } catch (err) {
    console.error('n8n tasks webhook error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /api/webhooks/n8n/boards - n8n gets list of boards
router.get('/n8n/boards', async (req, res) => {
  try {
    const boards = await Board.findAll({
      where: { isArchived: false },
      attributes: ['id', 'name', 'description', 'color', 'createdAt'],
      order: [['createdAt', 'DESC']],
    });
    res.json({ success: true, boards });
  } catch (err) {
    res.status(500).json({ message: 'Internal server error' });
  }
});

// GET /api/webhooks/n8n/users - n8n gets list of users (for assignment)
router.get('/n8n/users', async (req, res) => {
  try {
    const users = await User.findAll({
      where: { isActive: true },
      attributes: ['id', 'name', 'email', 'department', 'role'],
    });
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ message: 'Internal server error' });
  }
});

// POST /api/webhooks/n8n/send-notification - n8n triggers notification
router.post('/n8n/send-notification', async (req, res) => {
  try {
    const { userId, message, type, entityType, entityId } = req.body;

    if (!userId || !message) {
      return res.status(400).json({ message: 'userId and message are required' });
    }

    const notification = await Notification.create({
      userId,
      message,
      type: type || 'task_updated',
      entityType: entityType || 'task',
      entityId: entityId || null,
      isRead: false,
    });

    try {
      const io = getIO();
      io.to(`user:${userId}`).emit('notification:new', notification);
    } catch (e) {}

    res.status(201).json({ success: true, notification });
  } catch (err) {
    res.status(500).json({ message: 'Internal server error' });
  }
});

// POST /api/webhooks/n8n/teams-message - n8n sends Teams message
router.post('/n8n/teams-message', async (req, res) => {
  try {
    const { title, message, taskId } = req.body;

    await sendTeamsNotification({
      type: 'custom',
      title: title || 'Notification',
      message: message || '',
      taskId,
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: 'Failed to send Teams message' });
  }
});

module.exports = router;
