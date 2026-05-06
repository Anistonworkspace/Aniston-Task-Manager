const jwt = require('jsonwebtoken');
const { User } = require('../models');
const { Op } = require('sequelize');
const {
  resolveTier,
  TIER_1,
  TIER_2,
  TIER_3,
} = require('../config/tiers');

/**
 * Authenticate requests via Bearer token in the Authorization header.
 * Attaches the full user object (minus password) to req.user.
 */
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided.',
      });
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. Malformed authorization header.',
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.type === 'refresh') {
      return res.status(401).json({
        success: false,
        message: 'Use refresh token only at the refresh endpoint.',
      });
    }

    const user = await User.findByPk(decoded.id);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Token is valid but user no longer exists.',
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: 'Account has been deactivated. Contact an administrator.',
      });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token has expired. Please log in again.',
      });
    }
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token.',
      });
    }
    return res.status(500).json({
      success: false,
      message: 'Authentication error.',
    });
  }
};

/**
 * Restrict access to admin and super admin users only.
 *
 * Historically this middleware also let managers through (the old comment
 * read "manager has same access as admin"), which created a P0 escalation
 * surface: every route guarded by adminOnly was implicitly manager-or-admin.
 * As of CP-1 (org-chart hardening) it is strict — the name finally matches
 * the behavior. Routes that intentionally want both admins and managers
 * should import `managerOrAdmin` (or `adminOrManager`, an alias added below
 * for forward compatibility).
 *
 * Tier mapping note (Phase 5a): semantically this guard admits Tier 1
 * unconditionally PLUS Tier 2 when the legacy `role` is still 'admin'
 * (i.e., not a former 'manager' who was merged into Tier 2). This is a
 * COMPAT semantic — the new model treats admin and manager identically as
 * Tier 2. After Phase 5e tightens genuinely-admin-only routes to T1 only
 * (admin_settings, integrations, api_keys), most adminOnly call sites will
 * be replaced per-route with `requireTier(1)`.
 *
 * Must be used AFTER the authenticate middleware.
 */
const adminOnly = (req, res, next) => {
  if (!req.user) {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Admin privileges required.',
    });
  }
  const tier = resolveTier(req.user);
  // T1 always passes. T2 passes only when legacy role is admin (preserves
  // pre-Phase-5a semantic that a 'manager' role did NOT pass adminOnly).
  if (tier === TIER_1) return next();
  if (tier === TIER_2 && req.user.role === 'admin') return next();
  return res.status(403).json({
    success: false,
    message: 'Access denied. Admin privileges required.',
  });
};

/**
 * Restrict access to managers, admins, and super admins.
 * Assistant managers are explicitly excluded.
 *
 * Tier mapping (Phase 5a): equivalent to "Tier 1 or Tier 2". Implemented
 * via `resolveTier` so the same source of truth used by the new
 * tier-based guards (server/middleware/tier.js) governs this legacy
 * guard too.
 *
 * Must be used AFTER the authenticate middleware.
 */
const managerOrAdmin = (req, res, next) => {
  if (!req.user || resolveTier(req.user) > TIER_2) {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Manager or admin privileges required.',
    });
  }
  next();
};

// Forward-compatible alias. New routes that genuinely want both admins and
// managers should prefer this name — it reads correctly at the route file.
const adminOrManager = managerOrAdmin;

/**
 * Restrict access to assistant managers and super admins only (director plan management).
 *
 * Tier mapping (Phase 5a): admits Tier 1 (super admin) and Tier 3
 * (former assistant_manager). Excludes Tier 2 and Tier 4.
 */
const assistantManagerOnly = (req, res, next) => {
  if (!req.user) {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Assistant manager privileges required.',
    });
  }
  const tier = resolveTier(req.user);
  if (tier === TIER_1 || tier === TIER_3) return next();
  return res.status(403).json({
    success: false,
    message: 'Access denied. Assistant manager privileges required.',
  });
};

/**
 * Map action verbs to the minimum PermissionGrant level required.
 * The hierarchy is: view < edit < assign < manage < admin
 */
const ACTION_TO_MIN_LEVEL = {
  GET:    'view',
  POST:   'manage',
  PUT:    'edit',
  PATCH:  'edit',
  DELETE: 'manage',
};
const LEVEL_HIERARCHY = ['view', 'edit', 'assign', 'manage', 'admin'];

/**
 * Derive the resourceType(s) from the request URL for PermissionGrant lookups.
 * Supports both legacy (singular) and new (plural) resource type names.
 */
function deriveResourceTypes(url) {
  if (/\/workspaces/i.test(url)) return ['workspace', 'workspaces'];
  if (/\/boards/i.test(url)) return ['board', 'boards'];
  if (/\/tasks|\/subtasks/i.test(url)) return ['task', 'board', 'tasks', 'boards'];
  if (/\/teams|\/users/i.test(url)) return ['team', 'users'];
  if (/\/dashboard/i.test(url)) return ['dashboard'];
  if (/\/meetings/i.test(url)) return ['meetings'];
  if (/\/notes/i.test(url)) return ['notes'];
  if (/\/timeplans/i.test(url)) return ['time_plan'];
  if (/\/director-plan/i.test(url)) return ['director_plan'];
  if (/\/archive/i.test(url)) return ['archive'];
  if (/\/integrations/i.test(url)) return ['integrations'];
  if (/\/feedback/i.test(url)) return ['feedback'];
  if (/\/reviews/i.test(url)) return ['reports'];
  if (/\/automations/i.test(url)) return ['automations'];
  if (/\/labels/i.test(url)) return ['labels'];
  if (/\/departments/i.test(url)) return ['departments'];
  if (/\/admin-settings|\/permissions/i.test(url)) return ['admin_settings', 'roles'];
  if (/\/announcements/i.test(url)) return ['announcements'];
  if (/\/api-keys/i.test(url)) return ['api_keys'];
  if (/\/exports/i.test(url)) return ['exports'];
  return [];
}

/**
 * Derive the action from the HTTP method for permission grant lookups.
 */
function deriveAction(method) {
  const METHOD_TO_ACTION = {
    GET: 'view',
    POST: 'create',
    PUT: 'edit',
    PATCH: 'edit',
    DELETE: 'delete',
  };
  return METHOD_TO_ACTION[method] || 'view';
}

/**
 * Reusable role guard middleware factory.
 * Usage: requireRole('admin', 'manager') — only those roles (or isSuperAdmin) can proceed.
 *
 * Two-layer check:
 *   1. Static role — if user.role is in allowedRoles, pass immediately.
 *   2. PermissionGrant fallback — if the user has an active grant on the relevant
 *      resource type at or above the required level, pass.
 *
 * This means an admin can grant a member "manage" on workspaces, and that member
 * can then create/edit workspaces even though their role is 'member'.
 *
 * Logs unauthorized attempts for audit.
 *
 * @param  {...string} allowedRoles - Roles permitted to access the route
 * @returns {Function} Express middleware
 */
const requireRole = (...allowedRoles) => {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Not authenticated.' });
    }

    // Super admin always passes
    if (req.user.isSuperAdmin) return next();

    // Layer 1: Static role check
    if (allowedRoles.includes(req.user.role)) {
      return next();
    }

    // Layer 2: Check PermissionGrant table as fallback (both legacy and new action-based)
    try {
      const { PermissionGrant } = require('../models');
      const resourceTypes = deriveResourceTypes(req.originalUrl);
      if (resourceTypes.length > 0 && PermissionGrant) {
        const minLevel = ACTION_TO_MIN_LEVEL[req.method] || 'manage';
        const minIdx = LEVEL_HIERARCHY.indexOf(minLevel);
        const actionNeeded = deriveAction(req.method);

        const grants = await PermissionGrant.findAll({
          where: {
            userId: req.user.id,
            resourceType: { [Op.in]: resourceTypes },
            isActive: true,
            [Op.or]: [
              { expiresAt: null },
              { expiresAt: { [Op.gt]: new Date() } },
            ],
          },
        });

        const hasAccess = grants.some(g => {
          // New action-based check
          if (g.action && g.action === actionNeeded) return true;
          if (g.action === 'manage') return true; // manage implies all actions

          // Legacy level-based check
          if (g.permissionLevel) {
            const grantIdx = LEVEL_HIERARCHY.indexOf(g.permissionLevel);
            return grantIdx >= minIdx;
          }
          return false;
        });

        if (hasAccess) {
          return next();
        }
      }

      // Layer 3: Base-role matrix fallback.
      //
      // Original intent: a route guarded by `requireRole('admin')` could still
      // pass for other roles whose matrix entry granted that action (e.g. the
      // matrix knew managers had base meeting-management rights even on a
      // legacy `adminOnly` route).
      //
      // Bug found 2026-05-04: this fallback turned every `requireRole('manager',
      // 'admin')` GET route into "any authenticated user with base view"
      // because `member.workspaces.view = true` in the matrix → bypass on
      // `GET /api/workspaces/archived`. That leaked archived workspace names
      // to members despite the explicit role guard.
      //
      // Fix: only fall through for management actions (create/edit/delete/
      // manage). `view` was the bypass surface — base-role *read* permission
      // must NEVER override an explicit `requireRole(...)` directive that
      // listed only manager-tier roles. PermissionGrant (Layer 2) remains the
      // proper escape hatch for individual elevation.
      //
      // Phase 5b: the matrix lookup now goes through the engine's
      // tier-aware `getEffectiveBasePermission`, which prefers
      // TIER_PERMISSIONS[user.tier] when the user has a valid tier column
      // and falls back to ROLE_PERMISSIONS[user.role] for pre-migration users.
      try {
        const { getEffectiveBasePermission } = require('../services/permissionEngine');
        const newResourceTypes = deriveResourceTypes(req.originalUrl)
          .filter(r => !['workspace', 'board', 'task', 'team'].includes(r));
        const actionNeeded2 = deriveAction(req.method);
        const isElevatedAction = actionNeeded2 !== 'view';
        if (isElevatedAction) {
          for (const rt of newResourceTypes) {
            if (getEffectiveBasePermission(req.user, rt, actionNeeded2)) {
              return next();
            }
          }
        }
      } catch (e) {
        // Ignore — optional enhancement
      }
    } catch (err) {
      console.error('[Auth] PermissionGrant check error:', err.message);
    }

    console.warn(
      `[Auth] Unauthorized access attempt: user=${req.user.id} role=${req.user.role} ` +
      `attempted=${req.method} ${req.originalUrl} allowedRoles=[${allowedRoles.join(',')}]`
    );
    return res.status(403).json({
      success: false,
      message: 'You do not have permission to perform this action.',
    });
  };
};

/**
 * Restrict access to actual admin role only (NOT manager).
 * Used for admin-only modules: Admin Settings, Integrations config, Feedback management.
 *
 * Tier mapping (Phase 5a): identical compat semantic to `adminOnly`. After
 * Phase 5e replaces these guards per-route, most strictAdminOnly call sites
 * become `requireTier(1)`.
 *
 * Must be used AFTER the authenticate middleware.
 */
const strictAdminOnly = (req, res, next) => {
  if (!req.user) {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Admin privileges required.',
    });
  }
  const tier = resolveTier(req.user);
  if (tier === TIER_1) return next();
  if (tier === TIER_2 && req.user.role === 'admin') return next();
  return res.status(403).json({
    success: false,
    message: 'Access denied. Admin privileges required.',
  });
};

/**
 * Restrict access to Super Admins only. Regular admins are excluded — this is
 * the right gate for system-wide platform settings (session timeout, security
 * policy) where even an org admin must not be able to edit the value.
 *
 * Tier mapping (Phase 5a): equivalent to `requireTier(1)`. Implemented via
 * `resolveTier` so the legacy guard tracks the new tier-based source of
 * truth even before downstream callers migrate.
 *
 * Must be used AFTER the authenticate middleware.
 */
const superAdminOnly = (req, res, next) => {
  if (!req.user || resolveTier(req.user) !== TIER_1) {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Super Admin privileges required.',
    });
  }
  next();
};

module.exports = {
  authenticate,
  adminOnly,
  adminOrManager,
  managerOrAdmin,
  assistantManagerOnly,
  strictAdminOnly,
  superAdminOnly,
  requireRole,
};
