const { PermissionGrant, User } = require('../models');
const { Op } = require('sequelize');
const { logActivity } = require('../services/activityService');
const { getEffectivePermissions } = require('../middleware/permissions');

// GET /api/permissions — list all grants (admin)
exports.getPermissions = async (req, res) => {
  try {
    const { resourceType, resourceId, userId } = req.query;
    const where = { isActive: true };
    if (resourceType) where.resourceType = resourceType;
    if (resourceId) where.resourceId = resourceId;
    if (userId) where.userId = userId;

    const grants = await PermissionGrant.findAll({
      where,
      include: [
        { model: User, as: 'user', attributes: ['id', 'name', 'email', 'avatar', 'role'] },
        { model: User, as: 'granter', attributes: ['id', 'name', 'email'] },
      ],
      order: [['createdAt', 'DESC']],
    });
    res.json({ success: true, data: { permissions: grants } });
  } catch (err) {
    console.error('[Permission] getPermissions error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch permissions.' });
  }
};

// POST /api/permissions — grant permission
exports.grantPermission = async (req, res) => {
  try {
    const { userId, resourceType, resourceId, permissionLevel, expiresAt, notes } = req.body;

    if (!userId || !resourceType || !permissionLevel) {
      return res.status(400).json({ success: false, message: 'userId, resourceType, permissionLevel are required.' });
    }

    // Check if grant already exists
    const existing = await PermissionGrant.findOne({
      where: { userId, resourceType, resourceId: resourceId || null, isActive: true },
    });

    if (existing) {
      await existing.update({ permissionLevel, expiresAt: expiresAt || null, notes });
      logActivity({
        action: 'permission_updated',
        description: `${req.user.name} updated ${permissionLevel} permission for user`,
        entityType: 'permission',
        entityId: existing.id,
        userId: req.user.id,
        meta: { targetUserId: userId, resourceType, resourceId, permissionLevel },
      });
      return res.json({ success: true, data: { permission: existing } });
    }

    const grant = await PermissionGrant.create({
      userId,
      resourceType,
      resourceId: resourceId || null,
      permissionLevel,
      grantedBy: req.user.id,
      expiresAt: expiresAt || null,
      notes: notes || null,
    });

    logActivity({
      action: 'permission_granted',
      description: `${req.user.name} granted ${permissionLevel} access on ${resourceType}`,
      entityType: 'permission',
      entityId: grant.id,
      userId: req.user.id,
      meta: { targetUserId: userId, resourceType, resourceId, permissionLevel },
    });

    res.status(201).json({ success: true, data: { permission: grant } });
  } catch (err) {
    console.error('[Permission] grantPermission error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to grant permission.' });
  }
};

// POST /api/permissions/bulk — bulk grant permissions
exports.bulkGrantPermissions = async (req, res) => {
  try {
    const { grants } = req.body;
    if (!Array.isArray(grants) || grants.length === 0) {
      return res.status(400).json({ success: false, message: 'grants array is required.' });
    }

    const results = [];
    for (const g of grants) {
      const [grant, created] = await PermissionGrant.findOrCreate({
        where: { userId: g.userId, resourceType: g.resourceType, resourceId: g.resourceId || null, isActive: true },
        defaults: {
          permissionLevel: g.permissionLevel || 'view',
          grantedBy: req.user.id,
          expiresAt: g.expiresAt || null,
        },
      });
      if (!created) {
        await grant.update({ permissionLevel: g.permissionLevel || 'view', expiresAt: g.expiresAt || null });
      }
      results.push(grant);
    }

    logActivity({
      action: 'permission_bulk_update',
      description: `${req.user.name} updated ${grants.length} permission(s)`,
      entityType: 'permission',
      entityId: null,
      userId: req.user.id,
      meta: { count: grants.length },
    });

    res.json({ success: true, data: { permissions: results, count: results.length } });
  } catch (err) {
    console.error('[Permission] bulkGrant error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to bulk update permissions.' });
  }
};

// DELETE /api/permissions/:id — revoke permission
exports.revokePermission = async (req, res) => {
  try {
    const grant = await PermissionGrant.findByPk(req.params.id);
    if (!grant) return res.status(404).json({ success: false, message: 'Permission not found.' });

    await grant.update({ isActive: false });

    logActivity({
      action: 'permission_revoked',
      description: `${req.user.name} revoked permission`,
      entityType: 'permission',
      entityId: grant.id,
      userId: req.user.id,
      meta: { targetUserId: grant.userId, resourceType: grant.resourceType },
    });

    res.json({ success: true, message: 'Permission revoked.' });
  } catch (err) {
    console.error('[Permission] revokePermission error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to revoke permission.' });
  }
};

// GET /api/permissions/my-grants — get current user's active permission grants
exports.getMyGrants = async (req, res) => {
  try {
    const grants = await PermissionGrant.findAll({
      where: {
        userId: req.user.id,
        isActive: true,
        [Op.or]: [
          { expiresAt: null },
          { expiresAt: { [Op.gt]: new Date() } },
        ],
      },
      attributes: ['id', 'resourceType', 'resourceId', 'permissionLevel', 'expiresAt'],
    });
    res.json({ success: true, data: { grants } });
  } catch (err) {
    console.error('[Permission] getMyGrants error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch your permissions.' });
  }
};

// GET /api/permissions/effective/:userId — get effective permissions for a user
exports.getEffective = async (req, res) => {
  try {
    const { resourceType, resourceId } = req.query;
    const result = await getEffectivePermissions(req.params.userId, resourceType, resourceId);
    res.json({ success: true, data: { effective: result } });
  } catch (err) {
    console.error('[Permission] getEffective error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to get effective permissions.' });
  }
};

// GET /api/permissions/templates — permission templates by role
exports.getTemplates = async (_req, res) => {
  const templates = {
    admin: {
      label: 'Administrator',
      description: 'Full access to all resources',
      permissions: [
        { resourceType: 'workspace', permissionLevel: 'admin' },
        { resourceType: 'board', permissionLevel: 'admin' },
        { resourceType: 'team', permissionLevel: 'admin' },
        { resourceType: 'dashboard', permissionLevel: 'admin' },
      ],
    },
    manager: {
      label: 'Manager',
      description: 'Manage boards, assign tasks, view dashboards',
      permissions: [
        { resourceType: 'workspace', permissionLevel: 'manage' },
        { resourceType: 'board', permissionLevel: 'manage' },
        { resourceType: 'team', permissionLevel: 'manage' },
        { resourceType: 'dashboard', permissionLevel: 'view' },
      ],
    },
    member: {
      label: 'Team Member',
      description: 'View boards, edit own tasks',
      permissions: [
        { resourceType: 'workspace', permissionLevel: 'view' },
        { resourceType: 'board', permissionLevel: 'edit' },
        { resourceType: 'team', permissionLevel: 'view' },
        { resourceType: 'dashboard', permissionLevel: 'view' },
      ],
    },
    viewer: {
      label: 'Viewer',
      description: 'Read-only access',
      permissions: [
        { resourceType: 'workspace', permissionLevel: 'view' },
        { resourceType: 'board', permissionLevel: 'view' },
        { resourceType: 'team', permissionLevel: 'view' },
        { resourceType: 'dashboard', permissionLevel: 'view' },
      ],
    },
  };
  res.json({ success: true, data: { templates } });
};

// POST /api/permissions/apply-template — apply template to user
exports.applyTemplate = async (req, res) => {
  try {
    const { userId, template, resourceId } = req.body;
    const templates = {
      admin: [
        { resourceType: 'workspace', permissionLevel: 'admin' },
        { resourceType: 'board', permissionLevel: 'admin' },
        { resourceType: 'team', permissionLevel: 'admin' },
        { resourceType: 'dashboard', permissionLevel: 'admin' },
      ],
      manager: [
        { resourceType: 'workspace', permissionLevel: 'manage' },
        { resourceType: 'board', permissionLevel: 'manage' },
        { resourceType: 'team', permissionLevel: 'manage' },
        { resourceType: 'dashboard', permissionLevel: 'view' },
      ],
      member: [
        { resourceType: 'workspace', permissionLevel: 'view' },
        { resourceType: 'board', permissionLevel: 'edit' },
        { resourceType: 'team', permissionLevel: 'view' },
        { resourceType: 'dashboard', permissionLevel: 'view' },
      ],
    };

    const perms = templates[template];
    if (!perms) return res.status(400).json({ success: false, message: 'Invalid template.' });

    const results = [];
    for (const p of perms) {
      const [grant] = await PermissionGrant.findOrCreate({
        where: { userId, resourceType: p.resourceType, resourceId: resourceId || null, isActive: true },
        defaults: { permissionLevel: p.permissionLevel, grantedBy: req.user.id },
      });
      await grant.update({ permissionLevel: p.permissionLevel });
      results.push(grant);
    }

    logActivity({
      action: 'permission_template_applied',
      description: `${req.user.name} applied "${template}" template to user`,
      entityType: 'permission',
      entityId: null,
      userId: req.user.id,
      meta: { targetUserId: userId, template },
    });

    res.json({ success: true, data: { permissions: results } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to apply template.' });
  }
};
