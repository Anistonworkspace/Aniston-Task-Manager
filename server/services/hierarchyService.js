const { User, ManagerRelation } = require('../models');
const { sequelize } = require('../config/db');
const { Op } = require('sequelize');
const { PILL_ATTRIBUTES: USER_PILL_ATTRIBUTES } = require('../config/userAttributes');

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Org-chart hierarchy service — single source of truth for:
 *   - Reading the manager / descendants tree (legacy User.managerId AND
 *     manager_relations junction table).
 *   - Authorization decisions (canManageUser, canEditHierarchy, canAssignTo).
 *   - Transactional mutations (setPrimaryManager, removePrimaryManager) that
 *     keep User.managerId and manager_relations consistent.
 *
 * Every controller that touches hierarchy MUST go through this service. Doing
 * the writes inline elsewhere (User.update + ManagerRelation.update split
 * across statements) is what causes the local-vs-prod drift the audit flagged.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// Fields a "branch-safe" actor (manager / assistant manager) is permitted to
// edit on a user inside their org branch. Sensitive identity fields (role,
// hierarchyLevel, isActive, isSuperAdmin, email, managerId, accountStatus,
// workspaceId) are NOT included — those need full-scope authority.
const BRANCH_SAFE_USER_FIELDS = Object.freeze([
  'name',
  'designation',
  'title',
  'department',
  'departmentId',
  'avatar',
]);

// Fields available with full ('admin' or super_admin) scope on a target. Even
// at full scope, isSuperAdmin requires the actor itself to be a super_admin.
const FULL_SCOPE_USER_FIELDS = Object.freeze([
  ...BRANCH_SAFE_USER_FIELDS,
  'email',
  'role',
  'hierarchyLevel',
  'isActive',
  'accountStatus',
]);

// Fields only an actor with isSuperAdmin can flip on a target.
const SUPER_ADMIN_ONLY_FIELDS = Object.freeze(['isSuperAdmin']);

// ─── Tree reads ──────────────────────────────────────────────────────────────

/**
 * Get direct report IDs for a manager, unioning:
 *   1. User.managerId column (legacy / primary cache)
 *   2. manager_relations junction table (canonical multi-manager source)
 *
 * Inactive employees are filtered out. Returns deduplicated array of UUIDs.
 */
async function getDirectReportIds(managerId, { transaction } = {}) {
  if (!managerId) return [];
  const ids = new Set();

  const legacyReports = await User.findAll({
    where: { managerId, isActive: true },
    attributes: ['id'],
    raw: true,
    transaction,
  });
  for (const u of legacyReports) ids.add(u.id);

  try {
    const relations = await ManagerRelation.findAll({
      where: { managerId },
      attributes: ['employeeId'],
      raw: true,
      transaction,
    });
    if (relations.length > 0) {
      const employeeIds = relations.map((r) => r.employeeId);
      const activeEmployees = await User.findAll({
        where: { id: { [Op.in]: employeeIds }, isActive: true },
        attributes: ['id'],
        raw: true,
        transaction,
      });
      for (const u of activeEmployees) ids.add(u.id);
    }
  } catch (e) {
    // manager_relations may not exist on older databases — fall through.
  }

  return [...ids];
}

/**
 * Recursively get descendant user IDs for a given manager.
 * Visited-set protects against cycles in the data (defense in depth — cycles
 * are also blocked at write time).
 */
async function getDescendantIds(managerId, options = {}) {
  const { transaction, _visited } = options;
  const visited = _visited || new Set();
  if (!managerId || visited.has(managerId)) return [];
  visited.add(managerId);

  const directIds = await getDirectReportIds(managerId, { transaction });
  const allIds = new Set(directIds);

  for (const id of directIds) {
    const subIds = await getDescendantIds(id, { transaction, _visited: visited });
    for (const sid of subIds) allIds.add(sid);
  }

  return [...allIds];
}

/**
 * Whether a user has any active direct reports (either source).
 */
async function hasDirectReports(userId, { transaction } = {}) {
  if (!userId) return false;

  const legacyCount = await User.count({
    where: { managerId: userId, isActive: true },
    transaction,
  });
  if (legacyCount > 0) return true;

  try {
    const relCount = await ManagerRelation.count({
      where: { managerId: userId },
      transaction,
    });
    if (relCount > 0) {
      const rels = await ManagerRelation.findAll({
        where: { managerId: userId },
        attributes: ['employeeId'],
        raw: true,
        transaction,
      });
      const activeCount = await User.count({
        where: { id: { [Op.in]: rels.map((r) => r.employeeId) }, isActive: true },
        transaction,
      });
      return activeCount > 0;
    }
  } catch (e) {
    // table absent — already counted legacy above
  }
  return false;
}

/**
 * Resolve the canonical primary manager id for an employee.
 * Order of precedence:
 *   1. manager_relations row with isPrimary=true
 *   2. User.managerId (legacy fallback)
 * Returns null if no primary is set.
 */
async function getPrimaryManagerId(userId, { transaction } = {}) {
  if (!userId) return null;
  try {
    const primary = await ManagerRelation.findOne({
      where: { employeeId: userId, isPrimary: true },
      attributes: ['managerId'],
      transaction,
    });
    if (primary && primary.managerId) return primary.managerId;
  } catch (e) {
    // table absent — fall through
  }
  const u = await User.findByPk(userId, { attributes: ['managerId'], transaction });
  return u?.managerId || null;
}

/**
 * Check whether descendantId appears anywhere in ancestorId's subtree
 * (i.e. ancestorId can manage descendantId via the org branch).
 *
 * `ancestorId === descendantId` returns false — a user is not their own
 * descendant. Use `String() ===` callers if they need to include self.
 */
async function isDescendantOf(descendantId, ancestorId, options = {}) {
  if (!descendantId || !ancestorId) return false;
  if (String(descendantId) === String(ancestorId)) return false;
  const descendants = await getDescendantIds(ancestorId, options);
  return descendants.some((id) => String(id) === String(descendantId));
}

/**
 * Detect whether assigning `newManagerId` as `employeeId`'s primary manager
 * would create a cycle. Walks both User.managerId and manager_relations to
 * build a complete ancestor set of the proposed manager.
 *
 * Returns `{ wouldCycle: boolean, reason?: string }`.
 */
async function wouldCreateCycle(employeeId, newManagerId, { transaction } = {}) {
  if (!newManagerId) return { wouldCycle: false };
  if (String(newManagerId) === String(employeeId)) {
    return { wouldCycle: true, reason: 'A user cannot be their own manager.' };
  }

  // If employeeId is anywhere in newManagerId's ancestor chain, we'd cycle.
  // We climb upward from newManagerId, treating both User.managerId and any
  // primary manager_relations row as parents. Visited set prevents looping on
  // pre-existing cycle data.
  const visited = new Set();
  let frontier = [newManagerId];
  while (frontier.length > 0) {
    const next = [];
    for (const cur of frontier) {
      if (!cur || visited.has(cur)) continue;
      visited.add(cur);
      if (String(cur) === String(employeeId)) {
        return {
          wouldCycle: true,
          reason: 'Circular hierarchy detected: the proposed manager already reports (directly or indirectly) to this user.',
        };
      }
      const parentId = await getPrimaryManagerId(cur, { transaction });
      if (parentId) next.push(parentId);
    }
    frontier = next;
  }
  return { wouldCycle: false };
}

// ─── Authorization helpers ───────────────────────────────────────────────────

const PROTECTED_TARGET_ROLES = new Set(['admin']);

/**
 * Decide what an actor can do to a target user record.
 * Returns:
 *   - allowed: boolean (overall yes/no for any edit)
 *   - scope:   'full' | 'branch_safe' | 'self' | 'denied'
 *   - reason:  human-readable string when not allowed (or scope-restricted)
 *
 * Scopes:
 *   - 'full'         : actor may edit role / hierarchyLevel / isActive / email
 *                      (subject to additional super-admin gate for isSuperAdmin)
 *   - 'branch_safe'  : actor may edit only profile fields on a branch member
 *                      (no role / hierarchy / active flips). Used by managers
 *                      and assistant managers within their own subtree.
 *   - 'self'         : actor may edit only their own profile (no role change).
 *   - 'denied'       : no edits allowed.
 *
 * Caller is responsible for filtering req.body fields by scope.
 */
async function canManageUser(actor, target, options = {}) {
  if (!actor || !target) {
    return { allowed: false, scope: 'denied', reason: 'Actor or target missing.' };
  }
  const sameUser = String(actor.id) === String(target.id);

  // Super admin → full on anyone (still cannot remove their own super-admin
  // status here; that is enforced by SUPER_ADMIN_ONLY_FIELDS gating).
  if (actor.isSuperAdmin) {
    return { allowed: true, scope: 'full' };
  }

  // Strict admin → full on anyone except other super admins.
  if (actor.role === 'admin') {
    if (target.isSuperAdmin && !sameUser) {
      return {
        allowed: false,
        scope: 'denied',
        reason: 'Admins cannot modify a super admin account.',
      };
    }
    return { allowed: true, scope: 'full' };
  }

  // Manager → branch_safe scope on descendants. Cannot touch admins / super
  // admins / peers / ancestors / unrelated users. Cannot change own role.
  if (actor.role === 'manager') {
    if (sameUser) {
      // Manager may edit their own profile (safe fields), but role/hierarchy
      // changes for self are blocked elsewhere.
      return { allowed: true, scope: 'self' };
    }
    if (target.isSuperAdmin || PROTECTED_TARGET_ROLES.has(target.role)) {
      return {
        allowed: false,
        scope: 'denied',
        reason: 'Managers cannot modify admin or super admin users.',
      };
    }
    const inBranch = await isDescendantOf(target.id, actor.id, options);
    if (!inBranch) {
      return {
        allowed: false,
        scope: 'denied',
        reason: 'Managers can only manage users inside their own org branch.',
      };
    }
    return { allowed: true, scope: 'branch_safe' };
  }

  // Assistant manager → same as manager but typically tighter targets.
  if (actor.role === 'assistant_manager') {
    if (sameUser) return { allowed: true, scope: 'self' };
    if (target.isSuperAdmin || PROTECTED_TARGET_ROLES.has(target.role) || target.role === 'manager') {
      return {
        allowed: false,
        scope: 'denied',
        reason: 'Assistant managers cannot modify managers, admins, or super admins.',
      };
    }
    const inBranch = await isDescendantOf(target.id, actor.id, options);
    if (!inBranch) {
      return {
        allowed: false,
        scope: 'denied',
        reason: 'Assistant managers can only manage users inside their own subtree.',
      };
    }
    return { allowed: true, scope: 'branch_safe' };
  }

  // Member → may edit only self.
  if (sameUser) return { allowed: true, scope: 'self' };
  return { allowed: false, scope: 'denied', reason: 'Members cannot modify other users.' };
}

/**
 * Decide whether actor may edit hierarchy (re-parent an employee to a new
 * primary manager, or remove the primary manager when newManagerId is null).
 *
 * Rules:
 *   - Super admin / admin → allowed unless target is super admin (admin only)
 *     or it would create a cycle.
 *   - Manager → allowed only if:
 *       a) target user is in actor's subtree (or is actor's direct report),
 *       b) target is not admin / super admin / manager,
 *       c) newManagerId (if not null) is also in actor's subtree, or is the
 *          actor themselves (re-parent under self),
 *       d) no cycle is created.
 *   - Assistant manager → same as manager but cannot reparent under another
 *     manager outside own subtree.
 *   - Member → denied.
 *   - No actor may set their own primary manager.
 *
 * Returns `{ allowed: boolean, reason?: string }`.
 */
async function canEditHierarchy(actor, employeeId, newManagerId, options = {}) {
  if (!actor || !employeeId) {
    return { allowed: false, reason: 'Actor or employee missing.' };
  }

  if (String(employeeId) === String(actor.id)) {
    return { allowed: false, reason: 'You cannot change your own reporting manager.' };
  }

  if (newManagerId && String(newManagerId) === String(employeeId)) {
    return { allowed: false, reason: 'A user cannot be their own manager.' };
  }

  const target = await User.findByPk(employeeId, {
    attributes: ['id', 'role', 'isSuperAdmin', 'isActive', 'tier'],
    transaction: options.transaction,
  });
  if (!target) return { allowed: false, reason: 'Employee not found.' };

  // Tier 1 protection — applies to ALL actors, including other Tier 1 users.
  // Tier 1 (super admin) users are top-of-org leadership and must remain root
  // nodes. Reparenting them under anyone (or removing them from any branch)
  // is not a hierarchy operation we support — promote a successor to Tier 1
  // first and demote the existing Tier 1 instead.
  if (target.isSuperAdmin) {
    return {
      allowed: false,
      reason: 'Tier 1 users cannot be reassigned because they are top-level organization users.',
      code: 'TIER_1_IMMUTABLE',
    };
  }

  let proposedManager = null;
  if (newManagerId) {
    proposedManager = await User.findByPk(newManagerId, {
      attributes: ['id', 'role', 'isSuperAdmin', 'isActive', 'tier'],
      transaction: options.transaction,
    });
    if (!proposedManager) return { allowed: false, reason: 'Proposed manager not found.' };
    if (!proposedManager.isActive) {
      return { allowed: false, reason: 'Proposed manager is deactivated.' };
    }
    // NOTE: Tier 1 IS allowed as a proposed manager — Tier 1 represents
    // top-of-org leadership and lower tiers should be able to report to it.
    // The asymmetric rule is enforced above (target.isSuperAdmin → block):
    //   - target = Tier 1   → blocked (Tier 1 cannot be reassigned)
    //   - manager = Tier 1  → allowed (Tier 1 can manage other tiers)
    // The previous version of this branch incorrectly blocked the manager
    // case too and rejected legitimate "Mayank reports to Nitin (Tier 1)"
    // assignments with a misleading toast. Removed.
  }

  // Super admin → unrestricted (still cycle-checked below).
  if (!actor.isSuperAdmin) {
    if (actor.role === 'admin') {
      if (target.isSuperAdmin) {
        return { allowed: false, reason: 'Admins cannot reparent a super admin.' };
      }
      if (proposedManager && proposedManager.isSuperAdmin) {
        return { allowed: false, reason: 'Admins cannot assign a super admin as a primary manager.' };
      }
    } else if (actor.role === 'manager' || actor.role === 'assistant_manager') {
      // Cannot move admins / super admins / peers.
      if (target.isSuperAdmin || target.role === 'admin' || target.role === 'manager') {
        return {
          allowed: false,
          reason: `${actor.role === 'manager' ? 'Managers' : 'Assistant managers'} cannot reparent managers, admins, or super admins.`,
        };
      }
      // Target must be inside actor's subtree.
      const targetInBranch = await isDescendantOf(target.id, actor.id, options);
      if (!targetInBranch) {
        return {
          allowed: false,
          reason: 'You can only edit hierarchy for users inside your own org branch.',
        };
      }
      // Proposed manager (if any) must be actor themselves or also in subtree.
      if (proposedManager) {
        const isSelf = String(proposedManager.id) === String(actor.id);
        const proposedInBranch = isSelf
          ? true
          : await isDescendantOf(proposedManager.id, actor.id, options);
        if (!proposedInBranch) {
          return {
            allowed: false,
            reason: 'You cannot assign a manager outside your own org branch.',
          };
        }
        if (proposedManager.role === 'admin' || proposedManager.isSuperAdmin) {
          return {
            allowed: false,
            reason: 'You cannot assign an admin or super admin as a primary manager from this scope.',
          };
        }
      }
    } else {
      // Members and any other role have no hierarchy-edit privilege.
      return { allowed: false, reason: 'You do not have permission to edit hierarchy.' };
    }
  }

  // Cycle check (always, regardless of actor role).
  if (newManagerId) {
    const cycle = await wouldCreateCycle(employeeId, newManagerId, options);
    if (cycle.wouldCycle) return { allowed: false, reason: cycle.reason };
  }

  return { allowed: true };
}

// ─── Task assignment authorization (existing, kept stable) ───────────────────

async function getAssignableUsers(actor) {
  const isAdminOrSuperAdmin = actor.role === 'admin' || actor.isSuperAdmin;
  // Note: managers are NOT short-circuited here anymore. They see only users in
  // their own subtree (branch-scoped) per the CP-2 product rule. Until CP-2
  // ships, we keep the legacy behavior of including managers with global
  // visibility — toggle is below so CP-1 doesn't change task-assignment lists.
  // CP-1 keeps the old behavior: manager == admin for assignment list.
  const legacyManagerGlobal = actor.role === 'manager';

  if (isAdminOrSuperAdmin || legacyManagerGlobal) {
    return User.findAll({
      where: { isActive: true },
      attributes: [...USER_PILL_ATTRIBUTES, 'department', 'designation'],
      order: [['name', 'ASC']],
    });
  }

  if (actor.role === 'assistant_manager') {
    const descendantIds = await getDescendantIds(actor.id);
    const allowedIds = [actor.id, ...descendantIds];
    return User.findAll({
      where: { id: { [Op.in]: allowedIds }, isActive: true },
      attributes: [...USER_PILL_ATTRIBUTES, 'department', 'designation'],
      order: [['name', 'ASC']],
    });
  }

  return User.findAll({
    where: { id: actor.id, isActive: true },
    attributes: [...USER_PILL_ATTRIBUTES, 'department', 'designation'],
  });
}

async function canAssignTo(actor, targetUserId) {
  if (['admin', 'manager'].includes(actor.role) || actor.isSuperAdmin) return true;
  if (String(actor.id) === String(targetUserId)) return true;
  if (actor.role === 'assistant_manager') {
    const descendantIds = await getDescendantIds(actor.id);
    return descendantIds.some((id) => String(id) === String(targetUserId));
  }
  return false;
}

// ─── Transactional mutations ─────────────────────────────────────────────────

/**
 * Set or change the primary manager for an employee. Atomic: either both
 * User.managerId AND manager_relations are updated, or neither is.
 *
 * Authorization MUST be performed by the caller via canEditHierarchy(); this
 * function asserts authorization defensively and refuses if the actor cannot
 * edit hierarchy on the target. It also refuses if the change would cycle.
 *
 * Returns the updated User instance (re-fetched).
 */
async function setPrimaryManager(employeeId, managerId, actorUser, options = {}) {
  if (!employeeId) throw new Error('employeeId is required.');
  if (!managerId) {
    throw new Error('setPrimaryManager requires a non-null managerId. Use removePrimaryManager() to clear.');
  }
  const externalTx = options.transaction;
  const t = externalTx || (await sequelize.transaction());
  try {
    const auth = await canEditHierarchy(actorUser, employeeId, managerId, { transaction: t });
    if (!auth.allowed) {
      const err = new Error(auth.reason || 'Not authorized to edit hierarchy.');
      err.statusCode = 403;
      throw err;
    }

    const employee = await User.findByPk(employeeId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!employee) {
      const err = new Error('Employee not found.');
      err.statusCode = 404;
      throw err;
    }

    const previousManagerId = employee.managerId || null;

    // Step 1 — clear any other isPrimary rows for this employee.
    try {
      await ManagerRelation.update(
        { isPrimary: false },
        { where: { employeeId, isPrimary: true }, transaction: t },
      );
    } catch (e) {
      if (!options.tolerateMissingRelationsTable) throw e;
    }

    // Step 2 — upsert the new primary relation.
    try {
      const [rel, created] = await ManagerRelation.findOrCreate({
        where: { employeeId, managerId },
        defaults: { relationType: 'primary', isPrimary: true },
        transaction: t,
      });
      if (!created) {
        await rel.update(
          { isPrimary: true, relationType: 'primary' },
          { transaction: t },
        );
      }
    } catch (e) {
      if (!options.tolerateMissingRelationsTable) throw e;
    }

    // Step 3 — sync legacy User.managerId.
    await employee.update({ managerId }, { transaction: t });

    if (!externalTx) await t.commit();
    return {
      employee: await User.findByPk(employeeId, { transaction: externalTx }),
      previousManagerId,
      newManagerId: managerId,
    };
  } catch (err) {
    if (!externalTx) await t.rollback();
    throw err;
  }
}

/**
 * Remove the primary manager from an employee (make root). Atomic: clears
 * BOTH User.managerId AND every primary manager_relations row for that
 * employee in a single transaction. Per product decision (CP-1):
 *   - Secondary relations (functional / project / dotted_line) are NOT
 *     promoted automatically — the employee becomes a true root.
 *   - The employee's own subtree is NOT touched. Their direct reports keep
 *     reporting to them; the employee just loses their upward link.
 *
 * Authorization is enforced by canEditHierarchy(actor, employeeId, null).
 *
 * Returns:
 *   { employee, previousManagerId, removedRelationCount }
 */
async function removePrimaryManager(employeeId, actorUser, options = {}) {
  if (!employeeId) throw new Error('employeeId is required.');
  const externalTx = options.transaction;
  const t = externalTx || (await sequelize.transaction());
  try {
    const auth = await canEditHierarchy(actorUser, employeeId, null, { transaction: t });
    if (!auth.allowed) {
      const err = new Error(auth.reason || 'Not authorized to edit hierarchy.');
      err.statusCode = 403;
      throw err;
    }

    const employee = await User.findByPk(employeeId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!employee) {
      const err = new Error('Employee not found.');
      err.statusCode = 404;
      throw err;
    }

    const previousManagerId = employee.managerId || null;
    let removedRelationCount = 0;

    // Step 1 — delete every primary relation row for this employee. Even if
    // User.managerId is already null (drift), we clean the junction table so
    // the org-chart graph reflects truth on the next render.
    try {
      removedRelationCount = await ManagerRelation.destroy({
        where: { employeeId, isPrimary: true },
        transaction: t,
      });

      // Defensive: if no isPrimary row existed but legacy User.managerId points
      // at a relation row whose isPrimary flag was lost, also wipe relations
      // that match the legacy manager id with relationType='primary'.
      if (removedRelationCount === 0 && previousManagerId) {
        const stale = await ManagerRelation.destroy({
          where: {
            employeeId,
            managerId: previousManagerId,
            relationType: 'primary',
          },
          transaction: t,
        });
        removedRelationCount += stale;
      }
    } catch (e) {
      if (!options.tolerateMissingRelationsTable) throw e;
    }

    // Step 2 — clear legacy User.managerId.
    if (employee.managerId !== null) {
      await employee.update({ managerId: null }, { transaction: t });
    }

    if (!externalTx) await t.commit();
    return {
      employee: await User.findByPk(employeeId, { transaction: externalTx }),
      previousManagerId,
      removedRelationCount,
    };
  } catch (err) {
    if (!externalTx) await t.rollback();
    throw err;
  }
}

module.exports = {
  // Tree reads
  getDirectReportIds,
  getDescendantIds,
  hasDirectReports,
  getPrimaryManagerId,
  isDescendantOf,
  wouldCreateCycle,

  // Authorization
  canManageUser,
  canEditHierarchy,
  canAssignTo,
  getAssignableUsers,

  // Transactional mutations
  setPrimaryManager,
  removePrimaryManager,

  // Field allowlists exported so controllers can filter req.body by scope
  BRANCH_SAFE_USER_FIELDS,
  FULL_SCOPE_USER_FIELDS,
  SUPER_ADMIN_ONLY_FIELDS,
};
