const { hasPermission: checkPermission, computeEffectivePermissions } = require('../services/permissionEngine');
const { isBasePermission } = require('../config/permissionMatrix');
const { Op } = require('sequelize');

/**
 * Middleware factory: check if the current user has permission for a resource+action.
 *
 * Uses the new action-based permission engine.
 * Falls back to legacy level-based checks for backward compatibility.
 *
 * @param {string} resource - Resource key from permissionMatrix (e.g. 'boards', 'tasks')
 * @param {string} action - Action key (e.g. 'view', 'create', 'edit', 'delete')
 * @returns {Function} Express middleware
 */
function requirePermission(resource, action) {
  return async (req, res, next) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ success: false, message: 'Not authenticated.' });
      }

      // Super admin always passes
      if (user.isSuperAdmin) return next();

      const resourceId = req.params.id || req.params.workspaceId || req.body.resourceId || null;
      const allowed = await checkPermission(user, resource, action, resourceId);

      if (allowed) return next();

      return res.status(403).json({
        success: false,
        message: `Access denied. '${action}' permission required for '${resource}'.`,
      });
    } catch (error) {
      console.error('[Permission] Check failed:', error.message);
      return res.status(500).json({ success: false, message: 'Permission check failed.' });
    }
  };
}

/**
 * Legacy middleware for backward compatibility.
 * Maps old resourceType + requiredLevel to new resource + action system.
 *
 * @param {string} resourceType - 'workspace' | 'board' | 'team' | 'dashboard'
 * @param {string} requiredLevel - 'view' | 'edit' | 'assign' | 'manage' | 'admin'
 * @returns {Function} Express middleware
 */
function hasPermission(resourceType, requiredLevel = 'view') {
  // Map legacy resource types to new ones
  const LEGACY_RESOURCE_MAP = {
    workspace: 'workspaces',
    board: 'boards',
    team: 'users',
    dashboard: 'dashboard',
    task: 'tasks',
  };

  // Map legacy levels to primary actions
  const LEGACY_LEVEL_MAP = {
    view: 'view',
    edit: 'edit',
    assign: 'assign',
    manage: 'manage',
    admin: 'manage_settings',
  };

  const resource = LEGACY_RESOURCE_MAP[resourceType] || resourceType;
  const action = LEGACY_LEVEL_MAP[requiredLevel] || requiredLevel;

  return requirePermission(resource, action);
}

/**
 * Get effective permissions for a user on a resource.
 * Legacy function — now delegates to the permission engine.
 */
async function getEffectivePermissions(userId, resourceType, resourceId) {
  const { User } = require('../models');
  const user = await User.findByPk(userId);
  if (!user) return { level: 'none', grants: [], roleDefault: 'none' };

  const result = await computeEffectivePermissions(user);

  // Convert to legacy format for backward compatibility
  const levelHierarchy = ['view', 'edit', 'assign', 'manage', 'admin'];
  let effectiveLevel = null;

  if (user.role === 'admin' || user.role === 'manager') effectiveLevel = 'admin';
  else effectiveLevel = 'view';

  // Check if any grants elevate the level
  let grants = [];
  try {
    const { PermissionGrant } = require('../models');
    grants = await PermissionGrant.findAll({
      where: {
        userId,
        isActive: true,
        [Op.or]: [
          { expiresAt: null },
          { expiresAt: { [Op.gt]: new Date() } },
        ],
        ...(resourceType ? { resourceType } : {}),
      },
    });
  } catch (err) {
    console.error('[Permission] PermissionGrant query error (continuing with role defaults):', err.message);
  }

  for (const g of grants) {
    if (g.permissionLevel) {
      const grantIdx = levelHierarchy.indexOf(g.permissionLevel);
      const currentIdx = effectiveLevel ? levelHierarchy.indexOf(effectiveLevel) : -1;
      if (grantIdx > currentIdx) {
        effectiveLevel = g.permissionLevel;
      }
    }
  }

  return {
    level: effectiveLevel || 'none',
    grants: grants.map(g => ({
      id: g.id,
      level: g.permissionLevel,
      action: g.action,
      resourceType: g.resourceType,
      expiresAt: g.expiresAt,
      isTemporary: !!g.expiresAt,
    })),
    roleDefault: (user.role === 'admin' || user.role === 'manager') ? 'admin' : 'view',
  };
}

module.exports = { hasPermission, requirePermission, getEffectivePermissions };
