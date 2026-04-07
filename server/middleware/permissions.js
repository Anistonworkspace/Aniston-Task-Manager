const { PermissionGrant } = require('../models');
const { Op } = require('sequelize');

/**
 * Check if a user has a specific permission on a resource.
 * Falls back to role-based checks: admin always passes, manager passes for manage/edit/view.
 *
 * @param {string} resourceType - 'workspace' | 'board' | 'team' | 'dashboard'
 * @param {string} requiredLevel - 'view' | 'edit' | 'assign' | 'manage' | 'admin'
 * @returns {Function} Express middleware
 */
function hasPermission(resourceType, requiredLevel = 'view') {
  const levelHierarchy = ['view', 'edit', 'assign', 'manage', 'admin'];

  return async (req, res, next) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json({ success: false, message: 'Not authenticated.' });
      }

      // Admin always has full access
      if (user.role === 'admin') return next();

      // Manager has manage-level by default for their resources
      if (user.role === 'manager') {
        const managerDefault = levelHierarchy.indexOf('manage');
        const required = levelHierarchy.indexOf(requiredLevel);
        if (required <= managerDefault) return next();
      }

      // Check explicit permission grants
      const resourceId = req.params.id || req.params.workspaceId || req.body.resourceId || null;

      const where = {
        userId: user.id,
        resourceType,
        isActive: true,
        [Op.or]: [
          { expiresAt: null },
          { expiresAt: { [Op.gt]: new Date() } },
        ],
      };

      if (resourceId) {
        where[Op.and] = [
          { [Op.or]: [{ resourceId }, { resourceId: null }] },
        ];
      }

      const grants = await PermissionGrant.findAll({ where });

      if (grants.length > 0) {
        // Check if any grant meets required level
        const requiredIdx = levelHierarchy.indexOf(requiredLevel);
        const hasAccess = grants.some(g => {
          const grantIdx = levelHierarchy.indexOf(g.permissionLevel);
          return grantIdx >= requiredIdx;
        });

        if (hasAccess) return next();
      }

      return res.status(403).json({
        success: false,
        message: `Access denied. ${requiredLevel} permission required for ${resourceType}.`,
      });
    } catch (error) {
      console.error('[Permission] Check failed:', error.message);
      return res.status(500).json({ success: false, message: 'Permission check failed.' });
    }
  };
}

/**
 * Get effective permissions for a user on a resource
 */
async function getEffectivePermissions(userId, resourceType, resourceId) {
  const { User } = require('../models');
  const user = await User.findByPk(userId);

  const levelHierarchy = ['view', 'edit', 'assign', 'manage', 'admin'];
  let effectiveLevel = null;

  // Role-based defaults
  if (user.role === 'admin') {
    effectiveLevel = 'admin';
  } else if (user.role === 'manager') {
    effectiveLevel = 'manage';
  }

  // Check explicit grants
  const grants = await PermissionGrant.findAll({
    where: {
      userId,
      resourceType,
      isActive: true,
      [Op.or]: [
        { resourceId },
        { resourceId: null },
      ],
      [Op.and]: [
        { [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }] },
      ],
    },
  });

  for (const g of grants) {
    const grantIdx = levelHierarchy.indexOf(g.permissionLevel);
    const currentIdx = effectiveLevel ? levelHierarchy.indexOf(effectiveLevel) : -1;
    if (grantIdx > currentIdx) {
      effectiveLevel = g.permissionLevel;
    }
  }

  return {
    level: effectiveLevel || 'none',
    grants: grants.map(g => ({
      id: g.id,
      level: g.permissionLevel,
      expiresAt: g.expiresAt,
      isTemporary: !!g.expiresAt,
    })),
    roleDefault: user.role === 'admin' ? 'admin' : user.role === 'manager' ? 'manage' : 'view',
  };
}

module.exports = { hasPermission, getEffectivePermissions };
