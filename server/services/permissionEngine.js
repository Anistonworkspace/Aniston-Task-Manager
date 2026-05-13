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
  getGrantability,
  isGrantableByTier,
  isDeniableByTier,
  getPermissionCatalog,
  getActionMeta,
  isActionSavable,
  getActionSavabilityStatus,
  getUmbrellaFallback,
} = require('../config/permissionMatrix');
const { resolveTier, isValidTier, TIER_1, TIER_2 } = require('../config/tiers');

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

  // Build a map of which granular actions inherit from which umbrellas, so
  // an override on `tasks.assign` (umbrella) propagates to `tasks.assign_self`
  // (granular) in the effective map. The frontend preview uses `effective`
  // directly so this propagation is what makes the deny-via-umbrella case
  // visible in the per-resource matrix.
  const umbrellaChildren = {}; // 'resource.action' (umbrella) → ['resource.action' children]
  for (const [resource, actions] of Object.entries(RESOURCE_ACTIONS)) {
    for (const action of actions) {
      const key = `${resource}.${action}`;
      const umb = getUmbrellaFallback(resource, action);
      if (!umb) continue;
      const umbKey = `${umb.resource}.${umb.action}`;
      if (!umbrellaChildren[umbKey]) umbrellaChildren[umbKey] = [];
      umbrellaChildren[umbKey].push(key);
    }
  }

  // Pass 1: apply grants (lower precedence, applied first).
  for (const row of rows) {
    if (normalizeEffect(row.effect) !== 'grant') continue;
    const keys = expandGrantToKeys(row);
    for (const key of keys) {
      if (!basePerms[key]) {
        overrides.push(serializeOverride(row, key));
      }
      effective[key] = true;
      // Propagate to granular children that have no specific row of their own.
      for (const child of (umbrellaChildren[key] || [])) {
        // Don't clobber a child that has its own grant/deny row — that's
        // a Pass-1 or Pass-2 concern handled separately by its own iteration.
        const hasSpecific = rows.some((r) => r.resourceType === child.split('.')[0]
          && r.action === child.split('.')[1]);
        if (!hasSpecific) effective[child] = true;
      }
    }
  }

  // Pass 2: apply denies last so they override both base and grant.
  for (const row of rows) {
    if (normalizeEffect(row.effect) !== 'deny') continue;
    const keys = expandGrantToKeys(row);
    for (const key of keys) {
      denials.push(serializeOverride(row, key));
      effective[key] = false;
      // Propagate deny to granular children that have no specific row.
      for (const child of (umbrellaChildren[key] || [])) {
        const hasSpecific = rows.some((r) => r.resourceType === child.split('.')[0]
          && r.action === child.split('.')[1]);
        if (!hasSpecific) effective[child] = false;
      }
    }
  }

  // Locked actions are forced false in the effective map regardless of
  // overrides — defense in depth for the preview UI.
  for (const [resource, actions] of Object.entries(RESOURCE_ACTIONS)) {
    for (const action of actions) {
      if (getActionMeta(resource, action).enforcement === 'locked') {
        effective[`${resource}.${action}`] = false;
      }
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
 * Check if a user has a specific permission. Honors deny precedence + umbrella fallback.
 *
 * Phase 7 precedence (highest → lowest):
 *   1. Super admin            → always true
 *   2. SPECIFIC action deny   → false
 *   3. SPECIFIC action grant  → true
 *   4. UMBRELLA action deny   → false   (umbrella mapped via UMBRELLA_FALLBACKS)
 *   5. UMBRELLA action grant  → true
 *   6. SPECIFIC tier base     → true
 *   7. UMBRELLA tier base     → true    (synthesised by isTierBasePermission already)
 *   8. otherwise              → false
 *
 * Locked actions (ACTION_META.enforcement === 'locked') ALWAYS return false
 * regardless of overrides — these are system rules (e.g. approvals.approve_own)
 * and can never be granted via overrides. The savability check at the controller
 * layer also rejects attempts to write rows for them, but this is the read-side
 * defense in depth.
 *
 * @param {Object} user - User with .role, .isSuperAdmin, .id
 * @param {string} resource
 * @param {string} action
 * @param {string} [resourceId] - if provided, only same-id and global rows match
 * @returns {Promise<boolean>}
 */
async function hasPermission(user, resource, action, resourceId) {
  if (!user) return false;

  // Locked actions can NEVER be allowed via the permission engine — they
  // represent system rules (e.g. approvals.approve_own self-approval block).
  // This returns false for EVERYONE including super admin; the actual
  // controller-level enforcement (e.g. approver.id !== requester.id) is
  // an independent layer. Locked here means "no override can ever cause
  // this to be true via the engine".
  const meta = getActionMeta(resource, action);
  if (meta.enforcement === 'locked') return false;

  if (user.isSuperAdmin) return true;

  const rows = await fetchActiveGrants(user.id);

  const matchesRow = (row, res, act) => {
    if (row.resourceType !== res) return false;
    if (resourceId && row.resourceId && row.resourceId !== resourceId) return false;
    if (row.action) return row.action === act;
    if (row.permissionLevel) {
      return mapLegacyLevelToActions(res, row.permissionLevel).includes(act);
    }
    return false;
  };

  // ─── Level 1: SPECIFIC action override ──────────────────────────────
  if (rows.some((r) => normalizeEffect(r.effect) === 'deny' && matchesRow(r, resource, action))) {
    return false;
  }
  if (rows.some((r) => normalizeEffect(r.effect) === 'grant' && matchesRow(r, resource, action))) {
    return true;
  }

  // ─── Level 2: UMBRELLA action override (Phase 7 non-breaking) ───────
  // If the granular action has no specific override, fall back to the
  // umbrella so existing deny/grant rows on `tasks.assign` / `tasks.edit` /
  // `task_comments.delete` etc. still apply to the new finer-grained actions.
  const umbrella = getUmbrellaFallback(resource, action);
  if (umbrella) {
    if (rows.some((r) => normalizeEffect(r.effect) === 'deny' && matchesRow(r, umbrella.resource, umbrella.action))) {
      return false;
    }
    if (rows.some((r) => normalizeEffect(r.effect) === 'grant' && matchesRow(r, umbrella.resource, umbrella.action))) {
      return true;
    }
  }

  // ─── Level 3: SPECIFIC tier base default ────────────────────────────
  // getEffectiveBasePermission already performs umbrella synthesis via
  // isTierBasePermission, so this single call covers both specific and
  // umbrella base lookups.
  if (getEffectiveBasePermission(user, resource, action)) return true;

  return false;
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
 *
 * Rules (Phase 6 — canonical):
 *   1. Self-grant is BLOCKED unconditionally. A user cannot raise their
 *      own privileges by writing a row against themselves. Self-deny is
 *      still allowed (voluntary restriction).
 *   2. T3 / T4 cannot author overrides at all.
 *   3. The GRANTABILITY catalog (permissionMatrix.js) names the tiers
 *      authorised per (resource, action). The granter must appear in
 *      that list for `effect` to be allowed.
 *   4. T1 can grant/deny anything in the catalog. Unknown (resource,
 *      action) pairs fall back to NON_GRANTABLE which only allows T1
 *      DENY, so unknown pairs default-closed.
 *   5. Target users may pass through this layer even if the catalog
 *      hasn't been updated — callers MUST validate resource/action
 *      against RESOURCES + RESOURCE_ACTIONS first (see permissionController
 *      multiGrant which already does this).
 *
 * `targetUserId` is optional but should be passed for the self-grant
 * block to engage. Legacy callers that omit it will not get the
 * self-grant protection; pass `targetUserId` going forward.
 */
async function canGrantPermission(granter, resource, action, effect = 'grant', targetUserId = null) {
  const normEffect = normalizeEffect(effect);

  if (!granter) {
    return { allowed: false, reason: 'Not authenticated.', code: 'UNAUTH' };
  }

  // (0) Savability gate — Phase 7. Pending / locked / no_surface actions are
  // NEVER savable, period. This runs before every other check so the caller
  // gets a clear machine-readable code instead of a generic authority error.
  const savability = getActionSavabilityStatus(resource, action);
  if (savability === 'locked') {
    return {
      allowed: false,
      code: 'PERMISSION_LOCKED',
      reason: `'${resource}.${action}' is a locked system rule and cannot be granted or denied via overrides.`,
    };
  }
  if (savability === 'pending') {
    return {
      allowed: false,
      code: 'PERMISSION_NOT_ENFORCEABLE',
      reason: `'${resource}.${action}' is not yet wired in the backend — granting or denying it would have no effect. Mark it as pending in the catalog.`,
    };
  }
  if (savability === 'no_surface') {
    return {
      allowed: false,
      code: 'PERMISSION_NOT_ENFORCEABLE',
      reason: `'${resource}.${action}' has no in-app surface to gate — it cannot be granted or denied.`,
    };
  }
  if (savability === 'unknown') {
    return {
      allowed: false,
      code: 'PERMISSION_UNKNOWN',
      reason: `Unknown (resource, action) pair: '${resource}.${action}'.`,
    };
  }

  // (1) Self-grant block — cannot elevate your own privileges. Self-deny
  // is allowed as a voluntary restriction (harmless).
  if (
    normEffect === 'grant'
    && targetUserId
    && String(targetUserId) === String(granter.id)
  ) {
    return {
      allowed: false,
      code: 'SELF_GRANT_BLOCKED',
      reason: 'You cannot grant a permission to yourself.',
    };
  }

  // Super admin / Tier 1 path — always allowed for catalog-known pairs.
  if (granter.isSuperAdmin) return { allowed: true };

  const granterTier = resolveTier(granter);

  // (2) Tier 3 / Tier 4 cannot author overrides at all.
  if (granterTier !== TIER_1 && granterTier !== TIER_2) {
    return { allowed: false, reason: 'Your tier does not allow issuing permission overrides.' };
  }

  // (3) Catalog authority check.
  const grantability = getGrantability(resource, action);
  if (normEffect === 'deny') {
    if (!isDeniableByTier(resource, action, granterTier)) {
      return {
        allowed: false,
        reason: `Tier ${granterTier} cannot DENY '${action}' on '${resource}'. This action is reserved.`,
      };
    }
  } else {
    if (!isGrantableByTier(resource, action, granterTier)) {
      // Distinguish "destructive — never grantable" from "T1-only".
      const isNeverGrantable = !grantability.grantableBy || grantability.grantableBy.length === 0;
      const reason = isNeverGrantable
        ? `'${action}' on '${resource}' cannot be granted via override. Promote the user's tier instead, or this action is destructive and locked.`
        : `Tier ${granterTier} cannot GRANT '${action}' on '${resource}'. Tier 1 only.`;
      return { allowed: false, reason };
    }
  }

  // (4) Tier 2 additionally cannot grant a permission they do not
  // themselves currently hold. Tier 1 has every permission via the
  // isSuperAdmin bypass above so this only applies to T2.
  if (granterTier === TIER_2) {
    const granterHas = getEffectiveBasePermission(granter, resource, action);
    if (!granterHas) {
      const fallbackHas = await hasPermission(granter, resource, action);
      if (!fallbackHas) {
        return {
          allowed: false,
          reason: 'You cannot grant permissions you do not have.',
        };
      }
    }
  }

  return { allowed: true };
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
  getPermissionCatalog,
  mapLegacyLevelToActions,
  // Phase 5b helpers — tier-aware base lookup (single source of truth for
  // the engine's matrix decision). Exposed so middleware (auth.js
  // requireRole Layer 3) can use the same semantics without duplicating it.
  getEffectiveBasePermission,
  getEffectiveBasePermissions,
  // Phase 6 grantability helpers
  getGrantability,
  isGrantableByTier,
  isDeniableByTier,
  VALID_EFFECTS,
};
