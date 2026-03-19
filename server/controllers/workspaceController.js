const { Workspace, Board, User } = require('../models');
const { Op } = require('sequelize');
const { logActivity } = require('../services/activityService');

// GET /api/workspaces/mine — workspaces visible to current user
// Admins/Managers: see all workspaces
// Members: see only (1) workspaces they created, (2) workspaces assigned to them via workspaceId,
//          (3) workspaces where they're a member, (4) workspaces containing boards with tasks assigned to them
exports.getMyWorkspaces = async (req, res) => {
  try {
    const userId = req.user.id;
    const isAdminOrManager = req.user.role === 'admin' || req.user.role === 'manager';

    // Admins and Managers see all workspaces
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

    // Members: strict visibility
    const { sequelize } = require('../config/db');

    // Find workspace IDs where user has assigned tasks
    const [assignedWsRows] = await sequelize.query(
      `SELECT DISTINCT b."workspaceId" FROM tasks t JOIN boards b ON b.id = t."boardId"
       WHERE t."assignedTo" = :userId AND b."workspaceId" IS NOT NULL AND b."isArchived" = false AND (t."isArchived" = false OR t."isArchived" IS NULL)`,
      { replacements: { userId } }
    );
    const assignedWsIds = assignedWsRows.map(r => r.workspaceId).filter(Boolean);

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

    const myWorkspaces = allWorkspaces.filter(ws => {
      // 1. Created by me
      if (ws.createdBy === userId) return true;
      // 2. My workspaceId matches
      if (userRecord?.workspaceId && ws.id === userRecord.workspaceId) return true;
      // 3. I'm in workspaceMembers
      if (ws.workspaceMembers?.some(m => m.id === userId)) return true;
      // 4. I have tasks assigned to me in this workspace's boards
      if (assignedWsIds.includes(ws.id)) return true;
      return false;
    });

    res.json({ success: true, data: { workspaces: myWorkspaces } });
  } catch (err) {
    console.error('[Workspace] getMyWorkspaces error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch your workspaces.' });
  }
};

// GET /api/workspaces
exports.getWorkspaces = async (req, res) => {
  try {
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
