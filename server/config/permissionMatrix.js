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
  assign:            { label: 'Assign Self',          description: 'Assign self as owner/assignee' },
  assign_others:     { label: 'Assign Others',        description: 'Assign tasks to other users' },
  set_priority:      { label: 'Set Priority',         description: 'Change task priority (low/medium/high/critical)' },
  approve:           { label: 'Approve/Reject',       description: 'Approve or reject requests' },
  export:            { label: 'Export',               description: 'Export/download data' },
  manage:            { label: 'Manage',               description: 'Full management access' },
  manage_members:    { label: 'Manage Members',       description: 'Add/remove members' },
  manage_settings:   { label: 'Manage Settings',      description: 'Configure settings' },
  change_status:     { label: 'Change Status',        description: 'Change status fields' },
  comment:           { label: 'Comment',              description: 'Add comments' },
  upload:            { label: 'Upload Files',         description: 'Upload attachments' },
  // Set-once description override. Description is set-once for everyone
  // EXCEPT actors who hold this action — only Tier 1 by default. See
  // TIER_PERMISSIONS below and decision #10 of the role->tier migration plan.
  edit_locked_description: { label: 'Edit Locked Description', description: 'Edit a task description after it has been set' },
};

// ── Valid actions for each resource ─────────────────────────────────────
const RESOURCE_ACTIONS = {
  users:            ['view', 'create', 'edit', 'delete', 'manage'],
  departments:      ['view', 'create', 'edit', 'delete'],
  roles:            ['view', 'manage'],
  admin_settings:   ['view', 'manage'],
  workspaces:       ['view', 'create', 'edit', 'delete', 'manage_members'],
  boards:           ['view', 'create', 'edit', 'delete', 'manage_members', 'manage_settings', 'export'],
  tasks:            ['view', 'create', 'edit', 'delete', 'assign', 'assign_others', 'set_priority', 'change_status', 'comment', 'upload', 'approve', 'edit_locked_description'],
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
    tasks:            { view: true, create: true, edit: true, delete: true, assign: true, assign_others: true, set_priority: true, change_status: true, comment: true, upload: true, approve: true },
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
    boards:           { view: true, create: true,  edit: false, delete: false, manage_members: false, manage_settings: false, export: false },
    tasks:            { view: true, create: true, edit: true, delete: true, assign: true, assign_others: true, set_priority: true, change_status: true, comment: true, upload: true, approve: false },
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
    boards:           { view: true, create: true,  edit: false, delete: false, manage_members: false, manage_settings: false, export: false },
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
    boards:           { view: true, create: true, edit: true, delete: true, manage_members: true, manage_settings: true, export: true },
    tasks:            { view: true, create: true, edit: true, delete: true, assign: true, assign_others: true, set_priority: true, change_status: true, comment: true, upload: true, approve: true, edit_locked_description: true },
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
    boards:           { view: true, create: true, edit: true, delete: false, manage_members: true, manage_settings: true, export: true },
    // edit_locked_description is T1+T2 (decision #10 revised — Tier 1 and Tier 2
    // may rewrite an already-set task description; Tier 3/Tier 4 are blocked.)
    tasks:            { view: true, create: true, edit: true, delete: false, assign: true, assign_others: true, set_priority: true, change_status: true, comment: true, upload: true, approve: true, edit_locked_description: true },
    subtasks:         { view: true, create: true, edit: true, delete: false },
    task_comments:    { view: true, create: true, edit: true, delete: false },
    task_files:       { view: true, upload: true, delete: false },
    labels:           { view: true, create: true, edit: true, delete: false },
    automations:      { view: true, create: true, edit: true, delete: false },
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
    boards:           { view: true, create: true, edit: false, delete: false, manage_members: false, manage_settings: false, export: false },
    // tasks.delete tightened to false (decision #4, no destructive without scope proof).
    // tasks.approve remains false to match prior asst-manager behavior.
    tasks:            { view: true, create: true, edit: true, delete: false, assign: true, assign_others: true, set_priority: true, change_status: true, comment: true, upload: true, approve: false, edit_locked_description: false },
    subtasks:         { view: true, create: true, edit: true, delete: false },
    task_comments:    { view: true, create: true, edit: true, delete: false },
    task_files:       { view: true, upload: true, delete: false },
    labels:           { view: true, create: false, edit: false, delete: false },
    automations:      { view: false, create: false, edit: false, delete: false },
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
    boards:           { view: true, create: true, edit: false, delete: false, manage_members: false, manage_settings: false, export: false },
    // assign_others: false (decision #8 — implicit, kept as before)
    // set_priority: false (decision #9: T4 priority denied)
    // delete: false (controller has separate own-task-archive path)
    tasks:            { view: true, create: true, edit: true, delete: false, assign: true, assign_others: false, set_priority: false, change_status: true, comment: true, upload: true, approve: false, edit_locked_description: false },
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
 * Mirrors the shape of getBasePermissions(role) so future Phase-5 code can
 * swap one for the other without changing callers.
 */
function getTierPermissions(tier) {
  const tierPerms = TIER_PERMISSIONS[tier] || TIER_PERMISSIONS[4];
  const flat = {};
  for (const [resource, actions] of Object.entries(tierPerms)) {
    for (const [action, allowed] of Object.entries(actions)) {
      flat[`${resource}.${action}`] = !!allowed;
    }
  }
  return flat;
}

/**
 * Check if an action on a resource is a base permission for a tier.
 * Mirrors isBasePermission(role, resource, action). Unknown tier returns false.
 * @returns {boolean}
 */
function isTierBasePermission(tier, resource, action) {
  return !!TIER_PERMISSIONS[tier]?.[resource]?.[action];
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
  TIER_PERMISSIONS,
  getBasePermissions,
  isBasePermission,
  getTierPermissions,
  isTierBasePermission,
  getActionsForResource,
  getResourcesByCategory,
};
