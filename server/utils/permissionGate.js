'use strict';

/**
 * Inline permission-gate helpers for controllers (Phase 7).
 *
 * Provides a uniform `PERMISSION_DENIED` response shape so the frontend can
 * react identically across every wired action. The actual permission lookup
 * delegates to `permissionEngine.hasPermission` (umbrella-aware + deny-
 * precedence).
 *
 * Response shape on denial:
 *   401 if not authenticated
 *   403 { success: false, code: 'PERMISSION_DENIED',
 *         permission: 'tasks.assign_self',
 *         message: 'You cannot assign tasks to yourself.' }
 */

const { hasPermission } = require('../services/permissionEngine');

/**
 * Check a permission; if denied, sends a structured 403 response and returns
 * `true` to signal "stop, response already sent". Returns `false` when the
 * caller should proceed.
 *
 * Usage in a controller:
 *
 *   if (await denyIfNoPermission(res, req.user, 'tasks', 'assign_self',
 *       'You cannot assign tasks to yourself.')) return;
 *
 * The `message` is the user-facing string shown in the UI toast / banner.
 * Be specific — generic messages are worse than no message because the user
 * can't tell what they're being denied.
 */
async function denyIfNoPermission(res, user, resource, action, message, resourceId) {
  if (!user) {
    res.status(401).json({
      success: false,
      code: 'UNAUTH',
      message: 'Not authenticated.',
    });
    return true;
  }
  const allowed = await hasPermission(user, resource, action, resourceId);
  if (allowed) return false;
  res.status(403).json({
    success: false,
    code: 'PERMISSION_DENIED',
    permission: `${resource}.${action}`,
    message: message || `Permission denied: '${resource}.${action}'.`,
  });
  return true;
}

/**
 * Pure boolean variant — does not send a response. Use when the caller wants
 * to combine multiple permission checks or fall back to a different code path.
 */
async function checkPermission(user, resource, action, resourceId) {
  if (!user) return false;
  return hasPermission(user, resource, action, resourceId);
}

module.exports = { denyIfNoPermission, checkPermission };
