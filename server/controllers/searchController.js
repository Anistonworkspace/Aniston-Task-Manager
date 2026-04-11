const { Task, Board, User } = require('../models');
const { Op } = require('sequelize');
const { buildPendingPriorityOrder } = require('../utils/taskPrioritization');

/**
 * GET /api/search?q=...&limit=20
 * Global search across tasks and boards
 */
const globalSearch = async (req, res) => {
  try {
    const { q, limit = 20 } = req.query;

    if (!q || q.trim().length < 2) {
      return res.json({ success: true, data: { tasks: [], boards: [] } });
    }

    const searchTerm = q.trim();
    const maxResults = Math.min(parseInt(limit, 10) || 20, 50);

    // Search tasks
    const taskWhere = {
      isArchived: false,
      [Op.or]: [
        { title: { [Op.iLike]: `%${searchTerm}%` } },
        { description: { [Op.iLike]: `%${searchTerm}%` } },
      ],
    };

    // Members can only see their own tasks
    if (req.user.role === 'member') {
      taskWhere.assignedTo = req.user.id;
    }

    const tasks = await Task.findAll({
      where: taskWhere,
      include: [
        { model: Board, as: 'board', attributes: ['id', 'name', 'color'] },
        { model: User, as: 'assignee', attributes: ['id', 'name', 'avatar'] },
      ],
      attributes: ['id', 'title', 'status', 'priority', 'progress', 'dueDate', 'groupId', 'boardId', 'updatedAt', 'createdAt'],
      order: buildPendingPriorityOrder(),
      limit: maxResults,
    });

    // Search boards — RBAC at query-time for members
    const boardWhere = {
      isArchived: false,
      name: { [Op.iLike]: `%${searchTerm}%` },
    };

    let boardInclude = [
      { model: User, as: 'members', attributes: ['id'], through: { attributes: [] } },
    ];

    // Members: only return boards they are a member of (query-time filter)
    if (req.user.role === 'member') {
      boardInclude = [
        {
          model: User, as: 'members', attributes: ['id'], through: { attributes: [] },
          where: { id: req.user.id },
          required: true,  // INNER JOIN — only boards where user is a member
        },
      ];
    }

    const boards = await Board.findAll({
      where: boardWhere,
      include: boardInclude,
      attributes: ['id', 'name', 'color', 'description', 'updatedAt'],
      order: [['updatedAt', 'DESC']],
      limit: 10,
    });

    const visibleBoards = boards;

    res.json({
      success: true,
      data: {
        tasks: tasks.map(t => t.toJSON()),
        boards: visibleBoards.map(b => {
          const json = b.toJSON();
          json.memberCount = json.members ? json.members.length : 0;
          delete json.members;
          return json;
        }),
      },
    });
  } catch (error) {
    console.error('[Search] globalSearch error:', error);
    res.status(500).json({ success: false, message: 'Server error during search.' });
  }
};

module.exports = { globalSearch };
