const { TaskAssignee, User } = require('../models');
const { sequelize } = require('../config/db');
const { Op } = require('sequelize');
const { safeUUID } = require('../utils/safeSql');
const taskVisibility = require('../services/taskVisibilityService');
const logger = require('../utils/logger');

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

  const permissions = {
    role,
    isSuperAdmin,
    // hasFullAccess now means "may bypass per-task visibility checks". Only
    // admins / super admins do; managers and assistant managers are scoped to
    // their org subtree.
    hasFullAccess: isSuperAdmin || role === 'admin',
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
  const role = user.role;
  const isSuperAdmin = !!user.isSuperAdmin;

  // Super admin / admin — full access always.
  if (isSuperAdmin || role === 'admin') {
    return { allowed: true, reason: 'admin_access', allowedFields: null };
  }

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
      // Manager / assistant_manager: full edit on tasks inside their subtree.
      if ((role === 'manager' || role === 'assistant_manager') && inSubtree) {
        return { allowed: true, reason: 'subtree_management', allowedFields: null };
      }
      if (isAssignee || isTaskCreator || task.assignedTo === user.id) {
        return { allowed: true, reason: 'assignee_status', allowedFields: ['status', 'progress'] };
      }
      return { allowed: false, reason: 'not_assignee' };
    }

    case 'edit': {
      // Manager / assistant_manager: full edit on tasks inside their subtree.
      if ((role === 'manager' || role === 'assistant_manager') && inSubtree) {
        return { allowed: true, reason: 'subtree_management', allowedFields: null };
      }
      // Assignee / creator — can update the self-management whitelist.
      if (isAssignee || task.assignedTo === user.id || isTaskCreator) {
        return {
          allowed: true,
          reason: 'assignee_restricted',
          allowedFields: [
            'title', 'description', 'status', 'priority', 'progress',
            'groupId', 'position', 'tags', 'customFields',
            'dueDate', 'startDate',
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
      // Only manager+ acting on a task INSIDE their subtree.
      if ((role === 'manager' || role === 'assistant_manager') && inSubtree) {
        return { allowed: true, reason: 'subtree_management' };
      }
      return { allowed: false, reason: 'insufficient_role_for_reassign' };
    }

    case 'delete': {
      if ((role === 'manager' || role === 'assistant_manager') && inSubtree) {
        return { allowed: true, reason: 'subtree_management' };
      }
      // Members can archive their own tasks
      if ((isAssignee || task.assignedTo === user.id) && role === 'member') {
        return { allowed: true, reason: 'member_archive_only' };
      }
      return { allowed: false, reason: 'insufficient_role_for_delete' };
    }

    case 'create': {
      if (['manager', 'assistant_manager'].includes(role)) return { allowed: true, reason: 'can_create' };
      return { allowed: false, reason: 'members_cannot_create' };
    }

    case 'manage_members': {
      if ((role === 'manager' || role === 'assistant_manager') && inSubtree) {
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

    if (user.isSuperAdmin || user.role === 'admin') {
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
