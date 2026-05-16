const { PermissionGrant, User } = require('../models');
const { Op } = require('sequelize');
const { logActivity } = require('../services/activityService');
const { getEffectivePermissions } = require('../middleware/permissions');
const { emitToUser } = require('../services/socketService');
const {
  computeEffectivePermissions,
  canGrantPermission,
  getPermissionMetadata,
  getPermissionCatalog,
  VALID_EFFECTS,
} = require('../services/permissionEngine');
const { resolveTier, TIER_1 } = require('../config/tiers');
const safeLogger = require('../utils/safeLogger');
const { PILL_ATTRIBUTES: USER_PILL_ATTRIBUTES } = require('../config/userAttributes');

// Push a 'permissions:updated' event to a user's personal socket room so
// that a logged-in target re-fetches their effective permissions immediately
// after an admin grants/denies/revokes — eliminating stale UI state without
// requiring a page reload.
//
// Phase 6 — also emits 'user:force_refresh' which the client AuthContext
// listens for and reloads BOTH the user record (role/tier/isSuperAdmin)
// AND the permissions. Permission changes don't usually require a user
// reload, but emitting both keeps the AuthContext path uniform with role
// changes and makes the stale-state guarantee end-to-end: after a grant
// or deny lands, the next render reflects the new permission within ~1
// socket round-trip.
function notifyPermissionChange(userId, payload = {}) {
  if (!userId) return;
  try {
    emitToUser(userId, 'permissions:updated', { reason: 'admin-changed', ...payload });
    emitToUser(userId, 'user:force_refresh', { reason: 'permissions-changed', ...payload });
  } catch (err) {
    safeLogger.error('[Permission] notifyPermissionChange error', { err });
  }
}
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
        { model: User, as: 'user', attributes: [...USER_PILL_ATTRIBUTES] },
        { model: User, as: 'granter', attributes: ['id', 'name', 'email'] },
      ],
      order: [['createdAt', 'DESC']],
    });
    res.json({ success: true, data: { permissions: grants } });
  } catch (err) {
    // safeLogger (imported at top of file) keeps the full Sequelize/PG
    // error (sql, original) in the structured log under err — useful
    // for diagnosing schema drift — while redacting wrapped Axios
    // headers, JWT-shaped tokens, and password fields before disk.
    safeLogger.error('[Permission] getPermissions error', { err });
    res.status(500).json({ success: false, message: 'Failed to fetch permissions.' });
  }
};

// POST /api/permissions — grant or deny a permission (action-based system)
//
// Body:
//   userId        UUID, required
//   resourceType  string from permissionMatrix.RESOURCES, required
//   action        string (preferred) OR permissionLevel (legacy), one required
//   effect        'grant' | 'deny' (default: 'grant')
//   resourceId    UUID, optional — scope to a specific resource
//   scope         'global' | 'workspace' | 'board' (default: 'global')
//   expiresAt     ISO date, optional — temporary grant
//   reason, notes optional metadata
//
// Precedence handled by permissionEngine:
//   deny override > grant override > role default > nothing
exports.grantPermission = async (req, res) => {
  try {
    const {
      userId, resourceType, resourceId, action, permissionLevel,
      effect, expiresAt, reason, notes, scope,
    } = req.body;

    const grantAction = action || permissionLevel;
    const grantEffect = effect || 'grant';

    if (!userId || !resourceType || !grantAction) {
      return res.status(400).json({
        success: false,
        message: 'userId, resourceType, and action (or permissionLevel) are required.',
      });
    }

    if (!VALID_EFFECTS.includes(grantEffect)) {
      return res.status(400).json({
        success: false,
        message: `Invalid effect '${grantEffect}'. Must be one of: ${VALID_EFFECTS.join(', ')}`,
      });
    }

    if (!RESOURCES[resourceType]) {
      return res.status(400).json({
        success: false,
        message: `Invalid resource type: '${resourceType}'. Valid types: ${Object.keys(RESOURCES).join(', ')}`,
      });
    }

    if (action) {
      const validActions = RESOURCE_ACTIONS[resourceType] || [];
      if (!validActions.includes(action)) {
        return res.status(400).json({
          success: false,
          message: `Invalid action '${action}' for resource '${resourceType}'. Valid actions: ${validActions.join(', ')}`,
        });
      }
    }

    const targetUser = await User.findByPk(userId);
    if (!targetUser) {
      return res.status(404).json({ success: false, message: 'Target user not found.' });
    }

    // Safety rail: cannot deny or grant against the super admin. Their
    // privileges are not subject to override rules.
    if (targetUser.isSuperAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Super admin already has full access and cannot be overridden.',
      });
    }

    // For GRANT only: skip if already a base permission. For DENY: allow it
    // — the whole point of deny is to remove a base permission for one user.
    if (grantEffect === 'grant' && action && isBasePermission(targetUser.role, resourceType, action)) {
      return res.status(400).json({
        success: false,
        message: `'${action}' on '${resourceType}' is already included in the '${targetUser.role}' base role. No grant override needed.`,
        isBasePermission: true,
      });
    }

    // Authority check — granter must have the right to issue this effect.
    // Pass targetUserId so the self-grant block in canGrantPermission engages.
    const grantCheck = await canGrantPermission(req.user, resourceType, action || 'manage', grantEffect, userId);
    if (!grantCheck.allowed) {
      // Phase 7 — Savability errors are 400 (client-side validation), authority
      // errors are 403 (the request is structurally valid but the user lacks
      // authority). Always include a stable machine-readable code so the UI
      // can render the right banner.
      const savabilityCodes = ['PERMISSION_LOCKED', 'PERMISSION_NOT_ENFORCEABLE', 'PERMISSION_UNKNOWN'];
      const status = savabilityCodes.includes(grantCheck.code) ? 400 : 403;
      return res.status(status).json({
        success: false,
        code: grantCheck.code || 'PERMISSION_DENIED',
        message: grantCheck.reason || 'You do not have authority to issue this permission override.',
      });
    }

    // Existing override for the same (userId, resourceType, resourceId, action,
    // effect) tuple is updated in place rather than duplicated.
    const existingWhere = {
      userId,
      resourceType,
      resourceId: resourceId || null,
      effect: grantEffect,
      isActive: true,
    };
    if (action) existingWhere.action = action;

    const existing = await PermissionGrant.findOne({ where: existingWhere });

    if (existing) {
      await existing.update({
        expiresAt: expiresAt || null,
        reason: reason || existing.reason,
        notes: notes || existing.notes,
        scope: scope || existing.scope,
      });
      logActivity({
        action: grantEffect === 'deny' ? 'permission_denied_updated' : 'permission_updated',
        description: `${req.user.name} updated ${grantEffect} of '${grantAction}' on '${resourceType}' for ${targetUser.name}`,
        entityType: 'permission',
        entityId: existing.id,
        userId: req.user.id,
        meta: { targetUserId: userId, resourceType, resourceId, action: grantAction, effect: grantEffect },
      });
      notifyPermissionChange(userId, { resourceType, action: grantAction, effect: grantEffect });
      return res.json({ success: true, data: { permission: existing }, updated: true });
    }

    // Phase A — Race-safe insert. If two concurrent requests both pass the
    // existing-row check above, the partial UNIQUE index added in
    // migration 017 makes the second INSERT fail with
    // SequelizeUniqueConstraintError. We catch it, refetch the row that
    // won the race, and update it in place — making the endpoint
    // idempotent on the (userId, resourceType, resourceId, action, effect)
    // tuple regardless of concurrency.
    let grant;
    try {
      grant = await PermissionGrant.create({
        userId,
        resourceType,
        resourceId: resourceId || null,
        action: action || null,
        permissionLevel: action ? null : permissionLevel,
        effect: grantEffect,
        scope: scope || 'global',
        isOverride: true,
        grantedBy: req.user.id,
        expiresAt: expiresAt || null,
        reason: reason || null,
        notes: notes || null,
      });
    } catch (insertErr) {
      if (insertErr?.name === 'SequelizeUniqueConstraintError') {
        const winner = await PermissionGrant.findOne({ where: existingWhere });
        if (winner) {
          await winner.update({
            expiresAt: expiresAt || null,
            reason: reason || winner.reason,
            notes: notes || winner.notes,
            scope: scope || winner.scope,
          });
          logActivity({
            action: grantEffect === 'deny' ? 'permission_denied_updated' : 'permission_updated',
            description: `${req.user.name} updated ${grantEffect} of '${grantAction}' on '${resourceType}' for ${targetUser.name} (race-resolved)`,
            entityType: 'permission',
            entityId: winner.id,
            userId: req.user.id,
            meta: { targetUserId: userId, resourceType, resourceId, action: grantAction, effect: grantEffect, raceResolved: true },
          });
          notifyPermissionChange(userId, { resourceType, action: grantAction, effect: grantEffect });
          return res.json({ success: true, data: { permission: winner }, updated: true });
        }
      }
      throw insertErr;
    }

    logActivity({
      action: grantEffect === 'deny' ? 'permission_denied' : 'permission_granted',
      description: `${req.user.name} ${grantEffect === 'deny' ? 'denied' : 'granted'} '${grantAction}' on '${resourceType}' for ${targetUser.name}`,
      entityType: 'permission',
      entityId: grant.id,
      userId: req.user.id,
      meta: { targetUserId: userId, resourceType, resourceId, action: grantAction, effect: grantEffect, scope: scope || 'global' },
    });
    notifyPermissionChange(userId, { resourceType, action: grantAction, effect: grantEffect });

    res.status(201).json({ success: true, data: { permission: grant } });
  } catch (err) {
    safeLogger.error('[Permission] grantPermission error', { err });
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
    // Notify each affected user once.
    const affectedUserIds = Array.from(new Set(grants.map(g => g.userId).filter(Boolean)));
    affectedUserIds.forEach(uid => notifyPermissionChange(uid, { source: 'bulk' }));

    res.json({ success: true, data: { permissions: results, count: results.length } });
  } catch (err) {
    safeLogger.error('[Permission] bulkGrant error', { err });
    res.status(500).json({ success: false, message: 'Failed to bulk update permissions.' });
  }
};

// POST /api/permissions/multi — multi-resource × multi-action override (grant or deny)
exports.multiGrant = async (req, res) => {
  const { sequelize } = require('../config/db');
  const t = await sequelize.transaction();
  try {
    const { userId, resources, actions, scope, expiresAt, reason, effect } = req.body;
    const grantEffect = effect || 'grant';
    if (!VALID_EFFECTS.includes(grantEffect)) {
      await t.rollback();
      return res.status(400).json({
        success: false,
        message: `Invalid effect '${grantEffect}'. Must be one of: ${VALID_EFFECTS.join(', ')}`,
      });
    }

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

      for (const action of actionList) {
        if (!validActions.includes(action)) {
          skipped.push({ resource, action, reason: `'${action}' is not a valid action for '${resource}'` });
          continue;
        }

        // Per-action authority check. Phase 7 — canGrantPermission also
        // rejects locked/pending/no_surface actions with a structured code
        // before authority gating, so the UI can render a precise banner
        // instead of a generic "denied" message.
        const grantCheck = await canGrantPermission(req.user, resource, action, grantEffect, userId);
        if (!grantCheck.allowed) {
          errors.push({
            resource,
            action,
            code: grantCheck.code || 'PERMISSION_DENIED',
            reason: grantCheck.reason || 'No authority to grant.',
          });
          continue;
        }

        // For GRANT: skip if already a base permission. For DENY: do NOT skip
        // — that's the explicit purpose of a deny override.
        if (grantEffect === 'grant' && isBasePermission(targetUser.role, resource, action)) {
          skipped.push({ resource, action, reason: `Already included in '${targetUser.role}' base role` });
          continue;
        }

        const existing = await PermissionGrant.findOne({
          where: { userId, resourceType: resource, action, effect: grantEffect, isActive: true },
          transaction: t,
        });

        if (existing) {
          if (expiresAt || reason) {
            await existing.update({
              expiresAt: expiresAt || existing.expiresAt,
              reason: reason || existing.reason,
              scope: scope || existing.scope,
            }, { transaction: t });
            updated.push({ resource, action, id: existing.id, effect: grantEffect });
          } else {
            skipped.push({ resource, action, reason: `Already ${grantEffect}ed` });
          }
          continue;
        }

        // Phase A — Race-safe insert. Per-row try/catch handles
        // SequelizeUniqueConstraintError from the partial UNIQUE index
        // added by migration 017. If two concurrent multi-grant requests
        // arrive for the same tuple, the loser re-reads the winner and
        // updates it instead of crashing the whole transaction.
        try {
          const grant = await PermissionGrant.create({
            userId,
            resourceType: resource,
            action,
            permissionLevel: null,
            effect: grantEffect,
            scope: scope || 'global',
            isOverride: true,
            grantedBy: req.user.id,
            expiresAt: expiresAt || null,
            reason: reason || null,
          }, { transaction: t });

          created.push({ resource, action, id: grant.id, effect: grantEffect });
        } catch (insertErr) {
          if (insertErr?.name === 'SequelizeUniqueConstraintError') {
            const winner = await PermissionGrant.findOne({
              where: { userId, resourceType: resource, action, effect: grantEffect, isActive: true },
              transaction: t,
            });
            if (winner) {
              await winner.update({
                expiresAt: expiresAt || winner.expiresAt,
                reason: reason || winner.reason,
                scope: scope || winner.scope,
              }, { transaction: t });
              updated.push({ resource, action, id: winner.id, effect: grantEffect, raceResolved: true });
              continue;
            }
          }
          throw insertErr;
        }
      }
    }

    await t.commit();

    // Log activity
    const totalProcessed = created.length + updated.length;
    if (totalProcessed > 0) {
      const verb = grantEffect === 'deny' ? 'denied' : 'granted';
      logActivity({
        action: grantEffect === 'deny' ? 'permission_multi_deny' : 'permission_multi_grant',
        description: `${req.user.name} ${verb} ${totalProcessed} permission(s) for ${targetUser.name} (${created.length} new, ${updated.length} updated, ${skipped.length} skipped)`,
        entityType: 'permission',
        entityId: null,
        userId: req.user.id,
        meta: {
          targetUserId: userId,
          targetUserName: targetUser.name,
          resources: resourceList,
          actions: actionList,
          effect: grantEffect,
          created: created.length,
          updated: updated.length,
          skipped: skipped.length,
        },
      });
    }

    // Notify the target user that their permissions changed so any open
    // session re-fetches /auth/me/permissions and refreshes guards.
    if (created.length > 0 || updated.length > 0) {
      notifyPermissionChange(userId, {
        source: 'multi',
        effect: grantEffect,
        resources: resourceList,
        actions: actionList,
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
    safeLogger.error('[Permission] multiGrant error', { err });
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

    // Phase 7 — Tier-2 destructive guard. Revoking a permission grant is
    // soft-delete-class; T2 must not perform it (decision #4).
    const { assertCanDelete } = require('../services/tierEnforcement');
    const { sendIfTierError } = require('../utils/tierResponseHelpers');
    if (sendIfTierError(res, () => assertCanDelete(req.user, 'permission_grant', { isOwnResource: false }))) return;

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
    notifyPermissionChange(grant.userId, {
      source: 'revoke',
      resourceType: grant.resourceType,
      action: grant.action,
    });

    res.json({ success: true, message: 'Permission revoked.' });
  } catch (err) {
    safeLogger.error('[Permission] revokePermission error', { err });
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
    safeLogger.error('[Permission] getMyGrants error', { err });
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
          denials: result.denials,
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
    safeLogger.error('[Permission] getEffective error', { err });
    res.status(500).json({ success: false, message: 'Failed to get effective permissions.' });
  }
};

// GET /api/permissions/metadata — get permission structure for UI
exports.getMetadata = async (_req, res) => {
  try {
    const metadata = getPermissionMetadata();
    res.json({ success: true, data: { metadata } });
  } catch (err) {
    safeLogger.error('[Permission] getMetadata error', { err });
    res.status(500).json({ success: false, message: 'Failed to get permission metadata.' });
  }
};

// GET /api/permissions/catalog — canonical permission catalog (Phase 6)
//
// Returns resources, actions, grantability flags, and tier base matrices
// in one payload so the frontend Permission Overrides UI is driven from a
// single backend source of truth. Frontend should fetch this once per
// session and use it for all dropdowns / grantability gating.
exports.getCatalog = async (_req, res) => {
  try {
    const catalog = getPermissionCatalog();
    res.json({ success: true, data: { catalog } });
  } catch (err) {
    safeLogger.error('[Permission] getCatalog error', { err });
    res.status(500).json({ success: false, message: 'Failed to get permission catalog.' });
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
    safeLogger.error('[Permission] getBasePermissions error', { err });
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
          effect: g.effect || 'grant',
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
    safeLogger.error('[Permission] getHistory error', { err });
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
