const { Board, User, Task, Workspace, TaskOwner, TaskAssignee, sequelize } = require('../models');
const { validationResult } = require('express-validator');
const { Op } = require('sequelize');
const { emitToBoard, emitToUser } = require('../services/socketService');
const { logActivity } = require('../services/activityService');
const { sanitizeInput } = require('../utils/sanitize');
const { isValidStatus } = require('../utils/statusConfig');
const { buildPendingPriorityOrderAliased } = require('../utils/taskPrioritization');
const { safeUUIDList } = require('../utils/safeSql');
const boardMembershipService = require('../services/boardMembershipService');

// ── Table / column existence cache ──
const _tblCache = {};
async function _tblExists(name) {
  if (_tblCache[name] !== undefined) return _tblCache[name];
  try { await sequelize.query(`SELECT 1 FROM "${name}" LIMIT 0`); _tblCache[name] = true; }
  catch (e) { _tblCache[name] = false; }
  return _tblCache[name];
}

const _colCache = {};
async function _colExists(table, column) {
  const key = `${table}.${column}`;
  if (_colCache[key] !== undefined) return _colCache[key];
  try {
    // Use a direct SELECT to detect the column — avoids case-sensitivity issues
    // with information_schema on quoted table names like "BoardMembers".
    await sequelize.query(`SELECT "${column}" FROM "${table}" LIMIT 0`);
    _colCache[key] = true;
  } catch (e) { _colCache[key] = false; }
  return _colCache[key];
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

    // Auto-add creator as a board member (explicit — creator should always stay)
    await boardMembershipService.explicitAddMember(board.id, req.user.id);

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

      // ── Build visibility filters ──
      // For members, board visibility comes from two independent sources:
      //  A) Explicit membership (autoAdded=false) — survives task unassignment
      //  B) Current task assignments — always reflects live state
      // We must NOT use raw BoardMembers (autoAdded=true rows) for visibility
      // because those are stale after unassignment until async cleanup runs.
      const hasAutoAddedCol = await _colExists('BoardMembers', 'autoAdded');

      const boardOrFilters = [
        // Board created by user
        { createdBy: { [Op.in]: visibleUserIds } },
        // Explicitly-added board member (NOT auto-added via task assignment).
        // If autoAdded column exists, only include explicit members.
        // If column doesn't exist (pre-migration), fall back to all BoardMembers.
        hasAutoAddedCol
          ? sequelize.literal(`"Board"."id" IN (SELECT "boardId" FROM "BoardMembers" WHERE "userId" IN (${userIdList}) AND "autoAdded" = false)`)
          : sequelize.literal(`"Board"."id" IN (SELECT "boardId" FROM "BoardMembers" WHERE "userId" IN (${userIdList}))`),
        // Task-based visibility: user has active tasks on the board (always current)
        sequelize.literal(`"Board"."id" IN (SELECT DISTINCT "boardId" FROM tasks WHERE "assignedTo" IN (${userIdList}) AND ("isArchived" = false OR "isArchived" IS NULL))`),
      ];
      // Junction-table task visibility (always current)
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

      // Check explicit (non-auto-added) board membership.
      // We don't use the eager-loaded board.members here because it includes
      // stale auto-added rows that should not grant access after unassignment.
      let isExplicitMember = false;
      const hasAutoAddedCol = await _colExists('BoardMembers', 'autoAdded');
      if (hasAutoAddedCol) {
        const [explicitRows] = await sequelize.query(
          `SELECT 1 FROM "BoardMembers" WHERE "boardId" = :boardId AND "userId" = :userId AND "autoAdded" = false LIMIT 1`,
          { replacements: { boardId: board.id, userId } }
        );
        isExplicitMember = explicitRows.length > 0;
      } else {
        // Fallback: if autoAdded column doesn't exist, trust all BoardMembers rows
        isExplicitMember = board.members && board.members.some((m) => visibleUserIds.includes(m.id));
      }

      const hasAssignedTasks = board.tasks && board.tasks.some((t) => visibleUserIds.includes(t.assignedTo));
      const isTaskOwner = board.tasks && board.tasks.some((t) => t.owners && t.owners.some((o) => visibleUserIds.includes(o.id)));

      // Also check task_assignees table (not loaded via eager-load above)
      let isTaskAssignee = false;
      if (!isExplicitMember && !hasAssignedTasks && !isTaskOwner) {
        const assigneeCount = await TaskAssignee.count({
          where: { userId: { [Op.in]: visibleUserIds } },
          include: [{ model: Task, as: 'task', attributes: [], where: { boardId: board.id, isArchived: false }, required: true }],
        });
        isTaskAssignee = assigneeCount > 0;
      }

      if (!isExplicitMember && !hasAssignedTasks && !isTaskOwner && !isTaskAssignee) {
        return res.status(403).json({ success: false, message: 'Access denied. You are not a member of this board.' });
      }
      // Auto-add as member if they have tasks/ownership but aren't a member yet
      const isMember = board.members && board.members.some((m) => visibleUserIds.includes(m.id));
      if (!isMember && (hasAssignedTasks || isTaskOwner || isTaskAssignee)) {
        await boardMembershipService.autoAddMember(board.id, req.user.id);
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
 *
 * Permission model:
 *   - Admin / manager / assistant_manager / super admin → may update every allowed field.
 *   - Explicit board members (any role) → may only update the MEMBER_STRUCTURAL_FIELDS
 *     subset. This is what lets a member add/rename/remove a custom column on a board
 *     they belong to without needing full board-admin rights.
 *   - Anyone else → 403.
 *
 * Fields outside either subset in the request body are silently ignored (parity with
 * the legacy behaviour before per-field gating).
 */
const ALL_UPDATABLE_BOARD_FIELDS = [
  'name', 'description', 'color', 'columns', 'groups',
  'archivedGroups', 'customColumns', 'isArchived', 'workspaceId',
];
const MEMBER_STRUCTURAL_FIELDS = ['customColumns'];

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

    const role = req.user.role;
    const isSuperAdmin = !!req.user.isSuperAdmin;
    const isManagementRole = isSuperAdmin || ['admin', 'manager', 'assistant_manager'].includes(role);

    // Determine which fields the caller is permitted to touch on this board.
    let permittedFields = ALL_UPDATABLE_BOARD_FIELDS;
    if (!isManagementRole) {
      // Non-management role: must be an explicit (non-auto-added) board member
      // to touch the structural subset. We check the explicit flag because an
      // auto-added row (from a task assignment) can churn and we don't want
      // that to implicitly grant structural edit rights.
      let isExplicitBoardMember = false;
      try {
        const hasAutoAddedCol = await _colExists('BoardMembers', 'autoAdded');
        if (hasAutoAddedCol) {
          const [rows] = await sequelize.query(
            `SELECT 1 FROM "BoardMembers" WHERE "boardId" = :boardId AND "userId" = :userId AND "autoAdded" = false LIMIT 1`,
            { replacements: { boardId: board.id, userId: req.user.id } }
          );
          isExplicitBoardMember = rows.length > 0;
        } else {
          const [rows] = await sequelize.query(
            `SELECT 1 FROM "BoardMembers" WHERE "boardId" = :boardId AND "userId" = :userId LIMIT 1`,
            { replacements: { boardId: board.id, userId: req.user.id } }
          );
          isExplicitBoardMember = rows.length > 0;
        }
      } catch (err) {
        console.error('[Board] Membership check error:', err.message);
        isExplicitBoardMember = false;
      }

      if (!isExplicitBoardMember) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to modify this board.',
        });
      }

      // Reject the request outright if the caller tries to touch admin-only
      // fields — so the frontend gets a clear signal instead of a silent no-op.
      const attemptedAdminFields = Object.keys(req.body).filter(
        (f) => ALL_UPDATABLE_BOARD_FIELDS.includes(f) && !MEMBER_STRUCTURAL_FIELDS.includes(f)
      );
      if (attemptedAdminFields.length > 0) {
        return res.status(403).json({
          success: false,
          message: 'Only managers or admins can change this board setting.',
        });
      }

      permittedFields = MEMBER_STRUCTURAL_FIELDS;
    }

    const updates = {};
    for (const field of permittedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }
    if (updates.name !== undefined) updates.name = sanitizeInput(updates.name);
    if (updates.description !== undefined) updates.description = sanitizeInput(updates.description);

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No updatable fields were provided.',
      });
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

    // Only the creator, an admin, or a manager may delete (assistant_manager cannot)
    const canDelete = ['admin', 'manager'].includes(req.user.role) || board.createdBy === req.user.id;
    if (!canDelete) {
      return res.status(403).json({
        success: false,
        message: 'Only the board creator, an admin, or a manager can delete this board.',
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
      // Even if already a member, upgrade to explicit (non-auto) so cleanup doesn't remove them
      await boardMembershipService.explicitAddMember(board.id, userId);
      return res.status(409).json({ success: false, message: 'User is already a board member.' });
    }

    await boardMembershipService.explicitAddMember(board.id, userId);

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
