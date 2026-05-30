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
  users:                 { label: 'Users',               category: 'Administration' },
  departments:           { label: 'Departments',          category: 'Administration' },
  roles:                 { label: 'Roles & Permissions',   category: 'Administration' },
  admin_settings:        { label: 'Admin Settings',        category: 'Administration' },
  api_keys:              { label: 'API Keys',              category: 'Administration' },
  workspaces:            { label: 'Workspaces',            category: 'Project Management' },
  boards:                { label: 'Boards',                category: 'Project Management' },
  tasks:                 { label: 'Tasks',                 category: 'Task Management' },
  subtasks:              { label: 'Subtasks',              category: 'Task Management' },
  task_comments:         { label: 'Task Comments',         category: 'Task Management' },
  task_files:            { label: 'Task Files',            category: 'Task Management' },
  task_links:            { label: 'Task Links',            category: 'Task Management' },
  task_references:       { label: 'Task References',       category: 'Task Management' },
  labels:                { label: 'Labels',                category: 'Task Management' },
  status_templates:      { label: 'Status Templates',      category: 'Task Management' },
  automations:           { label: 'Automations',           category: 'Task Management' },
  workflows:             { label: 'Workflow Canvas',        category: 'Task Management' },
  dependencies:          { label: 'Dependencies',          category: 'Task Management' },
  comments:              { label: 'Comments',              category: 'Collaboration' },
  recurring_work:        { label: 'Recurring Work',        category: 'Task Management' },
  dashboard:             { label: 'Dashboard & Analytics',  category: 'Reporting' },
  reports:               { label: 'Reports & Reviews',      category: 'Reporting' },
  exports:               { label: 'Exports & Downloads',    category: 'Reporting' },
  meetings:              { label: 'Meetings',              category: 'Collaboration' },
  notes:                 { label: 'Notes',                 category: 'Collaboration' },
  announcements:         { label: 'Announcements',         category: 'Collaboration' },
  approvals:             { label: 'Approvals & Requests',   category: 'Collaboration' },
  time_plan:             { label: 'Time Plan',             category: 'Planning' },
  timeline:              { label: 'Timeline / Gantt',      category: 'Planning' },
  calendar:              { label: 'Calendar',              category: 'Planning' },
  archive:               { label: 'Archive',               category: 'Operations' },
  integrations:          { label: 'Integrations',          category: 'Operations' },
  feedback:              { label: 'Feedback',              category: 'Operations' },
  org_chart:             { label: 'Org Chart',             category: 'Operations' },
  notifications:         { label: 'Notifications',         category: 'Operations' },
  search:                { label: 'Search',                category: 'Operations' },
  // ── System / no-surface resources (documented in catalog; not enforceable today)
  backup:                { label: 'Backup',                category: 'System' },
  system:                { label: 'System Logs / Health',  category: 'System' },
  browser_notifications: { label: 'Browser Notifications',  category: 'System' },
};

// ── All possible actions (display metadata) ──────────────────────────────
// Per-action display name + description. The action SEMANTIC (which one
// gates which app feature) is determined by the controller wiring; this
// table only drives the UI strings. Action-specific rules (grantability,
// dangerous, enforcement status, scopes) live in ACTION_META below.
const ACTIONS = {
  // ── Common verbs (apply to multiple resources) ──────────────────────
  view:                    { label: 'View',                       description: 'View/read access' },
  view_all:                { label: 'View all',                   description: 'View every instance (not just own/scoped)' },
  view_team:               { label: 'View team',                  description: 'View data for your team / direct reports' },
  view_history:            { label: 'View history',               description: 'View audit / change history' },
  view_activity:           { label: 'View activity',              description: 'View activity feed' },
  view_sensitive:          { label: 'View sensitive fields',      description: 'View sensitive fields like email, manager, designation' },
  view_sensitive_stats:    { label: 'View sensitive stats',       description: 'View sensitive aggregate stats' },
  view_effective:          { label: 'View effective permissions',  description: 'View another user\'s effective permissions' },
  view_all_results:        { label: 'View all search results',     description: 'See results outside your normal visibility scope' },
  view_restricted_results: { label: 'View restricted search results', description: 'See restricted/archived results in search' },
  create:                  { label: 'Create',                     description: 'Create new records' },
  edit:                    { label: 'Edit',                       description: 'Edit/update records (umbrella)' },
  delete:                  { label: 'Delete',                     description: 'Delete records (umbrella)' },
  manage:                  { label: 'Manage',                     description: 'Full management access (umbrella)' },
  export:                  { label: 'Export',                     description: 'Export/download data' },
  archive:                 { label: 'Archive',                    description: 'Soft-delete / archive' },
  restore:                 { label: 'Restore',                    description: 'Restore from archive' },
  permanent_delete:        { label: 'Permanently delete',         description: 'Hard delete from archive (irreversible)' },
  approve:                 { label: 'Approve',                    description: 'Approve a request' },
  reject:                  { label: 'Reject',                     description: 'Reject a request' },
  request:                 { label: 'Request',                    description: 'Create a request' },
  create_request:          { label: 'Create request',             description: 'Create an approval / access request' },
  delegate:                { label: 'Delegate',                   description: 'Delegate to another user' },
  use:                     { label: 'Use',                        description: 'Use this feature' },
  receive:                 { label: 'Receive',                    description: 'Receive notifications' },
  clear:                   { label: 'Clear',                      description: 'Clear/dismiss all' },
  manage_members:          { label: 'Manage members',             description: 'Add/remove members (umbrella)' },
  manage_settings:         { label: 'Manage settings',            description: 'Configure settings' },
  manage_structure:        { label: 'Manage structure',           description: 'Manage org-chart structure' },

  // ── Task field edits ────────────────────────────────────────────────
  edit_title:              { label: 'Edit task title',            description: 'Rename a task after creation' },
  edit_description:        { label: 'Edit task description',      description: 'Edit a task description (set-once for lower tiers)' },
  edit_locked_description: { label: 'Edit locked description',    description: 'Edit a task description after it has been set' },
  edit_status:             { label: 'Change status',              description: 'Change a task status (working_on_it / stuck / etc.)' },
  edit_priority:           { label: 'Change priority',             description: 'Change task priority (low/medium/high/critical)' },
  edit_start_date:         { label: 'Change start date',          description: 'Change a task start date' },
  edit_due_date:           { label: 'Change due date',            description: 'Change a task due date' },
  edit_timeline:           { label: 'Change timeline',            description: 'Change a task timeline (start + due together)' },
  edit_assignee:           { label: 'Edit assignee field',        description: 'Modify the task assignee value directly' },
  change_status:           { label: 'Change status (legacy)',     description: 'LEGACY umbrella — superseded by tasks.edit_status' },
  set_priority:            { label: 'Set priority (legacy)',      description: 'LEGACY umbrella — superseded by tasks.edit_priority' },

  // ── Task assignment ─────────────────────────────────────────────────
  assign:                  { label: 'Self-assign (legacy)',       description: 'LEGACY umbrella — superseded by tasks.assign_self' },
  assign_self:             { label: 'Assign task to self',        description: 'Add yourself as an assignee on an existing task' },
  assign_others:           { label: 'Assign task to others',      description: 'Assign tasks to other users' },
  unassign_self:           { label: 'Unassign self',              description: 'Remove yourself from a task\'s assignees' },
  unassign_others:         { label: 'Unassign others',            description: 'Remove other users from a task\'s assignees' },

  // ── Task lifecycle ──────────────────────────────────────────────────
  complete:                { label: 'Complete task',              description: 'Mark a task as done' },
  mark_incomplete:         { label: 'Mark incomplete',            description: 'Revert a task from done back to working' },
  approve_completion:      { label: 'Approve completion',          description: 'Approve a task completion submission' },
  reject_completion:       { label: 'Reject completion',           description: 'Reject a task completion submission' },
  reopen:                  { label: 'Reopen task',                description: 'Reopen a closed task' },
  move_between_groups:     { label: 'Move between groups',        description: 'Move a task to a different group' },
  move_between_boards:     { label: 'Move between boards',        description: 'Move a task to a different board' },
  reorder:                 { label: 'Reorder task',               description: 'Drag-reorder a task within a group' },
  bulk_edit:               { label: 'Bulk edit',                  description: 'Apply edits to multiple tasks at once' },
  bulk_delete:             { label: 'Bulk delete',                description: 'Delete multiple tasks at once' },
  create_for_self:         { label: 'Create task for self',       description: 'Create a new task with yourself as the initial assignee (FUTURE — not yet enforced)' },

  // ── Comments / labels / files (granular) ────────────────────────────
  comment:                 { label: 'Comment (legacy)',           description: 'LEGACY umbrella — superseded by comments.create' },
  edit_own:                { label: 'Edit own',                   description: 'Edit your own records' },
  edit_any:                { label: 'Edit any',                   description: 'Edit any record (not just your own)' },
  delete_own:              { label: 'Delete own',                 description: 'Delete your own records' },
  delete_any:              { label: 'Delete any',                 description: 'Delete any record (not just your own)' },
  add_to_task:             { label: 'Add to task',                description: 'Add a label / item to a task' },
  remove_from_task:        { label: 'Remove from task',           description: 'Remove a label / item from a task' },
  upload:                  { label: 'Upload (legacy)',            description: 'LEGACY umbrella — superseded by task_files.upload' },
  download:                { label: 'Download',                   description: 'Download a file' },
  access_private:          { label: 'Access private files',      description: 'Access files not directly attached to your visible tasks' },

  // ── Boards / workspaces ─────────────────────────────────────────────
  add_member:              { label: 'Add member',                 description: 'Add a member to a board' },
  remove_member:           { label: 'Remove member',              description: 'Remove a member from a board' },
  change_member_role:      { label: 'Change member role',         description: 'Change a member\'s role on a board' },
  create_group:            { label: 'Create group',               description: 'Create a new group on a board' },
  edit_group:              { label: 'Edit group',                 description: 'Rename or recolor a group' },
  delete_group:            { label: 'Delete group',               description: 'Delete a group from a board' },
  reorder_group:           { label: 'Reorder groups',             description: 'Drag-reorder groups on a board' },
  reorder_task:            { label: 'Reorder tasks',              description: 'Drag-reorder tasks (board-level)' },

  // ── User / role / permission management ─────────────────────────────
  activate:                { label: 'Activate user',              description: 'Activate a deactivated user' },
  deactivate:              { label: 'Deactivate user',            description: 'Deactivate an active user' },
  reset_password:          { label: 'Reset password',             description: 'Reset another user\'s password' },
  change_role:             { label: 'Change role',                description: 'Change a user\'s role' },
  change_tier:             { label: 'Change tier',                description: 'Change a user\'s tier (T1-T4)' },
  change_manager:          { label: 'Change manager',             description: 'Change a user\'s manager' },
  change_hierarchy:        { label: 'Change hierarchy level',     description: 'Change a user\'s hierarchy level' },
  change_super_admin:      { label: 'Change super-admin flag',    description: 'Grant or revoke super-admin' },
  grant:                   { label: 'Grant permission',           description: 'Issue a grant override' },
  deny:                    { label: 'Deny permission',            description: 'Issue a deny override' },
  revoke:                  { label: 'Revoke permission',          description: 'Revoke an existing override' },

  // ── API keys / integrations / system ────────────────────────────────
  rotate:                  { label: 'Rotate key',                 description: 'Rotate / regenerate' },

  // ── Approvals self-approval (LOCKED system rule) ────────────────────
  approve_own:             { label: 'Approve own requests',       description: 'LOCKED system rule — self-approval is permanently blocked' },
  reject_own:              { label: 'Reject own requests',        description: 'LOCKED system rule — self-rejection is permanently blocked' },

  // ── Recurring work ──────────────────────────────────────────────────
  generate_now:            { label: 'Generate now',               description: 'Manually trigger recurring task generation' },
  pause:                   { label: 'Pause',                      description: 'Pause a recurring template' },
  resume:                  { label: 'Resume',                     description: 'Resume a paused recurring template' },

  // ── Time planning ───────────────────────────────────────────────────
  edit_team:               { label: 'Edit team time plan',        description: 'Edit other users\' time plans' },

  // ── Workflow Canvas ────────────────────────────────────────────────
  publish:                 { label: 'Publish',                    description: 'Flip a draft workflow to active so the engine picks it up' },
  test_run:                { label: 'Test run',                   description: 'Author-driven synthetic run for canvas validation' },
};

// ── Valid actions for each resource ─────────────────────────────────────
//
// Each list contains BOTH the legacy umbrella actions (kept for backward
// compat with existing permission_grants rows) AND the new granular actions
// added in Phase 7. The umbrella resolution lives in `permissionEngine.js`
// `hasPermission`, which checks the specific action first and falls back to
// the umbrella via UMBRELLA_FALLBACKS below.
const RESOURCE_ACTIONS = {
  // ── Administration ─────────────────────────────────────────────────
  users:                 [
    'view', 'view_sensitive', 'create', 'edit', 'delete', 'manage',
    'activate', 'deactivate', 'reset_password',
    'change_role', 'change_tier', 'change_manager', 'change_hierarchy', 'change_super_admin',
  ],
  departments:           ['view', 'create', 'edit', 'delete'],
  roles:                 ['view', 'manage', 'grant', 'deny', 'revoke', 'view_history', 'view_effective'],
  admin_settings:        ['view', 'manage', 'edit'],
  api_keys:              ['view', 'create', 'rotate', 'delete', 'manage'],

  // ── Project Management ─────────────────────────────────────────────
  workspaces:            ['view', 'create', 'edit', 'delete', 'manage_members'],
  boards:                [
    'view', 'create', 'edit', 'delete', 'archive', 'restore',
    'manage_members', 'add_member', 'remove_member', 'change_member_role',
    'manage_settings', 'export',
    'create_group', 'edit_group', 'delete_group', 'reorder_group', 'reorder_task',
  ],

  // ── Task Management ────────────────────────────────────────────────
  tasks:                 [
    // Read
    'view', 'view_all', 'view_activity', 'view_history',
    // Create / lifecycle
    'create', 'create_for_self', 'edit', 'delete', 'archive', 'restore',
    // Field edits (legacy umbrellas + new granular)
    'edit_title', 'edit_description', 'edit_locked_description',
    'edit_status', 'edit_priority', 'edit_start_date', 'edit_due_date',
    'edit_timeline', 'edit_assignee',
    'change_status', 'set_priority',
    // Assignment
    'assign', 'assign_self', 'assign_others', 'unassign_self', 'unassign_others',
    // Lifecycle gestures
    'complete', 'mark_incomplete', 'approve_completion', 'reject_completion', 'reopen',
    // Bulk / move / reorder
    'move_between_groups', 'move_between_boards', 'reorder', 'bulk_edit', 'bulk_delete',
    // Legacy umbrellas
    'comment', 'upload', 'approve',
  ],
  subtasks:              ['view', 'create', 'edit', 'delete', 'assign', 'change_status'],
  task_comments:         [
    'view', 'create', 'edit', 'delete',
    'edit_own', 'edit_any', 'delete_own', 'delete_any',
  ],
  comments:              [
    'view', 'create', 'edit_own', 'edit_any', 'delete_own', 'delete_any',
  ],
  task_files:            [
    'view', 'view_all', 'access_private',
    'upload', 'download', 'delete', 'delete_own', 'delete_any',
  ],
  task_links:            ['view', 'create', 'edit', 'delete'],
  task_references:       ['view', 'create', 'edit', 'delete'],
  labels:                [
    'view', 'create', 'edit', 'delete',
    'add_to_task', 'remove_from_task',
  ],
  // Phase 2 — Status Tile Group (board-scoped). `view` covers reading the
  // template list for the create-task modal; `create/edit/delete` are the
  // T1/T2 write surface; `set_default` flags one template per board as the
  // board default (separate from edit so admins can demote/promote without
  // re-submitting the whole template).
  status_templates:      ['view', 'create', 'edit', 'delete', 'set_default'],
  automations:           ['view', 'create', 'edit', 'delete'],
  // Workflow Canvas — visual node-graph automation. `manage` is the umbrella
  // (mirrors api_keys/boards/integrations) so existing grant rows that use
  // `manage` continue to confer publish + test_run; the per-action surface
  // exists for finer overrides.
  workflows:             ['view', 'create', 'edit', 'delete', 'manage', 'publish', 'test_run'],
  dependencies:          [
    'view', 'create', 'edit', 'delete',
    'request', 'approve', 'reject', 'delegate',
  ],
  recurring_work:        [
    'view', 'create', 'edit', 'delete',
    'generate_now', 'pause', 'resume',
  ],

  // ── Reporting ──────────────────────────────────────────────────────
  dashboard:             ['view', 'view_team', 'view_all', 'view_sensitive_stats', 'export'],
  reports:               ['view', 'view_all', 'create', 'edit', 'delete', 'export'],
  exports:               ['view', 'export'],

  // ── Collaboration ──────────────────────────────────────────────────
  meetings:              ['view', 'create', 'edit', 'delete', 'manage'],
  notes:                 ['view', 'create', 'edit', 'delete'],
  announcements:         ['view', 'create', 'edit', 'delete'],
  approvals:             [
    'view', 'view_all', 'create_request', 'approve', 'reject', 'manage',
    'approve_own', 'reject_own', // LOCKED system rules
  ],

  // ── Planning ───────────────────────────────────────────────────────
  time_plan:             ['view', 'view_all', 'create', 'edit', 'edit_team', 'delete', 'manage'],
  timeline:              ['view', 'view_all', 'edit'],
  calendar:              ['view', 'view_all', 'edit'],

  // ── Operations ─────────────────────────────────────────────────────
  archive:               ['view', 'restore', 'permanent_delete', 'manage'],
  integrations:          ['view', 'edit', 'delete', 'manage'],
  feedback:              ['view', 'create', 'manage'],
  org_chart:             ['view', 'view_all', 'manage', 'manage_structure'],
  notifications:         ['view', 'manage', 'clear'],
  search:                ['use', 'view_all_results', 'view_restricted_results'],

  // ── System / no-surface (documented; not enforceable today) ───────
  backup:                ['view', 'create', 'restore', 'download'],
  system:                ['view_history'],
  browser_notifications: ['receive', 'manage'],
};

// ── Umbrella fallback mapping (Phase 7 — non-breaking migration) ────────
//
// New granular actions resolve through this map when no specific override
// exists for them. Example: a deny on `tasks.assign` (legacy umbrella) will
// still block `tasks.assign_self` because the engine consults the umbrella
// after the specific action check returns "no override". This preserves
// every existing permission_grants row while letting admins add finer
// overrides on top.
//
// Format: 'resource.action' (granular) → { resource, action } (umbrella)
// Leave entries OUT for actions that ARE umbrellas themselves (no fallback).
const UMBRELLA_FALLBACKS = {
  // Tasks — assignment
  'tasks.assign_self':         { resource: 'tasks', action: 'assign' },
  'tasks.unassign_self':       { resource: 'tasks', action: 'assign' },
  'tasks.unassign_others':     { resource: 'tasks', action: 'assign_others' },

  // Tasks — field edits
  'tasks.edit_title':          { resource: 'tasks', action: 'edit' },
  'tasks.edit_description':    { resource: 'tasks', action: 'edit' },
  'tasks.edit_status':         { resource: 'tasks', action: 'change_status' },
  'tasks.edit_priority':       { resource: 'tasks', action: 'set_priority' },
  'tasks.edit_start_date':     { resource: 'tasks', action: 'edit' },
  'tasks.edit_due_date':       { resource: 'tasks', action: 'edit' },
  'tasks.edit_timeline':       { resource: 'tasks', action: 'edit' },
  'tasks.edit_assignee':       { resource: 'tasks', action: 'assign_others' },

  // Tasks — lifecycle
  'tasks.complete':            { resource: 'tasks', action: 'change_status' },
  'tasks.mark_incomplete':     { resource: 'tasks', action: 'change_status' },
  'tasks.reopen':              { resource: 'tasks', action: 'change_status' },
  'tasks.approve_completion':  { resource: 'tasks', action: 'approve' },
  'tasks.reject_completion':   { resource: 'tasks', action: 'approve' },
  'tasks.archive':             { resource: 'tasks', action: 'delete' },
  'tasks.restore':             { resource: 'tasks', action: 'delete' },
  'tasks.move_between_groups': { resource: 'tasks', action: 'edit' },
  'tasks.move_between_boards': { resource: 'tasks', action: 'edit' },
  'tasks.reorder':             { resource: 'tasks', action: 'edit' },
  'tasks.bulk_edit':           { resource: 'tasks', action: 'edit' },
  'tasks.bulk_delete':         { resource: 'tasks', action: 'delete' },
  'tasks.view_activity':       { resource: 'tasks', action: 'view' },
  'tasks.view_history':        { resource: 'tasks', action: 'view' },
  'tasks.view_all':            { resource: 'tasks', action: 'view' },

  // Comments — own/any split
  'comments.create':           { resource: 'tasks', action: 'comment' },
  'comments.edit_own':         { resource: 'task_comments', action: 'edit' },
  'comments.edit_any':         { resource: 'task_comments', action: 'edit' },
  'comments.delete_own':       { resource: 'task_comments', action: 'delete' },
  'comments.delete_any':       { resource: 'task_comments', action: 'delete' },
  'task_comments.edit_own':    { resource: 'task_comments', action: 'edit' },
  'task_comments.edit_any':    { resource: 'task_comments', action: 'edit' },
  'task_comments.delete_own':  { resource: 'task_comments', action: 'delete' },
  'task_comments.delete_any':  { resource: 'task_comments', action: 'delete' },

  // Task files — granular
  'task_files.upload':         { resource: 'tasks', action: 'upload' },
  'task_files.delete_own':     { resource: 'task_files', action: 'delete' },
  'task_files.delete_any':     { resource: 'task_files', action: 'delete' },

  // Labels — task-level operations
  'labels.add_to_task':        { resource: 'labels', action: 'create' },
  'labels.remove_from_task':   { resource: 'labels', action: 'edit' },

  // Dependencies — split create/approve/reject
  'dependencies.approve':      { resource: 'dependencies', action: 'create' },
  'dependencies.reject':       { resource: 'dependencies', action: 'create' },
  'dependencies.request':      { resource: 'dependencies', action: 'create' },
  'dependencies.delegate':     { resource: 'dependencies', action: 'create' },
  'dependencies.edit':         { resource: 'dependencies', action: 'create' },

  // Boards — member / group ops
  'boards.add_member':         { resource: 'boards', action: 'manage_members' },
  'boards.remove_member':      { resource: 'boards', action: 'manage_members' },
  'boards.change_member_role': { resource: 'boards', action: 'manage_members' },
  'boards.create_group':       { resource: 'boards', action: 'edit' },
  'boards.edit_group':         { resource: 'boards', action: 'edit' },
  'boards.delete_group':       { resource: 'boards', action: 'delete' },
  'boards.reorder_group':      { resource: 'boards', action: 'edit' },
  'boards.reorder_task':       { resource: 'boards', action: 'edit' },
  'boards.archive':            { resource: 'boards', action: 'delete' },
  'boards.restore':            { resource: 'boards', action: 'delete' },

  // Recurring — base on tasks
  'recurring_work.view':       { resource: 'tasks', action: 'view' },
  'recurring_work.create':     { resource: 'tasks', action: 'create' },
  'recurring_work.edit':       { resource: 'tasks', action: 'edit' },
  'recurring_work.delete':     { resource: 'tasks', action: 'delete' },
  'recurring_work.pause':      { resource: 'tasks', action: 'edit' },
  'recurring_work.resume':     { resource: 'tasks', action: 'edit' },
  'recurring_work.generate_now': { resource: 'tasks', action: 'manage' },

  // Users — granular field-mgmt actions umbrella to users.manage so T1/T2
  // keep their current defaults.
  'users.view_sensitive':      { resource: 'users', action: 'view' },
  'users.activate':            { resource: 'users', action: 'manage' },
  'users.deactivate':          { resource: 'users', action: 'manage' },
  'users.reset_password':      { resource: 'users', action: 'manage' },
  'users.change_role':         { resource: 'users', action: 'manage' },
  'users.change_tier':         { resource: 'users', action: 'manage' },
  'users.change_manager':      { resource: 'users', action: 'edit' },
  'users.change_hierarchy':    { resource: 'users', action: 'edit' },
  'users.change_super_admin':  { resource: 'users', action: 'manage' },

  // Roles & permissions — granular umbrella to roles.manage
  'roles.grant':               { resource: 'roles', action: 'manage' },
  'roles.deny':                { resource: 'roles', action: 'manage' },
  'roles.revoke':              { resource: 'roles', action: 'manage' },
  'roles.view_history':        { resource: 'roles', action: 'view' },
  'roles.view_effective':      { resource: 'roles', action: 'view' },

  // Admin / system aliases
  'admin_settings.edit':       { resource: 'admin_settings', action: 'manage' },
  'integrations.edit':         { resource: 'integrations', action: 'manage' },
  'integrations.delete':       { resource: 'integrations', action: 'manage' },
  'api_keys.rotate':           { resource: 'api_keys', action: 'manage' },

  // Tasks — extra granular
  'tasks.view_all':            { resource: 'tasks', action: 'view' },
  'tasks.view_activity':       { resource: 'tasks', action: 'view' },
  'tasks.view_history':        { resource: 'tasks', action: 'view' },
  'tasks.bulk_delete':         { resource: 'tasks', action: 'delete' },
  'tasks.approve_completion':  { resource: 'tasks', action: 'approve' },
  'tasks.reject_completion':   { resource: 'tasks', action: 'approve' },
  'tasks.reorder':             { resource: 'tasks', action: 'edit' },

  // Workflow Canvas — finer actions umbrella to workflows.manage so any
  // existing manage grant carries publish + test_run by default. edit/create/
  // delete/view stay on the specific action.
  'workflows.publish':         { resource: 'workflows', action: 'manage' },
  'workflows.test_run':        { resource: 'workflows', action: 'manage' },

  // Files / comments granular delete_any
  'task_files.view':           { resource: 'tasks', action: 'view' },
  'task_files.delete_any':     { resource: 'task_files', action: 'delete' },
  'comments.view':             { resource: 'tasks', action: 'view' },
  'comments.delete_any':       { resource: 'task_comments', action: 'delete' },
};

// ── ACTION_META (Phase 7 — per-action display + behavior config) ────────
//
// Only entries that DIVERGE from sensible defaults need to live here.
// Defaults applied when an entry is missing:
//   enforcement:  'wired'  (assume enforced unless marked otherwise)
//   dangerous:    false
//   systemOnly:   false
//   warnOnDeny:   false
//   scopes:       ['global', 'workspace', 'board']
//
// enforcement values:
//   'wired'      — backend gate exists; can be granted/denied via UI
//   'pending'    — catalog entry but not yet enforced; save REJECTED
//   'no_surface' — no app feature to gate; save REJECTED
//   'locked'     — system rule; default deny everyone; never settable
const ACTION_META = {
  tasks: {
    // Wired — Phase 7 + Phase B headline actions
    assign_self:             { enforcement: 'wired', warnOnDeny: true,  scopes: ['global', 'workspace', 'board'] },
    assign_others:           { enforcement: 'wired', dangerous: true,  scopes: ['global', 'workspace', 'board'] },
    unassign_self:           { enforcement: 'wired', scopes: ['global', 'workspace', 'board'] },
    unassign_others:         { enforcement: 'wired', dangerous: true, scopes: ['global', 'workspace', 'board'] },
    edit_status:             { enforcement: 'wired', warnOnDeny: true },
    edit_priority:           { enforcement: 'wired' },
    edit_start_date:         { enforcement: 'wired' },
    edit_due_date:           { enforcement: 'wired' },
    edit_title:              { enforcement: 'wired' },           // Phase B
    edit_description:        { enforcement: 'wired' },           // Phase B
    edit_timeline:           { enforcement: 'wired' },           // Phase B
    edit_assignee:           { enforcement: 'wired' },           // Phase B
    complete:                { enforcement: 'wired', warnOnDeny: true },
    mark_incomplete:         { enforcement: 'wired' },
    reopen:                  { enforcement: 'wired' },
    archive:                 { enforcement: 'wired', dangerous: true },
    restore:                 { enforcement: 'wired' },
    move_between_groups:     { enforcement: 'wired' },
    move_between_boards:     { enforcement: 'wired', dangerous: true },
    bulk_edit:               { enforcement: 'wired', dangerous: true },
    bulk_delete:             { enforcement: 'wired', dangerous: true },  // Phase B
    edit_locked_description: { enforcement: 'wired', dangerous: true },
    reorder:                 { enforcement: 'wired' },           // Phase B
    view_activity:           { enforcement: 'wired' },           // Phase B
    view_history:            { enforcement: 'wired' },           // Phase B — same surface as view_activity
    approve_completion:      { enforcement: 'wired' },           // Phase B
    reject_completion:       { enforcement: 'wired' },           // Phase B
    // Genuinely future / no current single endpoint
    view_all:                { enforcement: 'pending', description: 'FUTURE — no separate cross-org task-view endpoint exists; visibility is computed per-tier today.' },
    create_for_self:         { enforcement: 'pending', description: 'FUTURE — gate creation-time self-assign separately from tasks.create' },
  },
  labels: {
    add_to_task:             { enforcement: 'wired' },
    remove_from_task:        { enforcement: 'wired' },
  },
  task_files: {
    view:                    { enforcement: 'wired' },           // Phase B
    upload:                  { enforcement: 'wired' },
    download:                { enforcement: 'wired' },
    delete_own:              { enforcement: 'wired' },
    delete_any:              { enforcement: 'wired', dangerous: true }, // Phase B
    // No "view all task files across org" or "access private files" surfaces
    // exist in fileController today — kept as no_surface for honesty.
    view_all:                { enforcement: 'no_surface', description: 'No cross-org file-list endpoint exists today.' },
    access_private:          { enforcement: 'no_surface', dangerous: true, description: 'No private-files feature exists today.' },
  },
  comments: {
    create:                  { enforcement: 'wired' },
    delete_own:              { enforcement: 'wired' },
    delete_any:              { enforcement: 'wired', dangerous: true }, // Phase B
    view:                    { enforcement: 'wired' },                  // Phase B
    // No comment-edit endpoint exists in commentController today.
    // Marking no_surface so admins see "Not enforceable" rather than
    // "Pending — coming soon"; if the edit endpoint is added later,
    // flip these to 'wired'.
    edit_own:                { enforcement: 'no_surface', description: 'No edit-comment endpoint exists today.' },
    edit_any:                { enforcement: 'no_surface', dangerous: true, description: 'No edit-comment endpoint exists today.' },
  },
  task_comments: {
    edit_own:                { enforcement: 'pending' },
    edit_any:                { enforcement: 'pending', dangerous: true },
    delete_own:              { enforcement: 'pending' },
    delete_any:              { enforcement: 'pending', dangerous: true },
  },
  dependencies: {
    create:                  { enforcement: 'wired' },
    approve:                 { enforcement: 'wired' },
    reject:                  { enforcement: 'wired' },
    edit:                    { enforcement: 'wired' },           // Phase B
    request:                 { enforcement: 'wired' },           // Phase B
    delegate:                { enforcement: 'wired' },           // Phase B
  },
  boards: {
    add_member:              { enforcement: 'wired' },
    remove_member:            { enforcement: 'wired' },
    create_group:            { enforcement: 'wired' },
    edit_group:              { enforcement: 'wired' },
    delete_group:            { enforcement: 'wired', dangerous: true }, // Phase B — gated in updateBoard groups-array shrink
    archive:                 { enforcement: 'wired' },           // Phase B
    restore:                 { enforcement: 'wired' },           // Phase B
    reorder_group:           { enforcement: 'wired' },           // Phase B — both updateBoard groups-array and reorderGroups endpoint
    // No dedicated endpoint today — kept pending until a separate per-task
    // reorder endpoint exists (different from tasks.reorder which is
    // already wired at the task level).
    reorder_task:            { enforcement: 'pending', description: 'Covered today by tasks.reorder at task level; no board-level reorder endpoint exists.' },
    // No "change member role" endpoint exists — board membership is binary
    // (member/not-member) in the data model. Marking no_surface.
    change_member_role:      { enforcement: 'no_surface', description: 'Board membership is binary in the schema — there is no per-board role concept to change.' },
  },
  task_links: {
    view: { enforcement: 'pending' },
    create: { enforcement: 'pending' },
    edit: { enforcement: 'pending' },
    delete: { enforcement: 'pending' },
  },
  task_references: {
    view: { enforcement: 'pending' },
    create: { enforcement: 'pending' },
    edit: { enforcement: 'pending' },
    delete: { enforcement: 'pending' },
  },
  // Workflow Canvas — Phase W1 + audit follow-up. All actions are wired
  // through routes/workflows.js + workflowController + workflowEngine.
  // `publish` and `test_run` are flagged dangerous because they cause real
  // side effects (engine fan-out to notifications / task mutations / Teams).
  workflows: {
    view:     { enforcement: 'wired' },
    create:   { enforcement: 'wired' },
    edit:     { enforcement: 'wired' },
    delete:   { enforcement: 'wired', dangerous: true },
    manage:   { enforcement: 'wired' },
    publish:  { enforcement: 'wired', dangerous: true },
    test_run: { enforcement: 'wired', dangerous: true },
  },
  recurring_work: {
    view:         { enforcement: 'wired' },                              // Phase B
    create:       { enforcement: 'wired' },                              // Phase B
    edit:         { enforcement: 'wired' },                              // Phase B
    delete:       { enforcement: 'wired', dangerous: true },             // Phase B
    generate_now: { enforcement: 'wired', dangerous: true, systemOnly: true }, // Phase B
    pause:        { enforcement: 'wired' },                              // Phase B
    resume:       { enforcement: 'wired' },                              // Phase B
  },
  users: {
    view_sensitive:     { enforcement: 'wired', dangerous: true },       // Phase B
    activate:           { enforcement: 'wired' },                        // Phase B
    deactivate:         { enforcement: 'wired', dangerous: true },       // Phase B
    reset_password:     { enforcement: 'wired', dangerous: true },       // Phase B
    change_role:        { enforcement: 'wired', dangerous: true },       // Phase B
    change_tier:        { enforcement: 'wired', dangerous: true },       // Phase B
    change_manager:     { enforcement: 'wired' },                        // Phase B
    change_hierarchy:   { enforcement: 'wired' },                        // Phase B
    change_super_admin: { enforcement: 'wired', dangerous: true, systemOnly: true }, // Phase B
  },
  roles: {
    grant:          { enforcement: 'pending', dangerous: true },
    deny:           { enforcement: 'pending', dangerous: true },
    revoke:         { enforcement: 'pending', dangerous: true },
    view_history:   { enforcement: 'pending' },
    view_effective: { enforcement: 'pending' },
  },
  admin_settings: {
    edit: { enforcement: 'pending', dangerous: true },
  },
  api_keys: {
    rotate: { enforcement: 'pending', dangerous: true },
  },
  integrations: {
    edit:   { enforcement: 'pending', dangerous: true },
    delete: { enforcement: 'pending', dangerous: true },
  },
  approvals: {
    view:           { enforcement: 'pending' },
    create_request: { enforcement: 'pending' },
    approve:        { enforcement: 'pending' },
    reject:         { enforcement: 'pending' },
    view_all:       { enforcement: 'pending' },
    manage:         { enforcement: 'pending' },
    // LOCKED — self-approval is permanently blocked at the controller level.
    // These entries exist purely for documentation in the catalog so the UI
    // can show the rule and explain why it can't be granted.
    approve_own:    { enforcement: 'locked', dangerous: true, systemOnly: true },
    reject_own:     { enforcement: 'locked', dangerous: true, systemOnly: true },
  },
  dashboard: {
    view_team:            { enforcement: 'pending' },
    view_all:             { enforcement: 'pending' },
    view_sensitive_stats: { enforcement: 'pending', dangerous: true },
  },
  reports: {
    view_all: { enforcement: 'pending' },
    create:   { enforcement: 'pending' },
    edit:     { enforcement: 'pending' },
    delete:   { enforcement: 'pending', dangerous: true },
  },
  time_plan: {
    view_all:  { enforcement: 'pending' },
    edit_team: { enforcement: 'pending' },
  },
  timeline: {
    view_all: { enforcement: 'pending' },
    edit:     { enforcement: 'pending' },
  },
  calendar: {
    view:     { enforcement: 'pending' },
    view_all: { enforcement: 'pending' },
    edit:     { enforcement: 'pending' },
  },
  org_chart: {
    view_all:         { enforcement: 'pending' },
    manage_structure: { enforcement: 'pending', dangerous: true },
  },
  notifications: {
    clear: { enforcement: 'pending' },
  },
  archive: {
    restore:           { enforcement: 'pending' },
    permanent_delete:  { enforcement: 'pending', dangerous: true, systemOnly: true },
  },
  search: {
    use:                     { enforcement: 'pending' },
    view_all_results:        { enforcement: 'pending' },
    view_restricted_results: { enforcement: 'pending', dangerous: true },
  },
  // ── no_surface resources — documented in catalog; cannot be wired ──
  backup: {
    view:     { enforcement: 'no_surface', systemOnly: true },
    create:   { enforcement: 'no_surface', systemOnly: true, dangerous: true },
    restore:  { enforcement: 'no_surface', systemOnly: true, dangerous: true },
    download: { enforcement: 'no_surface', systemOnly: true, dangerous: true },
  },
  system: {
    view_history: { enforcement: 'no_surface', systemOnly: true },
  },
  browser_notifications: {
    receive: { enforcement: 'no_surface', systemOnly: true },
    manage:  { enforcement: 'no_surface', systemOnly: true },
  },
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
    tasks:            { view: true, create: true, edit: true, delete: true, assign: true, assign_others: true, set_priority: true, change_status: true, comment: true, upload: true, approve: true },
    subtasks:         { view: true, create: true, edit: true, delete: true },
    task_comments:    { view: true, create: true, edit: true, delete: true },
    task_files:       { view: true, upload: true, delete: true },
    // labels.delete moved to T1-only (May 2026 v2 product decision). Legacy
    // admin role maps to T2 in the tier model; the canonical T2 base also
    // has labels.delete=false, so this legacy row mirrors the new rule for
    // pre-migration users without a tier column.
    labels:           { view: true, create: true, edit: true, delete: false },
    status_templates: { view: true, create: true, edit: true, delete: true, set_default: true },
    automations:      { view: true, create: true, edit: true, delete: true },
    workflows:        { view: true, create: true, edit: true, delete: true, manage: true, publish: true, test_run: true },
    dependencies:     { view: true, create: true, delete: true },
    dashboard:        { view: true, export: true },
    reports:          { view: true, export: true },
    exports:          { view: true, export: true },
    meetings:         { view: true, create: true, edit: true, delete: true, manage: true },
    notes:            { view: true, create: true, edit: true, delete: true },
    announcements:    { view: true, create: true, edit: true, delete: true },
    time_plan:        { view: true, create: true, edit: true, delete: true, manage: true },
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
    tasks:            { view: true, create: true, edit: true, delete: true, assign: true, assign_others: true, set_priority: true, change_status: true, comment: true, upload: true, approve: true },
    subtasks:         { view: true, create: true, edit: true, delete: true },
    task_comments:    { view: true, create: true, edit: true, delete: true },
    task_files:       { view: true, upload: true, delete: true },
    // labels.delete moved to T1-only (May 2026 v2 product decision).
    // Manager role maps to T2; canonical T2.labels.delete=false. Legacy
    // pre-migration users (no tier column) follow the same rule here.
    labels:           { view: true, create: true, edit: true, delete: false },
    status_templates: { view: true, create: true, edit: true, delete: true, set_default: true },
    automations:      { view: true, create: true, edit: true, delete: true },
    workflows:        { view: true, create: true, edit: true, delete: true, manage: true, publish: true, test_run: true },
    dependencies:     { view: true, create: true, delete: true },
    dashboard:        { view: true, export: true },
    reports:          { view: true, export: true },
    exports:          { view: true, export: true },
    meetings:         { view: true, create: true, edit: true, delete: true, manage: true },
    notes:            { view: true, create: true, edit: true, delete: true },
    announcements:    { view: true, create: true, edit: true, delete: true },
    time_plan:        { view: true, create: true, edit: true, delete: true, manage: true },
    timeline:         { view: true },
    archive:          { view: true, manage: true },
    integrations:     { view: false, manage: false },
    feedback:         { view: true, create: true, manage: true },
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
    // boards.create is now base-allowed: assistant managers can spin up a
    // board inside a workspace they can access. The createBoard controller
    // still verifies workspace access for non-admin/manager actors so they
    // cannot drop a board into a workspace they are not entitled to see.
    // edit/delete/manage_members/manage_settings/export remain false — those
    // are management-only actions (rename/archive/reorder groups, member
    // management, settings, exports) and have not been loosened.
    boards:           { view: true, create: true,  edit: false, delete: false, manage_members: false, manage_settings: false, export: false, create_group: true },
    // tasks.approve = true: assistant_managers are walked into the approval
    // chain as sequential approvers for their direct reports. Per-task chain
    // membership is enforced inside processApprovalAction; this just unlocks
    // the `tasks.approve_completion` route gate. Mirrors TIER_PERMISSIONS[3].
    tasks:            { view: true, create: true, edit: true, delete: true, assign: true, assign_others: true, set_priority: true, change_status: true, comment: true, upload: true, approve: true },
    subtasks:         { view: true, create: true, edit: true, delete: true },
    task_comments:    { view: true, create: true, edit: true, delete: true },
    task_files:       { view: true, upload: true, delete: true },
    // labels.create widened to true (May 2026 v2 — every contributor can
    // mint labels via the picker; library rename/recolor still T2+ via the
    // route-level `managerOrAdmin` gate). Mirrors TIER_PERMISSIONS[3].
    labels:           { view: true, create: true, edit: false, delete: false, add_to_task: true, remove_from_task: true },
    status_templates: { view: true, create: false, edit: false, delete: false, set_default: false },
    automations:      { view: false, create: false, edit: false, delete: false },
    // Workflow Canvas — T3 default = no access. Sidebar entry hidden unless
    // an explicit `workflows.view` grant is issued via PermissionGrant.
    workflows:        { view: false, create: false, edit: false, delete: false, manage: false, publish: false, test_run: false },
    dependencies:     { view: true, create: true, delete: false },
    dashboard:        { view: true, export: false },
    reports:          { view: true, export: false },
    exports:          { view: false, export: false },
    meetings:         { view: true, create: true, edit: true, delete: true, manage: false },
    notes:            { view: true, create: true, edit: true, delete: true },
    announcements:    { view: true, create: false, edit: false, delete: false },
    time_plan:        { view: true, create: true, edit: true, delete: true, manage: false },
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
    // boards.create is now base-allowed: members can create their own board
    // inside a workspace they can already access. The createBoard controller
    // verifies workspace access for non-admin/manager actors. boards.edit
    // remains false so members cannot rename/archive/reorder groups via
    // PUT /boards/:id — addGroup uses a separate per-board route guarded by
    // boardVisibilityService.canUserSeeBoard instead.
    boards:           { view: true, create: true,  edit: false, delete: false, manage_members: false, manage_settings: false, export: false, create_group: true },
    // Members can create their own tasks and self-assign. Editing applies to
    // their own/self-assigned tasks only — controllers enforce the field-level
    // whitelist; assigning OTHERS requires the explicit assign_others grant.
    // set_priority is reserved for management roles by default — members
    // should not set priority on a task (mirrors the product rule that
    // priority is a planning concern owned by leads).
    tasks:            { view: true, create: true, edit: true, delete: false, assign: true, assign_others: false, set_priority: false, change_status: true, comment: true, upload: true, approve: false },
    subtasks:         { view: true, create: true, edit: true, delete: false },
    task_comments:    { view: true, create: true, edit: false, delete: false },
    task_files:       { view: true, upload: true, delete: false },
    // labels.create + dependencies.create widened to true (May 2026 v2 — every
    // contributor can mint labels via the picker AND request blocking work
    // from teammates). Library rename/recolor still T2+ via the route-level
    // `managerOrAdmin` gate; permanent label/dependency delete still T1-only.
    // Mirrors TIER_PERMISSIONS[4].
    labels:           { view: true, create: true, edit: false, delete: false, add_to_task: true, remove_from_task: true },
    status_templates: { view: true, create: false, edit: false, delete: false, set_default: false },
    automations:      { view: false, create: false, edit: false, delete: false },
    // Workflow Canvas — T4 default = no access (same as T3). Sidebar entry
    // hidden unless an explicit `workflows.view` grant is issued.
    workflows:        { view: false, create: false, edit: false, delete: false, manage: false, publish: false, test_run: false },
    dependencies:     { view: true, create: true, delete: false },
    dashboard:        { view: false, export: false },
    reports:          { view: true, export: false },
    exports:          { view: false, export: false },
    meetings:         { view: true, create: true, edit: false, delete: false, manage: false },
    notes:            { view: true, create: true, edit: true, delete: true },
    announcements:    { view: true, create: false, edit: false, delete: false },
    time_plan:        { view: true, create: true, edit: true, delete: true, manage: false },
    timeline:         { view: true },
    archive:          { view: false, manage: false },
    integrations:     { view: false, manage: false },
    feedback:         { view: false, create: true, manage: false },
    org_chart:        { view: true, manage: false },
    notifications:    { view: true, manage: false },
    api_keys:         { view: false, create: false, delete: false, manage: false },
  },
};

// ── Tier-based permissions (Phase 4 of role -> tier RBAC migration) ──────
//
// CANONICAL going forward. Currently NOT yet read by the permission engine
// (engine flips in Phase 5). Provided as data + helpers so callers, tests,
// and future audits can verify the agreed product rules.
//
// Encoded rules (per confirmed product decisions):
//   - Tier 1 (was super admin): full access. Every action = true.
//   - Tier 2 (was admin + manager): broad access EXCEPT
//       * Every `delete` action      -> false   (decision #4)
//       * archive.manage             -> false   (manage = restore/permanent-delete = destructive)
//       * notifications.manage       -> false   (manage = clear/delete = destructive)
//       * admin_settings.{view,manage}, integrations.{view,manage},
//         api_keys.* (system administration — Tier 1 only)
//       * tasks.edit_locked_description -> TRUE (decision #10 revised: T1+T2 may
//         override the description set-once lock; T3+T4 remain blocked.)
//       * Director plan: T1+T2 (decision #6) — kept true
//       * Feedback: T1+T2 (decision #5) — kept true incl. manage
//   - Tier 3 (was assistant_manager): subtree-scoped management.
//       * Matrix grants are coarse — subtree scoping is enforced by visibility
//         services in controllers. Matrix entries match the previous
//         assistant_manager row EXCEPT every destructive `delete` is tightened
//         to false (decision #4: "no delete unless explicitly safe and scoped").
//       * Personal data delete (notes, time_plan) preserved — matches the rule
//         that everyone manages their own scratch data.
//   - Tier 4 (was member): identical to the previous member row. The
//     "create on stranger board" escalation path is fixed in Phase 5
//     controllers — no matrix change needed.
//
// Trade-off note: Tier 2 cannot delete its OWN notes / time blocks here. This
// follows the strict reading of decision #4 ("Tier 2 must not delete anything,
// anywhere"). If product later wants to relax for personal scratch data, this
// is the single file to edit.
const TIER_PERMISSIONS = {
  // ── Tier 1 — full system access (was: isSuperAdmin=true) ────────────────
  1: {
    users:            { view: true, create: true, edit: true, delete: true, manage: true },
    departments:      { view: true, create: true, edit: true, delete: true },
    roles:            { view: true, manage: true },
    admin_settings:   { view: true, manage: true },
    workspaces:       { view: true, create: true, edit: true, delete: true, manage_members: true },
    boards:           { view: true, create: true, edit: true, delete: true, manage_members: true, manage_settings: true, export: true, create_group: true },
    tasks:            { view: true, create: true, edit: true, delete: true, assign: true, assign_others: true, set_priority: true, change_status: true, comment: true, upload: true, approve: true, edit_locked_description: true },
    subtasks:         { view: true, create: true, edit: true, delete: true },
    task_comments:    { view: true, create: true, edit: true, delete: true },
    task_files:       { view: true, upload: true, delete: true },
    labels:           { view: true, create: true, edit: true, delete: true },
    status_templates: { view: true, create: true, edit: true, delete: true, set_default: true },
    automations:      { view: true, create: true, edit: true, delete: true },
    workflows:        { view: true, create: true, edit: true, delete: true, manage: true, publish: true, test_run: true },
    dependencies:     { view: true, create: true, delete: true },
    dashboard:        { view: true, export: true },
    reports:          { view: true, export: true },
    exports:          { view: true, export: true },
    meetings:         { view: true, create: true, edit: true, delete: true, manage: true },
    notes:            { view: true, create: true, edit: true, delete: true },
    announcements:    { view: true, create: true, edit: true, delete: true },
    time_plan:        { view: true, create: true, edit: true, delete: true, manage: true },
    timeline:         { view: true },
    archive:          { view: true, manage: true },
    integrations:     { view: true, manage: true },
    feedback:         { view: true, create: true, manage: true },
    org_chart:        { view: true, manage: true },
    notifications:    { view: true, manage: true },
    api_keys:         { view: true, create: true, delete: true, manage: true },
  },

  // ── Tier 2 — broad management, NO destructive ops (was: admin + manager) ─
  2: {
    users:            { view: true, create: true, edit: true, delete: false, manage: true },
    departments:      { view: true, create: true, edit: true, delete: false },
    roles:            { view: true, manage: true },
    // Admin Settings / Integrations / API Keys are system-administration
    // surfaces — Tier 1 only per migration plan §3.1 (accepted by product).
    admin_settings:   { view: false, manage: false },
    workspaces:       { view: true, create: true, edit: true, delete: false, manage_members: true },
    boards:           { view: true, create: true, edit: true, delete: false, manage_members: true, manage_settings: true, export: true, create_group: true },
    // edit_locked_description is T1+T2 (decision #10 revised — Tier 1 and Tier 2
    // may rewrite an already-set task description; Tier 3/Tier 4 are blocked.)
    tasks:            { view: true, create: true, edit: true, delete: false, assign: true, assign_others: true, set_priority: true, change_status: true, comment: true, upload: true, approve: true, edit_locked_description: true },
    subtasks:         { view: true, create: true, edit: true, delete: false },
    task_comments:    { view: true, create: true, edit: true, delete: false },
    task_files:       { view: true, upload: true, delete: false },
    // Label management — Tier 2 can create/edit and apply/remove on tasks,
    // but permanent deletion of a label from the global label list is now
    // Tier 1 ONLY (May 2026 v2 product decision — reversed the earlier T2
    // carveout). Rationale: deleting a label cascades-detaches it from every
    // task that referenced it, which is genuinely destructive for cross-team
    // boards. Curation (rename / recolor / archive-by-disuse) remains T2.
    labels:           { view: true, create: true, edit: true, delete: false, add_to_task: true, remove_from_task: true },
    status_templates: { view: true, create: true, edit: true, delete: true, set_default: true },
    automations:      { view: true, create: true, edit: true, delete: false },
    // Workflow Canvas — T2 keeps full functional access EXCEPT delete is
    // tightened to false to match decision #4 ("Tier 2 must not delete
    // anything, anywhere"). Publish + test_run remain true.
    workflows:        { view: true, create: true, edit: true, delete: false, manage: true, publish: true, test_run: true },
    dependencies:     { view: true, create: true, delete: false },
    dashboard:        { view: true, export: true },
    reports:          { view: true, export: true },
    exports:          { view: true, export: true },
    meetings:         { view: true, create: true, edit: true, delete: false, manage: true },
    notes:            { view: true, create: true, edit: true, delete: false },
    announcements:    { view: true, create: true, edit: true, delete: false },
    time_plan:        { view: true, create: true, edit: true, delete: false, manage: true },
    timeline:         { view: true },
    // archive.manage = restore + permanent-delete -> destructive.
    archive:          { view: true, manage: false },
    integrations:     { view: false, manage: false },
    feedback:         { view: true, create: true, manage: true },
    org_chart:        { view: true, manage: true },
    // notifications.manage covers clear-all/delete -> destructive.
    notifications:    { view: true, manage: false },
    api_keys:         { view: false, create: false, delete: false, manage: false },
  },

  // ── Tier 3 — subtree-scoped management (was: assistant_manager) ────────
  // Subtree scoping is enforced by controllers (taskVisibilityService, etc.);
  // matrix entries express "what coarse permissions exist". Destructive
  // actions are tightened to false per decision #4.
  3: {
    users:            { view: true, create: false, edit: false, delete: false, manage: false },
    departments:      { view: true, create: false, edit: false, delete: false },
    roles:            { view: false, manage: false },
    admin_settings:   { view: false, manage: false },
    workspaces:       { view: true, create: false, edit: false, delete: false, manage_members: false },
    // boards.create allowed; controller verifies workspace scope (decision #7).
    // create_group: true — every tier that can see a board may add groups to
    // it. addGroup controller pre-gates via boardVisibilityService.canUserSeeBoard,
    // so this explicit entry just stops the umbrella fallback (which would
    // otherwise inherit boards.edit=false) from blocking T3.
    boards:           { view: true, create: true, edit: false, delete: false, manage_members: false, manage_settings: false, export: false, create_group: true },
    // tasks.delete tightened to false (decision #4, no destructive without scope proof).
    // tasks.approve = true: the approval chain in approvalChainService walks
    // assistant_managers in as sequential approvers for their Tier 4 reports,
    // and computeApprovalCapabilities authorises them on a per-task basis. The
    // umbrella matrix value just unlocks the `tasks.approve_completion` route
    // gate; processApprovalAction still enforces "you must be in this task's
    // chain" so a T3 can't approve tasks they aren't an approver for.
    tasks:            { view: true, create: true, edit: true, delete: false, assign: true, assign_others: true, set_priority: true, change_status: true, comment: true, upload: true, approve: true, edit_locked_description: false },
    subtasks:         { view: true, create: true, edit: true, delete: false },
    task_comments:    { view: true, create: true, edit: true, delete: false },
    task_files:       { view: true, upload: true, delete: false },
    // Labels — Tier 3 can mint new labels and apply / remove them on any
    // task they can see (visibility is enforced by taskVisibilityService at
    // the controller). May 2026 v2 product decision widened `create` to
    // T3/T4 so the one-click "create new label and attach to this task"
    // flow in the label picker works for every contributor; library
    // rename/recolor remain T2+ via the route-level `managerOrAdmin` gate;
    // permanent delete is T1-only via the tier base above. The granular
    // add_to_task / remove_from_task gates remain the per-task surface.
    labels:           { view: true, create: true, edit: false, delete: false, add_to_task: true, remove_from_task: true },
    status_templates: { view: true, create: false, edit: false, delete: false, set_default: false },
    automations:      { view: false, create: false, edit: false, delete: false },
    // Workflow Canvas — T3 default = no access (matches automations row).
    // Sidebar entry hidden. A `workflows.view` PermissionGrant can lift this.
    workflows:        { view: false, create: false, edit: false, delete: false, manage: false, publish: false, test_run: false },
    dependencies:     { view: true, create: true, delete: false },
    dashboard:        { view: true, export: false },
    reports:          { view: true, export: false },
    exports:          { view: false, export: false },
    // meetings.delete tightened to false; create/edit retained for own meetings.
    meetings:         { view: true, create: true, edit: true, delete: false, manage: false },
    // Personal scratch data — own-data delete preserved.
    notes:            { view: true, create: true, edit: true, delete: true },
    announcements:    { view: true, create: false, edit: false, delete: false },
    time_plan:        { view: true, create: true, edit: true, delete: true, manage: false },
    // Director plan: T1+T2 only (decision #6).
    timeline:         { view: true },
    archive:          { view: false, manage: false },
    integrations:     { view: false, manage: false },
    feedback:         { view: false, create: true, manage: false },
    org_chart:        { view: true, manage: false },
    notifications:    { view: true, manage: false },
    api_keys:         { view: false, create: false, delete: false, manage: false },
  },

  // ── Tier 4 — self-scoped contributor (was: member) ─────────────────────
  // IDENTICAL to the previous member matrix. The audit-flagged "create task
  // on stranger board escalates visibility" issue is fixed at the controller
  // layer in Phase 5 (boardVisibility.canUserSeeBoard before allowing
  // non-management create), NOT by tightening this matrix — Tier 4 should
  // continue to create boards/tasks within workspaces they can already see.
  4: {
    users:            { view: false, create: false, edit: false, delete: false, manage: false },
    departments:      { view: false, create: false, edit: false, delete: false },
    roles:            { view: false, manage: false },
    admin_settings:   { view: false, manage: false },
    workspaces:       { view: true, create: false, edit: false, delete: false, manage_members: false },
    // create_group: true — Tier 4 may add groups to any board they can see
    // (addGroup controller pre-gates via boardVisibilityService.canUserSeeBoard).
    // Explicit entry overrides the umbrella fallback that would otherwise
    // inherit boards.edit=false.
    boards:           { view: true, create: true, edit: false, delete: false, manage_members: false, manage_settings: false, export: false, create_group: true },
    // assign_others: false (decision #8 — implicit, kept as before)
    // set_priority: false (decision #9: T4 priority denied)
    // delete: false (controller has separate own-task-archive path)
    tasks:            { view: true, create: true, edit: true, delete: false, assign: true, assign_others: false, set_priority: false, change_status: true, comment: true, upload: true, approve: false, edit_locked_description: false },
    subtasks:         { view: true, create: true, edit: true, delete: false },
    task_comments:    { view: true, create: true, edit: false, delete: false },
    task_files:       { view: true, upload: true, delete: false },
    // Labels — Tier 4 can mint and apply / remove labels on tasks they can
    // see (May 2026 v2 product decision — every contributor can curate
    // labels on their own work). Library rename/recolor remain T2+ via the
    // route-level `managerOrAdmin` gate on PUT /labels/:id; permanent
    // delete is T1-only via the tier matrix.
    labels:           { view: true, create: true, edit: false, delete: false, add_to_task: true, remove_from_task: true },
    status_templates: { view: true, create: false, edit: false, delete: false, set_default: false },
    automations:      { view: false, create: false, edit: false, delete: false },
    // Workflow Canvas — T4 default = no access. Same shape as T3. Sidebar
    // entry hidden unless an explicit `workflows.view` grant is issued.
    workflows:        { view: false, create: false, edit: false, delete: false, manage: false, publish: false, test_run: false },
    // Dependencies — Tier 4 can create dependency requests (May 2026 v2
    // product decision). Every contributor can request blocking work from
    // a teammate. The middleware `dependencyRequestPermissions.canCreateOnTask`
    // continues to gate WHICH parent task they can attach a dependency to
    // (must be linked to it). Permanent deletion of a dependency record
    // remains T1-only.
    dependencies:     { view: true, create: true, delete: false },
    dashboard:        { view: false, export: false },
    reports:          { view: true, export: false },
    exports:          { view: false, export: false },
    meetings:         { view: true, create: true, edit: false, delete: false, manage: false },
    notes:            { view: true, create: true, edit: true, delete: true },
    announcements:    { view: true, create: false, edit: false, delete: false },
    time_plan:        { view: true, create: true, edit: true, delete: true, manage: false },
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
 * Get base permissions for a tier (1..4).
 * Returns a flat object: { "resource.action": true/false }
 *
 * Phase 7 — extended with umbrella synthesis. Granular actions defined in
 * RESOURCE_ACTIONS but not explicitly listed under the tier inherit their
 * umbrella's value via UMBRELLA_FALLBACKS. Example: tier 4's
 * `tasks.assign_self` is not in TIER_PERMISSIONS[4]; the umbrella
 * `tasks.assign` is true → synthesised value is true.
 *
 * Locked actions (ACTION_META[r][a].enforcement === 'locked') are forced
 * to false for everyone so a locked entry can never accidentally resolve
 * to allowed even if a future grant row exists.
 */
function getTierPermissions(tier) {
  const tierPerms = TIER_PERMISSIONS[tier] || TIER_PERMISSIONS[4];
  const flat = {};

  // First pass: explicit entries from TIER_PERMISSIONS.
  for (const [resource, actions] of Object.entries(tierPerms)) {
    for (const [action, allowed] of Object.entries(actions)) {
      flat[`${resource}.${action}`] = !!allowed;
    }
  }

  // Second pass: synthesise granular actions that don't have explicit
  // tier entries by reading the umbrella value.
  for (const [resource, actionList] of Object.entries(RESOURCE_ACTIONS)) {
    for (const action of actionList) {
      const key = `${resource}.${action}`;
      if (flat[key] !== undefined) continue;

      const meta = ACTION_META[resource]?.[action];
      // Locked / no_surface: forced false everywhere (no runtime app surface
      // to enable, or system rule that must never be true).
      if (meta?.enforcement === 'locked' || meta?.enforcement === 'no_surface') {
        flat[key] = false;
        continue;
      }

      const umbrella = UMBRELLA_FALLBACKS[key];
      if (umbrella) {
        const umbKey = `${umbrella.resource}.${umbrella.action}`;
        if (flat[umbKey] !== undefined) {
          flat[key] = flat[umbKey];
          continue;
        }
      }

      // Tier 1 fallback — matches the runtime super-admin bypass. For any
      // catalog-known action that isn't locked / no_surface and has no
      // explicit or umbrella entry, Tier 1 resolves true. This keeps the
      // "Default allowed" badge in the Permission Overrides UI honest for
      // Super Admin without requiring an explicit booleanat every entry.
      if (tier === 1) {
        flat[key] = true;
        continue;
      }

      // Other tiers fail-closed.
      flat[key] = false;
    }
  }

  return flat;
}

/**
 * Check if an action on a resource is a base permission for a tier.
 *
 * Phase 7 — same umbrella synthesis as getTierPermissions, but for a
 * single-pair lookup. Unknown tier returns false.
 *
 * @returns {boolean}
 */
function isTierBasePermission(tier, resource, action) {
  const meta = ACTION_META[resource]?.[action];
  // Locked / no_surface → always false (matches getTierPermissions).
  if (meta?.enforcement === 'locked' || meta?.enforcement === 'no_surface') return false;
  // Unknown resource/action → false (fail closed).
  if (!RESOURCES[resource]) return false;
  if (!(RESOURCE_ACTIONS[resource] || []).includes(action)) return false;
  // Explicit entry wins.
  if (TIER_PERMISSIONS[tier]?.[resource]?.[action] !== undefined) {
    return !!TIER_PERMISSIONS[tier][resource][action];
  }
  // Umbrella fallback.
  const umbrella = UMBRELLA_FALLBACKS[`${resource}.${action}`];
  if (umbrella && TIER_PERMISSIONS[tier]?.[umbrella.resource]?.[umbrella.action] !== undefined) {
    return !!TIER_PERMISSIONS[tier][umbrella.resource][umbrella.action];
  }
  // Tier 1 fallback — matches runtime super-admin bypass for any catalog
  // action without an umbrella, e.g. approvals.view, search.use.
  if (tier === 1) return true;
  // Other tiers fail-closed.
  return false;
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

// ── GRANTABILITY catalog (Phase 6 — override authority per pair) ────────
//
// For every (resource, action) pair, which tier(s) may issue a GRANT or
// DENY override against another user. The PRECEDENCE rule at runtime
// (DENY > GRANT > base) is unchanged by this — this metadata only
// controls who is ALLOWED to write rows into permission_grants.
//
// Authoring rules:
//   1. Destructive `delete` and `manage` actions on shared data are
//      NEVER grantable (members must be promoted to a tier whose base
//      already includes the action). T1 may DENY them.
//   2. System-administration surfaces (admin_settings, integrations,
//      api_keys, roles, archive) are T1-only — neither grantable nor
//      deniable by T2. Hides the dangerous-elevation path entirely.
//   3. Operational actions (tasks/boards/workspaces non-destructive)
//      are T1+T2 grantable.
//   4. `tasks.edit_locked_description` is the one carve-out: it
//      overrides the set-once description lock, so T1-only grant.
//
// `getGrantability(resource, action)` returns NON_GRANTABLE for unknown
// pairs so unknown resources cannot be granted by accident.

const _T1 = 1;
const _T2 = 2;
const NON_GRANTABLE = Object.freeze({ grantableBy: [], deniableBy: [_T1] });
const T1_ONLY       = Object.freeze({ grantableBy: [_T1], deniableBy: [_T1] });
const T1_T2         = Object.freeze({ grantableBy: [_T1, _T2], deniableBy: [_T1, _T2] });

const GRANTABILITY = {
  // ── Administration ────────────────────────────────────────────
  users: {
    view: T1_T2,
    create: T1_ONLY,        // sensitive — user provisioning
    edit: T1_ONLY,          // sensitive — role/email mutation
    delete: NON_GRANTABLE,  // destructive
    manage: T1_ONLY,
  },
  departments: { view: T1_T2, create: T1_T2, edit: T1_T2, delete: NON_GRANTABLE },
  roles:          { view: T1_ONLY, manage: T1_ONLY },
  admin_settings: { view: T1_ONLY, manage: T1_ONLY },
  api_keys:       { view: T1_ONLY, create: T1_ONLY, delete: NON_GRANTABLE, manage: T1_ONLY },

  // ── Project Management ────────────────────────────────────────
  workspaces: {
    view: T1_T2, create: T1_T2, edit: T1_T2,
    delete: NON_GRANTABLE, manage_members: T1_T2,
  },
  boards: {
    view: T1_T2, create: T1_T2, edit: T1_T2,
    delete: NON_GRANTABLE,
    manage_members: T1_T2, manage_settings: T1_T2, export: T1_T2,
  },
  tasks: {
    view: T1_T2, create: T1_T2, edit: T1_T2,
    delete: NON_GRANTABLE,
    assign: T1_T2, assign_others: T1_T2,
    set_priority: T1_T2, change_status: T1_T2,
    comment: T1_T2, upload: T1_T2, approve: T1_T2,
    edit_locked_description: T1_ONLY, // overrides set-once description lock
  },
  subtasks:      { view: T1_T2, create: T1_T2, edit: T1_T2, delete: NON_GRANTABLE },
  task_comments: { view: T1_T2, create: T1_T2, edit: T1_T2, delete: NON_GRANTABLE },
  task_files:    { view: T1_T2, upload: T1_T2, delete: NON_GRANTABLE },
  // labels.delete is now T1_T2 (was NON_GRANTABLE). Aligned with the May 2026
  // product decision: managers may curate their team's label library end-to-
  // end, including deletion. The destructive operation is still confined to
  // T1+T2 base — T3/T4 cannot be granted delete via PermissionGrant.
  labels:        { view: T1_T2, create: T1_T2, edit: T1_T2, delete: T1_T2 },
  // Phase 2 — status_templates mirrors labels' grantability shape: every
  // action is T1/T2 only (no T3/T4 grant or deny rows). Templates are
  // board-config metadata, not work product, so admins can curate the
  // library end-to-end including deletes.
  status_templates: { view: T1_T2, create: T1_T2, edit: T1_T2, delete: T1_T2, set_default: T1_T2 },
  automations:   { view: T1_T2, create: T1_T2, edit: T1_T2, delete: NON_GRANTABLE },
  // Workflow Canvas — T1/T2 can grant view/create/edit/manage/publish/test_run
  // to a lower-tier user (the common case: give a T3 contributor canvas
  // access via PermissionGrant). `delete` is NON_GRANTABLE because deleting
  // a published workflow is destructive (cascades wipe nodes/edges/runs).
  workflows: {
    view: T1_T2, create: T1_T2, edit: T1_T2,
    delete: NON_GRANTABLE,
    manage: T1_T2, publish: T1_T2, test_run: T1_T2,
  },
  dependencies:  { view: T1_T2, create: T1_T2, delete: NON_GRANTABLE },

  // ── Reporting ─────────────────────────────────────────────────
  dashboard: { view: T1_T2, export: T1_T2 },
  reports:   { view: T1_T2, export: T1_T2 },
  exports:   { view: T1_T2, export: T1_T2 },

  // ── Collaboration ─────────────────────────────────────────────
  meetings:      { view: T1_T2, create: T1_T2, edit: T1_T2, delete: NON_GRANTABLE, manage: T1_T2 },
  notes:         { view: T1_T2, create: T1_T2, edit: T1_T2, delete: NON_GRANTABLE },
  announcements: { view: T1_T2, create: T1_T2, edit: T1_T2, delete: NON_GRANTABLE },

  // ── Planning ──────────────────────────────────────────────────
  time_plan: { view: T1_T2, create: T1_T2, edit: T1_T2, delete: NON_GRANTABLE, manage: T1_T2 },
  timeline:  { view: T1_T2 },

  // ── Operations ────────────────────────────────────────────────
  archive:       { view: T1_ONLY, manage: NON_GRANTABLE }, // restore + permanent delete: T1-only base; never grantable
  integrations:  { view: T1_ONLY, manage: T1_ONLY },
  feedback:      { view: T1_T2, create: T1_T2, manage: T1_T2 },
  org_chart:     { view: T1_T2, manage: T1_T2 },
  notifications: { view: T1_T2, manage: NON_GRANTABLE }, // manage = clear/delete: destructive
};

/**
 * Lookup grantability for a (resource, action) pair. Returns NON_GRANTABLE
 * as a fail-safe default for unknown pairs so unknown combos cannot be
 * granted by accident even if a UI bug submits one.
 *
 * Phase 7 — also enforces enforcement status. Actions tagged 'locked',
 * 'pending', or 'no_surface' are NEVER grantable or deniable (regardless
 * of GRANTABILITY catalog). The frontend tags these with badges and
 * disables the checkbox; the backend rejects save attempts with
 * PERMISSION_LOCKED / PERMISSION_NOT_ENFORCEABLE.
 */
function getGrantability(resource, action) {
  const meta = ACTION_META[resource]?.[action];
  if (meta && (meta.enforcement === 'locked'
              || meta.enforcement === 'pending'
              || meta.enforcement === 'no_surface')) {
    return NON_GRANTABLE_FULL;
  }
  return GRANTABILITY[resource]?.[action] || NON_GRANTABLE;
}

// Phase 7 — for locked/pending/no_surface actions we ALSO want deny to be
// disabled (the Phase 6 NON_GRANTABLE allowed T1 to deny). For these
// system-level actions, no one should be able to write any override.
const NON_GRANTABLE_FULL = Object.freeze({ grantableBy: [], deniableBy: [] });

/** Is this (resource, action) grantable by the given tier? */
function isGrantableByTier(resource, action, tier) {
  const g = getGrantability(resource, action);
  return Array.isArray(g.grantableBy) && g.grantableBy.includes(tier);
}

/** Is this (resource, action) deniable by the given tier? */
function isDeniableByTier(resource, action, tier) {
  const g = getGrantability(resource, action);
  return Array.isArray(g.deniableBy) && g.deniableBy.includes(tier);
}

/**
 * Lookup display + behavior metadata for an action.
 * Returns an object that is ALWAYS safe to spread into the UI catalog
 * payload (no `null` fields). Defaults match the "wired, non-dangerous,
 * scoped to global/workspace/board" common case.
 */
function getActionMeta(resource, action) {
  const explicit = ACTION_META[resource]?.[action] || {};
  const baseLabel = ACTIONS[action]?.label || action;
  const baseDesc = ACTIONS[action]?.description || '';
  return {
    label: explicit.label || baseLabel,
    description: explicit.description || baseDesc,
    enforcement: explicit.enforcement || 'wired',
    dangerous: !!explicit.dangerous,
    systemOnly: !!explicit.systemOnly,
    warnOnDeny: !!explicit.warnOnDeny,
    scopes: explicit.scopes || ['global', 'workspace', 'board'],
  };
}

/**
 * Is this (resource, action) settable as a grant/deny override at all?
 * Returns false for unknown pairs and for any action whose enforcement
 * status is 'locked', 'pending', or 'no_surface'. The permissionController
 * save path checks this BEFORE consulting canGrantPermission so a clear
 * machine-readable code is returned (PERMISSION_LOCKED /
 * PERMISSION_NOT_ENFORCEABLE) instead of a generic authority error.
 */
function isActionSavable(resource, action) {
  if (!RESOURCES[resource]) return false;
  if (!(RESOURCE_ACTIONS[resource] || []).includes(action)) return false;
  const meta = getActionMeta(resource, action);
  return meta.enforcement === 'wired';
}

/** Returns the savability reason for non-savable pairs: 'locked' | 'pending' |
 *  'no_surface' | 'unknown' | null (when savable). */
function getActionSavabilityStatus(resource, action) {
  if (!RESOURCES[resource]) return 'unknown';
  if (!(RESOURCE_ACTIONS[resource] || []).includes(action)) return 'unknown';
  const meta = getActionMeta(resource, action);
  if (meta.enforcement === 'wired') return null;
  return meta.enforcement; // 'locked' | 'pending' | 'no_surface'
}

/** Lookup umbrella fallback for a granular (resource, action) pair. */
function getUmbrellaFallback(resource, action) {
  return UMBRELLA_FALLBACKS[`${resource}.${action}`] || null;
}

/**
 * Build the public catalog payload served by GET /api/permissions/catalog.
 *
 * Phase 7 — now includes a `meta` map keyed by `resource.action` that carries
 * the per-action display label, description, enforcement status, dangerous /
 * systemOnly / warnOnDeny flags, and allowed scopes. The frontend uses this
 * to render badges, disable non-savable actions, and warn before dangerous
 * grants or default-overriding denies.
 *
 * Includes a flattened tier-permissions map (computed via getTierPermissions,
 * which performs umbrella synthesis) so the UI can show "Default allowed
 * for selected user" / "Default denied" without re-running the engine.
 */
function getPermissionCatalog() {
  const resourcesByCategory = getResourcesByCategory();
  const meta = {};
  for (const [resource, actions] of Object.entries(RESOURCE_ACTIONS)) {
    for (const action of actions) {
      meta[`${resource}.${action}`] = getActionMeta(resource, action);
    }
  }
  const tierPermissionsFlat = {};
  for (const tier of [1, 2, 3, 4]) {
    tierPermissionsFlat[tier] = getTierPermissions(tier);
  }
  return {
    resources: RESOURCES,
    actions: ACTIONS,
    resourceActions: RESOURCE_ACTIONS,
    resourcesByCategory,
    grantability: GRANTABILITY,
    tierPermissions: TIER_PERMISSIONS,
    // Phase 7 additions
    meta,
    umbrellaFallbacks: UMBRELLA_FALLBACKS,
    tierPermissionsFlat,
  };
}

module.exports = {
  RESOURCES,
  ACTIONS,
  RESOURCE_ACTIONS,
  ROLE_PERMISSIONS,
  TIER_PERMISSIONS,
  GRANTABILITY,
  // Phase 7
  ACTION_META,
  UMBRELLA_FALLBACKS,
  getBasePermissions,
  isBasePermission,
  getTierPermissions,
  isTierBasePermission,
  getActionsForResource,
  getResourcesByCategory,
  getGrantability,
  isGrantableByTier,
  isDeniableByTier,
  getPermissionCatalog,
  // Phase 7 helpers
  getActionMeta,
  isActionSavable,
  getActionSavabilityStatus,
  getUmbrellaFallback,
};
