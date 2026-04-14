/**
 * Centralized permission definitions for the Aniston Task Manager.
 *
 * Role hierarchy (least to most privileged):
 *   member (employee) < assistant_manager < manager < admin < super_admin (isSuperAdmin flag)
 *
 * TWO permission systems coexist:
 *   1. Legacy flat permissions — { action: true/false } e.g. create_workspace, manage_users
 *   2. New granular permissions — { "resource.action": true/false } e.g. "boards.create", "tasks.assign"
 *
 * The `canUser` function checks BOTH for backward compatibility.
 * New code should prefer `hasGranularPermission` for precise checks.
 */

// ── Resource & Action definitions (mirrors server/config/permissionMatrix.js) ──

export const RESOURCES = {
  users:            { label: 'Users',               category: 'Administration' },
  departments:      { label: 'Departments',          category: 'Administration' },
  roles:            { label: 'Roles & Permissions',   category: 'Administration' },
  admin_settings:   { label: 'Admin Settings',        category: 'Administration' },
  workspaces:       { label: 'Workspaces',            category: 'Project Management' },
  boards:           { label: 'Boards',                category: 'Project Management' },
  tasks:            { label: 'Tasks',                 category: 'Project Management' },
  subtasks:         { label: 'Subtasks',              category: 'Project Management' },
  task_comments:    { label: 'Task Comments',         category: 'Project Management' },
  task_files:       { label: 'Task Files',            category: 'Project Management' },
  labels:           { label: 'Labels',                category: 'Project Management' },
  automations:      { label: 'Automations',           category: 'Project Management' },
  dependencies:     { label: 'Dependencies',          category: 'Project Management' },
  dashboard:        { label: 'Dashboard & Analytics',  category: 'Reporting' },
  reports:          { label: 'Reports & Reviews',      category: 'Reporting' },
  exports:          { label: 'Exports & Downloads',    category: 'Reporting' },
  meetings:         { label: 'Meetings',              category: 'Collaboration' },
  notes:            { label: 'Notes',                 category: 'Collaboration' },
  announcements:    { label: 'Announcements',         category: 'Collaboration' },
  time_plan:        { label: 'Time Plan',             category: 'Planning' },
  director_plan:    { label: 'Director Plan',         category: 'Planning' },
  timeline:         { label: 'Timeline / Gantt',      category: 'Planning' },
  archive:          { label: 'Archive',               category: 'Operations' },
  integrations:     { label: 'Integrations',          category: 'Operations' },
  feedback:         { label: 'Feedback',              category: 'Operations' },
  org_chart:        { label: 'Org Chart',             category: 'Operations' },
  notifications:    { label: 'Notifications',         category: 'Operations' },
  api_keys:         { label: 'API Keys',              category: 'Administration' },
};

export const ACTIONS = {
  view:              { label: 'View',                 description: 'View/read access' },
  create:            { label: 'Create',               description: 'Create new records' },
  edit:              { label: 'Edit',                 description: 'Edit/update records' },
  delete:            { label: 'Delete',               description: 'Delete/archive records' },
  assign:            { label: 'Assign',               description: 'Assign to users' },
  approve:           { label: 'Approve/Reject',       description: 'Approve or reject requests' },
  export:            { label: 'Export',               description: 'Export/download data' },
  manage:            { label: 'Manage',               description: 'Full management access' },
  manage_members:    { label: 'Manage Members',       description: 'Add/remove members' },
  manage_settings:   { label: 'Manage Settings',      description: 'Configure settings' },
  change_status:     { label: 'Change Status',        description: 'Change status fields' },
  comment:           { label: 'Comment',              description: 'Add comments' },
  upload:            { label: 'Upload Files',         description: 'Upload attachments' },
};

export const RESOURCE_ACTIONS = {
  users:            ['view', 'create', 'edit', 'delete', 'manage'],
  departments:      ['view', 'create', 'edit', 'delete'],
  roles:            ['view', 'manage'],
  admin_settings:   ['view', 'manage'],
  workspaces:       ['view', 'create', 'edit', 'delete', 'manage_members'],
  boards:           ['view', 'create', 'edit', 'delete', 'manage_members', 'manage_settings', 'export'],
  tasks:            ['view', 'create', 'edit', 'delete', 'assign', 'change_status', 'comment', 'upload', 'approve'],
  subtasks:         ['view', 'create', 'edit', 'delete'],
  task_comments:    ['view', 'create', 'edit', 'delete'],
  task_files:       ['view', 'upload', 'delete'],
  labels:           ['view', 'create', 'edit', 'delete'],
  automations:      ['view', 'create', 'edit', 'delete'],
  dependencies:     ['view', 'create', 'delete'],
  dashboard:        ['view', 'export'],
  reports:          ['view', 'export'],
  exports:          ['view', 'export'],
  meetings:         ['view', 'create', 'edit', 'delete', 'manage'],
  notes:            ['view', 'create', 'edit', 'delete'],
  announcements:    ['view', 'create', 'edit', 'delete'],
  time_plan:        ['view', 'create', 'edit', 'delete', 'manage'],
  director_plan:    ['view', 'create', 'edit', 'delete'],
  timeline:         ['view'],
  archive:          ['view', 'manage'],
  integrations:     ['view', 'manage'],
  feedback:         ['view', 'create', 'manage'],
  org_chart:        ['view', 'manage'],
  notifications:    ['view', 'manage'],
  api_keys:         ['view', 'create', 'delete', 'manage'],
};

// ── Legacy flat permissions (backward compatibility) ────────────────────

const PERMISSIONS = {
  create_workspace:    ['manager', 'admin'],
  edit_workspace:      ['manager', 'admin'],
  delete_workspace:    ['manager', 'admin'],
  create_board:        ['manager', 'admin'],
  edit_board:          ['manager', 'admin'],
  delete_board:        ['manager', 'admin'],
  create_task:         ['assistant_manager', 'manager', 'admin'],
  assign_members:      ['assistant_manager', 'manager', 'admin'],
  edit_others_tasks:   ['manager', 'admin'],
  manage_settings:     ['manager', 'admin'],
  manage_board_settings: ['manager', 'admin'],
  view_dashboard:      ['assistant_manager', 'manager', 'admin'],
  manage_users:        ['manager', 'admin'],
};

const ACTION_TO_GRANT = {
  create_workspace:      { resourceTypes: ['workspace', 'workspaces'], minLevel: 'manage' },
  edit_workspace:        { resourceTypes: ['workspace', 'workspaces'], minLevel: 'edit' },
  delete_workspace:      { resourceTypes: ['workspace', 'workspaces'], minLevel: 'manage' },
  create_board:          { resourceTypes: ['board', 'boards'],         minLevel: 'manage' },
  edit_board:            { resourceTypes: ['board', 'boards'],         minLevel: 'edit' },
  delete_board:          { resourceTypes: ['board', 'boards'],         minLevel: 'manage' },
  create_task:           { resourceTypes: ['task', 'board', 'tasks', 'boards'], minLevel: 'assign' },
  assign_members:        { resourceTypes: ['task', 'board', 'tasks', 'boards'], minLevel: 'assign' },
  edit_others_tasks:     { resourceTypes: ['task', 'board', 'tasks', 'boards'], minLevel: 'manage' },
  manage_settings:       { resourceTypes: ['workspace', 'workspaces', 'admin_settings'], minLevel: 'admin' },
  manage_board_settings: { resourceTypes: ['board', 'boards'],         minLevel: 'admin' },
  view_dashboard:        { resourceTypes: ['dashboard'],               minLevel: 'view' },
  manage_users:          { resourceTypes: ['team', 'users'],           minLevel: 'manage' },
};

const LEVEL_HIERARCHY = ['view', 'edit', 'assign', 'manage', 'admin'];

/**
 * Check if a user can perform an action (legacy + new granular system).
 *
 * Priority order:
 *   1. Super admin -> always true
 *   2. granularPermissions["resource.action"] -> new system (most precise)
 *   3. effectivePermissions[action] -> legacy system (backward compat)
 *   4. Static role check -> PERMISSIONS[action].includes(userRole)
 *   5. Client-side grant check -> fallback
 *
 * @param {string} userRole
 * @param {string} action - Legacy action key OR "resource.action" format
 * @param {boolean} isSuperAdmin
 * @param {Array} grants
 * @param {Object} effectivePermissions - Legacy flat { action: boolean }
 * @param {Object} [granularPermissions] - New { "resource.action": boolean }
 * @returns {boolean}
 */
export function canUser(userRole, action, isSuperAdmin = false, grants = [], effectivePermissions = {}, granularPermissions = {}) {
  if (isSuperAdmin) return true;

  // Check new granular permissions first (resource.action format)
  if (granularPermissions && typeof granularPermissions === 'object' && Object.keys(granularPermissions).length > 0) {
    // Direct check for "resource.action" format
    if (action.includes('.')) {
      return !!granularPermissions[action];
    }
  }

  // Legacy: server-computed effective permissions
  if (effectivePermissions && typeof effectivePermissions === 'object' && Object.keys(effectivePermissions).length > 0) {
    if (effectivePermissions[action] !== undefined) {
      return !!effectivePermissions[action];
    }
  }

  // Fallback: static role check
  if (PERMISSIONS[action]?.includes(userRole)) return true;

  // Fallback: client-side grant check (supports both legacy and new action-based)
  const grantReq = ACTION_TO_GRANT[action];
  if (grantReq && grants.length > 0) {
    const minIdx = LEVEL_HIERARCHY.indexOf(grantReq.minLevel);
    return grants.some(g => {
      // Legacy level-based
      if (g.permissionLevel && grantReq.resourceTypes.includes(g.resourceType)) {
        return LEVEL_HIERARCHY.indexOf(g.permissionLevel) >= minIdx;
      }
      // New action-based
      if (g.action && grantReq.resourceTypes.includes(g.resourceType)) {
        return true; // If there's an action-based grant for this resource, it's allowed
      }
      return false;
    });
  }

  return false;
}

/**
 * New granular permission check. Preferred for new code.
 *
 * @param {string} resource - Resource key (e.g. 'boards', 'tasks')
 * @param {string} action - Action key (e.g. 'view', 'create', 'edit')
 * @param {boolean} isSuperAdmin
 * @param {Object} granularPermissions - { "resource.action": boolean }
 * @returns {boolean}
 */
export function hasGranularPermission(resource, action, isSuperAdmin = false, granularPermissions = {}) {
  if (isSuperAdmin) return true;
  return !!granularPermissions[`${resource}.${action}`];
}

/**
 * Get the resources grouped by category for the UI.
 */
export function getResourcesByCategory() {
  const grouped = {};
  for (const [key, meta] of Object.entries(RESOURCES)) {
    if (!grouped[meta.category]) grouped[meta.category] = [];
    grouped[meta.category].push({ key, ...meta });
  }
  return grouped;
}

/**
 * Get valid actions for a given resource.
 */
export function getActionsForResource(resource) {
  return RESOURCE_ACTIONS[resource] || [];
}

export { PERMISSIONS };
