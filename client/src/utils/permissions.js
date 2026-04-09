/**
 * Centralized permission definitions for the Aniston Task Manager.
 *
 * Role hierarchy (least to most privileged):
 *   member (employee) < assistant_manager < manager < admin < super_admin (isSuperAdmin flag)
 *
 * There are TWO ways permissions are checked:
 *   1. effectivePermissions — a precomputed { action: true/false } object from the server
 *      that merges role defaults + active permission grants. This is the PRIMARY source.
 *   2. Fallback — if effectivePermissions is empty (not loaded yet), falls back to
 *      static role check + grant-based check.
 */

const PERMISSIONS = {
  create_workspace:    ['assistant_manager', 'manager', 'admin'],
  edit_workspace:      ['assistant_manager', 'manager', 'admin'],
  delete_workspace:    ['admin'],
  create_board:        ['manager', 'admin'],
  edit_board:          ['manager', 'admin'],
  delete_board:        ['assistant_manager', 'manager', 'admin'],
  create_task:         ['assistant_manager', 'manager', 'admin'],
  assign_members:      ['assistant_manager', 'manager', 'admin'],
  edit_others_tasks:   ['manager', 'admin'],
  manage_settings:     ['admin'],
  manage_board_settings: ['admin'],
  view_dashboard:      ['assistant_manager', 'manager', 'admin'],
  manage_users:        ['manager', 'admin'],
};

const ACTION_TO_GRANT = {
  create_workspace:      { resourceTypes: ['workspace'],       minLevel: 'manage' },
  edit_workspace:        { resourceTypes: ['workspace'],       minLevel: 'edit' },
  delete_workspace:      { resourceTypes: ['workspace'],       minLevel: 'manage' },
  create_board:          { resourceTypes: ['board'],           minLevel: 'manage' },
  edit_board:            { resourceTypes: ['board'],           minLevel: 'edit' },
  delete_board:          { resourceTypes: ['board'],           minLevel: 'manage' },
  create_task:           { resourceTypes: ['task', 'board'],   minLevel: 'assign' },
  assign_members:        { resourceTypes: ['task', 'board'],   minLevel: 'assign' },
  edit_others_tasks:     { resourceTypes: ['task', 'board'],   minLevel: 'manage' },
  manage_settings:       { resourceTypes: ['workspace'],       minLevel: 'admin' },
  manage_board_settings: { resourceTypes: ['board'],           minLevel: 'admin' },
  view_dashboard:        { resourceTypes: ['dashboard'],       minLevel: 'view' },
  manage_users:          { resourceTypes: ['team'],            minLevel: 'manage' },
};

const LEVEL_HIERARCHY = ['view', 'edit', 'assign', 'manage', 'admin'];

/**
 * Check if a user can perform an action.
 *
 * Priority order:
 *   1. Super admin → always true
 *   2. effectivePermissions[action] → server-computed (role + grants merged) — most reliable
 *   3. Static role check → PERMISSIONS[action].includes(userRole)
 *   4. Client-side grant check → fallback if effectivePermissions not loaded
 *
 * @param {string} userRole - The user's role
 * @param {string} action - The action key
 * @param {boolean} isSuperAdmin - Whether the user has isSuperAdmin flag
 * @param {Array} grants - Array of { resourceType, permissionLevel } from PermissionGrant
 * @param {Object} effectivePermissions - Precomputed { action: boolean } from GET /auth/me/permissions
 * @returns {boolean}
 */
export function canUser(userRole, action, isSuperAdmin = false, grants = [], effectivePermissions = {}) {
  // Super admin bypasses everything
  if (isSuperAdmin) return true;

  // Primary: server-computed effective permissions (role + grants already merged)
  if (effectivePermissions && typeof effectivePermissions === 'object' && Object.keys(effectivePermissions).length > 0) {
    return !!effectivePermissions[action];
  }

  // Fallback: static role check
  if (PERMISSIONS[action]?.includes(userRole)) return true;

  // Fallback: client-side grant check
  const grantReq = ACTION_TO_GRANT[action];
  if (grantReq && grants.length > 0) {
    const minIdx = LEVEL_HIERARCHY.indexOf(grantReq.minLevel);
    return grants.some(g =>
      grantReq.resourceTypes.includes(g.resourceType) &&
      LEVEL_HIERARCHY.indexOf(g.permissionLevel) >= minIdx
    );
  }

  return false;
}

export { PERMISSIONS };