const { User, TaskApprovalFlow, RefreshToken, sequelize } = require('../models');
const { validationResult } = require('express-validator');
const { Op } = require('sequelize');
const { logActivity } = require('../services/activityService');
const hierarchy = require('../services/hierarchyService');
const {
  TIER_1,
  TierError,
  isValidTier,
  resolveTier,
  tierFromLegacy,
  assertNotLastTier1Change,
} = require('../config/tiers');
const safeLogger = require('../utils/safeLogger');
const { PILL_ATTRIBUTES: USER_PILL_ATTRIBUTES } = require('../config/userAttributes');

/**
 * Phase 5c — Last Tier-1 protection helper.
 *
 * Wraps `assertNotLastTier1Change` so the three destructive user-mgmt
 * paths (updateUser demotion, toggleUserStatus deactivation, deleteUser)
 * fail with the same machine-readable code/status without re-implementing
 * the try/catch each time.
 *
 * Returns true when a 4xx response was sent — caller MUST `return` after
 * to skip the destructive operation. Returns false to proceed.
 *
 * Non-TierError exceptions are re-thrown so the controller's outer
 * try/catch can log them as 500s.
 */
async function lastTier1Blocked(res, target, intent) {
  try {
    await assertNotLastTier1Change(target, intent, User);
    return false;
  } catch (err) {
    if (err instanceof TierError) {
      res.status(err.status).json({
        success: false,
        message: err.message,
        code: err.code,
      });
      return true;
    }
    throw err;
  }
}

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
    safeLogger.error('[User] Create error', { err: error });
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

    // Use the model's safe allowlist instead of `exclude: ['password']`. The
    // exclude form still SELECTs every other column including the TOAST-eligible
    // `teamsAccessToken` / `teamsRefreshToken` / `passwordResetToken`. A single
    // corrupt TOAST chunk anywhere in the table would fail this entire query
    // and leave the Admin Settings page showing "Server error fetching users".
    const users = await User.findAll({
      where,
      attributes: User.SAFE_USER_ATTRIBUTES,
      order: [['createdAt', 'DESC']],
    });

    res.json({ success: true, data: { users } });
  } catch (error) {
    safeLogger.error('[User] GetAll error', { err: error });
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

    // Phase B — granular per-field user mgmt gates. Each gate fires only
    // when the field is actually being mutated. Umbrellas fall back to
    // users.manage / users.edit so legacy overrides still work.
    {
      const { denyIfNoPermission } = require('../utils/permissionGate');
      const fieldGates = [
        { field: 'role',            action: 'change_role',         label: 'change user roles' },
        { field: 'tier',            action: 'change_tier',         label: 'change user tiers' },
        { field: 'managerId',       action: 'change_manager',      label: 'change user managers' },
        { field: 'hierarchyLevel',  action: 'change_hierarchy',    label: 'change user hierarchy levels' },
        { field: 'isSuperAdmin',    action: 'change_super_admin',  label: 'change super-admin status' },
      ];
      for (const g of fieldGates) {
        if (updates[g.field] !== undefined && updates[g.field] !== user[g.field]) {
          if (await denyIfNoPermission(res, req.user, 'users', g.action,
              `You do not have permission to ${g.label}.`)) return;
        }
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

    // Phase 5c — Last Tier-1 protection.
    //
    // If the target is currently Tier 1 and this update would land them at
    // anything other than Tier 1, refuse unless another active Tier 1 user
    // exists. We compute the "proposed tier" from whichever fields the
    // request is touching and compare against the live user.
    //
    // Demotion paths covered:
    //   - role flipped to a non-Tier-2-equivalent value (e.g. 'member')
    //     while isSuperAdmin remains true would actually KEEP tier=1 in
    //     tierFromLegacy (isSuperAdmin wins) — those updates are not
    //     demotions; the real demotion is clearing isSuperAdmin.
    //   - isSuperAdmin flipped to false while role drops below 'admin'.
    //   - tier explicitly set to a value other than 1.
    //   - isActive flipped to false while staying Tier 1 — handled by
    //     toggleUserStatus / via the deactivate intent below.
    if (resolveTier(user) === TIER_1) {
      const proposedRole         = updates.role         !== undefined ? updates.role         : user.role;
      const proposedIsSuperAdmin = updates.isSuperAdmin !== undefined ? updates.isSuperAdmin : user.isSuperAdmin;
      const proposedTier         = isValidTier(updates.tier)
        ? updates.tier
        : tierFromLegacy(proposedRole, proposedIsSuperAdmin);
      const isDemotion = proposedTier !== TIER_1;
      const isDeactivation = updates.isActive === false;

      if (isDemotion || isDeactivation) {
        const intent = isDemotion ? 'demote' : 'deactivate';
        if (await lastTier1Blocked(res, user, intent)) return;
      }
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

    // Snapshot tier-defining fields BEFORE update so we can detect a real
    // RBAC change after the save and notify the affected user in realtime.
    const prevTier = resolveTier(user);
    const prevRole = user.role;
    const prevSuperAdmin = !!user.isSuperAdmin;

    await user.update(updates);

    const newTier = resolveTier(user);
    const tierChanged =
      newTier !== prevTier ||
      user.role !== prevRole ||
      Boolean(user.isSuperAdmin) !== prevSuperAdmin;

    logActivity({
      action: 'user_updated',
      description: `${req.user.name} updated user "${user.name}"`,
      entityType: 'user',
      entityId: user.id,
      userId: req.user.id,
      meta: {
        fields: Object.keys(updates),
        scope: auth.scope,
        ...(tierChanged ? { previousTier: prevTier, newTier } : {}),
      },
    });

    // Realtime tier/role change notice — targeted only to the affected user's
    // personal socket room so their session can refresh permissions, sidebar,
    // and route guards without a manual reload. Self-edits are blocked above
    // for these fields, but we still skip self defensively. Best-effort emit:
    // a socket failure here MUST NOT fail the user-update response, since the
    // backend remains the source of truth and the next /auth/me call will
    // pick up the new tier regardless.
    //
    // Phase 6 — also emit 'user:force_refresh' which the AuthContext listens
    // for and reloads BOTH user AND permissions. The legacy 'user:role-updated'
    // event is preserved for any consumers (toasts, UI banners) that depend
    // on the structured payload; force_refresh is the canonical signal that
    // a re-fetch is required.
    if (tierChanged && String(user.id) !== String(req.user.id)) {
      try {
        const { emitToUser } = require('../services/socketService');
        emitToUser(user.id, 'user:role-updated', {
          previousTier: prevTier,
          newTier,
          newRole: user.role,
          isSuperAdmin: !!user.isSuperAdmin,
          changedBy: { id: req.user.id, name: req.user.name },
          at: new Date().toISOString(),
        });
        emitToUser(user.id, 'user:force_refresh', {
          reason: 'role-changed',
          previousTier: prevTier,
          newTier,
        });
      } catch (err) {
        safeLogger.error('[User] role-update emit failed', { err });
      }
    }

    res.json({
      success: true,
      message: 'User updated successfully.',
      data: { user: user.toJSON(), scope: auth.scope },
    });
  } catch (error) {
    safeLogger.error('[User] Update error', { err: error });
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

    // Phase 5e — closes audit P1-8. Only Tier 1 may reset another Tier 1's
    // password — without this guard a non-super-admin could reset a super
    // admin's password and impersonate them.
    if (resolveTier(user) === TIER_1 && resolveTier(req.user) !== TIER_1) {
      return res.status(403).json({
        success: false,
        message: 'Only a Tier 1 user can reset another Tier 1 user\'s password.',
      });
    }

    // Phase B — granular users.reset_password gate. Umbrella → users.manage.
    {
      const { denyIfNoPermission } = require('../utils/permissionGate');
      if (await denyIfNoPermission(res, req.user, 'users', 'reset_password',
          'You do not have permission to reset user passwords.')) return;
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
    safeLogger.error('[User] ResetPassword error', { err: error });
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

    // Phase B — granular users.activate / users.deactivate gates. Umbrella
    // → users.manage. Composes on top of the tier rules below.
    {
      const { denyIfNoPermission } = require('../utils/permissionGate');
      const actionKey = newStatus ? 'activate' : 'deactivate';
      if (await denyIfNoPermission(res, req.user, 'users', actionKey,
          newStatus ? 'You do not have permission to activate users.'
                    : 'You do not have permission to deactivate users.')) return;
    }

    // Phase 7 — Tier-2 destructive guard. Deactivation is destructive; only
    // Tier 1 may perform it. The legacy `auth.scope === 'full'` admits Tier 2
    // admins, so we layer `assertCanDelete` on top to enforce decision #4
    // (T2 cannot delete/deactivate anything anywhere).
    if (newStatus === false) {
      const { assertCanDelete } = require('../services/tierEnforcement');
      const { sendIfTierError } = require('../utils/tierResponseHelpers');
      if (sendIfTierError(res, () => assertCanDelete(req.user, 'user', { isOwnResource: false }))) return;

      // Phase 5c — Last Tier-1 protection. A deactivation that would leave
      // zero active Tier 1 users is refused (decision #12).
      if (await lastTier1Blocked(res, user, 'deactivate')) return;
    }

    // Persist the override flag so Microsoft sync respects this manual choice.
    // P0-12 — On deactivation we additionally unstick the approval chain and
    // revoke active refresh tokens. The whole sequence runs in one
    // transaction so a partial failure (e.g. RefreshToken update raises) does
    // not leave the user disabled with stranded pending approvals.
    let skippedApprovals = 0;
    let revokedTokens = 0;
    await sequelize.transaction(async (t) => {
      await user.update(
        { isActive: newStatus, localStatusOverride: true },
        { transaction: t }
      );

      if (newStatus === false) {
        // (a) Unstick the approval chain — any pending row pointed at this
        // user becomes 'skipped' so downstream "next approver" resolution
        // can advance past the deactivated approver.
        try {
          const [count] = await TaskApprovalFlow.update(
            {
              status: 'skipped',
              actionAt: new Date(),
              comment: 'Auto-skipped: approver deactivated',
            },
            {
              where: { userId: user.id, status: 'pending' },
              transaction: t,
            }
          );
          skippedApprovals = count || 0;
        } catch (e) {
          // Re-throw so the transaction rolls back.
          throw e;
        }

        // (b) Revoke every active refresh token for the user so the
        // deactivated account cannot continue an existing session.
        try {
          const [count] = await RefreshToken.update(
            { revokedAt: new Date() },
            { where: { userId: user.id, revokedAt: null }, transaction: t }
          );
          revokedTokens = count || 0;
        } catch (e) {
          throw e;
        }
      }
    });

    logActivity({
      action: newStatus ? 'user_activated' : 'user_deactivated',
      description: `${req.user.name} ${newStatus ? 'activated' : 'deactivated'} user "${user.name}"`,
      entityType: 'user',
      entityId: user.id,
      userId: req.user.id,
      meta: newStatus === false
        ? { skippedApprovals, revokedTokens }
        : undefined,
    });

    res.json({
      success: true,
      message: `User ${newStatus ? 'activated' : 'deactivated'} successfully.`,
      data: { user: user.toJSON() },
    });
  } catch (error) {
    safeLogger.error('[User] ToggleStatus error', { err: error });
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
    attributes: [...USER_PILL_ATTRIBUTES, 'department', 'designation', 'hierarchyLevel', 'title', 'workspaceId', 'managerId', 'isActive'],
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
        attributes: [...USER_PILL_ATTRIBUTES, 'department', 'designation', 'hierarchyLevel', 'title', 'workspaceId', 'managerId', 'isActive'],
        order: [['name', 'ASC']],
      });
    } else if (req.user.role === 'manager') {
      members = await getTeamSubordinates(req.user.id);
    } else {
      members = [];
    }
    res.json({ success: true, data: { members } });
  } catch (error) {
    safeLogger.error('[User] getMyTeam error', { err: error });
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

    // Phase 7 — Tier-2 destructive guard. `auth.scope === 'full'` admits
    // Tier 2 admins, so we layer `assertCanDelete` to enforce decision #4
    // (T2 cannot delete anything anywhere). Closes the audit P0-1 leak.
    const { assertCanDelete } = require('../services/tierEnforcement');
    const { sendIfTierError } = require('../utils/tierResponseHelpers');
    if (sendIfTierError(res, () => assertCanDelete(req.user, 'user', { isOwnResource: false }))) return;

    // Phase 5c — Last Tier-1 protection. Defense in depth: today the
    // hard "super admin accounts cannot be deleted via this endpoint"
    // rule above already prevents Tier-1 deletion entirely. If that rule
    // is ever loosened, this guard ensures a successor T1 must exist
    // first. No-op for non-Tier-1 targets.
    if (await lastTier1Blocked(res, user, 'delete')) return;

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
    safeLogger.error('[User] Delete error', { err: error });
    res.status(500).json({ success: false, message: 'Server error deleting user.' });
  }
};

module.exports = { createUser, getAllUsersAdmin, updateUser, resetPassword, toggleUserStatus, getMyTeam, deleteUser };
