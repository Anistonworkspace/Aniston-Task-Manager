const express = require('express');
const { body } = require('express-validator');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const {
  login,
  getProfile,
  updateProfile,
  getAllUsers,
  uploadAvatar,
  forgotPassword,
  resetPassword,
  createPassword,
  changePassword,
  getPendingAccounts,
  approveAccount,
  rejectAccount,
  refreshTokenEndpoint,
  microsoftAuthUrl,
  microsoftCallback,
  getSsoStatus,
} = require('../controllers/authController');
const { upload, handleMulterError, validateFileSignature } = require('../middleware/upload');

const router = express.Router();

// ─── POST /api/auth/register — DISABLED (admin-only user creation) ───
router.post('/register', (req, res) => {
  return res.status(403).json({
    success: false,
    message: 'Public registration is disabled. Please contact your administrator to create an account.',
  });
});

// ─── POST /api/auth/login ────────────────────────────────────
router.post(
  '/login',
  [
    body('email')
      .trim()
      .notEmpty().withMessage('Email is required')
      .isEmail().withMessage('Must be a valid email address')
      .normalizeEmail(),
    body('password')
      .notEmpty().withMessage('Password is required'),
  ],
  login
);

// ─── GET /api/auth/profile ───────────────────────────────────
router.get('/profile', authenticate, getProfile);
router.get('/me', authenticate, getProfile);

// ─── GET /api/auth/me/permissions — effective permissions (role + grants merged) ──
router.get('/me/permissions', authenticate, async (req, res) => {
  try {
    const { PermissionGrant } = require('../models');
    const { Op } = require('sequelize');

    const role = req.user.role;
    const isSuperAdmin = !!req.user.isSuperAdmin;

    // Role-based default permissions
    const ROLE_PERMISSIONS = {
      admin:             { create_workspace: true, edit_workspace: true, delete_workspace: true, create_board: true, edit_board: true, delete_board: true, create_task: true, assign_members: true, edit_others_tasks: true, manage_settings: true, manage_board_settings: true, view_dashboard: true, manage_users: true },
      manager:           { create_workspace: true, edit_workspace: true, delete_workspace: false, create_board: true, edit_board: true, delete_board: true, create_task: true, assign_members: true, edit_others_tasks: true, manage_settings: false, manage_board_settings: false, view_dashboard: true, manage_users: true },
      assistant_manager: { create_workspace: true, edit_workspace: true, delete_workspace: false, create_board: false, edit_board: false, delete_board: false, create_task: true, assign_members: true, edit_others_tasks: false, manage_settings: false, manage_board_settings: false, view_dashboard: true, manage_users: false },
      member:            { create_workspace: false, edit_workspace: false, delete_workspace: false, create_board: false, edit_board: false, delete_board: false, create_task: false, assign_members: false, edit_others_tasks: false, manage_settings: false, manage_board_settings: false, view_dashboard: false, manage_users: false },
    };

    // Start with role defaults (super admin gets everything)
    const effective = isSuperAdmin
      ? Object.fromEntries(Object.keys(ROLE_PERMISSIONS.admin).map(k => [k, true]))
      : { ...(ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.member) };

    // Fetch active, non-expired grants from the permission_grants table
    const grants = await PermissionGrant.findAll({
      where: {
        userId: req.user.id,
        isActive: true,
        [Op.or]: [
          { expiresAt: null },
          { expiresAt: { [Op.gt]: new Date() } },
        ],
      },
      attributes: ['resourceType', 'permissionLevel', 'resourceId'],
      raw: true,
    });

    // Map grant → which actions it unlocks
    const LEVEL_HIERARCHY = ['view', 'edit', 'assign', 'manage', 'admin'];
    const GRANT_TO_ACTIONS = {
      workspace: { manage: ['create_workspace', 'edit_workspace', 'delete_workspace'], edit: ['edit_workspace'], admin: ['create_workspace', 'edit_workspace', 'delete_workspace', 'manage_settings'] },
      board:     { manage: ['create_board', 'edit_board', 'delete_board', 'create_task', 'assign_members', 'edit_others_tasks'], edit: ['edit_board', 'create_task'], assign: ['create_task', 'assign_members'], admin: ['create_board', 'edit_board', 'delete_board', 'create_task', 'assign_members', 'edit_others_tasks', 'manage_board_settings'] },
      task:      { manage: ['create_task', 'assign_members', 'edit_others_tasks'], assign: ['create_task', 'assign_members'] },
      dashboard: { view: ['view_dashboard'] },
      team:      { manage: ['manage_users'] },
    };

    // Apply grants: for each grant, unlock the actions at that level and below
    for (const grant of grants) {
      const resourceActions = GRANT_TO_ACTIONS[grant.resourceType];
      if (!resourceActions) continue;

      const grantIdx = LEVEL_HIERARCHY.indexOf(grant.permissionLevel);

      // Unlock actions for this level and all lower levels
      for (const [level, actions] of Object.entries(resourceActions)) {
        const levelIdx = LEVEL_HIERARCHY.indexOf(level);
        if (grantIdx >= levelIdx) {
          for (const action of actions) {
            effective[action] = true;
          }
        }
      }
    }

    res.json({
      success: true,
      data: {
        permissions: effective,
        grants: grants,
        role: role,
        isSuperAdmin: isSuperAdmin,
      },
    });
  } catch (err) {
    console.error('[Auth] me/permissions error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to compute permissions.' });
  }
});

// ─── PUT /api/auth/profile ───────────────────────────────────
router.put(
  '/profile',
  authenticate,
  [
    body('name')
      .optional()
      .trim()
      .isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters'),
    body('newPassword')
      .optional()
      .isStrongPassword({ minLength: 8, minLowercase: 1, minUppercase: 1, minNumbers: 1, minSymbols: 1 })
      .withMessage('New password must be at least 8 characters and contain uppercase, lowercase, number, and special character'),
  ],
  updateProfile
);

// ─── POST /api/auth/refresh ─────────────────────────────────
router.post('/refresh', refreshTokenEndpoint);

// ─── POST /api/auth/forgot-password ──────────────────────────
router.post('/forgot-password', forgotPassword);

// ─── POST /api/auth/reset-password ───────────────────────────
router.post('/reset-password', resetPassword);

// ─── POST /api/auth/create-password (authenticated) ──────────
router.post(
  '/create-password',
  authenticate,
  [
    body('password')
      .notEmpty().withMessage('Password is required')
      .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
      .matches(/[A-Z]/).withMessage('Password must contain an uppercase letter')
      .matches(/[a-z]/).withMessage('Password must contain a lowercase letter')
      .matches(/\d/).withMessage('Password must contain a number')
      .matches(/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/).withMessage('Password must contain a special character'),
    body('confirmPassword')
      .notEmpty().withMessage('Password confirmation is required'),
  ],
  createPassword
);

// ─── PUT /api/auth/change-password (authenticated) ───────────
router.put(
  '/change-password',
  authenticate,
  [
    body('currentPassword')
      .notEmpty().withMessage('Current password is required'),
    body('newPassword')
      .notEmpty().withMessage('New password is required')
      .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
      .matches(/[A-Z]/).withMessage('Password must contain an uppercase letter')
      .matches(/[a-z]/).withMessage('Password must contain a lowercase letter')
      .matches(/\d/).withMessage('Password must contain a number')
      .matches(/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/).withMessage('Password must contain a special character'),
    body('confirmNewPassword')
      .notEmpty().withMessage('Password confirmation is required'),
  ],
  changePassword
);

// ─── POST /api/auth/avatar ────────────────────────────────────
router.post('/avatar', authenticate, upload.single('avatar'), handleMulterError, validateFileSignature, uploadAvatar);

// ─── GET /api/auth/users ─────────────────────────────────────
router.get('/users', authenticate, getAllUsers);

// ─── Microsoft SSO ────────────────────────────────────────────
router.get('/microsoft', microsoftAuthUrl);
router.get('/microsoft/callback', microsoftCallback);
router.get('/sso-status', getSsoStatus);

// ─── Account Approval (admin/manager only) ───────────────────
router.get('/pending-accounts', authenticate, managerOrAdmin, getPendingAccounts);
router.put('/approve/:userId', authenticate, managerOrAdmin, approveAccount);
router.put('/reject/:userId', authenticate, managerOrAdmin, rejectAccount);

module.exports = router;
