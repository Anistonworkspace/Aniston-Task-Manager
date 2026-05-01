const { User } = require('../models');
const { validationResult } = require('express-validator');
const { Op } = require('sequelize');
const { logActivity } = require('../services/activityService');
const hierarchy = require('../services/hierarchyService');

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
 *
 * Edit a user's profile and (for full-scope actors only) their identity
 * fields. Authorization is delegated to hierarchyService.canManageUser, which
 * returns one of three positive scopes:
 *
 *   - 'full'        : super admin, or admin (cannot touch super admins)
 *   - 'branch_safe' : manager / assistant manager, target inside own subtree
 *   - 'self'        : actor editing their own record
 *
 * Sensitive fields (role, hierarchyLevel, isActive, accountStatus, email,
 * isSuperAdmin) are filtered to 'full' scope only — and isSuperAdmin
 * additionally requires the actor itself to be a super admin. This closes the
 * P0 escalation where a manager could set role: 'admin' on any peer.
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

    const sameUser = String(req.params.id) === String(req.user.id);

    // Self role / hierarchy / super-admin / active flag changes are blocked
    // unconditionally — even for super admins. Promotion/demotion of self
    // belongs in a separate, audited flow.
    if (sameUser) {
      const selfBlocked = ['role', 'hierarchyLevel', 'isSuperAdmin', 'isActive', 'accountStatus'];
      for (const f of selfBlocked) {
        if (req.body[f] !== undefined && req.body[f] !== user[f]) {
          return res.status(403).json({
            success: false,
            message: `You cannot change your own ${f}.`,
          });
        }
      }
    }

    const auth = await hierarchy.canManageUser(req.user, user);
    if (!auth.allowed) {
      return res.status(403).json({
        success: false,
        message: auth.reason || 'You do not have permission to edit this user.',
      });
    }

    // Build the allowlist from the resolved scope.
    let permitted;
    if (auth.scope === 'full') {
      permitted = new Set(hierarchy.FULL_SCOPE_USER_FIELDS);
      if (req.user.isSuperAdmin) {
        for (const f of hierarchy.SUPER_ADMIN_ONLY_FIELDS) permitted.add(f);
      }
    } else if (auth.scope === 'branch_safe' || auth.scope === 'self') {
      permitted = new Set(hierarchy.BRANCH_SAFE_USER_FIELDS);
    } else {
      // Should be unreachable because auth.allowed gated above, but defensive.
      return res.status(403).json({ success: false, message: 'You do not have permission to edit this user.' });
    }

    // Detect attempts to change forbidden fields so the caller learns *why*
    // — silently dropping fields is confusing.
    const forbiddenAttempts = [];
    for (const field of Object.keys(req.body)) {
      if (
        ['name', 'email', 'role', 'department', 'designation', 'departmentId', 'isActive', 'hierarchyLevel', 'isSuperAdmin', 'accountStatus', 'avatar', 'title'].includes(field) &&
        !permitted.has(field) &&
        req.body[field] !== undefined &&
        req.body[field] !== user[field]
      ) {
        forbiddenAttempts.push(field);
      }
    }
    if (forbiddenAttempts.length > 0) {
      return res.status(403).json({
        success: false,
        message: `You cannot change the following field(s) on this user: ${forbiddenAttempts.join(', ')}.`,
        forbiddenFields: forbiddenAttempts,
      });
    }

    const updates = {};
    for (const field of permitted) {
      if (req.body[field] !== undefined) {
        updates[field] = field === 'email'
          ? String(req.body[field]).toLowerCase()
          : req.body[field];
      }
    }

    // If this update is flipping isActive, mark the row so Microsoft sync
    // does not silently revert the change on its next pass.
    if (
      updates.isActive !== undefined &&
      Boolean(updates.isActive) !== Boolean(user.isActive)
    ) {
      updates.localStatusOverride = true;
    }

    // Email uniqueness (only relevant when 'email' is in the permitted set).
    if (updates.email && updates.email !== user.email.toLowerCase()) {
      const existing = await User.findOne({
        where: { email: updates.email, id: { [Op.ne]: user.id } },
      });
      if (existing) {
        return res.status(409).json({
          success: false,
          message: 'Email already in use by another user.',
        });
      }
    }

    // Safe demotion: when a manager-class role is dropped to 'member' and
    // they had direct reports, bubble those reports up to the demoted user's
    // own manager so children don't get orphaned. This only fires on 'full'
    // scope changes (managers/assistants cannot reach this code path because
    // 'role' isn't in their permitted set).
    if (updates.role && updates.role !== user.role) {
      const wasManager = ['admin', 'manager', 'assistant_manager'].includes(user.role);
      const isNowLower = updates.role === 'member';
      if (wasManager && isNowLower) {
        const directReports = await User.findAll({
          where: { managerId: user.id, isActive: true },
          attributes: ['id'],
        });
        if (directReports.length > 0) {
          await User.update(
            { managerId: user.managerId || null },
            { where: { managerId: user.id } },
          );
        }
      }
    }

    await user.update(updates);

    logActivity({
      action: 'user_updated',
      description: `${req.user.name} updated user "${user.name}"`,
      entityType: 'user',
      entityId: user.id,
      userId: req.user.id,
      meta: { fields: Object.keys(updates), scope: auth.scope },
    });

    res.json({
      success: true,
      message: 'User updated successfully.',
      data: { user: user.toJSON(), scope: auth.scope },
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
 * PUT /api/users/:id/toggle-status
 *
 * Activate / deactivate a user. Requires full-scope authority on the target —
 * i.e. only admins / super admins can call this. Managers and assistant
 * managers are blocked even if the route middleware lets them in (defence in
 * depth against misnamed middleware).
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

    const auth = await hierarchy.canManageUser(req.user, user);
    if (!auth.allowed || auth.scope !== 'full') {
      return res.status(403).json({
        success: false,
        message: auth.reason || 'Only admins or super admins can change account status.',
      });
    }

    const newStatus = !user.isActive;
    // Persist the override flag so Microsoft sync respects this manual choice.
    await user.update({ isActive: newStatus, localStatusOverride: true });

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
 *
 * Permanently delete a user account. Restricted to full-scope authority and
 * gated additionally by:
 *   - actor cannot delete self
 *   - admins cannot delete other admins (only super admins can)
 *   - nobody (including super admins) can delete a super admin via this route
 */
const deleteUser = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    if (user.id === req.user.id) {
      return res.status(400).json({ success: false, message: 'Cannot delete your own account.' });
    }

    const auth = await hierarchy.canManageUser(req.user, user);
    if (!auth.allowed || auth.scope !== 'full') {
      return res.status(403).json({
        success: false,
        message: auth.reason || 'Only admins or super admins can delete user accounts.',
      });
    }

    if (user.isSuperAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Super admin accounts cannot be deleted via this endpoint.',
      });
    }
    if (user.role === 'admin' && req.user.role === 'admin' && !req.user.isSuperAdmin) {
      return res.status(400).json({
        success: false,
        message: 'Admins cannot delete other admin accounts. A super admin must perform this action.',
      });
    }

    const userName = user.name;
    await user.destroy();

    logActivity({
      action: 'user_deleted',
      description: `${req.user.name} permanently deleted user "${userName}"`,
      entityType: 'user',
      entityId: user.id,
      userId: req.user.id,
    });

    res.json({ success: true, message: `${userName}'s account has been permanently deleted.` });
  } catch (error) {
    console.error('[User] Delete error:', error);
    res.status(500).json({ success: false, message: 'Server error deleting user.' });
  }
};

module.exports = { createUser, getAllUsersAdmin, updateUser, resetPassword, toggleUserStatus, getMyTeam, deleteUser };
