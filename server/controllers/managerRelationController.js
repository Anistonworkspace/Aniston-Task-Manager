const { ManagerRelation, User } = require('../models');
const { Op } = require('sequelize');

/**
 * GET /api/manager-relations/:employeeId
 * Returns all manager relations for a given employee.
 */
exports.getRelationsForEmployee = async (req, res) => {
  try {
    const relations = await ManagerRelation.findAll({
      where: { employeeId: req.params.employeeId },
      include: [{ model: User, as: 'manager', attributes: ['id', 'name', 'email', 'avatar', 'role', 'designation', 'department'] }],
      order: [['isPrimary', 'DESC'], ['createdAt', 'ASC']],
    });
    res.json({ success: true, data: { relations } });
  } catch (err) {
    console.error('[ManagerRelation] getRelations error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch manager relations.' });
  }
};

/**
 * POST /api/manager-relations
 * Add a new manager relation for an employee.
 * Body: { employeeId, managerId, relationType, isPrimary }
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

    // Include manager data in response
    const full = await ManagerRelation.findByPk(relation.id, {
      include: [{ model: User, as: 'manager', attributes: ['id', 'name', 'email', 'avatar', 'role', 'designation', 'department'] }],
    });

    res.status(201).json({ success: true, data: { relation: full } });
  } catch (err) {
    console.error('[ManagerRelation] addRelation error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to add manager relation.' });
  }
};

/**
 * PUT /api/manager-relations/:id
 * Update an existing relation (relationType, isPrimary).
 */
exports.updateRelation = async (req, res) => {
  try {
    const relation = await ManagerRelation.findByPk(req.params.id);
    if (!relation) return res.status(404).json({ success: false, message: 'Relation not found.' });

    const { relationType, isPrimary } = req.body;

    if (isPrimary) {
      // Clear other primary flags for this employee
      await ManagerRelation.update({ isPrimary: false }, { where: { employeeId: relation.employeeId, isPrimary: true, id: { [Op.ne]: relation.id } } });
      // Sync User.managerId
      await User.update({ managerId: relation.managerId }, { where: { id: relation.employeeId } });
    }

    await relation.update({
      ...(relationType !== undefined && { relationType }),
      ...(isPrimary !== undefined && { isPrimary }),
    });

    res.json({ success: true, data: { relation } });
  } catch (err) {
    console.error('[ManagerRelation] updateRelation error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update relation.' });
  }
};

/**
 * DELETE /api/manager-relations/:id
 * Remove a manager relation. If it was primary, clear User.managerId.
 */
exports.removeRelation = async (req, res) => {
  try {
    const relation = await ManagerRelation.findByPk(req.params.id);
    if (!relation) return res.status(404).json({ success: false, message: 'Relation not found.' });

    const wasPrimary = relation.isPrimary;
    const employeeId = relation.employeeId;
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

    res.json({ success: true, message: 'Manager relation removed.' });
  } catch (err) {
    console.error('[ManagerRelation] removeRelation error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to remove relation.' });
  }
};

/**
 * POST /api/manager-relations/sync
 * Migrate existing managerId data into manager_relations table.
 * Idempotent — safe to call multiple times.
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

    res.json({ success: true, message: `Synced ${created} new relations from existing managerId data. ${usersWithManager.length - created} already existed.` });
  } catch (err) {
    console.error('[ManagerRelation] sync error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to sync relations.' });
  }
};