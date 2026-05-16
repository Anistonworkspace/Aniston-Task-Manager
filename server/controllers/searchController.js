const { Task, Board, User } = require('../models');
const { Op } = require('sequelize');
const { buildPendingPriorityOrder } = require('../utils/taskPrioritization');
const taskVisibility = require('../services/taskVisibilityService');
const boardVisibility = require('../services/boardVisibilityService');
const { PILL_ATTRIBUTES: USER_PILL_ATTRIBUTES } = require('../config/userAttributes');

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
      [Op.and]: [
        {
          [Op.or]: [
            { title: { [Op.iLike]: `%${searchTerm}%` } },
            { description: { [Op.iLike]: `%${searchTerm}%` } },
          ],
        },
      ],
    };

    // CP-3 RBAC: scope every viewer (admin/super_admin unrestricted; everyone
    // else → self + descendants). The earlier `member-only` filter leaked
    // every task to managers and assistant managers.
    const visibilityFragment = await taskVisibility.buildTaskVisibilityWhere(req.user);
    if (visibilityFragment && visibilityFragment[Op.and]) {
      for (const f of visibilityFragment[Op.and]) taskWhere[Op.and].push(f);
    }

    const tasks = await Task.findAll({
      where: taskWhere,
      include: [
        { model: Board, as: 'board', attributes: ['id', 'name', 'color'] },
        { model: User, as: 'assignee', attributes: [...USER_PILL_ATTRIBUTES] },
      ],
      attributes: ['id', 'title', 'status', 'priority', 'progress', 'dueDate', 'groupId', 'boardId', 'updatedAt', 'createdAt'],
      order: buildPendingPriorityOrder(),
      limit: maxResults,
    });

    // Search boards — RBAC delegated to boardVisibilityService so this
    // matches the sidebar / direct-URL rule. Previously only `member` was
    // scoped here; assistant_manager fell through to "see all" and leaked
    // every board name in the org via the global search results.
    //
    // The fragment is keyed on `Op.or` (a Symbol). Object.assign copies
    // Symbol keys, but Object.keys() does NOT — so we must merge
    // unconditionally (for admin/manager the service returns `{}`, making
    // the assign a no-op).
    const boardWhere = {
      isArchived: false,
      name: { [Op.iLike]: `%${searchTerm}%` },
    };
    const boardVisWhere = await boardVisibility.buildBoardVisibilityWhere(req.user);
    Object.assign(boardWhere, boardVisWhere || {});

    const boards = await Board.findAll({
      where: boardWhere,
      include: [
        { model: User, as: 'members', attributes: ['id'], through: { attributes: [] } },
      ],
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
