const { PermissionGrant, User } = require('../models');
const { Op } = require('sequelize');
const { logActivity } = require('../services/activityService');
const { getEffectivePermissions } = require('../middleware/permissions');
const {
  computeEffectivePermissions,
  canGrantPermission,
  getPermissionMetadata,
} = require('../services/permissionEngine');
const {
  RESOURCES,
  RESOURCE_ACTIONS,
  ROLE_PERMISSIONS,
  getBasePermissions,
  isBasePermission,
  getResourcesByCategory,
} = require('../config/permissionMatrix');

// GET /api/permissions — list all grants
exports.getPermissions = async (req, res) => {
  try {
    const { resourceType, resourceId, userId, includeRevoked } = req.query;
    const where = {};
    if (!includeRevoked) where.isActive = true;
    if (resourceType) where.resourceType = resourceType;
    if (resourceId) where.resourceId = resourceId;
    if (userId) where.userId = userId;

    const grants = await PermissionGrant.findAll({
      where,
      include: [
        { model: User, as: 'user', attributes: ['id', 'name', 'email', 'avatar', 'role', 'isSuperAdmin'] },
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

// POST /api/permissions — grant permission (new action-based system)
exports.grantPermission = async (req, res) => {
  try {
    const { userId, resourceType, resourceId, action, permissionLevel, expiresAt, reason, notes, scope } = req.body;

    // Determine action: use new 'action' field, fall back to legacy 'permissionLevel'
    const grantAction = action || permissionLevel;
    if (!userId || !resourceType || !grantAction) {
      return res.status(400).json({
        success: false,
        message: 'userId, resourceType, and action (or permissionLevel) are required.',
      });
    }

    // Validate resource type
    if (!RESOURCES[resourceType]) {
      return res.status(400).json({
        success: false,
        message: `Invalid resource type: '${resourceType}'. Valid types: ${Object.keys(RESOURCES).join(', ')}`,
      });
    }

    // Validate action for this resource (only for new action-based grants)
    if (action) {
      const validActions = RESOURCE_ACTIONS[resourceType] || [];
      if (!validActions.includes(action)) {
        return res.status(400).json({
          success: false,
          message: `Invalid action '${action}' for resource '${resourceType}'. Valid actions: ${validActions.join(', ')}`,
        });
      }
    }

    // Check target user exists
    const targetUser = await User.findByPk(userId);
    if (!targetUser) {
      return res.status(404).json({ success: false, message: 'Target user not found.' });
    }

    // Prevent granting to super admin (they already have everything)
    if (targetUser.isSuperAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Super admin already has full access. No grants needed.',
      });
    }

    // Check if this is already a base permission for the user's role
    if (action && isBasePermission(targetUser.role, resourceType, action)) {
      return res.status(400).json({
        success: false,
        message: `'${action}' on '${resourceType}' is already included in the '${targetUser.role}' base role. No override needed.`,
        isBasePermission: true,
      });
    }

    // Check if granter has authority to grant this permission
    const grantCheck = await canGrantPermission(req.user, resourceType, action || 'manage');
    if (!grantCheck.allowed) {
      return res.status(403).json({
        success: false,
        message: grantCheck.reason || 'You do not have authority to grant this permission.',
      });
    }

    // Check for existing duplicate active grant
    const existingWhere = {
      userId,
      resourceType,
      resourceId: resourceId || null,
      isActive: true,
    };
    if (action) existingWhere.action = action;

    const existing = await PermissionGrant.findOne({ where: existingWhere });

    if (existing) {
      // Update existing grant
      await existing.update({
        expiresAt: expiresAt || null,
        reason: reason || existing.reason,
        notes: notes || existing.notes,
        scope: scope || existing.scope,
      });
      logActivity({
        action: 'permission_updated',
        description: `${req.user.name} updated ${action || permissionLevel} permission on ${resourceType} for ${targetUser.name}`,
        entityType: 'permission',
        entityId: existing.id,
        userId: req.user.id,
        meta: { targetUserId: userId, resourceType, resourceId, action: grantAction },
      });
      return res.json({ success: true, data: { permission: existing }, updated: true });
    }

    // Create new grant
    const grant = await PermissionGrant.create({
      userId,
      resourceType,
      resourceId: resourceId || null,
      action: action || null,
      permissionLevel: action ? null : permissionLevel,
      scope: scope || 'global',
      isOverride: true,
      grantedBy: req.user.id,
      expiresAt: expiresAt || null,
      reason: reason || null,
      notes: notes || null,
    });

    logActivity({
      action: 'permission_granted',
      description: `${req.user.name} granted '${grantAction}' on '${resourceType}' to ${targetUser.name}`,
      entityType: 'permission',
      entityId: grant.id,
      userId: req.user.id,
      meta: { targetUserId: userId, resourceType, resourceId, action: grantAction, scope: scope || 'global' },
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
      const existingWhere = {
        userId: g.userId,
        resourceType: g.resourceType,
        resourceId: g.resourceId || null,
        isActive: true,
      };
      if (g.action) existingWhere.action = g.action;

      const [grant, created] = await PermissionGrant.findOrCreate({
        where: existingWhere,
        defaults: {
          action: g.action || null,
          permissionLevel: g.action ? null : (g.permissionLevel || 'view'),
          scope: g.scope || 'global',
          isOverride: true,
          grantedBy: req.user.id,
          expiresAt: g.expiresAt || null,
          reason: g.reason || null,
        },
      });
      if (!created) {
        await grant.update({
          action: g.action || grant.action,
          permissionLevel: g.action ? null : (g.permissionLevel || grant.permissionLevel),
          expiresAt: g.expiresAt || null,
        });
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

// POST /api/permissions/multi — multi-resource multi-action grant in one operation
exports.multiGrant = async (req, res) => {
  const { sequelize } = require('../config/db');
  const t = await sequelize.transaction();
  try {
    const { userId, resources, actions, scope, expiresAt, reason } = req.body;

    // Validate required fields
    if (!userId) {
      await t.rollback();
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }

    // Normalize to arrays (backward compat: accept single values too)
    const resourceList = Array.isArray(resources) ? resources : (resources ? [resources] : []);
    const actionList = Array.isArray(actions) ? actions : (actions ? [actions] : []);

    // Also accept legacy single-value fields for backward compat
    if (resourceList.length === 0 && req.body.resourceType) resourceList.push(req.body.resourceType);
    if (actionList.length === 0 && req.body.action) actionList.push(req.body.action);

    if (resourceList.length === 0 || actionList.length === 0) {
      await t.rollback();
      return res.status(400).json({ success: false, message: 'At least one resource and one action are required.' });
    }

    // Validate target user
    const targetUser = await User.findByPk(userId, { transaction: t });
    if (!targetUser) {
      await t.rollback();
      return res.status(404).json({ success: false, message: 'Target user not found.' });
    }
    if (targetUser.isSuperAdmin) {
      await t.rollback();
      return res.status(400).json({ success: false, message: 'Super admin already has full access.' });
    }

    // Validate all resources
    const invalidResources = resourceList.filter(r => !RESOURCES[r]);
    if (invalidResources.length > 0) {
      await t.rollback();
      return res.status(400).json({
        success: false,
        message: `Invalid resource(s): ${invalidResources.join(', ')}`,
      });
    }

    // Build all valid resource+action combinations and process them
    const created = [];
    const skipped = [];
    const updated = [];
    const errors = [];

    for (const resource of resourceList) {
      const validActions = RESOURCE_ACTIONS[resource] || [];

      // Check granter authority for this resource (once per resource)
      const grantCheck = await canGrantPermission(req.user, resource, 'manage');
      if (!grantCheck.allowed) {
        errors.push({ resource, reason: grantCheck.reason || 'No authority to grant.' });
        continue;
      }

      for (const action of actionList) {
        // Skip actions not valid for this resource
        if (!validActions.includes(action)) {
          skipped.push({ resource, action, reason: `'${action}' is not a valid action for '${resource}'` });
          continue;
        }

        // Skip if already a base permission
        if (isBasePermission(targetUser.role, resource, action)) {
          skipped.push({ resource, action, reason: `Already included in '${targetUser.role}' base role` });
          continue;
        }

        // Check for existing active grant
        const existing = await PermissionGrant.findOne({
          where: { userId, resourceType: resource, action, isActive: true },
          transaction: t,
        });

        if (existing) {
          // Update expiry/reason if provided
          if (expiresAt || reason) {
            await existing.update({
              expiresAt: expiresAt || existing.expiresAt,
              reason: reason || existing.reason,
              scope: scope || existing.scope,
            }, { transaction: t });
            updated.push({ resource, action, id: existing.id });
          } else {
            skipped.push({ resource, action, reason: 'Already granted' });
          }
          continue;
        }

        // Create new grant
        const grant = await PermissionGrant.create({
          userId,
          resourceType: resource,
          action,
          permissionLevel: null,
          scope: scope || 'global',
          isOverride: true,
          grantedBy: req.user.id,
          expiresAt: expiresAt || null,
          reason: reason || null,
        }, { transaction: t });

        created.push({ resource, action, id: grant.id });
      }
    }

    await t.commit();

    // Log activity
    const totalProcessed = created.length + updated.length;
    if (totalProcessed > 0) {
      logActivity({
        action: 'permission_multi_grant',
        description: `${req.user.name} granted ${totalProcessed} permission(s) to ${targetUser.name} (${created.length} new, ${updated.length} updated, ${skipped.length} skipped)`,
        entityType: 'permission',
        entityId: null,
        userId: req.user.id,
        meta: {
          targetUserId: userId,
          targetUserName: targetUser.name,
          resources: resourceList,
          actions: actionList,
          created: created.length,
          updated: updated.length,
          skipped: skipped.length,
        },
      });
    }

    res.status(created.length > 0 ? 201 : 200).json({
      success: true,
      data: {
        created,
        updated,
        skipped,
        errors,
        summary: {
          total: resourceList.length * actionList.length,
          created: created.length,
          updated: updated.length,
          skipped: skipped.length,
          errors: errors.length,
        },
      },
    });
  } catch (err) {
    await t.rollback();
    console.error('[Permission] multiGrant error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to process multi-grant.' });
  }
};

// DELETE /api/permissions/:id — revoke permission
exports.revokePermission = async (req, res) => {
  try {
    const grant = await PermissionGrant.findByPk(req.params.id, {
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'role'] }],
    });
    if (!grant) return res.status(404).json({ success: false, message: 'Permission not found.' });

    await grant.update({
      isActive: false,
      revokedAt: new Date(),
      revokedBy: req.user.id,
    });

    logActivity({
      action: 'permission_revoked',
      description: `${req.user.name} revoked '${grant.action || grant.permissionLevel}' on '${grant.resourceType}' from ${grant.user?.name || 'user'}`,
      entityType: 'permission',
      entityId: grant.id,
      userId: req.user.id,
      meta: { targetUserId: grant.userId, resourceType: grant.resourceType, action: grant.action },
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
      attributes: ['id', 'resourceType', 'resourceId', 'action', 'permissionLevel', 'scope', 'expiresAt'],
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
    const targetUser = await User.findByPk(req.params.userId);
    if (!targetUser) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const result = await computeEffectivePermissions(targetUser);

    // Also include legacy format for backward compat
    const { resourceType, resourceId } = req.query;
    let legacyEffective = null;
    if (resourceType) {
      legacyEffective = await getEffectivePermissions(req.params.userId, resourceType, resourceId);
    }

    res.json({
      success: true,
      data: {
        effective: {
          permissions: result.permissions,
          basePermissions: result.basePermissions,
          overrides: result.overrides,
          grants: result.grants,
          role: result.role,
          isSuperAdmin: result.isSuperAdmin,
          // Legacy fields
          ...(legacyEffective ? {
            level: legacyEffective.level,
            roleDefault: legacyEffective.roleDefault,
          } : {}),
        },
      },
    });
  } catch (err) {
    console.error('[Permission] getEffective error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to get effective permissions.' });
  }
};

// GET /api/permissions/metadata — get permission structure for UI
exports.getMetadata = async (_req, res) => {
  try {
    const metadata = getPermissionMetadata();
    res.json({ success: true, data: { metadata } });
  } catch (err) {
    console.error('[Permission] getMetadata error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to get permission metadata.' });
  }
};

// GET /api/permissions/base-permissions/:role — get base permissions for a role
exports.getBasePermissionsForRole = async (req, res) => {
  try {
    const { role } = req.params;
    const validRoles = ['admin', 'manager', 'assistant_manager', 'member'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ success: false, message: `Invalid role: ${role}` });
    }
    const base = getBasePermissions(role);
    res.json({ success: true, data: { role, permissions: base } });
  } catch (err) {
    console.error('[Permission] getBasePermissions error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to get base permissions.' });
  }
};

// GET /api/permissions/history/:userId — permission audit history for a user
exports.getPermissionHistory = async (req, res) => {
  try {
    const grants = await PermissionGrant.findAll({
      where: { userId: req.params.userId },
      include: [
        { model: User, as: 'granter', attributes: ['id', 'name', 'email'] },
      ],
      order: [['createdAt', 'DESC']],
      limit: 100,
    });

    res.json({
      success: true,
      data: {
        history: grants.map(g => ({
          id: g.id,
          resourceType: g.resourceType,
          action: g.action,
          permissionLevel: g.permissionLevel,
          scope: g.scope,
          isActive: g.isActive,
          grantedBy: g.granter?.name,
          grantedAt: g.createdAt,
          expiresAt: g.expiresAt,
          revokedAt: g.revokedAt,
          reason: g.reason,
          notes: g.notes,
        })),
      },
    });
  } catch (err) {
    console.error('[Permission] getHistory error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to get permission history.' });
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
