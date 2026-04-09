const { User } = require('../models');
const { Op } = require('sequelize');

/**
 * Recursively get all descendant user IDs for a given manager.
 * Follows the managerId chain in the users table.
 */
async function getDescendantIds(managerId, visited = new Set()) {
  if (!managerId || visited.has(managerId)) return [];
  visited.add(managerId);

  const directReports = await User.findAll({
    where: { managerId, isActive: true },
    attributes: ['id'],
    raw: true,
  });

  const ids = directReports.map(u => u.id);
  for (const report of directReports) {
    const subIds = await getDescendantIds(report.id, visited);
    ids.push(...subIds);
  }
  return ids;
}

/**
 * Get list of users that the actor can assign tasks to.
 * - admin / super admin → all active users
 * - manager / assistant_manager → self + descendants in org tree
 * - member → self only
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

module.exports = { getDescendantIds, getAssignableUsers, canAssignTo };
