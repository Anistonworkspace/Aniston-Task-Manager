const { TaskAssignee, User } = require('../models');
const { sequelize } = require('../config/db');
const { Op } = require('sequelize');
const { safeUUID } = require('../utils/safeSql');

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
    hasFullAccess: isSuperAdmin || role === 'admin' || role === 'manager',
    hasBoardAccess: role === 'assistant_manager',
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
 * Layer 2 — Task Visibility Query Builder
 * Constructs WHERE clauses that filter tasks based on user's role and membership.
 * Returns a Sequelize-compatible where condition to merge into task queries.
 */
async function buildTaskVisibilityFilter(user, boardId) {
  const role = user.role;
  const isSuperAdmin = !!user.isSuperAdmin;

  // Admin / super admin — no filter, see everything
  if (isSuperAdmin || role === 'admin') {
    return {};
  }

  // Manager / Assistant Manager — full access to tasks within the board
  if (role === 'manager' || role === 'assistant_manager') {
    return {};
  }

  // Check if member is hierarchy manager — they can see their subtree's tasks too
  const uid = safeUUID(user.id, 'user.id');
  const orConditions = [
    { assignedTo: user.id },
    { createdBy: user.id },
  ];

  // Only include junction-table subqueries if the tables exist
  if (await taskOwnersTableExists()) {
    orConditions.push(
      sequelize.literal(`"Task"."id" IN (SELECT "taskId" FROM task_owners WHERE "userId" = ${uid})`)
    );
  }
  if (await taskAssigneesTableExists()) {
    orConditions.push(
      sequelize.literal(`"Task"."id" IN (SELECT "taskId" FROM task_assignees WHERE "userId" = ${uid})`)
    );
  }
  return { [Op.or]: orConditions };
}

/**
 * Layer 3 — Action Permission Check
 * Validates whether a user can perform a specific action on a specific task.
 *
 * @param {string} action - 'view' | 'edit' | 'edit_status' | 'edit_all' | 'reassign' | 'delete' | 'create'
 * @param {object} user - The authenticated user
 * @param {object} task - The task being acted upon (with assignees loaded)
 * @param {Array} taskAssignees - Array of TaskAssignee records for this task
 * @param {object} [req] - Express request (for hierarchy manager caching)
 * @returns {{ allowed: boolean, reason: string, allowedFields: string[]|null }}
 */
function checkTaskAction(action, user, task, taskAssignees = [], req) {
  const role = user.role;
  const isSuperAdmin = !!user.isSuperAdmin;

  // Super admin / admin / manager — full access always (manager = admin)
  if (isSuperAdmin || role === 'admin' || role === 'manager') {
    return { allowed: true, reason: 'admin_access', allowedFields: null };
  }

  // Find user's membership role in this task
  const userAssignment = taskAssignees.find(ta => ta.userId === user.id);
  const isAssignee = userAssignment?.role === 'assignee';
  const isSupervisor = userAssignment?.role === 'supervisor';
  const isMember = !userAssignment && role === 'member';
  const isTaskCreator = task.createdBy === user.id;

  // Check if member is hierarchy manager (sync check using cached value)
  const hierarchyMgr = req?._isHierarchyManager || false;

  switch (action) {
    case 'view': {
      // Assistant manager — allowed for team members' tasks
      if (role === 'assistant_manager') return { allowed: true, reason: 'assistant_manager_access' };
      // Member — only if linked via task_assignees or creator
      if (userAssignment || isTaskCreator || task.assignedTo === user.id) {
        return { allowed: true, reason: 'member_linked' };
      }
      return { allowed: false, reason: 'no_task_membership' };
    }

    case 'edit_status': {
      if (role === 'assistant_manager') return { allowed: true, reason: 'assistant_manager_access' };
      if (isAssignee || isTaskCreator || task.assignedTo === user.id) {
        return { allowed: true, reason: 'assignee_status', allowedFields: ['status', 'progress'] };
      }
      return { allowed: false, reason: 'not_assignee' };
    }

    case 'edit': {
      // Assistant manager — full task edit access
      if (role === 'assistant_manager') {
        return { allowed: true, reason: 'assistant_manager_access', allowedFields: null };
      }
      // Assignee employee — can only update status/progress on own tasks
      if (isAssignee || task.assignedTo === user.id || isTaskCreator) {
        return { allowed: true, reason: 'assignee_restricted', allowedFields: ['title', 'status', 'progress', 'groupId', 'position'] };
      }
      // Supervisor — can view and comment but NOT edit fields
      if (isSupervisor) {
        return { allowed: false, reason: 'supervisor_read_only' };
      }
      return { allowed: false, reason: 'no_edit_permission' };
    }

    case 'reassign': {
      // Only manager+ can reassign
      if (role === 'manager') return { allowed: true, reason: 'manager_access' };
      if (role === 'assistant_manager') return { allowed: true, reason: 'assistant_manager_access' };
      return { allowed: false, reason: 'insufficient_role_for_reassign' };
    }

    case 'delete': {
      // Manager and assistant_manager can delete
      if (role === 'manager' || role === 'assistant_manager') return { allowed: true, reason: 'manager_access' };
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
      if (['manager', 'assistant_manager'].includes(role)) return { allowed: true, reason: 'can_manage_members' };
      return { allowed: false, reason: 'insufficient_role_for_member_management' };
    }

    default:
      return { allowed: false, reason: 'unknown_action' };
  }
}

/**
 * Middleware: Verify user can view a specific task (for GET /tasks/:id endpoints)
 * Must be used after authenticate. Loads task assignees and checks visibility.
 */
async function canViewTask(req, res, next) {
  const user = req.user;
  const taskId = req.params.id || req.params.taskId;
  if (!taskId) return next();

  const role = user.role;
  const isSuperAdmin = !!user.isSuperAdmin;

  // Admin/super admin/manager/assistant_manager — always allowed
  if (isSuperAdmin || role === 'admin' || role === 'manager' || role === 'assistant_manager') {
    return next();
  }

  // Check if user is linked to this task via task_assignees (new system)
  if (await taskAssigneesTableExists()) {
    const assignment = await TaskAssignee.findOne({
      where: { taskId, userId: user.id },
    });
    if (assignment) return next();
  }

  // Check if user is linked via task_owners (multi-owner system)
  const { Task, TaskOwner } = require('../models');
  if (await taskOwnersTableExists()) {
    const ownerRecord = await TaskOwner.findOne({
      where: { taskId, userId: user.id },
    });
    if (ownerRecord) return next();
  }

  // Backward compat: check old assignedTo column and createdBy
  const task = await Task.findByPk(taskId, { attributes: ['id', 'assignedTo', 'createdBy'] });
  if (!task) {
    return res.status(404).json({ success: false, message: 'Task not found.' });
  }

  if (task.assignedTo === user.id || task.createdBy === user.id) {
    return next();
  }

  // Assistant manager — check if any assignee is on their team
  if (role === 'assistant_manager') {
    const teamMembers = await User.findAll({
      where: { managerId: user.id },
      attributes: ['id'],
      raw: true,
    });
    const teamIds = teamMembers.map(m => m.id);
    teamIds.push(user.id);

    if (await taskAssigneesTableExists()) {
      const teamAssignment = await TaskAssignee.findOne({
        where: { taskId, userId: { [Op.in]: teamIds } },
      });
      if (teamAssignment) return next();
    }

    // Check task_owners for team members
    const teamOwner = await taskOwnersTableExists() ? await TaskOwner.findOne({
      where: { taskId, userId: { [Op.in]: teamIds } },
    }) : null;
    if (teamOwner) return next();

    // Check old assignedTo
    if (teamIds.includes(task.assignedTo)) return next();
  }

  return res.status(403).json({
    success: false,
    message: 'Access denied. You are not authorized to view this task.',
  });
}

module.exports = {
  attachTaskPermissions,
  buildTaskVisibilityFilter,
  checkTaskAction,
  canViewTask,
  isHierarchyManager,
  ROLE_HIERARCHY,
};
