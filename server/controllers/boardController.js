const { Board, User, Task, Workspace, TaskOwner, TaskAssignee, sequelize } = require('../models');
const { validationResult } = require('express-validator');
const { Op } = require('sequelize');
const { emitToBoard, emitToUser, forceUserLeaveBoard } = require('../services/socketService');
const { logActivity } = require('../services/activityService');
const { sanitizeInput } = require('../utils/sanitize');
const { isValidStatus } = require('../utils/statusConfig');
const { buildPendingPriorityOrderAliased } = require('../utils/taskPrioritization');
const { safeUUIDList } = require('../utils/safeSql');
const boardMembershipService = require('../services/boardMembershipService');
const taskVisibility = require('../services/taskVisibilityService');
const boardVisibility = require('../services/boardVisibilityService');

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
 * Returns true iff the viewer is allowed to drop a board into this workspace.
 *
 * Mirrors the rule used by GET /api/workspaces/:id so creation cannot be
 * abused to plant boards in workspaces the caller cannot otherwise see:
 *   - admin / manager / super_admin             → unrestricted
 *   - assistant_manager / member                → must be the workspace
 *     creator, the user.workspaceId target, an explicit workspaceMember in
 *     their org subtree, OR have at least one accessible board inside the
 *     workspace (mirrors the sidebar).
 */
async function canUserCreateInWorkspace(user, workspace) {
  if (!user || !workspace) return false;
  if (user.isSuperAdmin) return true;
  if (user.role === 'admin' || user.role === 'manager') return true;

  const userId = user.id;

  // Org subtree (self + descendants) — same set used in workspaceController
  // for workspace-member visibility decisions.
  let visibleUserIds = [userId];
  try {
    const hierarchyService = require('../services/hierarchyService');
    const descendants = await hierarchyService.getDescendantIds(userId);
    visibleUserIds = visibleUserIds.concat(descendants);
  } catch { /* hierarchy walk is best-effort */ }

  if (workspace.createdBy === userId) return true;

  try {
    const userRecord = await User.findByPk(userId, { attributes: ['id', 'workspaceId'] });
    if (userRecord?.workspaceId === workspace.id) return true;
  } catch { /* fall through */ }

  try {
    const wsWithMembers = await Workspace.findByPk(workspace.id, {
      include: [{ model: User, as: 'workspaceMembers', attributes: ['id'] }],
    });
    if (wsWithMembers?.workspaceMembers?.some((m) => visibleUserIds.includes(m.id))) {
      return true;
    }
  } catch { /* fall through */ }

  // Last resort: do they have any accessible board in this workspace? This
  // matches the "see workspace because I can see at least one of its boards"
  // rule used by the sidebar.
  try {
    const accessibleBoardIds = await boardVisibility.getVisibleBoardIdsForUser(user, { includeArchived: false });
    if (accessibleBoardIds.size === 0) return false;
    const wsBoards = await Board.findAll({
      where: { workspaceId: workspace.id, isArchived: false },
      attributes: ['id'],
      raw: true,
    });
    return wsBoards.some((b) => accessibleBoardIds.has(b.id));
  } catch (err) {
    console.warn('[Board] canUserCreateInWorkspace fallback failed:', err.message);
    return false;
  }
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

    const { name, description, color, columns, groups, workspaceId } = req.body;

    // Validate workspace existence AND access. The route gate
    // (requirePermission('boards','create')) lets every role through that
    // owns boards.create in the matrix, so the controller is now the only
    // line of defence preventing a member from creating a board inside a
    // workspace they cannot reach. Admin / manager / super admin remain
    // unrestricted via canUserCreateInWorkspace.
    let resolvedWorkspaceId = null;
    if (workspaceId) {
      const ws = await Workspace.findByPk(workspaceId);
      if (!ws) {
        return res.status(400).json({ success: false, message: 'Workspace not found.' });
      }
      const allowed = await canUserCreateInWorkspace(req.user, ws);
      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: 'You do not have access to this workspace.',
        });
      }
      resolvedWorkspaceId = ws.id;
    }

    const board = await Board.create({
      name: sanitizeInput(name),
      description: sanitizeInput(description) || '',
      color: color || '#0073ea',
      columns: columns || undefined,
      groups: groups || undefined,
      workspaceId: resolvedWorkspaceId,
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

    // Visibility scoping is delegated to boardVisibilityService — the SAME
    // rule used by getBoard, search, and direct-URL access. assistant_manager
    // and member are restricted to {self ∪ descendants}; admin/manager/super
    // admin remain unrestricted. The service correctly walks both
    // User.managerId AND manager_relations via hierarchyService.
    //
    // CRITICAL — merge with Object.assign UNCONDITIONALLY. The visibility
    // fragment is keyed on `Op.or`, which is a Symbol. A previous attempt
    // gated the merge with `if (Object.keys(visWhere).length > 0)` — but
    // Object.keys() ignores Symbols, so the guard was always false and the
    // filter was silently dropped, leaking every board name to non-admins.
    // For unrestricted viewers the service returns `{}`, so the unconditional
    // assign is a safe no-op. (Object.assign does copy own Symbol keys.)
    const visWhere = await boardVisibility.buildBoardVisibilityWhere(req.user);
    Object.assign(where, visWhere || {});

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
            // Eager-load taskAssignees so taskVisibility.filterVisibleTasks
            // can decide visibility in memory without N+1 lookups.
            { model: TaskAssignee, as: 'taskAssignees', attributes: ['userId', 'role'], required: false },
          ],
          limit: 500,
        },
      ],
    });

    if (!board) {
      return res.status(404).json({ success: false, message: 'Board not found.' });
    }

    // ── Stage 1: Board reachability (separate from task-row visibility) ──
    // Admin / super_admin / manager can REACH any board (sidebar / direct
    // URL). assistant_manager and member must be linked via explicit
    // membership, task assignment, or task ownership for themselves OR a
    // user in their hierarchy subtree. NOTE: reaching the board does NOT
    // imply they see every task on it — Stage 2 below filters task rows
    // independently by hierarchy (CP-3 RBAC).
    //
    // Delegates to boardVisibilityService.canUserSeeBoard so the rule
    // matches getBoards, search, and exportBoard exactly. Previously this
    // grouped assistant_manager with admin/manager and let them reach any
    // board — leaking board names.
    const role = req.user.role;
    const isSuperAdmin = !!req.user.isSuperAdmin;
    const reachable = await boardVisibility.canUserSeeBoard(req.user, board.id);
    if (!reachable) {
      return res.status(403).json({ success: false, message: 'Access denied. You are not a member of this board.' });
    }

    // Auto-add the viewer as a (auto) board member when they reached this
    // board through a task path — keeps the legacy autoAdded-cleanup loop
    // in sync. We skip this for unrestricted roles (they don't need an
    // explicit membership row to see the board) and for users who already
    // have an explicit row.
    if (!isSuperAdmin && role !== 'admin' && role !== 'manager') {
      const userId = req.user.id;
      const visibleUserIds = [userId];
      try {
        const descendantIds = await require('../services/hierarchyService').getDescendantIds(userId);
        for (const id of descendantIds) visibleUserIds.push(id);
      } catch { /* hierarchy walk is best-effort */ }

      const hasAssignedTasks = board.tasks && board.tasks.some((t) => visibleUserIds.includes(t.assignedTo));
      const isTaskOwner = board.tasks && board.tasks.some((t) => t.owners && t.owners.some((o) => visibleUserIds.includes(o.id)));
      let isTaskAssignee = false;
      if (!hasAssignedTasks && !isTaskOwner) {
        const assigneeCount = await TaskAssignee.count({
          where: { userId: { [Op.in]: visibleUserIds } },
          include: [{ model: Task, as: 'task', attributes: [], where: { boardId: board.id, isArchived: false }, required: true }],
        });
        isTaskAssignee = assigneeCount > 0;
      }
      const isMember = board.members && board.members.some((m) => m.id === userId);
      if (!isMember && (hasAssignedTasks || isTaskOwner || isTaskAssignee)) {
        await boardMembershipService.autoAddMember(board.id, req.user.id);
      }
    }

    // ── Stage 2: Task-row visibility (CP-3 strict RBAC) ──
    // Filter the eager-loaded tasks down to rows the viewer is permitted to
    // see by hierarchy. Admin / super_admin pass through unchanged. Manager,
    // assistant_manager and member only see tasks where assignee / creator /
    // owner / task_assignees user is inside their { self ∪ descendants }
    // set. Board membership is NOT a shortcut — even an explicit
    // BoardMember-manager added to a board outside their subtree only sees
    // their own subtree's rows.
    let visibleTasks = board.tasks || [];
    const tasksAlreadyTruncated = visibleTasks.length >= 500;
    if (!isSuperAdmin && role !== 'admin' && visibleTasks.length > 0) {
      visibleTasks = await taskVisibility.filterVisibleTasks(req.user, visibleTasks);
    }

    // Replace board.tasks with the filtered list. Sequelize models use a
    // private setter for associations — fall back to the JSON path if needed.
    const boardJSON = board.toJSON();
    boardJSON.tasks = visibleTasks.map((t) => (t.toJSON ? t.toJSON() : t));

    const responseData = { board: boardJSON };
    if (tasksAlreadyTruncated) {
      responseData.warning = 'This board has more than 500 tasks. Only the first 500 tasks are shown. Use filters to narrow results.';
    }

    res.json({ success: true, data: responseData });
  } catch (error) {
    console.error('[Board] GetBoard error:', {
      message: error.message,
      name: error.name,
      sql: error.sql || error.parent?.sql || undefined,
      original: error.original?.message || error.parent?.message || undefined,
      stack: error.stack?.split('\n').slice(0, 5).join('\n'),
    });
    res.status(500).json({ success: false, message: 'Server error fetching board.' });
  }
};

/**
 * PUT /api/boards/:id
 *
 * Permission model (three field tiers):
 *   - RENAMABLE_FIELDS (name, description) → any user with board access
 *     (boardVisibilityService.canUserSeeBoard). Renaming is treated as a
 *     basic capability that follows access, not a management privilege:
 *     a member who can create / reach a board can also rename it. Delete,
 *     archive, color, columns, groups (add/remove/reorder), workspace
 *     reassignment etc. are explicitly NOT in this tier.
 *   - MEMBER_STRUCTURAL_FIELDS (customColumns) → any role, but only when
 *     the caller is an EXPLICIT (non-auto-added) board member. Mirrors the
 *     pre-existing custom-column edit rule.
 *   - ADMIN_FIELDS (everything else) → admin / manager / assistant_manager /
 *     super admin. Loosening of group create/rename is handled by the
 *     dedicated POST /:id/groups and PATCH /:id/groups/:groupId routes; the
 *     full-array update via PUT /:id remains management-only so adding /
 *     removing / reordering groups, swapping the workspace, archiving the
 *     board, etc. stay protected.
 *
 * Fields outside any tier in the request body are ignored.
 */
const RENAMABLE_BOARD_FIELDS = ['name', 'description'];
const MEMBER_STRUCTURAL_FIELDS = ['customColumns'];
const ADMIN_BOARD_FIELDS = [
  'color', 'columns', 'groups', 'archivedGroups', 'isArchived', 'workspaceId',
];
const ALL_UPDATABLE_BOARD_FIELDS = [
  ...RENAMABLE_BOARD_FIELDS,
  ...MEMBER_STRUCTURAL_FIELDS,
  ...ADMIN_BOARD_FIELDS,
];

async function _isExplicitBoardMember(boardId, userId) {
  try {
    const hasAutoAddedCol = await _colExists('BoardMembers', 'autoAdded');
    const sql = hasAutoAddedCol
      ? `SELECT 1 FROM "BoardMembers" WHERE "boardId" = :boardId AND "userId" = :userId AND "autoAdded" = false LIMIT 1`
      : `SELECT 1 FROM "BoardMembers" WHERE "boardId" = :boardId AND "userId" = :userId LIMIT 1`;
    const [rows] = await sequelize.query(sql, { replacements: { boardId, userId } });
    return rows.length > 0;
  } catch (err) {
    console.error('[Board] Membership check error:', err.message);
    return false;
  }
}

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

    // What did the caller actually ask to change? Discard unknown keys here so
    // tier checks only fire on fields the controller would persist.
    const requestedFields = Object.keys(req.body).filter(
      (f) => ALL_UPDATABLE_BOARD_FIELDS.includes(f) && req.body[f] !== undefined
    );
    if (requestedFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No updatable fields were provided.',
      });
    }

    const permittedFields = new Set();

    if (isManagementRole) {
      // Management roles retain full access to every tier — but only for
      // boards they're entitled to see. boardVisibilityService scopes
      // assistant_manager (and member) to {self ∪ descendants}; admin,
      // manager and super_admin remain unrestricted. Without this gate an
      // assistant_manager could PUT /boards/:id on ANY board id they
      // discovered, including ones outside their hierarchy — surfaced by
      // the rename regression as a 200 where 403 was expected.
      if (!isSuperAdmin && role !== 'admin' && role !== 'manager') {
        const reachable = await boardVisibility.canUserSeeBoard(req.user, board.id);
        if (!reachable) {
          return res.status(403).json({
            success: false,
            message: 'You do not have access to this board.',
          });
        }
      }
      ALL_UPDATABLE_BOARD_FIELDS.forEach((f) => permittedFields.add(f));
    } else {
      const wantsRename = requestedFields.some((f) => RENAMABLE_BOARD_FIELDS.includes(f));
      const wantsStructural = requestedFields.some((f) => MEMBER_STRUCTURAL_FIELDS.includes(f));
      const wantsAdmin = requestedFields.some((f) => ADMIN_BOARD_FIELDS.includes(f));

      // Hardest gate first: if the request includes any admin-only field
      // (color, groups array, archivedGroups, isArchived, workspaceId,
      // columns), reject outright with a precise message — even if the
      // caller also included a permitted rename field. Mixing tiers in one
      // request must NOT be a way to slip an admin field through.
      if (wantsAdmin) {
        return res.status(403).json({
          success: false,
          message: 'Only managers or admins can change this board setting.',
        });
      }

      // Rename tier: any user with board access (canUserSeeBoard) can edit
      // name / description. Mirrors the sidebar visibility rule so it's
      // impossible to rename a board the caller cannot otherwise reach.
      if (wantsRename) {
        const reachable = await boardVisibility.canUserSeeBoard(req.user, board.id);
        if (!reachable) {
          return res.status(403).json({
            success: false,
            message: 'You do not have access to this board.',
          });
        }
        RENAMABLE_BOARD_FIELDS.forEach((f) => permittedFields.add(f));
      }

      // Structural tier: customColumns continues to require an EXPLICIT
      // board member row (auto-added rows from task assignments do not
      // count — they churn and shouldn't grant structural edit rights).
      if (wantsStructural) {
        const isExplicit = await _isExplicitBoardMember(board.id, req.user.id);
        if (!isExplicit) {
          return res.status(403).json({
            success: false,
            message: 'You do not have permission to modify this board.',
          });
        }
        MEMBER_STRUCTURAL_FIELDS.forEach((f) => permittedFields.add(f));
      }
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

    // Phase 5d — global destructive-action gate. T1 always passes; T2 (the
    // new admin+manager combined tier) is BLOCKED — decision #4 strict.
    // This also closes audit P1-19: a member who somehow reached this point
    // as creator is blocked too because they pass isOwnResource:false.
    {
      const { assertCanDelete } = require('../services/tierEnforcement');
      const { sendIfTierError } = require('../utils/tierResponseHelpers');
      if (sendIfTierError(res, () => assertCanDelete(req.user, 'board', { isOwnResource: false }))) return;
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

    // Phase 5d — destructive-action gate. Removing a board member is a
    // soft-delete-class operation (revokes their access), so T2 is blocked
    // per decision #4. T1 may still curate membership.
    {
      const { assertCanDelete } = require('../services/tierEnforcement');
      const { sendIfTierError } = require('../utils/tierResponseHelpers');
      if (sendIfTierError(res, () => assertCanDelete(req.user, 'board_member', { isOwnResource: false }))) return;
    }

    const removedUser = await User.findByPk(userId, { attributes: ['id', 'name'] });
    await board.removeMember(userId);

    // Phase 4 — kick the removed user's sockets out of the board room so
    // they stop receiving emitToBoard broadcasts they're no longer
    // authorised to see (their next API GET will 403, but until then the
    // socket would happily forward live data they shouldn't have).
    forceUserLeaveBoard(userId, board.id).catch((err) =>
      console.warn('[Board] forceUserLeaveBoard (removeMember) failed:', err.message)
    );

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
 * POST /api/boards/:id/groups
 * Body: { title, color }
 *
 * Append a single group to the board's groups JSONB. Distinct from
 * `reorderGroups` (which replaces the whole array, manager/admin only) and
 * from `updateBoard` (which can rewrite the groups array, management roles
 * only) so that members and assistant managers can ADD a group to a board
 * they have access to without being able to rename / delete / reorder.
 *
 * Permission model:
 *   - super_admin / admin / manager → always allowed.
 *   - assistant_manager / member    → allowed iff
 *       boardVisibilityService.canUserSeeBoard returns true. This matches
 *       the sidebar visibility rule exactly so a user cannot manufacture
 *       group additions on a board they would not otherwise see.
 */
const addGroup = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const board = await Board.findByPk(req.params.id);
    if (!board) {
      return res.status(404).json({ success: false, message: 'Board not found.' });
    }

    const reachable = await boardVisibility.canUserSeeBoard(req.user, board.id);
    if (!reachable) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You do not have access to this board.',
      });
    }

    const { title, color } = req.body;
    const existing = Array.isArray(board.groups) ? board.groups : [];
    const palette = ['#e2445c', '#fdab3d', '#00c875', '#579bfc', '#a25ddc', '#ff642e'];
    const newGroup = {
      id: `group_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title: sanitizeInput(title),
      color: color || palette[existing.length % palette.length],
      position: existing.length,
    };
    const updatedGroups = [...existing, newGroup];

    await board.update({ groups: updatedGroups });

    const fullBoard = await Board.findByPk(board.id, {
      include: [
        { model: User, as: 'creator', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: User, as: 'members', attributes: ['id', 'name', 'email', 'avatar'], through: { attributes: [] } },
      ],
    });

    emitToBoard(board.id, 'board:updated', { board: fullBoard });

    logActivity({
      action: 'board_group_added',
      description: `Added group "${newGroup.title}" to board "${board.name}"`,
      entityType: 'board',
      entityId: board.id,
      boardId: board.id,
      userId: req.user.id,
      meta: { groupId: newGroup.id, groupTitle: newGroup.title },
    });

    res.status(201).json({
      success: true,
      message: 'Group added successfully.',
      data: { group: newGroup, groups: updatedGroups },
    });
  } catch (error) {
    console.error('[Board] AddGroup error:', error);
    res.status(500).json({ success: false, message: 'Server error adding group.' });
  }
};

/**
 * PATCH /api/boards/:id/groups/:groupId
 * Body: { title?, color? }
 *
 * Rename a single group on a board. Companion to addGroup — used by members
 * and assistant managers (and everyone else) so they can rename a group on a
 * board they have access to without going through PUT /:id (which still
 * blocks the structural groups-array rewrite for non-management roles).
 *
 * Permission model:
 *   - super_admin / admin / manager → always allowed.
 *   - assistant_manager / member    → allowed iff
 *     boardVisibilityService.canUserSeeBoard returns true.
 *
 * Status codes:
 *   - 200 success
 *   - 400 invalid title
 *   - 403 no access
 *   - 404 board / group not found
 */
const renameGroup = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const board = await Board.findByPk(req.params.id);
    if (!board) {
      return res.status(404).json({ success: false, message: 'Board not found.' });
    }

    const reachable = await boardVisibility.canUserSeeBoard(req.user, board.id);
    if (!reachable) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. You do not have access to this board.',
      });
    }

    const groupId = req.params.groupId;
    const groups = Array.isArray(board.groups) ? board.groups : [];
    const idx = groups.findIndex((g) => g && g.id === groupId);
    if (idx === -1) {
      return res.status(404).json({ success: false, message: 'Group not found on this board.' });
    }

    const { title, color } = req.body;
    if (title === undefined && color === undefined) {
      return res.status(400).json({ success: false, message: 'Provide a title or color to update.' });
    }

    const previous = groups[idx];
    const updatedGroup = { ...previous };
    if (title !== undefined) {
      const cleaned = sanitizeInput(String(title)).trim();
      if (!cleaned) {
        return res.status(400).json({ success: false, message: 'Group name cannot be empty.' });
      }
      if (cleaned.length > 80) {
        return res.status(400).json({ success: false, message: 'Group name must be 80 characters or fewer.' });
      }
      updatedGroup.title = cleaned;
      // Keep `name` mirrored for any legacy code that reads either field.
      updatedGroup.name = cleaned;
    }
    if (color !== undefined) {
      if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(color))) {
        return res.status(400).json({ success: false, message: 'Color must be a valid hex code.' });
      }
      updatedGroup.color = color;
    }

    const updatedGroups = [...groups];
    updatedGroups[idx] = updatedGroup;
    await board.update({ groups: updatedGroups });

    const fullBoard = await Board.findByPk(board.id, {
      include: [
        { model: User, as: 'creator', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: User, as: 'members', attributes: ['id', 'name', 'email', 'avatar'], through: { attributes: [] } },
      ],
    });

    emitToBoard(board.id, 'board:updated', { board: fullBoard });

    logActivity({
      action: 'board_group_renamed',
      description: `Renamed group "${previous.title || previous.name || groupId}" → "${updatedGroup.title}" on board "${board.name}"`,
      entityType: 'board',
      entityId: board.id,
      boardId: board.id,
      userId: req.user.id,
      meta: {
        groupId,
        previousTitle: previous.title || previous.name,
        newTitle: updatedGroup.title,
      },
    });

    res.json({
      success: true,
      message: 'Group updated successfully.',
      data: { group: updatedGroup, groups: updatedGroups },
    });
  } catch (error) {
    console.error('[Board] RenameGroup error:', error);
    res.status(500).json({ success: false, message: 'Server error renaming group.' });
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

    // Board-level access check delegated to the centralized service so it
    // matches the sidebar visibility rule. Admin/manager/super_admin remain
    // unrestricted; assistant_manager/member must have a real visibility
    // path (creator / explicit member / task assignment / ownership in
    // self+subtree).
    const reachable = await boardVisibility.canUserSeeBoard(req.user, board.id);
    if (!reachable) {
      return res.status(403).json({ success: false, message: 'Access denied. You are not authorized to export this board.' });
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
  addGroup,
  renameGroup,
  exportBoard,
  importTasks,
};
