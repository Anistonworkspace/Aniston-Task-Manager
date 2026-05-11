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
};

export const RESOURCE_ACTIONS = {
  users:            ['view', 'create', 'edit', 'delete', 'manage'],
  departments:      ['view', 'create', 'edit', 'delete'],
  roles:            ['view', 'manage'],
  admin_settings:   ['view', 'manage'],
  workspaces:       ['view', 'create', 'edit', 'delete', 'manage_members'],
  boards:           ['view', 'create', 'edit', 'delete', 'manage_members', 'manage_settings', 'export'],
  tasks:            ['view', 'create', 'edit', 'delete', 'assign', 'assign_others', 'set_priority', 'change_status', 'comment', 'upload', 'approve'],
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

// ── Legacy flat permissions (backward compatibility) ────────────────────

const PERMISSIONS = {
  create_workspace:    ['manager', 'admin'],
  edit_workspace:      ['manager', 'admin'],
  delete_workspace:    ['manager', 'admin'],
  // All roles can now create boards. The backend createBoard controller still
  // verifies workspace access for assistant_manager / member, so a member
  // who tries to create a board in a workspace they cannot see will receive
  // a 403 even though the UI lets them open the create-board modal.
  create_board:        ['member', 'assistant_manager', 'manager', 'admin'],
  // RENAME is open to all authenticated roles when the user has access to
  // the board. Backend updateBoard splits "rename" (name/description) from
  // structural settings (color, columns, archived, members, etc.) — the
  // latter remain manager+/admin only via edit_board / delete_board.
  rename_board:        ['member', 'assistant_manager', 'manager', 'admin'],
  rename_group:        ['member', 'assistant_manager', 'manager', 'admin'],
  edit_board:          ['manager', 'admin'],
  delete_board:        ['manager', 'admin'],
  // All roles can create their own tasks. Assigning OTHERS is gated separately
  // via assign_members / tasks.assign_others below.
  create_task:         ['member', 'assistant_manager', 'manager', 'admin'],
  // All roles can add a group to boards they can access. The backend route
  // (POST /boards/:id/groups) enforces board-access via boardVisibilityService.
  // RENAMING and REORDERING groups are also open to every tier that can see
  // the board (PATCH /boards/:id/groups/:groupId, PUT /boards/:id/groups/reorder
  // — both gated by boardVisibilityService at the controller). Group order is
  // a board-global property: every viewer sees the same arrangement, so
  // there is no per-user preference to protect. ARCHIVING / structural
  // groups-array rewrites via PUT /boards/:id remain edit_board.
  create_group:        ['member', 'assistant_manager', 'manager', 'admin'],
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
 * Server's effective permissions already reflect deny overrides (deny wins
 * over base + grant). So a `false` here means either the role doesn't have it
 * or an admin denied it explicitly.
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
 * Returns true ONLY when the server has explicitly resolved this permission
 * to false (i.e. an admin DENY override is in effect, OR the role itself
 * doesn't grant it). This is the canonical check used by route guards and
 * sidebar visibility for resources that are base-allowed for everyone (e.g.
 * org_chart.view) — undefined falls back to "not denied" so that we don't
 * incorrectly hide the UI before /auth/me/permissions has finished loading.
 *
 * Mirrors the server's permissionEngine: deny precedence is honoured because
 * the server already collapsed deny+grant+role into a single boolean.
 *
 * @param {string} resource
 * @param {string} action
 * @param {boolean} isSuperAdmin
 * @param {Object} granularPermissions
 * @returns {boolean}
 */
export function isExplicitlyDenied(resource, action, isSuperAdmin = false, granularPermissions = {}) {
  if (isSuperAdmin) return false;
  return granularPermissions[`${resource}.${action}`] === false;
}

/**
 * Convenience: can this user assign tasks to OTHER users? Returns false if
 * either the role doesn't have it or an admin denied it.
 */
export function canAssignOthers(isSuperAdmin = false, granularPermissions = {}) {
  return hasGranularPermission('tasks', 'assign_others', isSuperAdmin, granularPermissions);
}

/**
 * Convenience: can this user change task priority? Mirrors the backend
 * `tasks.set_priority` action (members default to false). Use this to
 * decide whether to render PriorityCell as an editable dropdown vs a
 * read-only pill — backend remains the source of truth and will 403 on
 * forged direct PUTs.
 */
export function canSetPriority(isSuperAdmin = false, granularPermissions = {}) {
  return hasGranularPermission('tasks', 'set_priority', isSuperAdmin, granularPermissions);
}

/**
 * Per-task variant of canSetPriority. Mirrors the backend gate in
 * createTask/updateTask/bulkUpdateTasks: a user without the global
 * `tasks.set_priority` action may still edit priority on a task they
 * created AND solely own. Used by board cells and the task modal so a
 * Tier 4 user editing their own task sees the dropdown, while one editing
 * a task delegated to them stays read-only.
 *
 * Self-owned == createdBy === user.id AND no foreign role='assignee' rows
 * (supervisors are oversight, not ownership). The legacy scalar
 * `task.assignedTo` is treated as a single assignee row when present.
 */
export function canSetPriorityForTask(user, task, isSuperAdmin = false, granularPermissions = {}) {
  if (isSuperAdmin) return true;
  if (canSetPriority(isSuperAdmin, granularPermissions)) return true;
  if (!user || !task) return false;
  const uid = user.id;
  if (!uid) return false;
  if (task.createdBy && task.createdBy !== uid) return false;
  if (!task.createdBy) return false;
  if (typeof task.assignedTo === 'string' && task.assignedTo && task.assignedTo !== uid) return false;
  if (Array.isArray(task.assignedTo) && task.assignedTo.some((id) => id && id !== uid)) return false;
  if (Array.isArray(task.taskAssignees)) {
    const foreignAssignee = task.taskAssignees.find((ta) => {
      if (!ta) return false;
      const taUid = ta.userId || (ta.user && ta.user.id);
      if (!taUid || taUid === uid) return false;
      return ta.role === 'assignee';
    });
    if (foreignAssignee) return false;
  }
  return true;
}

// ── Task action helpers (canonical) ────────────────────────────────────
//
// These helpers are the single source of truth used by every task UI
// surface (board row, board modal, dashboard, home widgets, bulk action
// bar). They mirror the backend rules in `server/middleware/taskPermissions.js`
// and `server/services/permissionEngine.js` so an explicit DENY override
// on the user always wins over the role default.
//
// Usage:
//   const { user, isSuperAdmin, granularPermissions } = useAuth();
//   if (canArchiveTask(user, task, granularPermissions)) { ... }

import { resolveTier, TIER_1, TIER_2 } from './tiers';

const MANAGEMENT_ROLES = ['admin', 'manager', 'assistant_manager'];

/**
 * Is this user a member-rank assignee/creator of the given task?
 * Used as the "own task" predicate for member-restricted actions.
 */
export function isOwnTask(user, task) {
  if (!user || !task) return false;
  const uid = user.id;
  if (!uid) return false;
  if (task.assignedTo === uid) return true;
  if (task.createdBy === uid) return true;
  if (Array.isArray(task.taskAssignees)) {
    return task.taskAssignees.some(ta => (ta.userId || ta.user?.id) === uid);
  }
  return false;
}

/**
 * Can this user edit *any* of this task's fields?
 *
 * Rules:
 *   - Super admin: always yes.
 *   - Explicit DENY on tasks.edit: never (overrides role default).
 *   - Approved tasks: locked except for management roles.
 *   - Management roles (admin/manager/assistant_manager): yes.
 *   - Member: yes if the task is theirs (owns it via assignedTo/createdBy/
 *     taskAssignees) and tasks.edit is granted.
 *
 * If `task` is omitted, returns whether the user can edit tasks in general
 * (e.g. for showing "edit" affordances at the board level).
 */
export function canEditTask(user, task, granularPermissions = {}) {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  // Explicit deny always wins, including for management roles.
  if (granularPermissions['tasks.edit'] === false) return false;
  // Approved tasks are locked for non-management actors.
  const isApproved = !!task && task.approvalStatus === 'approved';
  if (isApproved && !MANAGEMENT_ROLES.includes(user.role)) return false;
  if (MANAGEMENT_ROLES.includes(user.role)) return true;
  // Member needs tasks.edit AND ownership (when task context is provided).
  if (granularPermissions['tasks.edit'] !== true) return false;
  if (!task) return true;
  return isOwnTask(user, task);
}

/**
 * Can this user edit a task's TITLE specifically?
 *
 * Title is a set-once field for lower tiers. Tier 1 (Super Admin) AND
 * Tier 2 (Admin / Manager) may rename a task at any time after creation.
 * Tier 3 / Tier 4 cannot, even if they are the task's creator or
 * assignee. Title creation happens via POST /tasks (createTask), which
 * is unaffected — pass `task = null` (or a task with no `id`) to indicate
 * the new-task path and this helper returns true for anyone who could
 * otherwise edit the task at all.
 *
 * Tier 2 was tightened to mirror Tier 1's task-edit surface — including
 * title — because the previous "Tier 1 only" rule blocked a manager from
 * fixing a typo on a task they personally created. Mirrors the backend
 * gate in `server/controllers/taskController.js` (`updateTask` title-lock
 * branch) and the `assignee_restricted` allowedFields whitelist in
 * `server/middleware/taskPermissions.js`, which intentionally omits
 * 'title' for the Tier 3/4 assignee path.
 */
export function canEditTaskTitle(user, task, granularPermissions = {}) {
  if (!user) return false;
  // New-task path: anyone who can edit the task at all may set the title
  // during creation. The board UI's quick-add input passes `task = null`,
  // and the TaskModal create-mode (no task.id) hits the same branch.
  const isNewTask = !task || !task.id;
  if (isNewTask) return canEditTask(user, task, granularPermissions);
  // Existing task: Tier 1 or Tier 2 only.
  const tier = resolveTier(user);
  return tier === TIER_1 || tier === TIER_2;
}

/**
 * Can this user change this task's due date?
 *
 * Mirrors the backend rule in `taskController.updateTask` (DUE_DATE_LOCKED
 * branch) — once a task has a due date, only Tier 1 / Tier 2 may change
 * it. Tier 3 / Tier 4 may still SET the initial due date on a task that
 * has none (e.g. a self-assigned task they just quick-created), but may
 * not keep changing it after that. Lower tiers must use the due-date
 * extension workflow to request a change from a manager.
 *
 * Used by board cells, the task modal, and any other surface that exposes
 * a date picker. The visual state for a locked picker is "disabled +
 * tooltip", never hidden — a Tier 3/4 actor must still see the existing
 * due date clearly so they know what they're working against.
 *
 * NOTE: when called WITHOUT a task (e.g. for a brand-new task being
 * created in the modal), returns true — the gate only fires on existing
 * tasks with an existing due date.
 */
export function canEditDueDate(user, task) {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  const tier = resolveTier(user);
  if (tier === TIER_1 || tier === TIER_2) return true;
  // Tier 3 / Tier 4: allowed only on the INITIAL set. The frontend treats
  // a missing task or a task with no existing dueDate as "initial set"
  // (mirrors the backend gate which is keyed on `task.dueDate`).
  if (!task) return true;
  return !task.dueDate;
}

/**
 * Can this user archive (soft-delete) this task?
 *
 * Archive is a SEPARATE action from permanent delete. Tier 1 (Super Admin)
 * and Tier 2 (Admin/Manager) may archive any task they can see — an
 * explicit DENY on `tasks.delete` no longer blocks T1/T2 archive because
 * the action is now distinct from the permanent-delete authority. Tier 3/4
 * still need the matrix `tasks.delete` (default false; can be granted as
 * an override), and members may only archive their own tasks.
 *
 * Mirrors the backend archive gate in `taskController.updateTask` /
 * `bulkUpdateTasks` which short-circuits T1+T2 to allowed.
 */
export function canArchiveTask(user, task, granularPermissions = {}) {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  // Tier 1 / Tier 2 may archive regardless of `tasks.delete`. A user that
  // shouldn't see the task at all wouldn't have it rendered, so scope is
  // already enforced by visibility upstream.
  const tier = resolveTier(user);
  if (tier === TIER_1 || tier === TIER_2) return true;
  // Tier 3/4: still require the matrix permission (deny-aware).
  if (granularPermissions['tasks.delete'] === false) return false;
  if (MANAGEMENT_ROLES.includes(user.role)) {
    return granularPermissions['tasks.delete'] !== false;
  }
  // Members must be explicitly granted tasks.delete to archive, and only
  // their own tasks.
  if (granularPermissions['tasks.delete'] !== true) return false;
  if (!task) return true;
  return isOwnTask(user, task);
}

/**
 * Can this user permanently delete this task? (Admin/manager-only by default.)
 * Members never permanently delete — archive is the strongest action they have.
 */
export function canDeleteTask(user, task, granularPermissions = {}) {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  if (granularPermissions['tasks.delete'] === false) return false;
  if (MANAGEMENT_ROLES.includes(user.role)) {
    return granularPermissions['tasks.delete'] !== false;
  }
  return false;
}

/**
 * Aggregate: should we render a row-action affordance / three-dot menu /
 * trash icon at all for this task? True iff at least one of edit/archive/
 * delete is permitted. Use this to avoid leaving an empty action slot.
 */
export function canManageTaskActions(user, task, granularPermissions = {}) {
  return canEditTask(user, task, granularPermissions)
    || canArchiveTask(user, task, granularPermissions)
    || canDeleteTask(user, task, granularPermissions);
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
