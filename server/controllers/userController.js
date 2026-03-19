const { User } = require('../models');
const { validationResult } = require('express-validator');
const { Op } = require('sequelize');
const { logActivity } = require('../services/activityService');

/**
 * POST /api/users
 * Admin/Manager creates a new user (member).
 */
const createUser = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { name, email, password, role, department, designation, departmentId } = req.body;

    const existing = await User.findOne({ where: { email: email.toLowerCase() } });
    if (existing) {
      return res.status(409).json({ success: false, message: 'A user with this email already exists.' });
    }

    // Managers can only create members
    if (req.user.role === 'manager' && role && role !== 'member') {
      return res.status(403).json({ success: false, message: 'Managers can only create member accounts.' });
    }

    const user = await User.create({
      name,
      email: email.toLowerCase(),
      password,
      role: role || 'member',
      department: department || null,
      designation: designation || null,
      departmentId: departmentId || null,
      isActive: true,
    });

    logActivity({
      action: 'user_created',
      description: `${req.user.name} created user "${name}"`,
      entityType: 'user',
      entityId: user.id,
      userId: req.user.id,
    });

    res.status(201).json({
      success: true,
      message: 'User created successfully.',
      data: { user: user.toJSON() },
    });
  } catch (error) {
    console.error('[User] Create error:', error);
    res.status(500).json({ success: false, message: 'Server error creating user.' });
  }
};

/**
 * GET /api/users
 * Admin/Manager gets all users (including inactive).
 */
const getAllUsersAdmin = async (req, res) => {
  try {
    const { search, role, department, status } = req.query;
    const where = {};

    if (search) {
      where[Op.or] = [
        { name: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
        { designation: { [Op.iLike]: `%${search}%` } },
      ];
    }

    if (role) where.role = role;
    if (department) where.department = { [Op.iLike]: `%${department}%` };
    if (status === 'active') where.isActive = true;
    if (status === 'inactive') where.isActive = false;

    // Only show approved users in main list (pending shown separately)
    where.accountStatus = 'approved';

    const users = await User.findAll({
      where,
      attributes: { exclude: ['password'] },
      order: [['createdAt', 'DESC']],
    });

    res.json({ success: true, data: { users } });
  } catch (error) {
    console.error('[User] GetAll error:', error);
    res.status(500).json({ success: false, message: 'Server error fetching users.' });
  }
};

/**
 * PUT /api/users/:id
 * Admin updates a user's details (name, email, role, department, designation, isActive).
 */
const updateUser = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const user = await User.findByPk(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    // Prevent editing own role
    if (req.params.id === req.user.id && req.body.role && req.body.role !== req.user.role) {
      return res.status(403).json({ success: false, message: 'You cannot change your own role.' });
    }

    const allowedFields = ['name', 'email', 'role', 'department', 'designation', 'departmentId', 'isActive', 'hierarchyLevel'];
    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = field === 'email' ? req.body[field].toLowerCase() : req.body[field];
      }
    }

    // Check email uniqueness if changing
    if (updates.email && updates.email.toLowerCase() !== user.email.toLowerCase()) {
      const existing = await User.findOne({ where: { email: updates.email.toLowerCase(), id: { [Op.ne]: user.id } } });
      if (existing) {
        return res.status(409).json({ success: false, message: 'Email already in use by another user.' });
      }
    }

    await user.update(updates);

    logActivity({
      action: 'user_updated',
      description: `${req.user.name} updated user "${user.name}"`,
      entityType: 'user',
      entityId: user.id,
      userId: req.user.id,
      meta: { fields: Object.keys(updates) },
    });

    res.json({
      success: true,
      message: 'User updated successfully.',
      data: { user: user.toJSON() },
    });
  } catch (error) {
    console.error('[User] Update error:', error);
    res.status(500).json({ success: false, message: 'Server error updating user.' });
  }
};

/**
 * PUT /api/users/:id/reset-password
 * Admin resets a user's password.
 */
const resetPassword = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const user = await User.findByPk(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const { newPassword } = req.body;
    await user.update({ password: newPassword });

    logActivity({
      action: 'password_reset',
      description: `${req.user.name} reset password for "${user.name}"`,
      entityType: 'user',
      entityId: user.id,
      userId: req.user.id,
    });

    res.json({ success: true, message: 'Password reset successfully.' });
  } catch (error) {
    console.error('[User] ResetPassword error:', error);
    res.status(500).json({ success: false, message: 'Server error resetting password.' });
  }
};

/**
 * PUT /api/users/:id/deactivate
 * Admin toggles user active status.
 */
const toggleUserStatus = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    if (req.params.id === req.user.id) {
      return res.status(403).json({ success: false, message: 'You cannot deactivate your own account.' });
    }

    const newStatus = !user.isActive;
    await user.update({ isActive: newStatus });

    logActivity({
      action: newStatus ? 'user_activated' : 'user_deactivated',
      description: `${req.user.name} ${newStatus ? 'activated' : 'deactivated'} user "${user.name}"`,
      entityType: 'user',
      entityId: user.id,
      userId: req.user.id,
    });

    res.json({
      success: true,
      message: `User ${newStatus ? 'activated' : 'deactivated'} successfully.`,
      data: { user: user.toJSON() },
    });
  } catch (error) {
    console.error('[User] ToggleStatus error:', error);
    res.status(500).json({ success: false, message: 'Server error toggling user status.' });
  }
};

/**
 * GET /api/users/my-team
 * Returns the current user's team (hierarchy-aware, up to 3 levels deep).
 * Admin → all active users.
 * Manager → their direct reports + those reports' reports (recursive, max 3 levels).
 */
async function getTeamSubordinates(managerId, depth = 0, maxDepth = 3) {
  if (depth >= maxDepth) return [];
  const directReports = await User.findAll({
    where: { managerId, isActive: true },
    attributes: ['id', 'name', 'email', 'role', 'department', 'designation', 'avatar', 'hierarchyLevel', 'title', 'workspaceId', 'managerId', 'isActive'],
  });
  const all = [...directReports];
  for (const report of directReports) {
    const sub = await getTeamSubordinates(report.id, depth + 1, maxDepth);
    all.push(...sub);
  }
  return all;
}

const getMyTeam = async (req, res) => {
  try {
    let members;
    if (req.user.role === 'admin') {
      members = await User.findAll({
        where: { isActive: true },
        attributes: ['id', 'name', 'email', 'role', 'department', 'designation', 'avatar', 'hierarchyLevel', 'title', 'workspaceId', 'managerId', 'isActive'],
        order: [['name', 'ASC']],
      });
    } else if (req.user.role === 'manager') {
      members = await getTeamSubordinates(req.user.id);
    } else {
      members = [];
    }
    res.json({ success: true, data: { members } });
  } catch (error) {
    console.error('[User] getMyTeam error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch team.' });
  }
};

/**
 * DELETE /api/users/:id
 * Permanently delete a user account.
 */
const deleteUser = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (user.id === req.user.id) {
      return res.status(400).json({ success: false, message: 'Cannot delete your own account.' });
    }
    if (user.role === 'admin' && req.user.role === 'admin') {
      return res.status(400).json({ success: false, message: 'Cannot delete another admin account.' });
    }
    const userName = user.name;
    await user.destroy();
    res.json({ success: true, message: `${userName}'s account has been permanently deleted.` });
  } catch (error) {
    console.error('[User] Delete error:', error);
    res.status(500).json({ success: false, message: 'Server error deleting user.' });
  }
};

module.exports = { createUser, getAllUsersAdmin, updateUser, resetPassword, toggleUserStatus, getMyTeam, deleteUser };
