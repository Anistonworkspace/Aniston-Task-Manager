const { TaskAssignee, User } = require('../models');
const { sequelize } = require('../config/db');
const { Op } = require('sequelize');
const { safeUUID } = require('../utils/safeSql');

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
 * Layer 1 — Role Check: Attaches permission context to req.taskPermissions
 * Determines what level of access the user has based on their role.
 */
function attachTaskPermissions(req, res, next) {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ success: false, message: 'Not authenticated.' });
  }

  const role = user.role;
  const isSuperAdmin = !!user.isSuperAdmin;

  const permissions = {
    role,
    isSuperAdmin,
    // Full access: admin (or super admin) sees everything
    hasFullAccess: isSuperAdmin || role === 'admin',
    // Board-level access: manager and assistant_manager see all tasks in their boards
    hasBoardAccess: role === 'manager' || role === 'assistant_manager',
    // Partial access: (reserved for future roles with team-scoped visibility)
    hasPartialAccess: false,
    // Restricted: employee/member sees only their own tasks
    isRestricted: role === 'member',
    // Action permissions based on role
    canCreate: isSuperAdmin || ['admin', 'manager', 'assistant_manager'].includes(role),
    canEditOthers: isSuperAdmin || ['admin', 'manager', 'assistant_manager'].includes(role),
    canDelete: isSuperAdmin || ['admin', 'manager', 'assistant_manager'].includes(role),
    canAssignMembers: isSuperAdmin || ['admin', 'manager', 'assistant_manager'].includes(role),
    canManageBoardSettings: isSuperAdmin || role === 'admin',
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

  // Member/employee — ONLY see tasks they are personally linked to
  const uid = safeUUID(user.id, 'user.id');
  return {
    [Op.or]: [
      // Linked via task_assignees (new system)
      sequelize.literal(`"Task"."id" IN (SELECT "taskId" FROM task_assignees WHERE "userId" = ${uid})`),
      // Linked via task_owners (multi-owner system)
      sequelize.literal(`"Task"."id" IN (SELECT "taskId" FROM task_owners WHERE "userId" = ${uid})`),
      // Backward compat: old assignedTo column
      { assignedTo: user.id },
      // Tasks they created (so they can track what they made)
      { createdBy: user.id },
    ],
  };
}

/**
 * Layer 3 — Action Permission Check
 * Validates whether a user can perform a specific action on a specific task.
 *
 * @param {string} action - 'view' | 'edit' | 'edit_status' | 'edit_all' | 'reassign' | 'delete' | 'create'
 * @param {object} user - The authenticated user
 * @param {object} task - The task being acted upon (with assignees loaded)
 * @param {Array} taskAssignees - Array of TaskAssignee records for this task
 * @returns {{ allowed: boolean, reason: string, allowedFields: string[]|null }}
 */
function checkTaskAction(action, user, task, taskAssignees = []) {
  const role = user.role;
  const isSuperAdmin = !!user.isSuperAdmin;

  // Super admin / admin — full access always
  if (isSuperAdmin || role === 'admin') {
    return { allowed: true, reason: 'admin_access', allowedFields: null };
  }

  // Find user's membership role in this task
  const userAssignment = taskAssignees.find(ta => ta.userId === user.id);
  const isAssignee = userAssignment?.role === 'assignee';
  const isSupervisor = userAssignment?.role === 'supervisor';
  const isMember = !userAssignment && role === 'member';
  const isTaskCreator = task.createdBy === user.id;

  switch (action) {
    case 'view': {
      // Manager — always allowed within their boards
      if (role === 'manager') return { allowed: true, reason: 'manager_access' };
      // Assistant manager — allowed for team members' tasks
      if (role === 'assistant_manager') return { allowed: true, reason: 'assistant_manager_access' };
      // Member — only if linked via task_assignees or creator
      if (userAssignment || isTaskCreator || task.assignedTo === user.id) {
        return { allowed: true, reason: 'member_linked' };
      }
      return { allowed: false, reason: 'no_task_membership' };
    }

    case 'edit_status': {
      // Anyone linked to the task can update status
      if (role === 'manager') return { allowed: true, reason: 'manager_access' };
      if (role === 'assistant_manager') return { allowed: true, reason: 'assistant_manager_access' };
      if (isAssignee || isTaskCreator || task.assignedTo === user.id) {
        return { allowed: true, reason: 'assignee_status', allowedFields: ['status', 'progress'] };
      }
      return { allowed: false, reason: 'not_assignee' };
    }

    case 'edit': {
      // Manager — can edit all fields (unless admin-created task)
      if (role === 'manager') {
        const restrictedFields = ['title', 'status', 'progress', 'groupId', 'position'];
        // Check if task was created by admin
        if (task.creator?.role === 'admin') {
          return { allowed: true, reason: 'manager_restricted', allowedFields: restrictedFields };
        }
        return { allowed: true, reason: 'manager_access', allowedFields: null };
      }
      // Assistant manager — can edit tasks within their team
      if (role === 'assistant_manager') {
        if (task.creator?.role === 'admin') {
          return { allowed: true, reason: 'assistant_manager_restricted', allowedFields: ['title', 'status', 'progress', 'groupId', 'position'] };
        }
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
  const assignment = await TaskAssignee.findOne({
    where: { taskId, userId: user.id },
  });
  if (assignment) return next();

  // Check if user is linked via task_owners (multi-owner system)
  const { Task, TaskOwner } = require('../models');
  const ownerRecord = await TaskOwner.findOne({
    where: { taskId, userId: user.id },
  });
  if (ownerRecord) return next();

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

    const teamAssignment = await TaskAssignee.findOne({
      where: { taskId, userId: { [Op.in]: teamIds } },
    });
    if (teamAssignment) return next();

    // Check task_owners for team members
    const teamOwner = await TaskOwner.findOne({
      where: { taskId, userId: { [Op.in]: teamIds } },
    });
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
  ROLE_HIERARCHY,
};