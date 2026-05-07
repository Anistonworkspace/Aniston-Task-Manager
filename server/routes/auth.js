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
  getAssignableUsersList,
} = require('../controllers/authController');
const { createUpload, handleMulterError, postUploadValidation, setCategoryMiddleware } = require('../middleware/upload');

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
    const { computeEffectivePermissions } = require('../services/permissionEngine');

    const result = await computeEffectivePermissions(req.user);

    // Build legacy-compatible flat permissions for backward compat with existing frontend
    const legacyPerms = {};
    const LEGACY_KEYS = [
      'create_workspace', 'edit_workspace', 'delete_workspace',
      'create_board', 'edit_board', 'delete_board',
      'create_task', 'assign_members', 'edit_others_tasks',
      'manage_settings', 'manage_board_settings',
      'view_dashboard', 'manage_users',
    ];
    // Map new resource.action format to legacy keys
    const NEW_TO_LEGACY = {
      'workspaces.create': 'create_workspace',
      'workspaces.edit': 'edit_workspace',
      'workspaces.delete': 'delete_workspace',
      'workspaces.manage_members': 'assign_members',
      'boards.create': 'create_board',
      'boards.edit': 'edit_board',
      'boards.delete': 'delete_board',
      'boards.manage_settings': 'manage_board_settings',
      'tasks.create': 'create_task',
      'tasks.assign': 'assign_members',
      'tasks.edit': 'edit_others_tasks',
      'admin_settings.view': 'manage_settings',
      'admin_settings.manage': 'manage_settings',
      'dashboard.view': 'view_dashboard',
      'users.manage': 'manage_users',
      'users.create': 'manage_users',
    };

    // Start with legacy keys all false
    for (const key of LEGACY_KEYS) legacyPerms[key] = false;

    // Map from new permissions
    for (const [newKey, allowed] of Object.entries(result.permissions)) {
      if (allowed) {
        const legacyKey = NEW_TO_LEGACY[newKey];
        if (legacyKey) legacyPerms[legacyKey] = true;
      }
    }

    res.json({
      success: true,
      data: {
        permissions: legacyPerms,
        granularPermissions: result.permissions,
        basePermissions: result.basePermissions,
        overrides: result.overrides,
        denials: result.denials,
        grants: result.grants,
        role: result.role,
        isSuperAdmin: result.isSuperAdmin,
        isHierarchyManager: false,
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
    body('fontSizePreference')
      .optional({ nullable: true })
      .isIn(['compact', 'default', 'comfortable', 'large'])
      .withMessage('fontSizePreference must be one of: compact, default, comfortable, large'),
  ],
  updateProfile
);

// ─── POST /api/auth/refresh ─────────────────────────────────
router.post('/refresh', refreshTokenEndpoint);

// ─── POST /api/auth/logout ──────────────────────────────────
// Server-side cleanup on logout. With D-2 we now have a refresh-token
// denylist, so logout truly revokes the session — not just clears local
// state. The endpoint does FOUR things:
//   1. Deactivate this device's web-push subscription (by endpoint, scoped
//      to req.user.id). Other devices for the same user keep getting push.
//   2. Force-disconnect the user's socket(s) from the realtime fan-out.
//   3. Revoke the refresh token. If `allDevices=true`, revoke ALL active
//      refresh tokens for this user (logout-everywhere). If `refreshToken`
//      is in the body, revoke just that specific token's row. If neither,
//      we still log out the access-token tab (cookies/headers cleared on
//      the client) but the refresh token survives — frontend should always
//      send the refresh token to fully end the session.
//   4. Be tolerant of missing body fields — frontend may not have a push
//      subscription, may not pass the refresh token (older clients), etc.
//
// Body (all optional):
//   { endpoint?: string, socketId?: string, allDevices?: boolean, refreshToken?: string }
//
// Response is always 200 with success=true so the frontend can proceed with
// local cleanup even if a step fails.
router.post('/logout', authenticate, async (req, res) => {
  const { endpoint, socketId, allDevices } = req.body || {};
  // D-1: prefer the refresh token from the httpOnly cookie. Falls back to
  // req.body.refreshToken for clients that haven't migrated to cookies yet.
  const { getRefreshTokenFromRequest, clearAuthCookies } = require('../utils/authCookies');
  const refreshToken = getRefreshTokenFromRequest(req);
  const result = { pushDeactivated: 0, socketsDisconnected: 0, refreshTokensRevoked: 0 };

  // Clear the cookies first so even if a downstream step throws, the browser
  // is no longer holding live credentials. Idempotent (clearing absent
  // cookies is a no-op).
  clearAuthCookies(res);

  try {
    const { deactivateSubscription, deactivateAllForUser } = require('../services/pushService');
    if (allDevices) {
      result.pushDeactivated = await deactivateAllForUser(req.user.id);
    } else if (endpoint) {
      result.pushDeactivated = await deactivateSubscription(req.user.id, endpoint);
    }
  } catch (err) {
    console.warn('[Auth.logout] push deactivate failed:', err.message);
  }

  try {
    const { disconnectUser } = require('../services/socketService');
    // If the client passes socketId, disconnect just that tab. Otherwise
    // (or with allDevices=true) drop every socket for the user — every other
    // tab for the same user in this browser/profile will be kicked too.
    result.socketsDisconnected = await disconnectUser(
      req.user.id,
      allDevices ? null : (socketId || null)
    );
  } catch (err) {
    console.warn('[Auth.logout] socket disconnect failed:', err.message);
  }

  // Refresh-token revocation — D-2 denylist.
  try {
    const jwt = require('jsonwebtoken');
    const { revokeRefreshToken, revokeAllRefreshTokensForUser } =
      require('../controllers/authController');
    if (allDevices) {
      // Logout-everywhere: kill the whole user's session set.
      result.refreshTokensRevoked = await revokeAllRefreshTokensForUser(req.user.id);
    } else if (refreshToken) {
      // Targeted revoke: decode (no verify needed — even an expired/forged
      // token can be safely "revoked" — at worst the row doesn't exist and
      // the update is a 0-row no-op). We still validate `id` matches the
      // authenticated user so a malicious client can't revoke another
      // user's token by guessing its JTI.
      const decoded = jwt.decode(refreshToken) || {};
      if (decoded.jti && decoded.id === req.user.id) {
        await revokeRefreshToken(decoded.jti);
        result.refreshTokensRevoked = 1;
      }
    }
  } catch (err) {
    console.warn('[Auth.logout] refresh-token revoke failed:', err.message);
  }

  res.json({ success: true, message: 'Logged out.', data: result });
});

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
const avatarUpload = createUpload('avatar');
router.post('/avatar', authenticate, setCategoryMiddleware('avatar'), avatarUpload.single('avatar'), handleMulterError, postUploadValidation('avatar'), uploadAvatar);

// ─── GET /api/auth/users ─────────────────────────────────────
router.get('/users', authenticate, getAllUsers);

// ─── GET /api/auth/assignable-users — hierarchy-filtered user list for task assignment ───
router.get('/assignable-users', authenticate, getAssignableUsersList);

// ─── Microsoft SSO ────────────────────────────────────────────
router.get('/microsoft', microsoftAuthUrl);
router.get('/microsoft/callback', microsoftCallback);
router.get('/sso-status', getSsoStatus);

// ─── Account Approval (admin/manager only) ───────────────────
router.get('/pending-accounts', authenticate, managerOrAdmin, getPendingAccounts);
router.put('/approve/:userId', authenticate, managerOrAdmin, approveAccount);
router.put('/reject/:userId', authenticate, managerOrAdmin, rejectAccount);

module.exports = router;
