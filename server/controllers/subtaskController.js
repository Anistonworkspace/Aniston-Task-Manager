const { validationResult } = require('express-validator');
const { Subtask, Task, User } = require('../models');
const { logActivity } = require('../services/activityService');

// POST /api/subtasks
const createSubtask = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { title, taskId, assignedTo } = req.body;

    // Verify parent task exists
    const task = await Task.findByPk(taskId);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Parent task not found.' });
    }

    // Members can only add subtasks to tasks assigned to them
    if (req.user.role === 'member' && task.assignedTo !== req.user.id) {
      return res.status(403).json({ success: false, message: 'You can only add subtasks to tasks assigned to you.' });
    }

    // Get next position
    const maxPos = await Subtask.max('position', { where: { taskId } });
    const position = (maxPos || 0) + 1;

    const subtask = await Subtask.create({
      title,
      taskId,
      assignedTo: assignedTo || null,
      createdBy: req.user.id,
      position,
    });

    // Fetch with associations
    const fullSubtask = await Subtask.findByPk(subtask.id, {
      include: [
        { model: User, as: 'creator', attributes: ['id', 'name', 'avatar'] },
        { model: User, as: 'assignee', attributes: ['id', 'name', 'avatar'] },
      ],
    });

    logActivity({
      action: 'subtask_added',
      description: `${req.user.name} added subtask "${title}"`,
      entityType: 'subtask',
      entityId: subtask.id,
      taskId,
      boardId: task.boardId,
      userId: req.user.id,
    });

    res.status(201).json({ success: true, data: { subtask: fullSubtask } });
  } catch (error) {
    console.error('Create subtask error:', error);
    res.status(500).json({ success: false, message: 'Server error creating subtask.' });
  }
};

// GET /api/subtasks?taskId=xxx
const getSubtasks = async (req, res) => {
  try {
    const { taskId } = req.query;
    if (!taskId) {
      return res.status(400).json({ success: false, message: 'taskId query parameter is required.' });
    }

    const subtasks = await Subtask.findAll({
      where: { taskId },
      include: [
        { model: User, as: 'creator', attributes: ['id', 'name', 'avatar'] },
        { model: User, as: 'assignee', attributes: ['id', 'name', 'avatar'] },
      ],
      order: [['position', 'ASC']],
    });

    res.json({ success: true, data: { subtasks } });
  } catch (error) {
    console.error('Get subtasks error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching subtasks.' });
  }
};

// PUT /api/subtasks/:id
const updateSubtask = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const subtask = await Subtask.findByPk(req.params.id, {
      include: [{ model: Task, as: 'task' }],
    });

    if (!subtask) {
      return res.status(404).json({ success: false, message: 'Subtask not found.' });
    }

    const isMember = req.user.role === 'member';

    // Members can only update subtasks on tasks assigned to them
    if (isMember && subtask.task.assignedTo !== req.user.id) {
      return res.status(403).json({ success: false, message: 'You can only update subtasks on tasks assigned to you.' });
    }

    // Members can only update status
    const allowedFields = isMember ? ['status'] : ['title', 'status', 'assignedTo'];
    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    await subtask.update(updates);

    if (updates.status) {
      logActivity({
        action: 'subtask_status_changed',
        description: `${req.user.name} changed subtask "${subtask.title}" to "${updates.status}"`,
        entityType: 'subtask',
        entityId: subtask.id,
        taskId: subtask.taskId,
        boardId: subtask.task.boardId,
        userId: req.user.id,
        meta: { status: updates.status },
      });
    }

    // Fetch updated subtask with associations
    const fullSubtask = await Subtask.findByPk(subtask.id, {
      include: [
        { model: User, as: 'creator', attributes: ['id', 'name', 'avatar'] },
        { model: User, as: 'assignee', attributes: ['id', 'name', 'avatar'] },
      ],
    });

    res.json({ success: true, data: { subtask: fullSubtask } });
  } catch (error) {
    console.error('Update subtask error:', error);
    res.status(500).json({ success: false, message: 'Server error updating subtask.' });
  }
};

// DELETE /api/subtasks/:id
const deleteSubtask = async (req, res) => {
  try {
    const subtask = await Subtask.findByPk(req.params.id);

    if (!subtask) {
      return res.status(404).json({ success: false, message: 'Subtask not found.' });
    }

    await subtask.destroy();
    res.json({ success: true, message: 'Subtask deleted.' });
  } catch (error) {
    console.error('Delete subtask error:', error);
    res.status(500).json({ success: false, message: 'Server error deleting subtask.' });
  }
};

module.exports = { createSubtask, getSubtasks, updateSubtask, deleteSubtask };
