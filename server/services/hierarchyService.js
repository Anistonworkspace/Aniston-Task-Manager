const { User, ManagerRelation } = require('../models');
const { Op } = require('sequelize');

/**
 * Get direct report IDs for a manager from BOTH sources:
 *   1. User.managerId column (legacy/primary)
 *   2. manager_relations junction table (multi-manager system)
 *
 * Returns deduplicated array of user IDs.
 */
async function getDirectReportIds(managerId) {
  const ids = new Set();

  // Source 1: User.managerId column
  const legacyReports = await User.findAll({
    where: { managerId, isActive: true },
    attributes: ['id'],
    raw: true,
  });
  for (const u of legacyReports) ids.add(u.id);

  // Source 2: manager_relations junction table
  try {
    const relations = await ManagerRelation.findAll({
      where: { managerId },
      attributes: ['employeeId'],
      raw: true,
    });
    // Verify employees are active
    if (relations.length > 0) {
      const employeeIds = relations.map(r => r.employeeId);
      const activeEmployees = await User.findAll({
        where: { id: { [Op.in]: employeeIds }, isActive: true },
        attributes: ['id'],
        raw: true,
      });
      for (const u of activeEmployees) ids.add(u.id);
    }
  } catch (e) {
    // manager_relations table may not exist in some environments
    // Fall through — legacy User.managerId is still used
  }

  return [...ids];
}

/**
 * Recursively get all descendant user IDs for a given manager.
 * Follows both User.managerId and manager_relations.
 */
async function getDescendantIds(managerId, visited = new Set()) {
  if (!managerId || visited.has(managerId)) return [];
  visited.add(managerId);

  const directIds = await getDirectReportIds(managerId);
  const allIds = [...directIds];

  for (const id of directIds) {
    const subIds = await getDescendantIds(id, visited);
    allIds.push(...subIds);
  }

  // Deduplicate
  return [...new Set(allIds)];
}

/**
 * Check if a user has any direct reports (via either User.managerId or manager_relations).
 */
async function hasDirectReports(userId) {
  // Check User.managerId
  const legacyCount = await User.count({ where: { managerId: userId, isActive: true } });
  if (legacyCount > 0) return true;

  // Check manager_relations
  try {
    const relCount = await ManagerRelation.count({ where: { managerId: userId } });
    if (relCount > 0) {
      // Verify at least one employee is active
      const rels = await ManagerRelation.findAll({
        where: { managerId: userId },
        attributes: ['employeeId'],
        raw: true,
      });
      const activeCount = await User.count({
        where: { id: { [Op.in]: rels.map(r => r.employeeId) }, isActive: true },
      });
      return activeCount > 0;
    }
  } catch (e) {
    // Table may not exist
  }

  return false;
}

/**
 * Get list of users that the actor can assign tasks to.
 * Strict RBAC:
 * - admin / super admin → all active users
 * - manager / assistant_manager → self + descendants in org tree
 * - member → self only (no task assignment capability)
 */
async function getAssignableUsers(actor) {
  const isAdmin = actor.role === 'admin' || actor.isSuperAdmin;

  if (isAdmin) {
    return User.findAll({
      where: { isActive: true },
      attributes: ['id', 'name', 'email', 'avatar', 'role', 'department', 'designation'],
      order: [['name', 'ASC']],
    });
  }

  if (['manager', 'assistant_manager'].includes(actor.role)) {
    const descendantIds = await getDescendantIds(actor.id);
    const allowedIds = [actor.id, ...descendantIds];
    return User.findAll({
      where: { id: { [Op.in]: allowedIds }, isActive: true },
      attributes: ['id', 'name', 'email', 'avatar', 'role', 'department', 'designation'],
      order: [['name', 'ASC']],
    });
  }

  // member → self only
  return User.findAll({
    where: { id: actor.id, isActive: true },
    attributes: ['id', 'name', 'email', 'avatar', 'role', 'department', 'designation'],
  });
}

/**
 * Check if actor can assign a task to targetUserId.
 * Strict RBAC: only admin/manager/assistant_manager can assign to others.
 */
async function canAssignTo(actor, targetUserId) {
  if (actor.role === 'admin' || actor.isSuperAdmin) return true;
  if (String(actor.id) === String(targetUserId)) return true;

  if (['manager', 'assistant_manager'].includes(actor.role)) {
    const descendantIds = await getDescendantIds(actor.id);
    return descendantIds.some(id => String(id) === String(targetUserId));
  }

  return false;
}

module.exports = { getDescendantIds, getDirectReportIds, hasDirectReports, getAssignableUsers, canAssignTo };
