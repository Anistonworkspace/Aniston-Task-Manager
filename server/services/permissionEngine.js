/**
 * Permission Engine — Central resolver for effective permissions.
 *
 * Precedence (highest -> lowest):
 *   1. Super admin / protected root admin -> always allowed (deny rows on super
 *      admins are ignored as a safety rail).
 *   2. Explicit DENY override (effect='deny') for matching resource+action.
 *   3. Explicit GRANT override (effect='grant') for matching resource+action.
 *   4. Base role permission from permissionMatrix.ROLE_PERMISSIONS.
 *
 * This module is the SINGLE source of truth for permission resolution. It is
 * used by middleware, the /auth/me/permissions endpoint, the task controller,
 * and the admin "Effective Permissions Preview" feature.
 *
 * Backwards compatibility: legacy rows that only have `permissionLevel` (no
 * `action`) are still supported via `mapLegacyLevelToActions`. Existing rows
 * are treated as effect='grant' (the column default).
 */

const { Op } = require('sequelize');
const {
  ROLE_PERMISSIONS,
  RESOURCES,
  RESOURCE_ACTIONS,
  getBasePermissions,
  isBasePermission,
  getTierPermissions,
  isTierBasePermission,
  getResourcesByCategory,
} = require('../config/permissionMatrix');
const { resolveTier, isValidTier } = require('../config/tiers');

const VALID_EFFECTS = ['grant', 'deny'];

/**
 * Resolve a user's BASE matrix lookup (Phase 5b of role -> tier migration).
 *
 * Prefers the tier-keyed matrix when the user has a valid `tier` column
 * (post migration 014 + Phase 3 hook); falls back to the legacy role-keyed
 * matrix for users that haven't been migrated yet so an environment without
 * migration 014 applied keeps working.
 *
 * `resolveTier` itself derives a tier even from purely legacy fields, so
 * this function is the SINGLE place where the engine decides whether to
 * authoritatively use the tier matrix or hedge with the role matrix.
 */
function getEffectiveBasePermission(user, resource, action) {
  if (!user) return false;
  if (isValidTier(user.tier)) {
    return isTierBasePermission(user.tier, resource, action);
  }
  // Legacy path — only fires for pre-migration users. After migration 014
  // + the User-model beforeSave hook (Phase 3), every user has a valid tier
  // column and this branch is unreachable.
  return isBasePermission(user.role, resource, action);
}

/**
 * Flat-form variant for computeEffectivePermissions seeding.
 * Same precedence as getEffectiveBasePermission.
 */
function getEffectiveBasePermissions(user) {
  if (user && isValidTier(user.tier)) {
    return getTierPermissions(user.tier);
  }
  return getBasePermissions(user?.role);
}

/**
 * Fetch all active, non-expired permission grants for a user. Includes both
 * grant and deny rows. Returns [] on schema errors so the app keeps working.
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
 * Expand a single row into the list of permission keys it touches.
 * Handles both new action-based rows and legacy permissionLevel rows.
 *
 * @returns {string[]} list of "resource.action" keys
 */
function expandGrantToKeys(grant) {
  const keys = [];
  if (!grant.resourceType) return keys;

  if (grant.action) {
    keys.push(`${grant.resourceType}.${grant.action}`);
  } else if (grant.permissionLevel) {
    const actions = mapLegacyLevelToActions(grant.resourceType, grant.permissionLevel);
    for (const action of actions) {
      keys.push(`${grant.resourceType}.${action}`);
    }
  }
  return keys;
}

function normalizeEffect(effect) {
  return VALID_EFFECTS.includes(effect) ? effect : 'grant';
}

/**
 * Compute the full effective permissions for a user.
 *
 * Returns:
 *   {
 *     permissions:       { "resource.action": true|false, ... },  // final
 *     basePermissions:   { ... },                                  // role only
 *     overrides:         [ ... ],                                  // grant rows that added perms
 *     denials:           [ ... ],                                  // deny rows that removed perms
 *     grants:            [ ... ],                                  // raw rows for UI
 *     role, isSuperAdmin
 *   }
 */
async function computeEffectivePermissions(user) {
  const role = user.role || 'member';
  const isSuperAdmin = !!user.isSuperAdmin;
  const tier = resolveTier(user);

  // Tier-aware base lookup (Phase 5b). Users with a valid tier column use
  // the tier matrix; pre-migration users fall back to the role matrix.
  const basePerms = getEffectiveBasePermissions(user);

  if (isSuperAdmin) {
    const allPerms = {};
    for (const [resource, actions] of Object.entries(RESOURCE_ACTIONS)) {
      for (const action of actions) {
        allPerms[`${resource}.${action}`] = true;
      }
    }
    return {
      permissions: allPerms,
      basePermissions: allPerms,
      overrides: [],
      denials: [],
      grants: [],
      role,
      tier,
      isSuperAdmin: true,
    };
  }

  const rows = await fetchActiveGrants(user.id);
  const effective = { ...basePerms };
  const overrides = [];
  const denials = [];

  // Pass 1: apply grants (lower precedence, applied first).
  for (const row of rows) {
    if (normalizeEffect(row.effect) !== 'grant') continue;
    const keys = expandGrantToKeys(row);
    for (const key of keys) {
      if (!basePerms[key]) {
        overrides.push(serializeOverride(row, key));
      }
      effective[key] = true;
    }
  }

  // Pass 2: apply denies last so they override both base and grant.
  for (const row of rows) {
    if (normalizeEffect(row.effect) !== 'deny') continue;
    const keys = expandGrantToKeys(row);
    for (const key of keys) {
      denials.push(serializeOverride(row, key));
      effective[key] = false;
    }
  }

  return {
    permissions: effective,
    basePermissions: basePerms,
    overrides,
    denials,
    grants: rows.map((g) => ({
      id: g.id,
      resourceType: g.resourceType,
      action: g.action,
      permissionLevel: g.permissionLevel,
      resourceId: g.resourceId,
      scope: g.scope,
      effect: normalizeEffect(g.effect),
      expiresAt: g.expiresAt,
      isTemporary: !!g.expiresAt,
    })),
    role,
    tier,
    isSuperAdmin: false,
  };
}

function serializeOverride(row, key) {
  const [resource, action] = key.split('.');
  return {
    id: row.id,
    resource,
    action,
    scope: row.scope || 'global',
    resourceId: row.resourceId,
    effect: normalizeEffect(row.effect),
    expiresAt: row.expiresAt,
    isTemporary: !!row.expiresAt,
    grantedBy: row.grantedBy,
    reason: row.reason,
  };
}

/**
 * Check if a user has a specific permission. Honors deny precedence.
 *
 * @param {Object} user - User with .role, .isSuperAdmin, .id
 * @param {string} resource
 * @param {string} action
 * @param {string} [resourceId] - if provided, only same-id and global rows match
 * @returns {Promise<boolean>}
 */
async function hasPermission(user, resource, action, resourceId) {
  if (!user) return false;
  if (user.isSuperAdmin) return true;

  const rows = await fetchActiveGrants(user.id);

  const matchesRow = (row) => {
    if (row.resourceType !== resource) return false;
    if (resourceId && row.resourceId && row.resourceId !== resourceId) return false;
    if (row.action) return row.action === action;
    if (row.permissionLevel) {
      return mapLegacyLevelToActions(resource, row.permissionLevel).includes(action);
    }
    return false;
  };

  // Deny wins.
  if (rows.some((r) => normalizeEffect(r.effect) === 'deny' && matchesRow(r))) {
    return false;
  }

  // Tier-aware base lookup (Phase 5b). Users with a valid tier column use
  // the tier matrix; pre-migration users fall back to the role matrix.
  if (getEffectiveBasePermission(user, resource, action)) return true;

  return rows.some((r) => normalizeEffect(r.effect) === 'grant' && matchesRow(r));
}

/**
 * Map legacy permission levels to action names for backward compat.
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
      assign: ['view', 'edit', 'assign', 'assign_others', 'change_status', 'comment'],
      manage: ['view', 'create', 'edit', 'delete', 'assign', 'assign_others', 'change_status', 'comment', 'upload'],
      admin: ['view', 'create', 'edit', 'delete', 'assign', 'assign_others', 'change_status', 'comment', 'upload', 'approve'],
    },
    feedback: {
      view: ['view'],
      edit: ['view', 'manage'],
      manage: ['view', 'manage'],
      admin: ['view', 'create', 'manage'],
    },
  };

  return LEGACY_MAP[resourceType]?.[level] || ['view'];
}

/**
 * Validate if a granter can grant or deny a specific permission.
 * Prevents privilege escalation and locks down deny authority to admin/super.
 */
async function canGrantPermission(granter, resource, action, effect = 'grant') {
  const normEffect = normalizeEffect(effect);

  if (granter.isSuperAdmin) return { allowed: true };

  // Only admin (and super admin) can issue deny overrides.
  if (normEffect === 'deny' && granter.role !== 'admin') {
    return { allowed: false, reason: 'Only admin or super admin can issue deny overrides.' };
  }

  if (granter.role === 'admin') {
    if (resource === 'roles' && action === 'manage') {
      return { allowed: false, reason: 'Only super admin can grant role management permissions.' };
    }
    return { allowed: true };
  }

  if (granter.role === 'manager') {
    // Tier-aware base lookup so a granter with a populated tier column is
    // checked against the new matrix; otherwise legacy behavior is preserved.
    const granterHas = getEffectiveBasePermission(granter, resource, action);
    if (!granterHas) {
      const has = await hasPermission(granter, resource, action);
      if (!has) {
        return { allowed: false, reason: 'You cannot grant permissions you do not have.' };
      }
    }
    if (resource === 'admin_settings' || resource === 'roles' || resource === 'api_keys') {
      return { allowed: false, reason: 'Managers cannot grant administrative permissions.' };
    }
    return { allowed: true };
  }

  return { allowed: false, reason: 'Your role does not allow granting permissions.' };
}

function getPermissionMetadata() {
  return {
    resources: RESOURCES,
    resourceActions: RESOURCE_ACTIONS,
    resourcesByCategory: getResourcesByCategory(),
    effects: VALID_EFFECTS,
  };
}

module.exports = {
  computeEffectivePermissions,
  hasPermission,
  canGrantPermission,
  fetchActiveGrants,
  getPermissionMetadata,
  mapLegacyLevelToActions,
  // Phase 5b helpers — tier-aware base lookup (single source of truth for
  // the engine's matrix decision). Exposed so middleware (auth.js
  // requireRole Layer 3) can use the same semantics without duplicating it.
  getEffectiveBasePermission,
  getEffectiveBasePermissions,
  VALID_EFFECTS,
};
