/**
 * Permission Engine — Central resolver for effective permissions.
 *
 * Computes: FINAL ACCESS = BASE ROLE PERMISSIONS + EXTRA GRANTED OVERRIDES
 *
 * This is the SINGLE source of truth for permission resolution.
 * Used by backend middleware, API endpoints, and the /auth/me/permissions route.
 */

const { Op } = require('sequelize');
const {
  ROLE_PERMISSIONS,
  RESOURCES,
  RESOURCE_ACTIONS,
  getBasePermissions,
  isBasePermission,
  getActionsForResource,
  getResourcesByCategory,
} = require('../config/permissionMatrix');

/**
 * Fetch all active, non-expired permission grants for a user.
 * Returns empty array if the table schema is out of sync (graceful degradation).
 */
async function fetchActiveGrants(userId) {
  try {
    const { PermissionGrant } = require('../models');
    return await PermissionGrant.findAll({
      where: {
        userId,
        isActive: true,
        [Op.or]: [
          { expiresAt: null },
          { expiresAt: { [Op.gt]: new Date() } },
        ],
      },
      raw: true,
    });
  } catch (err) {
    console.error('[PermissionEngine] fetchActiveGrants error (returning empty):', err.message);
    return [];
  }
}

/**
 * Compute the full effective permissions for a user.
 *
 * Returns a flat object: { "resource.action": true/false, ... }
 * along with metadata about which are base vs override.
 *
 * @param {Object} user - User object with .role, .isSuperAdmin, .id
 * @returns {Object} { permissions, grants, overrides, role, isSuperAdmin }
 */
async function computeEffectivePermissions(user) {
  const role = user.role || 'member';
  const isSuperAdmin = !!user.isSuperAdmin;

  // Step 1: Get base permissions from role
  const basePerms = getBasePermissions(role);

  // Step 2: Super admin gets everything
  if (isSuperAdmin) {
    const allPerms = {};
    for (const [resource, actions] of Object.entries(RESOURCE_ACTIONS)) {
      for (const action of actions) {
        allPerms[`${resource}.${action}`] = true;
      }
    }
    return {
      permissions: allPerms,
      grants: [],
      overrides: [],
      basePermissions: allPerms,
      role,
      isSuperAdmin: true,
    };
  }

  // Step 3: Fetch active grants
  const grants = await fetchActiveGrants(user.id);

  // Step 4: Build effective permissions = base + overrides
  const effective = { ...basePerms };
  const overrides = [];

  for (const grant of grants) {
    // New action-based grants
    if (grant.action && grant.resourceType) {
      const key = `${grant.resourceType}.${grant.action}`;
      // Only count as override if not already a base permission
      if (!basePerms[key]) {
        overrides.push({
          id: grant.id,
          resource: grant.resourceType,
          action: grant.action,
          scope: grant.scope,
          resourceId: grant.resourceId,
          expiresAt: grant.expiresAt,
          isTemporary: !!grant.expiresAt,
          grantedBy: grant.grantedBy,
          reason: grant.reason,
        });
      }
      effective[key] = true;
    }

    // Legacy permissionLevel-based grants (backward compatibility)
    if (grant.permissionLevel && !grant.action) {
      const legacyActions = mapLegacyLevelToActions(grant.resourceType, grant.permissionLevel);
      for (const action of legacyActions) {
        const key = `${grant.resourceType}.${action}`;
        if (!basePerms[key]) {
          overrides.push({
            id: grant.id,
            resource: grant.resourceType,
            action,
            scope: grant.scope || 'global',
            resourceId: grant.resourceId,
            expiresAt: grant.expiresAt,
            isTemporary: !!grant.expiresAt,
            grantedBy: grant.grantedBy,
            reason: grant.reason,
          });
        }
        effective[key] = true;
      }
    }
  }

  return {
    permissions: effective,
    grants: grants.map(g => ({
      id: g.id,
      resourceType: g.resourceType,
      action: g.action,
      permissionLevel: g.permissionLevel,
      resourceId: g.resourceId,
      scope: g.scope,
      expiresAt: g.expiresAt,
      isTemporary: !!g.expiresAt,
    })),
    overrides,
    basePermissions: basePerms,
    role,
    isSuperAdmin: false,
  };
}

/**
 * Check if a user has a specific permission.
 * This is the core check used by middleware.
 *
 * @param {Object} user - User object
 * @param {string} resource - Resource key (e.g. 'boards', 'tasks')
 * @param {string} action - Action key (e.g. 'view', 'create', 'edit')
 * @param {string} [resourceId] - Optional specific resource ID
 * @returns {Promise<boolean>}
 */
async function hasPermission(user, resource, action, resourceId) {
  if (!user) return false;

  // Super admin always has access
  if (user.isSuperAdmin) return true;

  // Check base role permission
  if (isBasePermission(user.role, resource, action)) return true;

  // Check explicit grants
  const grants = await fetchActiveGrants(user.id);

  return grants.some(g => {
    // New action-based check
    if (g.resourceType === resource && g.action === action) {
      // If resourceId is specified, check scope
      if (resourceId && g.resourceId && g.resourceId !== resourceId) return false;
      return true;
    }
    // Legacy level-based check
    if (g.resourceType === resource && g.permissionLevel && !g.action) {
      const legacyActions = mapLegacyLevelToActions(resource, g.permissionLevel);
      if (legacyActions.includes(action)) {
        if (resourceId && g.resourceId && g.resourceId !== resourceId) return false;
        return true;
      }
    }
    return false;
  });
}

/**
 * Map legacy permission levels to new action names for backward compatibility.
 */
function mapLegacyLevelToActions(resourceType, level) {
  const LEGACY_MAP = {
    workspace: {
      view: ['view'],
      edit: ['view', 'edit'],
      assign: ['view', 'edit', 'manage_members'],
      manage: ['view', 'create', 'edit', 'delete', 'manage_members'],
      admin: ['view', 'create', 'edit', 'delete', 'manage_members', 'manage_settings'],
    },
    board: {
      view: ['view'],
      edit: ['view', 'edit'],
      assign: ['view', 'edit', 'manage_members'],
      manage: ['view', 'create', 'edit', 'delete', 'manage_members', 'export'],
      admin: ['view', 'create', 'edit', 'delete', 'manage_members', 'manage_settings', 'export'],
    },
    team: {
      view: ['view'],
      edit: ['view', 'edit'],
      manage: ['view', 'create', 'edit', 'manage'],
      admin: ['view', 'create', 'edit', 'delete', 'manage'],
    },
    dashboard: {
      view: ['view'],
      edit: ['view', 'export'],
      manage: ['view', 'export'],
      admin: ['view', 'export'],
    },
    task: {
      view: ['view'],
      edit: ['view', 'edit', 'change_status', 'comment'],
      assign: ['view', 'edit', 'assign', 'change_status', 'comment'],
      manage: ['view', 'create', 'edit', 'delete', 'assign', 'change_status', 'comment', 'upload'],
      admin: ['view', 'create', 'edit', 'delete', 'assign', 'change_status', 'comment', 'upload', 'approve'],
    },
  };

  return LEGACY_MAP[resourceType]?.[level] || ['view'];
}

/**
 * Validate if a granter can grant a specific permission.
 * Prevents privilege escalation.
 *
 * @param {Object} granter - The user granting the permission
 * @param {string} resource - Target resource
 * @param {string} action - Target action
 * @returns {{ allowed: boolean, reason?: string }}
 */
async function canGrantPermission(granter, resource, action) {
  // Super admin can grant anything
  if (granter.isSuperAdmin) return { allowed: true };

  // Admin can grant anything except roles/admin_settings management
  if (granter.role === 'admin') {
    // Admin cannot grant super admin level permissions
    if (resource === 'roles' && action === 'manage') {
      return { allowed: false, reason: 'Only super admin can grant role management permissions.' };
    }
    return { allowed: true };
  }

  // Manager can only grant permissions they themselves have
  if (granter.role === 'manager') {
    const granterHas = isBasePermission('manager', resource, action);
    if (!granterHas) {
      // Check if manager has it via their own grants
      const has = await hasPermission(granter, resource, action);
      if (!has) {
        return { allowed: false, reason: 'You cannot grant permissions you do not have.' };
      }
    }
    // Managers cannot grant admin-level or role management permissions
    if (resource === 'admin_settings' || resource === 'roles' || resource === 'api_keys') {
      return { allowed: false, reason: 'Managers cannot grant administrative permissions.' };
    }
    return { allowed: true };
  }

  // Other roles cannot grant permissions
  return { allowed: false, reason: 'Your role does not allow granting permissions.' };
}

/**
 * Get permission metadata for the UI.
 */
function getPermissionMetadata() {
  return {
    resources: RESOURCES,
    resourceActions: RESOURCE_ACTIONS,
    resourcesByCategory: getResourcesByCategory(),
  };
}

module.exports = {
  computeEffectivePermissions,
  hasPermission,
  canGrantPermission,
  fetchActiveGrants,
  getPermissionMetadata,
  mapLegacyLevelToActions,
};
