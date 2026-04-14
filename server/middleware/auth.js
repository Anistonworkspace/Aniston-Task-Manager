const jwt = require('jsonwebtoken');
const { User } = require('../models');
const { Op } = require('sequelize');

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
 * Restrict access to admin and manager users (manager has same access as admin).
 * Must be used AFTER the authenticate middleware.
 */
const adminOnly = (req, res, next) => {
  if (!req.user || !['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Admin privileges required.',
    });
  }
  next();
};

/**
 * Restrict access to managers and admins only (NOT assistant_manager).
 * Manager has same access as admin. Assistant manager is excluded.
 * Must be used AFTER the authenticate middleware.
 */
const managerOrAdmin = (req, res, next) => {
  if (!req.user || (!['admin', 'manager'].includes(req.user.role) && !req.user.isSuperAdmin)) {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Manager or admin privileges required.',
    });
  }
  next();
};

/**
 * Restrict access to assistant managers and super admins only (director plan management).
 */
const assistantManagerOnly = (req, res, next) => {
  if (!req.user || (req.user.role !== 'assistant_manager' && !req.user.isSuperAdmin)) {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Assistant manager privileges required.',
    });
  }
  next();
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

      // Layer 3: Check new permission engine for base role permissions
      // This handles the case where route uses requireRole('admin') but the user's
      // role has base permission via the new matrix
      try {
        const { isBasePermission } = require('../config/permissionMatrix');
        const newResourceTypes = deriveResourceTypes(req.originalUrl).filter(r => !['workspace', 'board', 'task', 'team'].includes(r));
        const actionNeeded2 = deriveAction(req.method);
        for (const rt of newResourceTypes) {
          if (isBasePermission(req.user.role, rt, actionNeeded2)) {
            return next();
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
 * Must be used AFTER the authenticate middleware.
 */
const strictAdminOnly = (req, res, next) => {
  if (!req.user || (req.user.role !== 'admin' && !req.user.isSuperAdmin)) {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Admin privileges required.',
    });
  }
  next();
};

module.exports = { authenticate, adminOnly, managerOrAdmin, assistantManagerOnly, strictAdminOnly, requireRole };
