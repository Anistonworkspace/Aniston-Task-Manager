const { Board, User, Task, Workspace, TaskOwner, TaskAssignee, sequelize } = require('../models');
const { validationResult } = require('express-validator');
const { Op } = require('sequelize');
const { emitToBoard, emitToUser } = require('../services/socketService');
const { logActivity } = require('../services/activityService');
const { sanitizeInput } = require('../utils/sanitize');
const { isValidStatus } = require('../utils/statusConfig');
const { buildPendingPriorityOrderAliased } = require('../utils/taskPrioritization');
const { safeUUIDList } = require('../utils/safeSql');

// ── Table existence cache ──
const _tblCache = {};
async function _tblExists(name) {
  if (_tblCache[name] !== undefined) return _tblCache[name];
  try { await sequelize.query(`SELECT 1 FROM "${name}" LIMIT 0`); _tblCache[name] = true; }
  catch (e) { _tblCache[name] = false; }
  return _tblCache[name];
}

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
      name: sanitizeInput(name),
      description: sanitizeInput(description) || '',
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

    logActivity({
      action: 'board_created',
      description: `Created board "${board.name}"`,
      entityType: 'board',
      entityId: board.id,
      boardId: board.id,
      userId: req.user.id,
    });

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
 * Query params: search, archived, page (default 1), limit (default 20)
 */
const getBoards = async (req, res) => {
  try {
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(req.user.id)) {
      return res.status(401).json({ success: false, message: 'Invalid user session' });
    }

    const { search, archived } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    const where = {};

    if (archived !== 'true') {
      where.isArchived = false;
    }

    if (search) {
      where.name = { [Op.iLike]: `%${search}%` };
    }

    // Non-admin/manager/assistant_manager users only see boards they have access to
    const role = req.user.role;
    const userId = req.user.id;
    const isSuperAdmin = !!req.user.isSuperAdmin;

    if (!isSuperAdmin && role !== 'admin' && role !== 'manager' && role !== 'assistant_manager') {
      // Members only see boards they are connected to
      const visibleUserIds = [userId];
      const userIdList = safeUUIDList(visibleUserIds, 'visibleUserIds');

      const boardOrFilters = [
        // Board created by user (or team member for assistant_manager)
        { createdBy: { [Op.in]: visibleUserIds } },
        // User (or team) is a board member
        sequelize.literal(`"Board"."id" IN (SELECT "boardId" FROM "BoardMembers" WHERE "userId" IN (${userIdList}))`),
        // Legacy: user (or team) is in assignedTo column
        sequelize.literal(`"Board"."id" IN (SELECT DISTINCT "boardId" FROM tasks WHERE "assignedTo" IN (${userIdList}) AND ("isArchived" = false OR "isArchived" IS NULL))`),
      ];
      // Only add junction-table subqueries if the tables exist
      if (await _tblExists('task_assignees')) {
        boardOrFilters.push(sequelize.literal(`"Board"."id" IN (SELECT DISTINCT t."boardId" FROM tasks t INNER JOIN task_assignees ta ON ta."taskId" = t.id WHERE ta."userId" IN (${userIdList}) AND (t."isArchived" = false OR t."isArchived" IS NULL))`));
      }
      if (await _tblExists('task_owners')) {
        boardOrFilters.push(sequelize.literal(`"Board"."id" IN (SELECT DISTINCT t."boardId" FROM tasks t INNER JOIN task_owners to2 ON to2."taskId" = t.id WHERE to2."userId" IN (${userIdList}) AND (t."isArchived" = false OR t."isArchived" IS NULL))`));
      }
      where[Op.or] = boardOrFilters;
    }

    const { count, rows: boards } = await Board.findAndCountAll({
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
      limit,
      offset,
      distinct: true,
    });

    // Attach task counts for this page of boards only
    const boardIds = boards.map((b) => b.id);
    const taskCountMap = {};

    if (boardIds.length > 0) {
      const taskCounts = await Task.findAll({
        attributes: ['boardId', [sequelize.fn('COUNT', sequelize.col('id')), 'taskCount']],
        where: { boardId: { [Op.in]: boardIds }, isArchived: false },
        group: ['boardId'],
        raw: true,
      });
      taskCounts.forEach((tc) => {
        taskCountMap[tc.boardId] = parseInt(tc.taskCount, 10);
      });
    }

    const data = boards.map((b) => ({
      ...b.toJSON(),
      memberCount: b.members ? b.members.length : 0,
      taskCount: taskCountMap[b.id] || 0,
    }));

    const totalPages = Math.ceil(count / limit);

    res.json({
      success: true,
      data: {
        boards: data,
        pagination: { page, limit, total: count, totalPages },
      },
    });
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
            { model: User, as: 'owners', attributes: ['id', 'name', 'email', 'avatar'], through: { attributes: ['isPrimary'] } },
          ],
          limit: 500,
        },
      ],
    });

    if (!board) {
      return res.status(404).json({ success: false, message: 'Board not found.' });
    }

    // Access control for non-admin/manager/assistant_manager users
    const role = req.user.role;
    const isSuperAdmin = !!req.user.isSuperAdmin;
    if (!isSuperAdmin && role !== 'admin' && role !== 'manager' && role !== 'assistant_manager') {
      const userId = req.user.id;

      // Build the set of user IDs this person can "see through"
      let visibleUserIds = [userId];
      if (role === 'assistant_manager') {
        const teamMembers = await User.findAll({
          where: { managerId: userId },
          attributes: ['id'],
          raw: true,
        });
        visibleUserIds = visibleUserIds.concat(teamMembers.map(m => m.id));
      }

      const isMember = board.members && board.members.some((m) => visibleUserIds.includes(m.id));
      const hasAssignedTasks = board.tasks && board.tasks.some((t) => visibleUserIds.includes(t.assignedTo));
      const isTaskOwner = board.tasks && board.tasks.some((t) => t.owners && t.owners.some((o) => visibleUserIds.includes(o.id)));

      // Also check task_assignees table (not loaded via eager-load above)
      let isTaskAssignee = false;
      if (!isMember && !hasAssignedTasks && !isTaskOwner) {
        const assigneeCount = await TaskAssignee.count({
          where: { userId: { [Op.in]: visibleUserIds } },
          include: [{ model: Task, as: 'task', attributes: [], where: { boardId: board.id, isArchived: false }, required: true }],
        });
        isTaskAssignee = assigneeCount > 0;
      }

      if (!isMember && !hasAssignedTasks && !isTaskOwner && !isTaskAssignee) {
        return res.status(403).json({ success: false, message: 'Access denied. You are not a member of this board.' });
      }
      // Auto-add as member if they have tasks/ownership but aren't a member yet
      if (!isMember && (hasAssignedTasks || isTaskOwner || isTaskAssignee)) {
        try { await board.addMember(req.user.id); } catch (e) { /* ignore */ }
      }
    }

    const tasksTruncated = board.tasks && board.tasks.length >= 500;
    const responseData = { board };
    if (tasksTruncated) {
      responseData.warning = 'This board has more than 500 tasks. Only the first 500 tasks are shown. Use filters to narrow results.';
    }

    res.json({ success: true, data: responseData });
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

    const allowedFields = ['name', 'description', 'color', 'columns', 'groups', 'archivedGroups', 'customColumns', 'isArchived', 'workspaceId'];
    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }
    if (updates.name !== undefined) updates.name = sanitizeInput(updates.name);
    if (updates.description !== undefined) updates.description = sanitizeInput(updates.description);

    await board.update(updates);

    const fullBoard = await Board.findByPk(board.id, {
      include: [
        { model: User, as: 'creator', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: User, as: 'members', attributes: ['id', 'name', 'email', 'avatar'], through: { attributes: [] } },
      ],
    });

    // Real-time update
    emitToBoard(board.id, 'board:updated', { board: fullBoard });

    logActivity({
      action: updates.isArchived ? 'board_archived' : 'board_updated',
      description: updates.isArchived
        ? `Archived board "${board.name}"`
        : `Updated board "${board.name}"`,
      entityType: 'board',
      entityId: board.id,
      boardId: board.id,
      userId: req.user.id,
      meta: { updatedFields: Object.keys(updates) },
    });

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

    // Only the creator, an admin, or an assistant_manager may delete
    const canDelete = req.user.role === 'admin' || board.createdBy === req.user.id || req.user.role === 'assistant_manager';
    if (!canDelete) {
      return res.status(403).json({
        success: false,
        message: 'Only the board creator, an admin, or an assistant manager can delete this board.',
      });
    }

    // Enforce 90-day rule for archived boards
    if (board.isArchived) {
      const { canPermanentlyDelete } = require('../utils/archiveHelpers');
      const { allowed, daysRemaining } = canPermanentlyDelete(req.user, board.archivedAt);
      if (!allowed) {
        return res.status(403).json({ success: false, message: `This board is protected for ${daysRemaining} more days. Only Super Admin can delete before 90 days.` });
      }
    }

    const boardId = board.id;
    const boardName = board.name;
    await board.destroy();

    emitToBoard(boardId, 'board:deleted', { boardId });
    // Also broadcast to all for sidebar refresh
    try { const { getIO } = require('../services/socketService'); getIO().emit('board:deleted', { boardId }); } catch {}

    logActivity({
      action: 'board_deleted',
      description: `Deleted board "${boardName}"`,
      entityType: 'board',
      entityId: boardId,
      boardId: boardId,
      userId: req.user.id,
    });

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

    logActivity({
      action: 'board_member_added',
      description: `Added ${userToAdd.name} to board "${board.name}"`,
      entityType: 'board',
      entityId: board.id,
      boardId: board.id,
      userId: req.user.id,
      meta: { addedUserId: userId, addedUserName: userToAdd.name },
    });

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

    const removedUser = await User.findByPk(userId, { attributes: ['id', 'name'] });
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

    logActivity({
      action: 'board_member_removed',
      description: `Removed ${removedUser?.name || userId} from board "${board.name}"`,
      entityType: 'board',
      entityId: board.id,
      boardId: board.id,
      userId: req.user.id,
      meta: { removedUserId: userId, removedUserName: removedUser?.name },
    });

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
 * Export board tasks as CSV.
 * Requires authentication (applied at router level) + board-level access.
 */
const exportBoard = async (req, res) => {
  try {
    const board = await Board.findByPk(req.params.id, {
      include: [
        { model: User, as: 'members', attributes: ['id'], through: { attributes: [] } },
      ],
    });
    if (!board) return res.status(404).json({ success: false, message: 'Board not found.' });

    // Board-level access check: admin/manager/assistant_manager can export any board;
    // members can only export boards they belong to (as member, assignee, or creator).
    const role = req.user.role;
    const isSuperAdmin = !!req.user.isSuperAdmin;
    if (!isSuperAdmin && role !== 'admin' && role !== 'manager' && role !== 'assistant_manager') {
      const userId = req.user.id;
      const isMember = board.members && board.members.some(m => m.id === userId);
      const isCreator = board.createdBy === userId;
      if (!isMember && !isCreator) {
        // Also check if user has tasks in this board via task_assignees
        const assigneeCount = await TaskAssignee.count({
          include: [{ model: Task, as: 'task', attributes: [], where: { boardId: board.id, isArchived: false }, required: true }],
          where: { userId },
        });
        if (assigneeCount === 0) {
          return res.status(403).json({ success: false, message: 'Access denied. You are not authorized to export this board.' });
        }
      }
    }

    const { buildPendingPriorityOrder } = require('../utils/taskPrioritization');
    const tasks = await Task.findAll({
      where: { boardId: board.id, isArchived: false },
      include: [
        { model: User, as: 'assignee', attributes: ['name', 'email'] },
      ],
      order: buildPendingPriorityOrder(),
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

    const groups = board.groups || [];
    const defaultGroupId = groups[0]?.id || 'new';

    // Compute max position once before the loop to avoid N+1 queries
    let nextPosition = (await Task.max('position', { where: { boardId: board.id, groupId: defaultGroupId } }) || 0) + 1;

    const created = [];
    for (const item of importData) {
      if (!item.title) continue;
      const task = await Task.create({
        title: sanitizeInput(item.title || item.name || 'Untitled'),
        description: sanitizeInput(item.description || ''),
        status: isValidStatus(item.status, board) ? item.status : 'not_started',
        priority: ['low', 'medium', 'high', 'critical'].includes(item.priority) ? item.priority : 'medium',
        dueDate: item.dueDate || null,
        startDate: item.startDate || null,
        groupId: defaultGroupId,
        position: nextPosition++,
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
