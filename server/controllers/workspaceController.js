const { Workspace, Board, User } = require('../models');
const { Op } = require('sequelize');
const { logActivity } = require('../services/activityService');
const { safeUUIDList } = require('../utils/safeSql');

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

    // Members / assistant_managers: strict visibility based on board access
    const { sequelize } = require('../config/db');

    // Build list of user IDs whose work grants visibility
    let visibleUserIds = [userId];
    if (req.user.role === 'assistant_manager') {
      const teamMembers = await User.findAll({
        where: { managerId: userId },
        attributes: ['id'],
        raw: true,
      });
      visibleUserIds = visibleUserIds.concat(teamMembers.map(m => m.id));
    }

    const userIdList = safeUUIDList(visibleUserIds, 'visibleUserIds');

    // Find ALL accessible board IDs for this user (or team) — used to filter both workspaces AND boards within them
    const accessibleBoardCondition = `
      b."isArchived" = false AND (
        b.id IN (SELECT "boardId" FROM "BoardMembers" WHERE "userId" IN (${userIdList}))
        OR b.id IN (SELECT DISTINCT t."boardId" FROM tasks t INNER JOIN task_assignees ta ON ta."taskId" = t.id WHERE ta."userId" IN (${userIdList}) AND (t."isArchived" = false OR t."isArchived" IS NULL))
        OR b.id IN (SELECT DISTINCT t."boardId" FROM tasks t INNER JOIN task_owners to2 ON to2."taskId" = t.id WHERE to2."userId" IN (${userIdList}) AND (t."isArchived" = false OR t."isArchived" IS NULL))
        OR b.id IN (SELECT DISTINCT "boardId" FROM tasks WHERE "assignedTo" IN (${userIdList}) AND ("isArchived" = false OR "isArchived" IS NULL))
        OR b."createdBy" IN (${userIdList})
      )`;

    const [accessibleBoardRows] = await sequelize.query(
      `SELECT DISTINCT b.id, b."workspaceId" FROM boards b WHERE ${accessibleBoardCondition}`,
      { replacements: {} }
    );
    const accessibleBoardIds = new Set(accessibleBoardRows.map(r => r.id));
    const assignedWsIds = [...new Set(accessibleBoardRows.map(r => r.workspaceId).filter(Boolean))];

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
    console.error('[Workspace] getMyWorkspaces error:', err.message);
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
    console.error('[Workspace] getWorkspaces error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch workspaces.' });
  }
};

// GET /api/workspaces/:id
exports.getWorkspace = async (req, res) => {
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
      let visibleUserIds = [userId];
      if (role === 'assistant_manager') {
        const teamMembers = await User.findAll({
          where: { managerId: userId },
          attributes: ['id'],
          raw: true,
        });
        visibleUserIds = visibleUserIds.concat(teamMembers.map(m => m.id));
      }

      const isCreator = workspace.createdBy === userId;
      const userRecord = await User.findByPk(userId, { attributes: ['id', 'workspaceId'] });
      const isAssignedWorkspace = userRecord?.workspaceId === workspace.id;
      const isWsMember = workspace.workspaceMembers?.some(m => visibleUserIds.includes(m.id));

      // Check if user has any accessible boards in this workspace
      let hasAccessibleBoard = false;
      if (!isCreator && !isAssignedWorkspace && !isWsMember) {
        const { sequelize } = require('../config/db');
        const userIdList = safeUUIDList(visibleUserIds, 'visibleUserIds');
        const [rows] = await sequelize.query(
          `SELECT 1 FROM boards b WHERE b."workspaceId" = :wsId AND b."isArchived" = false AND (
            b.id IN (SELECT "boardId" FROM "BoardMembers" WHERE "userId" IN (${userIdList}))
            OR b.id IN (SELECT DISTINCT t."boardId" FROM tasks t INNER JOIN task_assignees ta ON ta."taskId" = t.id WHERE ta."userId" IN (${userIdList}) AND (t."isArchived" = false OR t."isArchived" IS NULL))
            OR b.id IN (SELECT DISTINCT t."boardId" FROM tasks t INNER JOIN task_owners to2 ON to2."taskId" = t.id WHERE to2."userId" IN (${userIdList}) AND (t."isArchived" = false OR t."isArchived" IS NULL))
            OR b.id IN (SELECT DISTINCT "boardId" FROM tasks WHERE "assignedTo" IN (${userIdList}) AND ("isArchived" = false OR "isArchived" IS NULL))
          ) LIMIT 1`,
          { replacements: { wsId: workspace.id } }
        );
        hasAccessibleBoard = rows.length > 0;
      }

      if (!isCreator && !isAssignedWorkspace && !isWsMember && !hasAccessibleBoard) {
        return res.status(403).json({ success: false, message: 'Access denied. You do not have access to this workspace.' });
      }

      // Filter boards within the workspace to only show accessible ones
      const { sequelize } = require('../config/db');
      const userIdList = safeUUIDList(visibleUserIds, 'visibleUserIds');
      const [accessibleBoardRows] = await sequelize.query(
        `SELECT DISTINCT b.id FROM boards b WHERE b."workspaceId" = :wsId AND b."isArchived" = false AND (
          b.id IN (SELECT "boardId" FROM "BoardMembers" WHERE "userId" IN (${userIdList}))
          OR b.id IN (SELECT DISTINCT t."boardId" FROM tasks t INNER JOIN task_assignees ta ON ta."taskId" = t.id WHERE ta."userId" IN (${userIdList}) AND (t."isArchived" = false OR t."isArchived" IS NULL))
          OR b.id IN (SELECT DISTINCT t."boardId" FROM tasks t INNER JOIN task_owners to2 ON to2."taskId" = t.id WHERE to2."userId" IN (${userIdList}) AND (t."isArchived" = false OR t."isArchived" IS NULL))
          OR b.id IN (SELECT DISTINCT "boardId" FROM tasks WHERE "assignedTo" IN (${userIdList}) AND ("isArchived" = false OR "isArchived" IS NULL))
          OR b."createdBy" IN (${userIdList})
        )`,
        { replacements: { wsId: workspace.id } }
      );
      const accessibleBoardIds = new Set(accessibleBoardRows.map(r => r.id));
      const wsJSON = workspace.toJSON();
      wsJSON.boards = (wsJSON.boards || []).filter(b => accessibleBoardIds.has(b.id));
      return res.json({ success: true, data: { workspace: wsJSON } });
    }

    res.json({ success: true, data: { workspace } });
  } catch (err) {
    console.error('[Workspace] getWorkspace error:', err.message);
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

    res.status(201).json({ success: true, data: { workspace: full } });
  } catch (err) {
    console.error('[Workspace] createWorkspace error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create workspace.' });
  }
};

// PUT /api/workspaces/:id
exports.updateWorkspace = async (req, res) => {
  try {
    const workspace = await Workspace.findByPk(req.params.id);
    if (!workspace) return res.status(404).json({ success: false, message: 'Workspace not found.' });

    const { name, description, color, icon, isActive } = req.body;
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

    res.json({ success: true, data: { workspace } });
  } catch (err) {
    console.error('[Workspace] updateWorkspace error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update workspace.' });
  }
};

// DELETE /api/workspaces/:id — admin only, workspaces cannot be deleted by managers or members
exports.deleteWorkspace = async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only administrators can delete workspaces. Workspaces are permanent.' });
    }
    const workspace = await Workspace.findByPk(req.params.id);
    if (!workspace) return res.status(404).json({ success: false, message: 'Workspace not found.' });

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
        // Add creator as board member
        await board.addMember(req.user);
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
      await board.addMember(req.user);
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
    res.json({ success: true, message: 'Member removed from workspace.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to remove member.' });
  }
};

// GET /api/workspaces/archived — fetch archived (inactive) workspaces
exports.getArchivedWorkspaces = async (req, res) => {
  try {
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
    console.error('[Workspace] getArchivedWorkspaces error:', err.message);
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
    res.json({ success: true, message: 'Workspace restored.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to restore workspace.' });
  }
};
