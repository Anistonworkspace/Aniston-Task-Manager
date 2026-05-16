const { ManagerRelation, User } = require('../models');
const { Op } = require('sequelize');
const hierarchy = require('../services/hierarchyService');
const { logActivity } = require('../services/activityService');
const { broadcastAll } = require('../services/socketService');
const { PILL_ATTRIBUTES: USER_PILL_ATTRIBUTES } = require('../config/userAttributes');

// Sensitive User columns that must NEVER appear in API responses (mirrors the
// allowlist in promotionController). The `manager` includes used below were
// already attribute-restricted, but we keep this constant in scope for future
// endpoints that need it. Includes `tier` + `isSuperAdmin` so the frontend
// resolveTier() can correctly render the manager's tier badge.
const USER_SAFE_ATTRS = [...USER_PILL_ATTRIBUTES, 'designation', 'department'];

/**
 * Emit `org:hierarchy:changed` after any structural mutation. Permission-gated
 * GET on the receiving side means broadcasting widely is safe.
 */
function emitHierarchyChanged(payload) {
  try {
    broadcastAll('org:hierarchy:changed', { ...payload, timestamp: new Date().toISOString() });
  } catch (e) { /* socket optional */ }
}

/**
 * GET /api/manager-relations/:employeeId  (also /api/multi-manager/:employeeId)
 * Returns all manager relations for a given employee.
 */
exports.getRelationsForEmployee = async (req, res) => {
  try {
    const relations = await ManagerRelation.findAll({
      where: { employeeId: req.params.employeeId },
      include: [{ model: User, as: 'manager', attributes: USER_SAFE_ATTRS }],
      order: [['isPrimary', 'DESC'], ['createdAt', 'ASC']],
    });
    res.json({ success: true, data: { relations } });
  } catch (err) {
    console.error('[ManagerRelation] getRelations error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch manager relations.' });
  }
};

/**
 * POST /api/manager-relations  (also /api/multi-manager)
 * Add a new manager relation for an employee.
 * Body: { employeeId, managerId, relationType, isPrimary }
 *
 * SECURITY (audit B4/B5): The previous version trusted whatever managerOrAdmin
 * let through. That allowed a Tier-2 user to wire any employee to any manager
 * across branches. This version delegates to hierarchy.canEditHierarchy which
 * enforces:
 *   - actor cannot reparent themselves
 *   - target cannot be Tier 1 (super admins are top-of-org by definition)
 *   - proposed manager cannot be Tier 1
 *   - branch-scope (managers only inside their own subtree)
 *   - cycle protection
 */
exports.addRelation = async (req, res) => {
  try {
    const { employeeId, managerId, relationType = 'functional', isPrimary = false } = req.body;

    if (!employeeId || !managerId) {
      return res.status(400).json({ success: false, message: 'employeeId and managerId are required.' });
    }
    if (employeeId === managerId) {
      return res.status(400).json({ success: false, message: 'An employee cannot be their own manager.' });
    }

    // Scope check — uses canEditHierarchy because adding a manager relation,
    // primary or not, is a hierarchy mutation. The same gate covers Tier 1
    // protection for both target and proposed manager.
    const auth = await hierarchy.canEditHierarchy(req.user, employeeId, managerId);
    if (!auth.allowed) {
      return res.status(403).json({ success: false, message: auth.reason || 'Not authorized.' });
    }

    // Check for duplicate
    const existing = await ManagerRelation.findOne({ where: { employeeId, managerId } });
    if (existing) {
      return res.status(409).json({ success: false, message: 'This manager relation already exists.' });
    }

    // If setting as primary, also update User.managerId for backward compat
    if (isPrimary) {
      await ManagerRelation.update({ isPrimary: false }, { where: { employeeId, isPrimary: true } });
      await User.update({ managerId }, { where: { id: employeeId } });
    }

    const relation = await ManagerRelation.create({ employeeId, managerId, relationType, isPrimary });

    // Include manager data in response — attributes already restricted above.
    const full = await ManagerRelation.findByPk(relation.id, {
      include: [{ model: User, as: 'manager', attributes: USER_SAFE_ATTRS }],
    });

    logActivity({
      action: 'manager_relation_added',
      description: `${req.user.name} added a ${relationType} manager relation`,
      entityType: 'user',
      entityId: employeeId,
      userId: req.user.id,
      meta: { managerId, relationType, isPrimary },
    });
    emitHierarchyChanged({ type: 'manager_relation_added', employeeId, managerId, relationType, isPrimary, actorId: req.user.id });

    res.status(201).json({ success: true, data: { relation: full } });
  } catch (err) {
    console.error('[ManagerRelation] addRelation error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to add manager relation.' });
  }
};

/**
 * PUT /api/manager-relations/:id  (also /api/multi-manager/:id)
 * Update an existing relation (relationType, isPrimary).
 *
 * SECURITY: same scope gate as addRelation. Promoting a secondary relation to
 * primary is a hierarchy mutation — must be authorised by canEditHierarchy.
 */
exports.updateRelation = async (req, res) => {
  try {
    const relation = await ManagerRelation.findByPk(req.params.id);
    if (!relation) return res.status(404).json({ success: false, message: 'Relation not found.' });

    const { relationType, isPrimary } = req.body;

    // If isPrimary is being SET (not just left unchanged), re-validate scope
    // against the (employee, manager) of this row. updateRelation is
    // effectively "make THIS relation the primary one", which is the same
    // structural mutation as setPrimaryManager.
    if (isPrimary === true) {
      const auth = await hierarchy.canEditHierarchy(req.user, relation.employeeId, relation.managerId);
      if (!auth.allowed) {
        return res.status(403).json({ success: false, message: auth.reason || 'Not authorized.' });
      }
      // Clear other primary flags for this employee
      await ManagerRelation.update({ isPrimary: false }, { where: { employeeId: relation.employeeId, isPrimary: true, id: { [Op.ne]: relation.id } } });
      // Sync User.managerId
      await User.update({ managerId: relation.managerId }, { where: { id: relation.employeeId } });
    }

    await relation.update({
      ...(relationType !== undefined && { relationType }),
      ...(isPrimary !== undefined && { isPrimary }),
    });

    logActivity({
      action: 'manager_relation_updated',
      description: `${req.user.name} updated a manager relation`,
      entityType: 'user',
      entityId: relation.employeeId,
      userId: req.user.id,
      meta: { relationId: relation.id, relationType, isPrimary },
    });
    emitHierarchyChanged({ type: 'manager_relation_updated', employeeId: relation.employeeId, managerId: relation.managerId, actorId: req.user.id });

    res.json({ success: true, data: { relation } });
  } catch (err) {
    console.error('[ManagerRelation] updateRelation error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update relation.' });
  }
};

/**
 * DELETE /api/manager-relations/:id  (also /api/multi-manager/:id)
 * Remove a manager relation. If it was primary, clear User.managerId.
 *
 * SECURITY: scope-checked via canEditHierarchy (the relation row tells us the
 * employee, so we can re-validate). The Tier-2 destructive guard
 * (assertCanDelete) remains in place from the previous version.
 */
exports.removeRelation = async (req, res) => {
  try {
    const relation = await ManagerRelation.findByPk(req.params.id);
    if (!relation) {
      return res.status(404).json({ success: false, message: 'Relation not found.' });
    }

    // Scope check — caller must have authority over this employee's hierarchy.
    // Pass null as proposed manager since deletion is conceptually "remove
    // this link"; we only need the employee-side authority.
    const auth = await hierarchy.canEditHierarchy(req.user, relation.employeeId, null);
    if (!auth.allowed) {
      return res.status(403).json({ success: false, message: auth.reason || 'Not authorized.' });
    }

    // Phase 7 — Tier-2 destructive guard. Removing a manager relation
    // mutates org-chart structure; T2 must not perform it (decision #4).
    const { assertCanDelete } = require('../services/tierEnforcement');
    const { sendIfTierError } = require('../utils/tierResponseHelpers');
    if (sendIfTierError(res, () => assertCanDelete(req.user, 'manager_relation', { isOwnResource: false }))) return;

    const wasPrimary = relation.isPrimary;
    const employeeId = relation.employeeId;
    const managerId = relation.managerId;
    await relation.destroy();

    // If we removed the primary, pick the next relation as primary or clear managerId
    if (wasPrimary) {
      const nextPrimary = await ManagerRelation.findOne({ where: { employeeId }, order: [['createdAt', 'ASC']] });
      if (nextPrimary) {
        await nextPrimary.update({ isPrimary: true });
        await User.update({ managerId: nextPrimary.managerId }, { where: { id: employeeId } });
      } else {
        await User.update({ managerId: null }, { where: { id: employeeId } });
      }
    }

    logActivity({
      action: 'manager_relation_removed',
      description: `${req.user.name} removed a manager relation`,
      entityType: 'user',
      entityId: employeeId,
      userId: req.user.id,
      meta: { relationId: req.params.id, managerId, wasPrimary },
    });
    emitHierarchyChanged({ type: 'manager_relation_removed', employeeId, managerId, wasPrimary, actorId: req.user.id });

    res.json({ success: true, message: 'Manager relation removed.' });
  } catch (err) {
    console.error('[ManagerRelation] removeRelation error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to remove relation.' });
  }
};

/**
 * POST /api/manager-relations/sync  (also /api/multi-manager/sync)
 * Migrate existing managerId data into manager_relations table.
 * Idempotent — safe to call multiple times.
 *
 * No per-row scope check here: this is a one-shot data-migration helper
 * (admin-only via route middleware) that just mirrors existing User.managerId
 * data into the junction table. It does not introduce any new relationships.
 */
exports.syncFromManagerId = async (req, res) => {
  try {
    const usersWithManager = await User.findAll({
      where: { managerId: { [Op.ne]: null }, isActive: true },
      attributes: ['id', 'managerId'],
      raw: true,
    });

    let created = 0;
    for (const u of usersWithManager) {
      const [, wasCreated] = await ManagerRelation.findOrCreate({
        where: { employeeId: u.id, managerId: u.managerId },
        defaults: { relationType: 'primary', isPrimary: true },
      });
      if (wasCreated) created++;
    }

    logActivity({
      action: 'manager_relations_synced',
      description: `${req.user.name} synced manager relations from legacy managerId`,
      entityType: 'system',
      entityId: null,
      userId: req.user.id,
      meta: { created, total: usersWithManager.length },
    });
    if (created > 0) emitHierarchyChanged({ type: 'manager_relations_synced', created, actorId: req.user.id });

    res.json({ success: true, message: `Synced ${created} new relations from existing managerId data. ${usersWithManager.length - created} already existed.` });
  } catch (err) {
    console.error('[ManagerRelation] sync error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to sync relations.' });
  }
};
