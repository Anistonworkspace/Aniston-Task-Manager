const { WorkLog, Task, User, Board } = require('../models');
const { validationResult } = require('express-validator');
const { Op } = require('sequelize');
const { logActivity } = require('../services/activityService');
const { sanitizeInput } = require('../utils/sanitize');

/**
 * POST /api/worklogs
 * Any authenticated user can create a work log for tasks assigned to them.
 * Manager/Admin can create logs for any task on their boards.
 */
const createWorkLog = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { content, taskId, date } = req.body;

    const task = await Task.findByPk(taskId);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }

    // Members can only add logs to tasks assigned to them
    if (req.user.role === 'member' && task.assignedTo !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'You can only add work logs to tasks assigned to you.',
      });
    }

    const worklog = await WorkLog.create({
      content: sanitizeInput(content),
      taskId,
      date: date || new Date().toISOString().slice(0, 10),
      userId: req.user.id,
    });

    const fullLog = await WorkLog.findByPk(worklog.id, {
      include: [
        { model: User, as: 'author', attributes: ['id', 'name', 'email', 'avatar'] },
      ],
    });

    logActivity({
      action: 'worklog_added',
      description: `${req.user.name} added a daily update`,
      entityType: 'worklog',
      entityId: worklog.id,
      taskId,
      boardId: task.boardId,
      userId: req.user.id,
    });

    res.status(201).json({
      success: true,
      message: 'Work log created.',
      data: { worklog: fullLog },
    });
  } catch (error) {
    console.error('[WorkLog] Create error:', error);
    res.status(500).json({ success: false, message: 'Server error creating work log.' });
  }
};

/**
 * GET /api/worklogs?taskId=...&userId=...&date=...&boardId=...
 * Members see only their own logs. Manager/Admin see all logs for their boards.
 */
const getWorkLogs = async (req, res) => {
  try {
    const { taskId, userId, date, boardId } = req.query;

    const where = {};

    if (taskId) where.taskId = taskId;
    if (date) where.date = date;

    // Members can only see their own logs
    if (req.user.role === 'member') {
      where.userId = req.user.id;
    } else if (userId) {
      where.userId = userId;
    }

    // If boardId filter, get all tasks for that board first
    if (boardId) {
      const boardTasks = await Task.findAll({
        where: { boardId, isArchived: false },
        attributes: ['id'],
      });
      where.taskId = { [Op.in]: boardTasks.map(t => t.id) };
    }

    const worklogs = await WorkLog.findAll({
      where,
      include: [
        { model: User, as: 'author', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: Task, as: 'task', attributes: ['id', 'title', 'boardId'] },
      ],
      order: [['date', 'DESC'], ['createdAt', 'DESC']],
    });

    res.json({ success: true, data: { worklogs } });
  } catch (error) {
    console.error('[WorkLog] GetWorkLogs error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching work logs.' });
  }
};

/**
 * PUT /api/worklogs/:id
 * Users can edit their own logs. Manager/Admin can edit any log.
 */
const updateWorkLog = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const worklog = await WorkLog.findByPk(req.params.id);
    if (!worklog) {
      return res.status(404).json({ success: false, message: 'Work log not found.' });
    }

    // Members can only edit their own logs
    if (req.user.role === 'member' && worklog.userId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'You can only edit your own work logs.' });
    }

    const { content } = req.body;
    if (content !== undefined) {
      await worklog.update({ content: sanitizeInput(content) });
    }

    const fullLog = await WorkLog.findByPk(worklog.id, {
      include: [
        { model: User, as: 'author', attributes: ['id', 'name', 'email', 'avatar'] },
      ],
    });

    res.json({ success: true, message: 'Work log updated.', data: { worklog: fullLog } });
  } catch (error) {
    console.error('[WorkLog] Update error:', error);
    res.status(500).json({ success: false, message: 'Server error updating work log.' });
  }
};

/**
 * DELETE /api/worklogs/:id
 * Manager/Admin only (route-level protection).
 */
const deleteWorkLog = async (req, res) => {
  try {
    const worklog = await WorkLog.findByPk(req.params.id);
    if (!worklog) {
      return res.status(404).json({ success: false, message: 'Work log not found.' });
    }

    await worklog.destroy();
    res.json({ success: true, message: 'Work log deleted.' });
  } catch (error) {
    console.error('[WorkLog] Delete error:', error);
    res.status(500).json({ success: false, message: 'Server error deleting work log.' });
  }
};

module.exports = { createWorkLog, getWorkLogs, updateWorkLog, deleteWorkLog };
