const { Board, User, Task, Workspace, sequelize } = require('../models');
const { validationResult } = require('express-validator');
const { Op } = require('sequelize');
const { emitToBoard, emitToUser } = require('../services/socketService');

/**
 * POST /api/boards
 */
const createBoard = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { name, description, color, columns, groups } = req.body;

    const board = await Board.create({
      name,
      description: description || '',
      color: color || '#0073ea',
      columns: columns || undefined,
      groups: groups || undefined,
      createdBy: req.user.id,
    });

    // Auto-add creator as a board member
    await board.addMember(req.user.id);

    // Reload with associations
    const fullBoard = await Board.findByPk(board.id, {
      include: [
        { model: User, as: 'creator', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: User, as: 'members', attributes: ['id', 'name', 'email', 'avatar'], through: { attributes: [] } },
      ],
    });

    // Broadcast board creation to all connected users (for sidebar refresh)
    const { getIO } = require('../services/socketService');
    try { getIO().emit('board:created', { board: fullBoard }); } catch {}

    res.status(201).json({
      success: true,
      message: 'Board created successfully.',
      data: { board: fullBoard },
    });
  } catch (error) {
    console.error('[Board] Create error:', error);
    res.status(500).json({ success: false, message: 'Server error creating board.' });
  }
};

/**
 * GET /api/boards
 */
const getBoards = async (req, res) => {
  try {
    const { search, archived } = req.query;

    const where = {};

    if (archived !== 'true') {
      where.isArchived = false;
    }

    if (search) {
      where.name = { [Op.iLike]: `%${search}%` };
    }

    const boards = await Board.findAll({
      where,
      include: [
        { model: User, as: 'creator', attributes: ['id', 'name', 'email', 'avatar'] },
        {
          model: User,
          as: 'members',
          attributes: ['id', 'name', 'email', 'avatar'],
          through: { attributes: [] },
        },
      ],
      order: [['createdAt', 'DESC']],
    });

    // Attach member count and task count
    const boardIds = boards.map((b) => b.id);
    const taskCounts = await Task.findAll({
      attributes: ['boardId', [sequelize.fn('COUNT', sequelize.col('id')), 'taskCount']],
      where: { boardId: { [Op.in]: boardIds }, isArchived: false },
      group: ['boardId'],
      raw: true,
    });

    const taskCountMap = {};
    taskCounts.forEach((tc) => {
      taskCountMap[tc.boardId] = parseInt(tc.taskCount, 10);
    });

    // Members only see boards they belong to
    let visibleBoards = boards;
    if (req.user.role === 'member') {
      visibleBoards = boards.filter((b) =>
        b.members && b.members.some((m) => m.id === req.user.id)
      );
    }

    const data = visibleBoards.map((b) => ({
      ...b.toJSON(),
      memberCount: b.members ? b.members.length : 0,
      taskCount: taskCountMap[b.id] || 0,
    }));

    res.json({ success: true, data: { boards: data } });
  } catch (error) {
    console.error('[Board] GetBoards error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching boards.' });
  }
};

/**
 * GET /api/boards/:id
 */
const getBoard = async (req, res) => {
  try {
    const board = await Board.findByPk(req.params.id, {
      include: [
        { model: User, as: 'creator', attributes: ['id', 'name', 'email', 'avatar'] },
        {
          model: User,
          as: 'members',
          attributes: ['id', 'name', 'email', 'avatar'],
          through: { attributes: [] },
        },
        { model: Workspace, as: 'workspace', attributes: ['id', 'name', 'color', 'icon'], required: false },
        {
          model: Task,
          as: 'tasks',
          where: { isArchived: false },
          required: false,
          include: [
            { model: User, as: 'assignee', attributes: ['id', 'name', 'email', 'avatar'] },
            { model: User, as: 'creator', attributes: ['id', 'name', 'email', 'avatar', 'role'] },
          ],
          order: [['position', 'ASC']],
        },
      ],
    });

    if (!board) {
      return res.status(404).json({ success: false, message: 'Board not found.' });
    }

    // Members can view boards they belong to OR have tasks assigned on
    if (req.user.role === 'member') {
      const isMember = board.members && board.members.some((m) => m.id === req.user.id);
      const hasAssignedTasks = board.tasks && board.tasks.some((t) => t.assignedTo === req.user.id);
      if (!isMember && !hasAssignedTasks) {
        return res.status(403).json({ success: false, message: 'Access denied. You are not a member of this board.' });
      }
      // Auto-add as member if they have tasks but aren't a member yet
      if (!isMember && hasAssignedTasks) {
        try { await board.addMember(req.user.id); } catch (e) { /* ignore */ }
      }
    }

    res.json({ success: true, data: { board } });
  } catch (error) {
    console.error('[Board] GetBoard error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching board.' });
  }
};

/**
 * PUT /api/boards/:id
 */
const updateBoard = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const board = await Board.findByPk(req.params.id);
    if (!board) {
      return res.status(404).json({ success: false, message: 'Board not found.' });
    }

    const allowedFields = ['name', 'description', 'color', 'columns', 'groups', 'isArchived'];
    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    await board.update(updates);

    const fullBoard = await Board.findByPk(board.id, {
      include: [
        { model: User, as: 'creator', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: User, as: 'members', attributes: ['id', 'name', 'email', 'avatar'], through: { attributes: [] } },
      ],
    });

    // Real-time update
    emitToBoard(board.id, 'board:updated', { board: fullBoard });

    res.json({
      success: true,
      message: 'Board updated successfully.',
      data: { board: fullBoard },
    });
  } catch (error) {
    console.error('[Board] Update error:', error);
    res.status(500).json({ success: false, message: 'Server error updating board.' });
  }
};

/**
 * DELETE /api/boards/:id
 */
const deleteBoard = async (req, res) => {
  try {
    const board = await Board.findByPk(req.params.id);
    if (!board) {
      return res.status(404).json({ success: false, message: 'Board not found.' });
    }

    // Only the creator or an admin may delete
    if (board.createdBy !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only the board creator or an admin can delete this board.',
      });
    }

    const boardId = board.id;
    await board.destroy();

    emitToBoard(boardId, 'board:deleted', { boardId });
    // Also broadcast to all for sidebar refresh
    try { const { getIO } = require('../services/socketService'); getIO().emit('board:deleted', { boardId }); } catch {}

    res.json({ success: true, message: 'Board deleted successfully.' });
  } catch (error) {
    console.error('[Board] Delete error:', error);
    res.status(500).json({ success: false, message: 'Server error deleting board.' });
  }
};

/**
 * POST /api/boards/:id/members
 * Body: { userId }
 */
const addMember = async (req, res) => {
  try {
    const board = await Board.findByPk(req.params.id, {
      include: [
        { model: User, as: 'members', attributes: ['id'], through: { attributes: [] } },
      ],
    });

    if (!board) {
      return res.status(404).json({ success: false, message: 'Board not found.' });
    }

    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    const userToAdd = await User.findByPk(userId);
    if (!userToAdd) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const alreadyMember = board.members.some((m) => m.id === userId);
    if (alreadyMember) {
      return res.status(409).json({ success: false, message: 'User is already a board member.' });
    }

    await board.addMember(userId);

    // Notify the added user
    emitToUser(userId, 'board:memberAdded', {
      boardId: board.id,
      boardName: board.name,
    });

    // Reload full board
    const fullBoard = await Board.findByPk(board.id, {
      include: [
        { model: User, as: 'creator', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: User, as: 'members', attributes: ['id', 'name', 'email', 'avatar'], through: { attributes: [] } },
      ],
    });

    emitToBoard(board.id, 'board:updated', { board: fullBoard });

    res.json({
      success: true,
      message: 'Member added successfully.',
      data: { board: fullBoard },
    });
  } catch (error) {
    console.error('[Board] AddMember error:', error);
    res.status(500).json({ success: false, message: 'Server error adding member.' });
  }
};

/**
 * DELETE /api/boards/:id/members/:userId
 */
const removeMember = async (req, res) => {
  try {
    const board = await Board.findByPk(req.params.id);
    if (!board) {
      return res.status(404).json({ success: false, message: 'Board not found.' });
    }

    const { userId } = req.params;

    // Cannot remove the board creator
    if (userId === board.createdBy) {
      return res.status(400).json({
        success: false,
        message: 'Cannot remove the board creator from membership.',
      });
    }

    await board.removeMember(userId);

    emitToUser(userId, 'board:memberRemoved', {
      boardId: board.id,
      boardName: board.name,
    });

    const fullBoard = await Board.findByPk(board.id, {
      include: [
        { model: User, as: 'creator', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: User, as: 'members', attributes: ['id', 'name', 'email', 'avatar'], through: { attributes: [] } },
      ],
    });

    emitToBoard(board.id, 'board:updated', { board: fullBoard });

    res.json({
      success: true,
      message: 'Member removed successfully.',
      data: { board: fullBoard },
    });
  } catch (error) {
    console.error('[Board] RemoveMember error:', error);
    res.status(500).json({ success: false, message: 'Server error removing member.' });
  }
};

/**
 * PUT /api/boards/:id/groups/reorder
 * Body: { groups: [{ id, title, color, position }] }
 */
const reorderGroups = async (req, res) => {
  try {
    const board = await Board.findByPk(req.params.id);
    if (!board) {
      return res.status(404).json({ success: false, message: 'Board not found.' });
    }

    const { groups } = req.body;
    if (!Array.isArray(groups)) {
      return res.status(400).json({ success: false, message: 'groups array is required.' });
    }

    await board.update({ groups });

    emitToBoard(board.id, 'board:updated', { board });

    res.json({ success: true, message: 'Groups reordered successfully.', data: { groups } });
  } catch (error) {
    console.error('[Board] ReorderGroups error:', error);
    res.status(500).json({ success: false, message: 'Server error reordering groups.' });
  }
};

/**
 * GET /api/boards/:id/export?format=csv
 * Export board tasks as CSV
 */
const exportBoard = async (req, res) => {
  try {
    const board = await Board.findByPk(req.params.id);
    if (!board) return res.status(404).json({ success: false, message: 'Board not found.' });

    const tasks = await Task.findAll({
      where: { boardId: board.id, isArchived: false },
      include: [
        { model: User, as: 'assignee', attributes: ['name', 'email'] },
      ],
      order: [['position', 'ASC']],
    });

    const format = req.query.format || 'csv';

    if (format === 'csv') {
      const header = 'Title,Status,Priority,Assignee,Due Date,Start Date,Group,Description\n';
      const rows = tasks.map(t => {
        const a = t.assignee?.name || '';
        return `"${(t.title || '').replace(/"/g, '""')}","${t.status}","${t.priority}","${a}","${t.dueDate || ''}","${t.startDate || ''}","${t.groupId}","${(t.description || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`;
      }).join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${board.name.replace(/[^a-zA-Z0-9]/g, '_')}_export.csv"`);
      return res.send(header + rows);
    }

    // JSON format
    res.json({ success: true, data: { board: { name: board.name, color: board.color }, tasks: tasks.map(t => t.toJSON()) } });
  } catch (error) {
    console.error('[Board] Export error:', error);
    res.status(500).json({ success: false, message: 'Server error exporting board.' });
  }
};

/**
 * POST /api/boards/:id/import
 * Import tasks from CSV data
 * Body: { tasks: [{ title, status, priority, dueDate, description }] }
 */
const importTasks = async (req, res) => {
  try {
    const board = await Board.findByPk(req.params.id);
    if (!board) return res.status(404).json({ success: false, message: 'Board not found.' });

    const { tasks: importData } = req.body;
    if (!Array.isArray(importData) || importData.length === 0) {
      return res.status(400).json({ success: false, message: 'tasks array is required.' });
    }

    const created = [];
    const groups = board.groups || [];
    const defaultGroupId = groups[0]?.id || 'new';

    for (const item of importData) {
      if (!item.title) continue;
      const maxPos = await Task.max('position', { where: { boardId: board.id, groupId: defaultGroupId } });
      const task = await Task.create({
        title: item.title,
        description: item.description || '',
        status: ['not_started', 'working_on_it', 'stuck', 'done'].includes(item.status) ? item.status : 'not_started',
        priority: ['low', 'medium', 'high', 'critical'].includes(item.priority) ? item.priority : 'medium',
        dueDate: item.dueDate || null,
        startDate: item.startDate || null,
        groupId: defaultGroupId,
        position: (maxPos || 0) + 1,
        boardId: board.id,
        createdBy: req.user.id,
      });
      created.push(task);
    }

    res.status(201).json({
      success: true,
      message: `${created.length} tasks imported successfully.`,
      data: { imported: created.length },
    });
  } catch (error) {
    console.error('[Board] Import error:', error);
    res.status(500).json({ success: false, message: 'Server error importing tasks.' });
  }
};

module.exports = {
  createBoard,
  getBoards,
  getBoard,
  updateBoard,
  deleteBoard,
  addMember,
  removeMember,
  reorderGroups,
  exportBoard,
  importTasks,
};
