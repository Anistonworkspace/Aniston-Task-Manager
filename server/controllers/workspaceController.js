const { Workspace, Board, User } = require('../models');
const { Op } = require('sequelize');
const { logActivity } = require('../services/activityService');
const boardMembershipService = require('../services/boardMembershipService');
const boardVisibility = require('../services/boardVisibilityService');
const { getIO } = require('../services/socketService');

// Sidebar refresh: workspace mutations have no per-room concept (workspaces
// don't have socket rooms), so we broadcast globally and let each receiving
// client invalidate its `boards.list` queryKey. The refetch hits the
// RBAC-aware `/workspaces/mine` + `/boards` endpoints, so unauthorised users
// see no change. Payload kept minimal — clients refetch for the truth.
function broadcastWorkspaceChange(event, workspaceId, extra = {}) {
  try {
    getIO().emit(event, { workspaceId, ...extra });
  } catch (_) { /* socket layer not initialised in tests */ }
}

// GET /api/workspaces/mine — workspaces visible to current user
// Admins/Managers: see all workspaces
// Members: see only (1) workspaces they created, (2) workspaces assigned to them via workspaceId,
//          (3) workspaces where they're a member, (4) workspaces containing boards with tasks assigned to them
exports.getMyWorkspaces = async (req, res) => {
  try {
    const userId = req.user.id;
    const isAdminOrManager = !!req.user.isSuperAdmin || req.user.role === 'admin' || req.user.role === 'manager';

    // Admins, Managers, and Super Admins see all workspaces
    if (isAdminOrManager) {
      const workspaces = await Workspace.findAll({
        where: { isActive: true },
        include: [
          { model: User, as: 'creator', attributes: ['id', 'name', 'email', 'avatar'] },
          { model: Board, as: 'boards', attributes: ['id', 'name', 'color'], where: { isArchived: false }, required: false },
          { model: User, as: 'workspaceMembers', attributes: ['id', 'name', 'email', 'avatar', 'role'] },
        ],
        order: [['createdAt', 'ASC']],
      });
      return res.json({ success: true, data: { workspaces } });
    }

    // Members / assistant_managers: strict visibility based on board access.
    // Delegated to boardVisibilityService so the rule matches getBoards,
    // getBoard, and search exactly. The previous inline SQL accepted ANY
    // BoardMembers row including stale auto-added ones — that surfaced
    // workspaces an asst_manager had no real relationship to.
    const visibleBoardIds = await boardVisibility.getVisibleBoardIdsForUser(req.user, { includeArchived: false });
    let assignedWsIds = [];
    if (visibleBoardIds.size > 0) {
      const visibleBoardRows = await Board.findAll({
        where: { id: { [Op.in]: Array.from(visibleBoardIds) } },
        attributes: ['id', 'workspaceId'],
        raw: true,
      });
      assignedWsIds = [...new Set(visibleBoardRows.map((r) => r.workspaceId).filter(Boolean))];
    }
    const accessibleBoardIds = visibleBoardIds;

    // For workspaceMember-membership the asst_manager also inherits visibility
    // through their direct-line subtree (org chart). Build the user-id set
    // here so a workspace where a descendant is a member still surfaces.
    let visibleUserIds = [userId];
    try {
      const hierarchyService = require('../services/hierarchyService');
      const descendants = await hierarchyService.getDescendantIds(userId);
      visibleUserIds = visibleUserIds.concat(descendants);
    } catch { /* hierarchy walk is best-effort */ }

    const userRecord = await User.findByPk(userId, { attributes: ['id', 'workspaceId'] });

    const allWorkspaces = await Workspace.findAll({
      where: { isActive: true },
      include: [
        { model: User, as: 'creator', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: Board, as: 'boards', attributes: ['id', 'name', 'color'], where: { isArchived: false }, required: false },
        { model: User, as: 'workspaceMembers', attributes: ['id', 'name', 'email', 'avatar', 'role'] },
      ],
      order: [['createdAt', 'ASC']],
    });

    const myWorkspaces = allWorkspaces
      .filter(ws => {
        // 1. Created by me
        if (ws.createdBy === userId) return true;
        // 2. My workspaceId matches
        if (userRecord?.workspaceId && ws.id === userRecord.workspaceId) return true;
        // 3. I'm in workspaceMembers
        if (ws.workspaceMembers?.some(m => visibleUserIds.includes(m.id))) return true;
        // 4. I have accessible boards in this workspace (via any assignment path)
        if (assignedWsIds.includes(ws.id)) return true;
        return false;
      })
      .map(ws => {
        // Filter boards within each workspace to only show accessible ones
        const wsJSON = ws.toJSON();
        wsJSON.boards = (wsJSON.boards || []).filter(b => accessibleBoardIds.has(b.id));
        return wsJSON;
      })
      // Remove workspaces with zero accessible boards (unless user is creator/member)
      .filter(ws => {
        if (ws.createdBy === userId) return true;
        if (userRecord?.workspaceId && ws.id === userRecord.workspaceId) return true;
        if (ws.workspaceMembers?.some(m => visibleUserIds.includes(m.id))) return true;
        return ws.boards.length > 0;
      });

    res.json({ success: true, data: { workspaces: myWorkspaces } });
  } catch (err) {
    console.error('[Workspace] getMyWorkspaces error:', err.message, err.stack);
    res.status(500).json({ success: false, message: 'Failed to fetch your workspaces.' });
  }
};

// GET /api/workspaces
// Non-admin/manager users are redirected to the filtered /mine endpoint logic
exports.getWorkspaces = async (req, res) => {
  try {
    const role = req.user.role;
    const isSuperAdmin = !!req.user.isSuperAdmin;

    // Only admin/manager/superadmin see all workspaces
    if (!isSuperAdmin && role !== 'admin' && role !== 'manager') {
      return exports.getMyWorkspaces(req, res);
    }

    const workspaces = await Workspace.findAll({
      where: { isActive: true },
      include: [
        { model: User, as: 'creator', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: Board, as: 'boards', attributes: ['id', 'name', 'color'], where: { isArchived: false }, required: false },
        { model: User, as: 'workspaceMembers', attributes: ['id', 'name', 'email', 'avatar', 'role', 'designation'] },
      ],
      order: [['createdAt', 'ASC']],
    });
    res.json({ success: true, data: { workspaces } });
  } catch (err) {
    console.error('[Workspace] getWorkspaces error:', err.message, err.stack);
    res.status(500).json({ success: false, message: 'Failed to fetch workspaces.' });
  }
};

// GET /api/workspaces/:id
exports.getWorkspace = async (req, res) => {
  // Companion tripwire to the one in updateWorkspace — see the explanatory
  // comment there. If we get here with id="order" the workspace-order
  // route file isn't being honored on the running backend.
  if (req.params.id === 'order' && process.env.NODE_ENV !== 'production') {
    console.warn('[RouteBug] /api/workspaces/order is being handled by getWorkspace. Check route order in server/routes/workspaces.js and restart the backend.');
    return res.status(500).json({
      success: false,
      message: 'Workspace order route is misconfigured. Please restart the backend dev server.',
    });
  }
  try {
    const workspace = await Workspace.findByPk(req.params.id, {
      include: [
        { model: User, as: 'creator', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: Board, as: 'boards', attributes: ['id', 'name', 'color', 'description'], where: { isArchived: false }, required: false },
        { model: User, as: 'workspaceMembers', attributes: ['id', 'name', 'email', 'avatar', 'role', 'designation', 'department'] },
      ],
    });
    if (!workspace) return res.status(404).json({ success: false, message: 'Workspace not found.' });

    // Access control: non-admin/manager users must have a reason to see this workspace
    const role = req.user.role;
    const isSuperAdmin = !!req.user.isSuperAdmin;
    if (!isSuperAdmin && role !== 'admin' && role !== 'manager') {
      const userId = req.user.id;

      // Org subtree (self + descendants via both User.managerId AND
      // manager_relations) — used to evaluate workspaceMember visibility.
      let visibleUserIds = [userId];
      try {
        const hierarchyService = require('../services/hierarchyService');
        const descendants = await hierarchyService.getDescendantIds(userId);
        visibleUserIds = visibleUserIds.concat(descendants);
      } catch { /* best-effort */ }

      const isCreator = workspace.createdBy === userId;
      const userRecord = await User.findByPk(userId, { attributes: ['id', 'workspaceId'] });
      const isAssignedWorkspace = userRecord?.workspaceId === workspace.id;
      const isWsMember = workspace.workspaceMembers?.some(m => visibleUserIds.includes(m.id));

      // Check if user has any accessible boards in this workspace via the
      // centralized boardVisibilityService (same rule as the sidebar).
      const accessibleBoardIds = await boardVisibility.getVisibleBoardIdsForUser(req.user, { includeArchived: false });
      const accessibleInThisWs = (workspace.boards || []).some(b => accessibleBoardIds.has(b.id));

      if (!isCreator && !isAssignedWorkspace && !isWsMember && !accessibleInThisWs) {
        return res.status(403).json({ success: false, message: 'Access denied. You do not have access to this workspace.' });
      }

      // Filter boards within the workspace to only show accessible ones.
      const wsJSON = workspace.toJSON();
      wsJSON.boards = (wsJSON.boards || []).filter(b => accessibleBoardIds.has(b.id));
      return res.json({ success: true, data: { workspace: wsJSON } });
    }

    res.json({ success: true, data: { workspace } });
  } catch (err) {
    console.error('[Workspace] getWorkspace error:', err.message, err.stack);
    res.status(500).json({ success: false, message: 'Failed to fetch workspace.' });
  }
};

// POST /api/workspaces
exports.createWorkspace = async (req, res) => {
  try {
    const { name, description, color, icon } = req.body;
    const workspace = await Workspace.create({
      name,
      description: description || '',
      color: color || '#0073ea',
      icon: icon || 'Briefcase',
      createdBy: req.user.id,
    });

    logActivity({
      action: 'workspace_created',
      description: `${req.user.name} created workspace "${name}"`,
      entityType: 'workspace',
      entityId: workspace.id,
      userId: req.user.id,
      meta: { workspaceName: name },
    });

    const full = await Workspace.findByPk(workspace.id, {
      include: [
        { model: User, as: 'creator', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: Board, as: 'boards', required: false },
        { model: User, as: 'workspaceMembers', attributes: ['id', 'name', 'email', 'avatar', 'role'] },
      ],
    });

    broadcastWorkspaceChange('workspace:created', workspace.id, { workspace: full });

    res.status(201).json({ success: true, data: { workspace: full } });
  } catch (err) {
    console.error('[Workspace] createWorkspace error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create workspace.' });
  }
};

// PUT /api/workspaces/:id
exports.updateWorkspace = async (req, res) => {
  // ─── Route-bug tripwire ───────────────────────────────────────
  // If `:id` is the literal string "order" we got here because the
  // /api/workspaces/order route was registered AFTER /:id (or wasn't
  // registered at all on the running backend). Loudly signal that in dev
  // so the regression is caught immediately. Production stays silent.
  if (req.params.id === 'order' && process.env.NODE_ENV !== 'production') {
    console.warn('[RouteBug] /api/workspaces/order is being handled by updateWorkspace. The literal `/order` route must be registered before `/:id` in server/routes/workspaces.js, and the backend must be restarted to pick up the change.');
    return res.status(500).json({
      success: false,
      message: 'Workspace order route is misconfigured. Please restart the backend dev server.',
    });
  }
  try {
    const workspace = await Workspace.findByPk(req.params.id);
    if (!workspace) return res.status(404).json({ success: false, message: 'Workspace not found.' });

    const { name, description, color, icon, isActive } = req.body;

    // Phase 7 — Tier-2 destructive guard. Flipping isActive=false is
    // soft-archive / delete-class; T2 cannot do it (decision #4). Re-enable
    // (isActive=true) is constructive and not gated here. Closes audit P0-4.
    if (isActive === false && workspace.isActive !== false) {
      const { assertCanDelete } = require('../services/tierEnforcement');
      const { sendIfTierError } = require('../utils/tierResponseHelpers');
      if (sendIfTierError(res, () => assertCanDelete(req.user, 'workspace', { isOwnResource: false }))) return;
    }

    await workspace.update({
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(color !== undefined && { color }),
      ...(icon !== undefined && { icon }),
      ...(isActive !== undefined && { isActive }),
    });

    logActivity({
      action: 'workspace_updated',
      description: `${req.user.name} updated workspace "${workspace.name}"`,
      entityType: 'workspace',
      entityId: workspace.id,
      userId: req.user.id,
    });

    // Real-time sidebar refresh — covers rename, color/icon change, AND
    // archive (isActive=false). Distinct event lets clients log differently
    // if they ever want to, but the routing target is the same `boards.list`.
    const archiveEvent = isActive === false ? 'workspace:archived' : 'workspace:updated';
    broadcastWorkspaceChange(archiveEvent, workspace.id, { workspace });

    res.json({ success: true, data: { workspace } });
  } catch (err) {
    console.error('[Workspace] updateWorkspace error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update workspace.' });
  }
};

// DELETE /api/workspaces/:id — admin only, workspaces cannot be deleted by managers or members
exports.deleteWorkspace = async (req, res) => {
  try {
    if (!['admin', 'manager'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Only administrators can delete workspaces. Workspaces are permanent.' });
    }
    const workspace = await Workspace.findByPk(req.params.id);
    if (!workspace) return res.status(404).json({ success: false, message: 'Workspace not found.' });

    // Phase 5d — destructive-action gate. Decision #4: only Tier 1 may
    // delete a workspace. Closes audit P0-3 / P0-4 (workspace mass-mutation)
    // for the delete path; the assign/restore/etc. paths are tightened in
    // Phase 5e.
    {
      const { assertCanDelete } = require('../services/tierEnforcement');
      const { sendIfTierError } = require('../utils/tierResponseHelpers');
      if (sendIfTierError(res, () => assertCanDelete(req.user, 'workspace', { isOwnResource: false }))) return;
    }

    // Enforce 90-day rule for archived workspaces
    if (!workspace.isActive && workspace.archivedAt) {
      const { canPermanentlyDelete } = require('../utils/archiveHelpers');
      const { allowed, daysRemaining } = canPermanentlyDelete(req.user, workspace.archivedAt);
      if (!allowed) {
        return res.status(403).json({ success: false, message: `This workspace is protected for ${daysRemaining} more days. Only Super Admin can delete before 90 days.` });
      }
    }

    // Unlink boards from workspace instead of deleting them
    await Board.update({ workspaceId: null }, { where: { workspaceId: workspace.id } });
    await User.update({ workspaceId: null }, { where: { workspaceId: workspace.id } });

    await workspace.destroy();

    logActivity({
      action: 'workspace_deleted',
      description: `${req.user.name} deleted workspace "${workspace.name}"`,
      entityType: 'workspace',
      entityId: workspace.id,
      userId: req.user.id,
    });

    // Sidebar refresh — clients re-fetch their workspace + board lists.
    broadcastWorkspaceChange('workspace:deleted', workspace.id);

    res.json({ success: true, message: 'Workspace deleted.' });
  } catch (err) {
    console.error('[Workspace] deleteWorkspace error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete workspace.' });
  }
};

// POST /api/workspaces/:id/boards — assign board to workspace
exports.assignBoard = async (req, res) => {
  try {
    const { boardId } = req.body;
    const board = await Board.findByPk(boardId);
    if (!board) return res.status(404).json({ success: false, message: 'Board not found.' });

    await board.update({ workspaceId: req.params.id });
    // The board moved between workspaces — broadcast both events so the
    // sidebar re-shuffles for everyone whose `boards.list` is registered.
    broadcastWorkspaceChange('workspace:updated', req.params.id, { boardId });
    try { getIO().emit('board:updated', { boardId, board }); } catch {}
    res.json({ success: true, data: { board } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to assign board.' });
  }
};

// POST /api/workspaces/:id/members — assign users to workspace
exports.assignMembers = async (req, res) => {
  try {
    const { userIds } = req.body;
    if (!Array.isArray(userIds)) return res.status(400).json({ success: false, message: 'userIds must be an array.' });

    await User.update({ workspaceId: req.params.id }, { where: { id: userIds } });

    logActivity({
      action: 'workspace_members_updated',
      description: `${req.user.name} assigned ${userIds.length} member(s) to workspace`,
      entityType: 'workspace',
      entityId: req.params.id,
      userId: req.user.id,
      meta: { userIds },
    });

    // Membership change can flip workspace visibility for affected users —
    // broadcast so their sidebar re-evaluates via the RBAC-aware refetch.
    broadcastWorkspaceChange('workspace:memberUpdated', req.params.id, { userIds });

    res.json({ success: true, message: `${userIds.length} member(s) assigned.` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to assign members.' });
  }
};

// POST /api/workspaces/from-template — create workspace from template
exports.createFromTemplate = async (req, res) => {
  try {
    const { templateId, name, description, color, icon, boards: templateBoards } = req.body;

    if (!name) return res.status(400).json({ success: false, message: 'Workspace name is required.' });

    // Create workspace
    const workspace = await Workspace.create({
      name,
      description: description || '',
      color: color || '#0073ea',
      icon: icon || 'Briefcase',
      createdBy: req.user.id,
    });

    // Create boards from template
    const createdBoards = [];
    if (Array.isArray(templateBoards)) {
      for (const tb of templateBoards) {
        const board = await Board.create({
          name: tb.name,
          color: tb.color || '#0073ea',
          columns: tb.columns || [],
          groups: tb.groups || [],
          workspaceId: workspace.id,
          createdBy: req.user.id,
        });
        // Add creator as board member (explicit — creator should always stay)
        await boardMembershipService.explicitAddMember(board.id, req.user.id);
        createdBoards.push(board);
      }
    }

    logActivity({
      action: 'workspace_created_from_template',
      description: `${req.user.name} created workspace "${name}" from template "${templateId}"`,
      entityType: 'workspace',
      entityId: workspace.id,
      userId: req.user.id,
      meta: { templateId, boardCount: createdBoards.length },
    });

    const full = await Workspace.findByPk(workspace.id, {
      include: [
        { model: User, as: 'creator', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: Board, as: 'boards', attributes: ['id', 'name', 'color'] },
        { model: User, as: 'workspaceMembers', attributes: ['id', 'name', 'email', 'avatar', 'role'] },
      ],
    });

    // Workspace + every templated board appeared in one go — one workspace
    // event is enough to drive the sidebar to re-fetch the whole structure.
    broadcastWorkspaceChange('workspace:created', workspace.id, { workspace: full });

    res.status(201).json({ success: true, data: { workspace: full } });
  } catch (err) {
    console.error('[Workspace] createFromTemplate error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create workspace from template.' });
  }
};

// POST /api/workspaces/:id/apply-template — apply a template (create boards) in an existing workspace
exports.applyTemplate = async (req, res) => {
  try {
    const workspace = await Workspace.findByPk(req.params.id);
    if (!workspace) return res.status(404).json({ success: false, message: 'Workspace not found.' });

    const { boards: templateBoards } = req.body;
    if (!Array.isArray(templateBoards) || templateBoards.length === 0) {
      return res.status(400).json({ success: false, message: 'No boards provided in template.' });
    }

    const createdBoards = [];
    for (const tb of templateBoards) {
      const board = await Board.create({
        name: tb.name,
        color: tb.color || '#0073ea',
        columns: tb.columns || [],
        groups: (tb.groups || []).map((g, i) => ({ ...g, id: g.id || `group_${i}`, position: i })),
        workspaceId: workspace.id,
        createdBy: req.user.id,
      });
      await boardMembershipService.explicitAddMember(board.id, req.user.id);
      createdBoards.push(board);
    }

    logActivity({
      action: 'workspace_template_applied',
      description: `${req.user.name} applied template to workspace "${workspace.name}"`,
      entityType: 'workspace',
      entityId: workspace.id,
      userId: req.user.id,
      meta: { boardCount: createdBoards.length },
    });

    // Several boards just landed in this workspace — sidebar refresh.
    broadcastWorkspaceChange('workspace:updated', workspace.id, {
      addedBoardIds: createdBoards.map((b) => b.id),
    });

    res.json({ success: true, data: { boards: createdBoards } });
  } catch (err) {
    console.error('[Workspace] applyTemplate error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to apply template.' });
  }
};

// DELETE /api/workspaces/:id/members/:userId
exports.removeMember = async (req, res) => {
  try {
    await User.update({ workspaceId: null }, { where: { id: req.params.userId, workspaceId: req.params.id } });
    // Workspace visibility may have changed for the removed user — broadcast
    // so their sidebar re-fetches from the RBAC-aware endpoints.
    broadcastWorkspaceChange('workspace:memberUpdated', req.params.id, {
      removedUserId: req.params.userId,
    });
    res.json({ success: true, message: 'Member removed from workspace.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to remove member.' });
  }
};

// GET /api/workspaces/archived — fetch archived (inactive) workspaces
//
// Route is guarded by `requireRole('manager','admin')` at the route layer, so
// in normal flow only managers/admins/super-admins reach here. The defensive
// re-check below exists because the same controller is now also reachable from
// internal helpers and because Layer-3 fallbacks in `requireRole` have
// historically allowed unintended bypass — failing closed here means a future
// regression in the auth middleware doesn't leak archived workspace names.
exports.getArchivedWorkspaces = async (req, res) => {
  try {
    const role = req.user?.role;
    const isSuperAdmin = !!req.user?.isSuperAdmin;
    if (!isSuperAdmin && role !== 'admin' && role !== 'manager') {
      return res.status(403).json({
        success: false,
        message: 'Only managers and admins can view archived workspaces.',
      });
    }
    const workspaces = await Workspace.findAll({
      where: { isActive: false },
      include: [
        { model: User, as: 'creator', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: Board, as: 'boards', attributes: ['id', 'name', 'color', 'isArchived'], required: false },
      ],
      order: [['updatedAt', 'DESC']],
    });
    res.json({ success: true, data: { workspaces } });
  } catch (err) {
    console.error('[Workspace] getArchivedWorkspaces error:', err.message, err.stack);
    res.status(500).json({ success: false, message: 'Failed to fetch archived workspaces.' });
  }
};

// PUT /api/workspaces/:id/restore — restore an archived workspace + its boards
exports.restoreWorkspace = async (req, res) => {
  try {
    const workspace = await Workspace.findByPk(req.params.id);
    if (!workspace) return res.status(404).json({ success: false, message: 'Workspace not found.' });
    await workspace.update({ isActive: true });
    // Also restore all boards in this workspace
    await Board.update({ isArchived: false }, { where: { workspaceId: req.params.id } });
    // Sidebar refresh — workspace + its boards reappear for everyone allowed
    // to see them.
    broadcastWorkspaceChange('workspace:restored', workspace.id, { workspace });
    res.json({ success: true, message: 'Workspace restored.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to restore workspace.' });
  }
};
