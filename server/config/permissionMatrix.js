/**
 * Centralized Permission Matrix for Aniston Task Manager.
 *
 * This is the SINGLE SOURCE OF TRUTH for all permission definitions.
 * Both backend middleware and the /auth/me/permissions endpoint use this.
 * The frontend mirrors this via its own permissions.js utility.
 *
 * Structure:
 *   RESOURCES — all app modules/resources that can be permission-controlled
 *   ACTIONS   — all possible actions per resource
 *   ROLE_PERMISSIONS — base permissions for each role (what each role gets by default)
 */

// ── All controllable resources in the app ──────────────────────────────
const RESOURCES = {
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

// ── All possible actions ────────────────────────────────────────────────
const ACTIONS = {
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

// ── Valid actions for each resource ─────────────────────────────────────
const RESOURCE_ACTIONS = {
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

// ── Base permissions for each role ──────────────────────────────────────
// true = allowed by default for this role
// false or missing = denied by default (can be granted as override)

const ROLE_PERMISSIONS = {
  admin: {
    users:            { view: true, create: true, edit: true, delete: true, manage: true },
    departments:      { view: true, create: true, edit: true, delete: true },
    roles:            { view: true, manage: true },
    admin_settings:   { view: true, manage: true },
    workspaces:       { view: true, create: true, edit: true, delete: true, manage_members: true },
    boards:           { view: true, create: true, edit: true, delete: true, manage_members: true, manage_settings: true, export: true },
    tasks:            { view: true, create: true, edit: true, delete: true, assign: true, change_status: true, comment: true, upload: true, approve: true },
    subtasks:         { view: true, create: true, edit: true, delete: true },
    task_comments:    { view: true, create: true, edit: true, delete: true },
    task_files:       { view: true, upload: true, delete: true },
    labels:           { view: true, create: true, edit: true, delete: true },
    automations:      { view: true, create: true, edit: true, delete: true },
    dependencies:     { view: true, create: true, delete: true },
    dashboard:        { view: true, export: true },
    reports:          { view: true, export: true },
    exports:          { view: true, export: true },
    meetings:         { view: true, create: true, edit: true, delete: true, manage: true },
    notes:            { view: true, create: true, edit: true, delete: true },
    announcements:    { view: true, create: true, edit: true, delete: true },
    time_plan:        { view: true, create: true, edit: true, delete: true, manage: true },
    director_plan:    { view: true, create: true, edit: true, delete: true },
    timeline:         { view: true },
    archive:          { view: true, manage: true },
    integrations:     { view: true, manage: true },
    feedback:         { view: true, create: true, manage: true },
    org_chart:        { view: true, manage: true },
    notifications:    { view: true, manage: true },
    api_keys:         { view: true, create: true, delete: true, manage: true },
  },

  // Manager has all access same as admin EXCEPT: admin_settings, integrations, feedback (admin-only modules)
  manager: {
    users:            { view: true, create: true, edit: true, delete: true, manage: true },
    departments:      { view: true, create: true, edit: true, delete: true },
    roles:            { view: true, manage: true },
    admin_settings:   { view: false, manage: false },
    workspaces:       { view: true, create: true, edit: true, delete: true, manage_members: true },
    boards:           { view: true, create: true, edit: true, delete: true, manage_members: true, manage_settings: true, export: true },
    tasks:            { view: true, create: true, edit: true, delete: true, assign: true, change_status: true, comment: true, upload: true, approve: true },
    subtasks:         { view: true, create: true, edit: true, delete: true },
    task_comments:    { view: true, create: true, edit: true, delete: true },
    task_files:       { view: true, upload: true, delete: true },
    labels:           { view: true, create: true, edit: true, delete: true },
    automations:      { view: true, create: true, edit: true, delete: true },
    dependencies:     { view: true, create: true, delete: true },
    dashboard:        { view: true, export: true },
    reports:          { view: true, export: true },
    exports:          { view: true, export: true },
    meetings:         { view: true, create: true, edit: true, delete: true, manage: true },
    notes:            { view: true, create: true, edit: true, delete: true },
    announcements:    { view: true, create: true, edit: true, delete: true },
    time_plan:        { view: true, create: true, edit: true, delete: true, manage: true },
    director_plan:    { view: true, create: true, edit: true, delete: true },
    timeline:         { view: true },
    archive:          { view: true, manage: true },
    integrations:     { view: false, manage: false },
    feedback:         { view: false, create: true, manage: false },
    org_chart:        { view: true, manage: true },
    notifications:    { view: true, manage: true },
    api_keys:         { view: true, create: true, delete: true, manage: true },
  },

  // Assistant manager: limited permissions — task CRUD, dashboard view, own meetings, personal time plan, dependencies
  assistant_manager: {
    users:            { view: true, create: false, edit: false, delete: false, manage: false },
    departments:      { view: true, create: false, edit: false, delete: false },
    roles:            { view: false, manage: false },
    admin_settings:   { view: false, manage: false },
    workspaces:       { view: true, create: false, edit: false, delete: false, manage_members: false },
    boards:           { view: true, create: false, edit: false, delete: false, manage_members: false, manage_settings: false, export: false },
    tasks:            { view: true, create: true, edit: true, delete: true, assign: true, change_status: true, comment: true, upload: true, approve: false },
    subtasks:         { view: true, create: true, edit: true, delete: true },
    task_comments:    { view: true, create: true, edit: true, delete: true },
    task_files:       { view: true, upload: true, delete: true },
    labels:           { view: true, create: false, edit: false, delete: false },
    automations:      { view: false, create: false, edit: false, delete: false },
    dependencies:     { view: true, create: true, delete: false },
    dashboard:        { view: true, export: false },
    reports:          { view: true, export: false },
    exports:          { view: false, export: false },
    meetings:         { view: true, create: true, edit: true, delete: true, manage: false },
    notes:            { view: true, create: true, edit: true, delete: true },
    announcements:    { view: true, create: false, edit: false, delete: false },
    time_plan:        { view: true, create: true, edit: true, delete: true, manage: false },
    director_plan:    { view: false, create: false, edit: false, delete: false },
    timeline:         { view: true },
    archive:          { view: false, manage: false },
    integrations:     { view: false, manage: false },
    feedback:         { view: false, create: true, manage: false },
    org_chart:        { view: true, manage: false },
    notifications:    { view: true, manage: false },
    api_keys:         { view: false, create: false, delete: false, manage: false },
  },

  member: {
    users:            { view: false, create: false, edit: false, delete: false, manage: false },
    departments:      { view: false, create: false, edit: false, delete: false },
    roles:            { view: false, manage: false },
    admin_settings:   { view: false, manage: false },
    workspaces:       { view: true, create: false, edit: false, delete: false, manage_members: false },
    boards:           { view: true, create: false, edit: false, delete: false, manage_members: false, manage_settings: false, export: false },
    tasks:            { view: true, create: false, edit: false, delete: false, assign: false, change_status: true, comment: true, upload: true, approve: false },
    subtasks:         { view: true, create: true, edit: true, delete: false },
    task_comments:    { view: true, create: true, edit: false, delete: false },
    task_files:       { view: true, upload: true, delete: false },
    labels:           { view: true, create: false, edit: false, delete: false },
    automations:      { view: false, create: false, edit: false, delete: false },
    dependencies:     { view: true, create: false, delete: false },
    dashboard:        { view: false, export: false },
    reports:          { view: true, export: false },
    exports:          { view: false, export: false },
    meetings:         { view: true, create: false, edit: false, delete: false, manage: false },
    notes:            { view: true, create: true, edit: true, delete: true },
    announcements:    { view: true, create: false, edit: false, delete: false },
    time_plan:        { view: true, create: true, edit: true, delete: true, manage: false },
    director_plan:    { view: false, create: false, edit: false, delete: false },
    timeline:         { view: true },
    archive:          { view: false, manage: false },
    integrations:     { view: false, manage: false },
    feedback:         { view: false, create: true, manage: false },
    org_chart:        { view: true, manage: false },
    notifications:    { view: true, manage: false },
    api_keys:         { view: false, create: false, delete: false, manage: false },
  },
};

/**
 * Get base permissions for a role.
 * Returns a flat object: { "resource.action": true/false }
 */
function getBasePermissions(role) {
  const rolePerms = ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.member;
  const flat = {};
  for (const [resource, actions] of Object.entries(rolePerms)) {
    for (const [action, allowed] of Object.entries(actions)) {
      flat[`${resource}.${action}`] = !!allowed;
    }
  }
  return flat;
}

/**
 * Check if an action on a resource is a base permission for a role.
 * @returns {boolean}
 */
function isBasePermission(role, resource, action) {
  return !!ROLE_PERMISSIONS[role]?.[resource]?.[action];
}

/**
 * Get all valid actions for a resource.
 * @returns {string[]}
 */
function getActionsForResource(resource) {
  return RESOURCE_ACTIONS[resource] || [];
}

/**
 * Get the full resources list grouped by category.
 */
function getResourcesByCategory() {
  const grouped = {};
  for (const [key, meta] of Object.entries(RESOURCES)) {
    if (!grouped[meta.category]) grouped[meta.category] = [];
    grouped[meta.category].push({ key, ...meta });
  }
  return grouped;
}

module.exports = {
  RESOURCES,
  ACTIONS,
  RESOURCE_ACTIONS,
  ROLE_PERMISSIONS,
  getBasePermissions,
  isBasePermission,
  getActionsForResource,
  getResourcesByCategory,
};
