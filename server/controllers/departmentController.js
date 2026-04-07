const { Department, User } = require('../models');
const { Op } = require('sequelize');
const { logActivity } = require('../services/activityService');

/**
 * POST /api/departments
 */
const createDepartment = async (req, res) => {
  try {
    const { name, description, color, head } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Department name is required.' });
    }

    const existing = await Department.findOne({ where: { name: { [Op.iLike]: name.trim() } } });
    if (existing) {
      return res.status(409).json({ success: false, message: 'A department with this name already exists.' });
    }

    const dept = await Department.create({
      name: name.trim(),
      description: description || null,
      color: color || '#0073ea',
      head: head || null,
    });

    const fullDept = await Department.findByPk(dept.id, {
      include: [
        { model: User, as: 'headUser', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: User, as: 'members', attributes: ['id', 'name', 'email', 'avatar', 'role', 'designation'] },
      ],
    });

    logActivity({
      action: 'department_created',
      description: `${req.user.name} created department "${name}"`,
      entityType: 'department',
      entityId: dept.id,
      userId: req.user.id,
    });

    res.status(201).json({
      success: true,
      message: 'Department created successfully.',
      data: { department: fullDept },
    });
  } catch (error) {
    console.error('[Department] Create error:', error);
    res.status(500).json({ success: false, message: 'Server error creating department.' });
  }
};

/**
 * GET /api/departments
 */
const getDepartments = async (req, res) => {
  try {
    const { search, active } = req.query;
    const where = {};

    if (active !== undefined) where.isActive = active === 'true';
    if (search) where.name = { [Op.iLike]: `%${search}%` };

    const departments = await Department.findAll({
      where,
      include: [
        { model: User, as: 'headUser', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: User, as: 'members', attributes: ['id', 'name', 'email', 'avatar', 'role', 'designation'] },
      ],
      order: [['name', 'ASC']],
    });

    const deptData = departments.map(d => {
      const plain = d.toJSON();
      plain.memberCount = plain.members ? plain.members.length : 0;
      return plain;
    });

    res.json({ success: true, data: { departments: deptData } });
  } catch (error) {
    console.error('[Department] GetAll error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching departments.' });
  }
};

/**
 * GET /api/departments/:id
 */
const getDepartment = async (req, res) => {
  try {
    const dept = await Department.findByPk(req.params.id, {
      include: [
        { model: User, as: 'headUser', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: User, as: 'members', attributes: ['id', 'name', 'email', 'avatar', 'role', 'designation', 'isActive'] },
      ],
    });

    if (!dept) {
      return res.status(404).json({ success: false, message: 'Department not found.' });
    }

    res.json({ success: true, data: { department: dept } });
  } catch (error) {
    console.error('[Department] Get error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * PUT /api/departments/:id
 */
const updateDepartment = async (req, res) => {
  try {
    const dept = await Department.findByPk(req.params.id);
    if (!dept) {
      return res.status(404).json({ success: false, message: 'Department not found.' });
    }

    const { name, description, color, head, isActive } = req.body;
    const updates = {};

    if (name !== undefined) {
      const existing = await Department.findOne({
        where: { name: { [Op.iLike]: name.trim() }, id: { [Op.ne]: dept.id } },
      });
      if (existing) {
        return res.status(409).json({ success: false, message: 'A department with this name already exists.' });
      }
      updates.name = name.trim();
    }
    if (description !== undefined) updates.description = description;
    if (color !== undefined) updates.color = color;
    if (head !== undefined) updates.head = head;
    if (isActive !== undefined) updates.isActive = isActive;

    await dept.update(updates);

    const fullDept = await Department.findByPk(dept.id, {
      include: [
        { model: User, as: 'headUser', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: User, as: 'members', attributes: ['id', 'name', 'email', 'avatar', 'role', 'designation'] },
      ],
    });

    res.json({
      success: true,
      message: 'Department updated successfully.',
      data: { department: fullDept },
    });
  } catch (error) {
    console.error('[Department] Update error:', error);
    res.status(500).json({ success: false, message: 'Server error updating department.' });
  }
};

/**
 * DELETE /api/departments/:id
 */
const deleteDepartment = async (req, res) => {
  try {
    const dept = await Department.findByPk(req.params.id);
    if (!dept) {
      return res.status(404).json({ success: false, message: 'Department not found.' });
    }

    // Clear departmentId from all users in this department
    await User.update({ departmentId: null }, { where: { departmentId: dept.id } });

    await dept.destroy();

    logActivity({
      action: 'department_deleted',
      description: `${req.user.name} deleted department "${dept.name}"`,
      entityType: 'department',
      entityId: dept.id,
      userId: req.user.id,
    });

    res.json({ success: true, message: 'Department deleted successfully.' });
  } catch (error) {
    console.error('[Department] Delete error:', error);
    res.status(500).json({ success: false, message: 'Server error deleting department.' });
  }
};

/**
 * PUT /api/departments/:id/assign
 * Assign users to a department
 */
const assignUsers = async (req, res) => {
  try {
    const { userIds } = req.body;
    if (!Array.isArray(userIds)) {
      return res.status(400).json({ success: false, message: 'userIds array is required.' });
    }

    const dept = await Department.findByPk(req.params.id);
    if (!dept) {
      return res.status(404).json({ success: false, message: 'Department not found.' });
    }

    await User.update(
      { departmentId: dept.id, department: dept.name },
      { where: { id: { [Op.in]: userIds } } }
    );

    const fullDept = await Department.findByPk(dept.id, {
      include: [
        { model: User, as: 'headUser', attributes: ['id', 'name', 'email', 'avatar'] },
        { model: User, as: 'members', attributes: ['id', 'name', 'email', 'avatar', 'role', 'designation'] },
      ],
    });

    res.json({
      success: true,
      message: 'Users assigned to department successfully.',
      data: { department: fullDept },
    });
  } catch (error) {
    console.error('[Department] AssignUsers error:', error);
    res.status(500).json({ success: false, message: 'Server error assigning users.' });
  }
};

/**
 * POST /api/departments/sync-from-users
 * Auto-create Department records from user.department strings.
 */
const syncFromUsers = async (req, res) => {
  try {
    const users = await User.findAll({ attributes: ['id', 'department', 'departmentId'] });
    const uniqueDepts = [...new Set(users.map(u => u.department).filter(Boolean))];
    let created = 0;
    let linked = 0;
    for (const deptName of uniqueDepts) {
      const [dept, wasCreated] = await Department.findOrCreate({
        where: { name: deptName },
        defaults: { name: deptName, color: '#0073ea', isActive: true },
      });
      if (wasCreated) created++;
      const [count] = await User.update(
        { departmentId: dept.id },
        { where: { department: deptName, departmentId: null } }
      );
      linked += count;
    }
    res.json({
      success: true,
      message: `Synced ${created} new departments, linked ${linked} users.`,
      data: { created, linked, total: uniqueDepts.length },
    });
  } catch (error) {
    console.error('[Department] SyncFromUsers error:', error);
    res.status(500).json({ success: false, message: 'Server error syncing departments.' });
  }
};

module.exports = { createDepartment, getDepartments, getDepartment, updateDepartment, deleteDepartment, assignUsers, syncFromUsers };
