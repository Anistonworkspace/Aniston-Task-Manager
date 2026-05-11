const { TaskAssignee, User } = require('../models');
const { sequelize } = require('../config/db');
const { Op } = require('sequelize');
const { safeUUID } = require('../utils/safeSql');
const taskVisibility = require('../services/taskVisibilityService');
const logger = require('../utils/logger');
// Tier helpers — single source of truth for RBAC. The `edit` action is
// keyed off the canonical tier value (1..4) only; legacy role-string checks
// have been removed so a Tier 2 user with role='manager' and one with
// role='admin' resolve identically (both are full-edit). Subtree scoping
// for Tier 3 management actions still uses taskVisibilityService — that's
// orthogonal to tier identity.
const { resolveTier, hasTierAtLeast, TIER_1, TIER_2, TIER_3, TIER_4 } = require('../config/tiers');

// ── Table existence cache (shared across all middleware calls) ───────────
const _tableCache = {};
async function _tableExists(name) {
  if (_tableCache[name] !== undefined) return _tableCache[name];
  try {
    await sequelize.query(`SELECT 1 FROM "${name}" LIMIT 0`);
    _tableCache[name] = true;
  } catch (e) {
    _tableCache[name] = false;
  }
  return _tableCache[name];
}
const taskAssigneesTableExists = () => _tableExists('task_assignees');
const taskOwnersTableExists = () => _tableExists('task_owners');

/**
 * Permission matrix constants
 */
const ROLE_HIERARCHY = {
  admin: 4,
  manager: 3,
  assistant_manager: 2,
  member: 1,
};

/**
 * Check if a member-role user is a hierarchy manager (has direct reports in org chart).
 * NOTE: This function is retained for non-permission uses (org chart display, etc.)
 * but is NO LONGER used for task permission decisions. Strict RBAC only.
 */
async function isHierarchyManager(user, req) {
  // Always return false for task permission purposes — strict RBAC
  return false;
}

/**
 * Layer 1 — Role Check: Attaches permission context to req.taskPermissions
 * Determines what level of access the user has based on their role.
 * STRICT RBAC: only admin, manager, assistant_manager get management permissions.
 */
function attachTaskPermissions(req, res, next) {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ success: false, message: 'Not authenticated.' });
  }

  const role = user.role;
  const isSuperAdmin = !!user.isSuperAdmin;
  const isManagementRole = isSuperAdmin || ['admin', 'manager', 'assistant_manager'].includes(role);
  // Tier-aware "is this user effectively Tier 2 or above?" — used for the
  // hasFullAccess flag so a Tier 2 manager (role='manager') gets the same
  // treatment as a Tier 2 admin (role='admin'). The earlier role-string
  // check left the two halves of Tier 2 asymmetric, which downstream code
  // could read as "manager isn't full access".
  const hasTier2OrHigher = hasTierAtLeast(user, TIER_2);

  const permissions = {
    role,
    isSuperAdmin,
    // hasFullAccess means "may bypass per-task visibility/scope checks for
    // task edits". Tier 1 + Tier 2 qualify — both halves of Tier 2 (admin
    // AND manager) are included via the tier resolver, fixing the prior
    // asymmetric role-string gate.
    hasFullAccess: hasTier2OrHigher,
    hasBoardAccess: role === 'manager' || role === 'assistant_manager',
    isHierarchyManager: false,
    hasPartialAccess: false,
    isRestricted: role === 'member',
    canCreate: isManagementRole,
    canEditOthers: isManagementRole,
    canDelete: isManagementRole,
    canAssignMembers: isManagementRole,
    canManageBoardSettings: isSuperAdmin || role === 'admin' || role === 'manager',
  };

  req.taskPermissions = permissions;
  next();
}

/**
 * Layer 2 — Task Visibility Query Builder (legacy compat shim)
 *
 * Existing callers (taskController.getTasks) expect a Sequelize where-fragment
 * they can merge into their own clause. We delegate to the new
 * taskVisibilityService so there's one rule, applied identically everywhere.
 *
 * Returns either `{}` (admin/super_admin → no filter) or
 * `{ [Op.and]: [{ [Op.or]: [...] }] }` for hierarchy-scoped viewers.
 */
async function buildTaskVisibilityFilter(user /*, boardId */) {
  return taskVisibility.buildTaskVisibilityWhere(user);
}

/**
 * Layer 3 — Action Permission Check (async).
 *
 * Validates whether a user can perform a specific action on a specific task.
 * "In subtree" means the task touches a user inside `viewer ∪ descendants`,
 * decided by the centralized taskVisibilityService. The result is cached on
 * `req._taskInSubtree` so multiple checkTaskAction calls in the same handler
 * (e.g. getTask runs view+edit+reassign+delete) only compute once.
 *
 * Why async: write controllers (`updateTask`, etc.) DON'T go through the
 * `canViewTask` middleware that pre-populates the cache, so the helper has
 * to be capable of computing it on demand. Reverting to a sync function and
 * relying on every caller to set `req._taskInSubtree` first is what caused
 * the manager-archive / inline-assign regression — easy to forget.
 *
 * @param {string} action - 'view' | 'edit' | 'edit_status' | 'edit_all' | 'reassign' | 'delete' | 'create' | 'manage_members'
 * @param {object} user
 * @param {object} task
 * @param {Array} taskAssignees
 * @param {object} [req] - used to cache the inSubtree decision per request
 * @returns {Promise<{ allowed: boolean, reason: string, allowedFields: string[]|null }>}
 */
async function checkTaskAction(action, user, task, taskAssignees = [], req) {
  const isSuperAdmin = !!user.isSuperAdmin;
  const tier = resolveTier(user);

  // Tier 1 (Super Admin) and Tier 2 (Admin / Manager) — full edit access on
  // every task in the system, with no subtree restriction. This is the
  // canonical "management" surface: write actions trust tier identity, NOT
  // role strings. A Tier 2 user with role='manager' and one with role='admin'
  // resolve identically here — fixing the asymmetric block on managers
  // outside their org subtree. Subtree scoping still applies to Tier 3
  // (assistant_manager) below.
  if (isSuperAdmin || tier === TIER_1 || tier === TIER_2) {
    return { allowed: true, reason: 'tier_full_access', allowedFields: null };
  }

  // From here down, the population is Tier 3 (assistant_manager) and Tier 4
  // (member). Tier 3 retains subtree-scoped management privileges for
  // non-edit actions (status/reassign/delete/manage_members); for the
  // primary `edit` action, both tiers fall to the assignee/creator
  // whitelist with the same dueDate-locking rule.

  // Find user's membership role in this task
  const userAssignment = taskAssignees.find(ta => ta.userId === user.id);
  const isAssignee = userAssignment?.role === 'assignee';
  const isSupervisor = userAssignment?.role === 'supervisor';
  const isTaskCreator = task.createdBy === user.id;
  const isLinked = !!userAssignment || isTaskCreator || task.assignedTo === user.id;

  // Resolve "in subtree" — single source of truth via taskVisibilityService.
  // Cached on the request to amortize across multiple checkTaskAction calls
  // in one handler (getTask runs four).
  let inSubtree = req?._taskInSubtree;
  if (inSubtree === undefined) {
    try {
      // Attach the live taskAssignees so canViewTask uses the in-memory
      // associations rather than re-querying — saves a roundtrip per call.
      const taskWithAssignees = task && typeof task === 'object'
        ? Object.assign(
            task.toJSON ? task.toJSON() : { ...task },
            { taskAssignees }
          )
        : task;
      inSubtree = await taskVisibility.canViewTask(user, taskWithAssignees);
    } catch (err) {
      // Defensive fall-through — treat as not-in-subtree if the visibility
      // service blew up. The user can still be allowed via assignee/creator
      // path below.
      logger.warn('[RBAC] inSubtree resolution failed:', err.message);
      inSubtree = false;
    }
    if (req) req._taskInSubtree = inSubtree;
  }

  switch (action) {
    case 'view': {
      if (isLinked || inSubtree) return { allowed: true, reason: 'subtree_or_linked' };
      return { allowed: false, reason: 'no_task_membership' };
    }

    case 'edit_status': {
      // Tier 3 (assistant_manager): subtree-scoped management still grants
      // unrestricted status edits inside the subtree.
      if (tier === TIER_3 && inSubtree) {
        return { allowed: true, reason: 'subtree_management', allowedFields: null };
      }
      if (isAssignee || isTaskCreator || task.assignedTo === user.id) {
        return { allowed: true, reason: 'assignee_status', allowedFields: ['status', 'progress'] };
      }
      return { allowed: false, reason: 'not_assignee' };
    }

    case 'edit': {
      // Tier 3 / Tier 4 — both fall to the assignee/creator whitelist for the
      // primary `edit` action. Tier 3 used to get full edit inside its
      // subtree; that was widening into "may rewrite anyone in my org's
      // tasks". The product rule is now: only Tier 1 / Tier 2 may edit
      // arbitrary fields; Tier 3 (and Tier 4) edit through the same
      // narrow whitelist when they're personally on the task.
      //
      // `assignedTo` is INCLUDED so a member-creator can self-assign their
      // own task once they've set a due date. The actual "can this user
      // assign target X" decision is left to `checkAssignmentAuthority`
      // (deny non-self for members lacking tasks.assign_others) and
      // `needsDueDateForAssignment` (block any assignment without a due
      // date) downstream in the controller — this whitelist only governs
      // *which fields are even readable* from the body.
      //
      // `dueDate` is also INCLUDED here so the field can reach the
      // controller, but the controller layers a separate "due-date lock"
      // gate on top: Tier 3 / Tier 4 may only set the INITIAL due date
      // (existing value null). Once a due date is on the task, only
      // Tier 1 / Tier 2 may change it. See `updateTask` and
      // `bulkUpdateTasks`. We deliberately keep dueDate in the whitelist
      // (rather than stripping it) so the controller can return a clear
      // 403 with `code: DUE_DATE_LOCKED` instead of a silent no-op.
      if (isAssignee || task.assignedTo === user.id || isTaskCreator) {
        // NOTE: `title` is intentionally OMITTED here. Per the title-lock
        // rule (Tier 1 only post-creation), assignees and creators may not
        // rename a task once it exists — only Tier 1 / Super Admin may.
        // The Tier 1 path takes the `admin_access` branch above, which
        // returns `allowedFields: null` (full whitelist). Stripping title
        // here is defense-in-depth: even if the controller-level title
        // gate is bypassed, the field merge in updateTask will silently
        // drop title for the assignee path because it's not in this list.
        return {
          allowed: true,
          reason: 'assignee_restricted',
          allowedFields: [
            'description', 'status', 'priority', 'progress',
            'groupId', 'position', 'tags', 'customFields',
            'dueDate', 'startDate', 'assignedTo',
            'plannedStartTime', 'plannedEndTime', 'estimatedHours', 'actualHours',
          ],
        };
      }
      // Supervisor — can view and comment but NOT edit fields
      if (isSupervisor) {
        return { allowed: false, reason: 'supervisor_read_only' };
      }
      return { allowed: false, reason: 'no_edit_permission' };
    }

    case 'reassign': {
      // Tier 3 may reassign INSIDE their subtree. (Tier 1/2 already returned
      // tier_full_access at the top.)
      if (tier === TIER_3 && inSubtree) {
        return { allowed: true, reason: 'subtree_management' };
      }
      return { allowed: false, reason: 'insufficient_role_for_reassign' };
    }

    case 'delete': {
      if (tier === TIER_3 && inSubtree) {
        return { allowed: true, reason: 'subtree_management' };
      }
      // Members can archive their own tasks
      if ((isAssignee || task.assignedTo === user.id) && tier === TIER_4) {
        return { allowed: true, reason: 'member_archive_only' };
      }
      return { allowed: false, reason: 'insufficient_role_for_delete' };
    }

    case 'create': {
      // Tier 3 (assistant_manager) — unrestricted create (T1/T2 already
      // returned at the top of the function).
      if (tier === TIER_3) {
        return { allowed: true, reason: 'can_create' };
      }
      // Tier 4 (member) — allowed to create. Downstream gates (`assign_others`
      // permission via checkAssignmentAuthority, plus needsDueDateForAssignment)
      // restrict member creates to *self-assigned tasks without due dates*,
      // which is the documented "personal task" path.
      if (tier === TIER_4) {
        return { allowed: true, reason: 'member_self_create' };
      }
      return { allowed: false, reason: 'unknown_tier_for_create' };
    }

    case 'manage_members': {
      if (tier === TIER_3 && inSubtree) {
        return { allowed: true, reason: 'can_manage_members' };
      }
      return { allowed: false, reason: 'insufficient_role_for_member_management' };
    }

    default:
      return { allowed: false, reason: 'unknown_action' };
  }
}

/**
 * Middleware: Verify user can view a specific task (for GET /tasks/:id endpoints)
 * Must be used after authenticate. Delegates to the centralized
 * taskVisibilityService — the SAME rule used by list queries — so a viewer
 * cannot access by direct URL anything the list filter would have hidden.
 *
 * On success, attaches `req._taskInSubtree = true` so downstream
 * checkTaskAction() can elevate manager / assistant_manager edit
 * permissions for the row that just passed visibility.
 */
async function canViewTask(req, res, next) {
  try {
    const user = req.user;
    const taskId = req.params.id || req.params.taskId;
    if (!taskId) return next();

    // Single decision point: defer to the kernel's unrestricted check so the
    // middleware short-circuit, the per-row check, and the list filter all
    // agree (D.1 hotfix — was `user.isSuperAdmin || user.role === 'admin'`).
    if (taskVisibility.isUnrestrictedTaskViewer(user)) {
      req._taskInSubtree = true;
      return next();
    }

    const allowed = await taskVisibility.canViewTask(user, taskId);
    if (allowed) {
      req._taskInSubtree = true;
      return next();
    }

    // Dependency-owner read path — a member assigned to a DependencyRequest
    // on this parent task gets read access (so "Open Parent" from the
    // Dependencies page doesn't 403). Mutations are still blocked by the
    // existing role/ownership rules — this only opens the visibility door.
    try {
      const { DependencyRequest } = require('../models');
      const depCount = await DependencyRequest.count({
        where: { parentTaskId: taskId, assignedToUserId: user.id },
      });
      if (depCount > 0) {
        // Dependency read access does NOT confer subtree powers.
        return next();
      }
    } catch { /* dependency_requests table may not exist on very old DBs */ }

    if (process.env.NODE_ENV !== 'production') {
      logger.warn(`[RBAC] task view denied: user=${user.id} (${user.role}) task=${taskId}`);
    }
    return res.status(403).json({
      success: false,
      message: 'Access denied. You are not authorized to view this task.',
    });
  } catch (err) {
    logger.error('[RBAC] canViewTask error:', err.message);
    return res.status(500).json({ success: false, message: 'Permission check failed.' });
  }
}

module.exports = {
  attachTaskPermissions,
  buildTaskVisibilityFilter,
  checkTaskAction,
  canViewTask,
  isHierarchyManager,
  ROLE_HIERARCHY,
};
