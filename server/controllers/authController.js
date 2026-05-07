const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const axios = require('axios');
const { User, RefreshToken } = require('../models');
const { validationResult } = require('express-validator');
const { Op } = require('sequelize');
const { getTeamsConfig } = require('../config/teams');
const { setAuthCookies, clearAuthCookies, getRefreshTokenFromRequest } = require('../utils/authCookies');

// In-memory store for per-email login rate limiting
// Key: email, Value: { count, firstAttempt }
const loginAttempts = new Map();
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function checkLoginRateLimit(email) {
  const now = Date.now();
  const entry = loginAttempts.get(email);
  if (!entry) return { allowed: true };
  // Reset window if expired
  if (now - entry.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(email);
    return { allowed: true };
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    return { allowed: false, retryAfterMs: LOGIN_WINDOW_MS - (now - entry.firstAttempt) };
  }
  return { allowed: true };
}

function recordFailedLogin(email) {
  const now = Date.now();
  const entry = loginAttempts.get(email);
  if (!entry || now - entry.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.set(email, { count: 1, firstAttempt: now });
  } else {
    entry.count += 1;
  }
}

function clearLoginAttempts(email) {
  loginAttempts.delete(email);
}

/**
 * Validate password strength: 8+ chars, uppercase, lowercase, number, special char.
 */
function validatePassword(password) {
  if (!password || password.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter.';
  if (!/[a-z]/.test(password)) return 'Password must contain at least one lowercase letter.';
  if (!/\d/.test(password)) return 'Password must contain at least one number.';
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) return 'Password must contain at least one special character.';
  return null;
}

/**
 * Generate a short-lived access token (1 hour).
 */
const generateToken = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: '1h',
  });

// Refresh token lifetime kept in one place so the JWT and the DB row agree.
const REFRESH_TOKEN_TTL_DAYS = 7;
const REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * Issue a refresh token AND record it in the refresh_tokens table.
 *
 * Every refresh token now carries a `jti` (JWT ID) UUID claim. The DB row,
 * keyed by the same JTI, is the authoritative "is this token still alive?"
 * record consulted on `/api/auth/refresh`.
 *
 * Caller passes optional `req` so we capture user-agent / IP for forensics
 * (best-effort — no failure if missing).
 *
 * Returns the JWT string. Backward-compatible with callers that don't await
 * the DB write — we still issue a usable JWT even if the DB insert fails;
 * the lookup at refresh time will then 401 the user, which is safer than
 * the alternative (signed token with no DB record = stealth bypass).
 */
async function issueRefreshToken(userId, req) {
  const jti = crypto.randomUUID();
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + REFRESH_TOKEN_TTL_MS);

  const token = jwt.sign(
    { id: userId, type: 'refresh', jti },
    process.env.JWT_SECRET,
    { expiresIn: `${REFRESH_TOKEN_TTL_DAYS}d` }
  );

  try {
    await RefreshToken.create({
      jti,
      userId,
      issuedAt,
      expiresAt,
      userAgent: req?.headers?.['user-agent']?.slice(0, 255) || null,
      ip: req?.ip?.slice(0, 45) || null,
    });
  } catch (err) {
    // Don't throw — but log loudly. A persistent failure here means refresh
    // tokens are issued but unverifiable, which the refresh endpoint will
    // catch and reject. Loudness here helps ops diagnose before users notice.
    console.error('[Auth] Failed to record refresh token:', err && err.message);
  }
  return token;
}

/**
 * Revoke a single refresh token by JTI. Idempotent (no-op if already
 * revoked). Optionally records the JTI of the new replacement token so we
 * can detect token-reuse on the next refresh attempt against the old JTI.
 */
async function revokeRefreshToken(jti, replacedByJti = null) {
  if (!jti) return;
  try {
    await RefreshToken.update(
      {
        revokedAt: new Date(),
        ...(replacedByJti ? { replacedByJti } : {}),
      },
      { where: { jti, revokedAt: null } }
    );
  } catch (err) {
    console.warn('[Auth] revokeRefreshToken failed:', err && err.message);
  }
}

/**
 * Revoke every active refresh token for a user. Used on (a) password change,
 * (b) detected token-reuse (chain compromise), (c) optional admin
 * "logout everywhere" actions.
 */
async function revokeAllRefreshTokensForUser(userId) {
  if (!userId) return 0;
  try {
    const [count] = await RefreshToken.update(
      { revokedAt: new Date() },
      { where: { userId, revokedAt: null } }
    );
    return count || 0;
  } catch (err) {
    console.warn('[Auth] revokeAllRefreshTokensForUser failed:', err && err.message);
    return 0;
  }
}

/**
 * POST /api/auth/register
 */
const register = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { name, email, password, department } = req.body;

    const existingUser = await User.findOne({ where: { email: email.toLowerCase() } });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email already exists.',
      });
    }

    const user = await User.create({
      name,
      email: email.toLowerCase(),
      password,
      department: department || null,
      accountStatus: 'pending',
      hasLocalPassword: true,
      passwordChangedAt: new Date(),
    });

    res.status(201).json({
      success: true,
      message: 'Your account request has been submitted. An admin will review and approve it.',
      data: { pending: true },
    });
  } catch (error) {
    console.error('[Auth] Register error:', error);
    res.status(500).json({ success: false, message: 'Server error during registration.' });
  }
};

/**
 * POST /api/auth/login
 * Supports both local users and Microsoft SSO users who have created a local password.
 */
const login = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, password } = req.body;
    const normalizedEmail = email.trim().toLowerCase();

    // Per-email rate limiting
    const rateCheck = checkLoginRateLimit(normalizedEmail);
    if (!rateCheck.allowed) {
      return res.status(429).json({
        success: false,
        message: 'Too many login attempts. Try again later.',
      });
    }

    const user = await User.findOne({ where: { email: normalizedEmail } });
    if (!user) {
      recordFailedLogin(normalizedEmail);
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: 'Account has been deactivated. Contact an administrator.',
      });
    }

    if (user.accountStatus === 'pending') {
      return res.status(403).json({
        success: false,
        message: 'Your account is pending admin approval. Please wait for approval.',
      });
    }

    if (user.accountStatus === 'rejected') {
      return res.status(403).json({
        success: false,
        message: 'Your account request was rejected. Contact an administrator.',
      });
    }

    // For Microsoft SSO users: allow login only if they've created a local password
    if (user.authProvider === 'microsoft' && !user.hasLocalPassword) {
      recordFailedLogin(normalizedEmail);
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    // For local users or Microsoft users with local password — validate password
    if (!user.password) {
      recordFailedLogin(normalizedEmail);
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      recordFailedLogin(normalizedEmail);
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    // Successful login — clear rate limit counter
    clearLoginAttempts(normalizedEmail);

    const token = generateToken(user.id);
    // issueRefreshToken records a refresh_tokens row with the new JTI so the
    // refresh endpoint can verify the token wasn't already rotated/revoked.
    const refreshToken = await issueRefreshToken(user.id, req);

    // D-1: set httpOnly cookies in addition to returning tokens in the body.
    // Body is kept for backward compat during the dual-track migration; new
    // clients should rely on the cookies and stop storing tokens in JS-readable
    // storage.
    setAuthCookies(res, { accessToken: token, refreshToken });

    res.json({
      success: true,
      message: 'Login successful.',
      data: { user: user.toJSON(), token, refreshToken },
    });
  } catch (error) {
    console.error('[Auth] Login error:', error);
    res.status(500).json({ success: false, message: 'Server error during login.' });
  }
};

/**
 * GET /api/auth/profile
 */
const getProfile = async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: { exclude: ['password'] },
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    res.json({ success: true, data: { user } });
  } catch (error) {
    console.error('[Auth] GetProfile error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * PUT /api/auth/profile
 */
const updateProfile = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const allowedFields = ['name', 'avatar', 'department', 'designation', 'departmentId', 'teamsNotificationsEnabled', 'fontSizePreference'];
    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    // Server-side enum guard for fontSizePreference. The route validator
    // already rejects bad strings, but a defensive check here protects
    // controller-level callers and keeps the DB constraint from ever firing
    // on a normal request path.
    const ALLOWED_FONT_SIZES = ['compact', 'default', 'comfortable', 'large'];
    if (updates.fontSizePreference !== undefined && updates.fontSizePreference !== null) {
      if (!ALLOWED_FONT_SIZES.includes(updates.fontSizePreference)) {
        return res.status(400).json({
          success: false,
          message: `fontSizePreference must be one of: ${ALLOWED_FONT_SIZES.join(', ')}.`,
        });
      }
    }

    // Block password change for Microsoft SSO users who haven't created a local password
    if (req.body.newPassword && req.user.authProvider === 'microsoft' && !req.user.hasLocalPassword) {
      return res.status(400).json({
        success: false,
        message: 'No local password set. Create a password first from your profile settings.',
      });
    }

    // Allow password change if provided with current password
    if (req.body.newPassword) {
      if (!req.body.currentPassword) {
        return res.status(400).json({
          success: false,
          message: 'Current password is required to set a new password.',
        });
      }

      const isMatch = await req.user.comparePassword(req.body.currentPassword);
      if (!isMatch) {
        return res.status(401).json({
          success: false,
          message: 'Current password is incorrect.',
        });
      }

      updates.password = req.body.newPassword;
    }

    await req.user.update(updates);
    await req.user.reload();

    res.json({
      success: true,
      message: 'Profile updated successfully.',
      data: { user: req.user.toJSON() },
    });
  } catch (error) {
    console.error('[Auth] UpdateProfile error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * GET /api/auth/users
 * Returns all active users (for assigning tasks, adding board members, etc.).
 */
const getAllUsers = async (req, res) => {
  try {
    const { search, role, department } = req.query;

    const where = { isActive: true, accountStatus: 'approved' };

    if (search) {
      where[Op.or] = [
        { name: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
      ];
    }

    if (role) {
      where.role = role;
    }

    if (department) {
      where.department = { [Op.iLike]: `%${department}%` };
    }

    // Phase 5e — closes audit P0-10. Redact sensitive fields (email, role)
    // for non-management tiers. T1/T2 see the full directory; T3/T4 see only
    // the minimum needed to pick someone in an assignable-users dropdown.
    const { hasTierAtLeast } = require('../config/tiers');
    const isManagement = hasTierAtLeast(req.user, 2);
    const attributes = isManagement
      ? ['id', 'name', 'email', 'avatar', 'role', 'department']
      : ['id', 'name', 'avatar', 'department'];

    const users = await User.findAll({
      where,
      attributes,
      order: [['name', 'ASC']],
    });

    res.json({ success: true, data: { users } });
  } catch (error) {
    console.error('[Auth] GetAllUsers error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * POST /api/auth/avatar
 * Upload user avatar image.
 */
const uploadAvatar = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image file provided.' });
    }

    const { storeFile, cleanupOnError } = require('../services/storageService');
    const { url } = await storeFile({
      filePath: req.file.path,
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      category: 'avatar',
    });

    await req.user.update({ avatar: url });
    await req.user.reload();

    res.json({
      success: true,
      message: 'Avatar updated successfully.',
      data: { user: req.user.toJSON(), avatarUrl: url },
    });
  } catch (error) {
    console.error('[Auth] UploadAvatar error:', error);
    const { cleanupOnError } = require('../services/storageService');
    cleanupOnError(req.file);
    res.status(500).json({ success: false, message: 'Server error uploading avatar.' });
  }
};

/**
 * POST /api/auth/forgot-password
 * Generate a reset token. Works for local users AND Microsoft SSO users with a local password.
 * Always returns the same response to prevent email enumeration.
 */
const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });

    const GENERIC_MSG = 'If that email exists, a reset link has been sent.';

    const user = await User.findOne({ where: { email: email.toLowerCase() } });
    if (!user) {
      return res.json({ success: true, message: GENERIC_MSG });
    }

    // Only generate reset if user has a local password
    // Microsoft-only users (no local password) get the same generic response
    const hasPassword = user.hasLocalPassword || user.authProvider === 'local';
    if (!hasPassword) {
      return res.json({ success: true, message: GENERIC_MSG });
    }

    // Generate a random token, store its hash in DB
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    await user.update({
      passwordResetToken: hashedToken,
      passwordResetExpires: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
    });

    const resetUrl = `${process.env.CLIENT_URL || 'http://localhost:3000'}/reset-password?token=${rawToken}`;

    // In production, send email. For now, log only in development.
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[Auth] Password reset requested for ${email}. Reset URL: ${resetUrl}`);
    }

    res.json({
      success: true,
      message: GENERIC_MSG,
      data: process.env.NODE_ENV === 'development' ? { resetUrl } : {},
    });
  } catch (error) {
    console.error('[Auth] ForgotPassword error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * POST /api/auth/reset-password
 * Reset password using a stored hashed token (single-use, 1-hour expiry).
 */
const resetPassword = async (req, res) => {
  try {
    const { token, newPassword, confirmNewPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ success: false, message: 'Token and new password are required.' });
    }
    if (confirmNewPassword !== undefined && newPassword !== confirmNewPassword) {
      return res.status(400).json({ success: false, message: 'Passwords do not match.' });
    }
    const pwError = validatePassword(newPassword);
    if (pwError) {
      return res.status(400).json({ success: false, message: pwError });
    }

    // Hash the provided token and look up in DB
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const user = await User.findOne({
      where: {
        passwordResetToken: hashedToken,
        passwordResetExpires: { [Op.gt]: new Date() },
      },
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'Reset link is invalid or has expired.',
      });
    }

    // Update password and clear reset token (single-use enforcement)
    await user.update({
      password: newPassword,
      hasLocalPassword: true,
      passwordChangedAt: new Date(),
      passwordResetToken: null,
      passwordResetExpires: null,
    });

    // Revoke all refresh tokens too — a forgot-password recovery is a strong
    // signal the user lost control of (or wants to reset) their sessions.
    await revokeAllRefreshTokensForUser(user.id);

    res.json({ success: true, message: 'Password reset successfully. You can now login.' });
  } catch (error) {
    console.error('[Auth] ResetPassword error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * POST /api/auth/create-password (authenticated — user must be logged in via Microsoft SSO first)
 * Allows Microsoft SSO users to create a local password for dual auth.
 */
const createPassword = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { password, confirmPassword } = req.body;

    if (!password || !confirmPassword) {
      return res.status(400).json({ success: false, message: 'Password and confirmation are required.' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ success: false, message: 'Passwords do not match.' });
    }

    const pwError = validatePassword(password);
    if (pwError) {
      return res.status(400).json({ success: false, message: pwError });
    }

    const user = await User.findByPk(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    if (user.hasLocalPassword) {
      return res.status(400).json({
        success: false,
        message: 'Password already exists. Use change-password instead.',
      });
    }

    await user.update({
      password,
      hasLocalPassword: true,
      passwordChangedAt: new Date(),
    });

    res.json({
      success: true,
      message: 'Password created successfully. You can now log in with your email and password.',
    });
  } catch (error) {
    console.error('[Auth] CreatePassword error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * PUT /api/auth/change-password (authenticated)
 * Change password for users who already have a local password.
 */
const changePassword = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { currentPassword, newPassword, confirmNewPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmNewPassword) {
      return res.status(400).json({ success: false, message: 'All password fields are required.' });
    }

    if (newPassword !== confirmNewPassword) {
      return res.status(400).json({ success: false, message: 'New passwords do not match.' });
    }

    const pwError = validatePassword(newPassword);
    if (pwError) {
      return res.status(400).json({ success: false, message: pwError });
    }

    const user = await User.findByPk(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    if (!user.hasLocalPassword && user.authProvider !== 'local') {
      return res.status(400).json({
        success: false,
        message: 'No local password set. Use create-password first.',
      });
    }

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
    }

    await user.update({
      password: newPassword,
      passwordChangedAt: new Date(),
    });

    // Revoke every active refresh token for this user. Combined with the
    // `iat < passwordChangedAt` check in refreshTokenEndpoint this gives us
    // belt-and-braces invalidation: even if a stolen refresh token slipped
    // past the timestamp check (clock skew, race), the per-token denylist
    // catches it on the next refresh attempt.
    await revokeAllRefreshTokensForUser(user.id);

    res.json({
      success: true,
      message: 'Password changed successfully. Please log in again.',
    });
  } catch (error) {
    console.error('[Auth] ChangePassword error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * GET /api/auth/pending-accounts
 */
const getPendingAccounts = async (req, res) => {
  try {
    const users = await User.findAll({
      where: { accountStatus: 'pending' },
      attributes: ['id', 'name', 'email', 'department', 'createdAt'],
      order: [['createdAt', 'DESC']],
    });
    res.json({ success: true, data: { users } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * PUT /api/auth/approve/:userId
 */
const approveAccount = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    await user.update({ accountStatus: 'approved' });
    res.json({ success: true, message: `${user.name}'s account has been approved.` });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * PUT /api/auth/reject/:userId
 *
 * Rejecting a pending account destroys the user row. Tier-2 actors are
 * blocked by `assertCanDelete` (decision #4 — T2 cannot delete anything,
 * anywhere) so they receive 403 even though the route admits them via
 * `managerOrAdmin`. Tier 1 may still reject pending accounts.
 */
const rejectAccount = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const { assertCanDelete } = require('../services/tierEnforcement');
    const { sendIfTierError } = require('../utils/tierResponseHelpers');
    if (sendIfTierError(res, () => assertCanDelete(req.user, 'user', { isOwnResource: false }))) return;

    await user.destroy();
    res.json({ success: true, message: `Account request from ${user.name} has been rejected and removed.` });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * POST /api/auth/refresh
 *
 * Exchange a valid refresh token for new access + refresh tokens, rotating
 * the refresh token in the process.
 *
 * Validation order (each must pass):
 *   1. JWT signature + expiry      — same as before, via jwt.verify.
 *   2. JWT `type === 'refresh'`     — reject access-token attempts.
 *   3. User exists and is active    — handles soft-delete / deactivation.
 *   4. JWT iat ≥ passwordChangedAt  — broad-sweep defence against tokens
 *                                     issued before a forced password reset.
 *   5. JTI exists in refresh_tokens — gate against forged JWTs (signature
 *                                     valid but not actually issued by us)
 *                                     and against tokens we revoked
 *                                     (logout, changePassword, etc.).
 *   6. JTI not revoked              — the per-token denylist itself.
 *   7. JTI not already rotated      — TOKEN-REUSE DETECTION. If the row's
 *                                     `replacedByJti` is set, this token was
 *                                     already exchanged. The fact that
 *                                     someone is replaying it is a strong
 *                                     signal of theft → we revoke EVERY
 *                                     active token for the user, not just
 *                                     this one.
 *
 * On success we revoke the presented JTI (recording the new JTI as its
 * `replacedByJti` for the chain audit trail) and issue a new pair.
 *
 * Backward compatibility note (soft cutover)
 * ------------------------------------------
 * Tokens issued before this code shipped do NOT carry a `jti` claim. They'd
 * fail step 5. To avoid forcing every active session to re-login on deploy
 * we accept claim-less tokens once: they pass through with steps 1–4 and a
 * fresh JTI'd token is issued. After the natural 7-day window all legacy
 * tokens have expired; from then on every refresh hits the full chain.
 */
const refreshTokenEndpoint = async (req, res) => {
  try {
    // D-1: prefer the httpOnly cookie. Falls back to req.body.refreshToken
    // for clients that haven't migrated yet.
    const refreshToken = getRefreshTokenFromRequest(req);
    if (!refreshToken) {
      return res.status(400).json({ success: false, message: 'refreshToken required.' });
    }

    const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
    if (decoded.type !== 'refresh') {
      return res.status(401).json({ success: false, message: 'Invalid token type.' });
    }

    const user = await User.findByPk(decoded.id);
    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, message: 'User not found or inactive.' });
    }

    // Phase 7 — Reject refresh tokens that pre-date the user's last password
    // change. Without this, a stolen long-lived refresh token survives any
    // forced reset until its 7-day natural expiry.
    if (user.passwordChangedAt && decoded.iat) {
      const passwordChangedAtSec = Math.floor(new Date(user.passwordChangedAt).getTime() / 1000);
      if (decoded.iat + 1 < passwordChangedAtSec) {
        return res.status(401).json({
          success: false,
          message: 'Session expired. Please log in again.',
          code: 'PASSWORD_CHANGED',
        });
      }
    }

    // Soft-cutover: tokens issued before D-2 don't carry a `jti`. Treat them
    // as legacy — let them refresh once, the new token will be tracked.
    if (!decoded.jti) {
      const newToken = generateToken(user.id);
      const newRefreshToken = await issueRefreshToken(user.id, req);
      setAuthCookies(res, { accessToken: newToken, refreshToken: newRefreshToken });
      return res.json({
        success: true,
        data: { token: newToken, refreshToken: newRefreshToken },
      });
    }

    const record = await RefreshToken.findByPk(decoded.jti);
    if (!record) {
      // JWT signature is valid AND user is active AND iat is newer than
      // passwordChangedAt — but we have no record of issuing this JTI. That
      // shouldn't happen unless the refresh_tokens row was wiped (schema
      // reset) OR the token was forged with our secret (catastrophic, but
      // either way we 401). Don't try to be clever.
      return res.status(401).json({ success: false, message: 'Refresh token is no longer valid. Please log in again.', code: 'TOKEN_NOT_TRACKED' });
    }

    if (record.revokedAt) {
      // Two cases: (a) we revoked this token (logout / changePassword) — fine,
      // 401. (b) it was already rotated (replacedByJti is set) and someone is
      // replaying the OLD token — strong indicator of session compromise.
      // Burn the chain.
      if (record.replacedByJti) {
        await revokeAllRefreshTokensForUser(user.id);
        return res.status(401).json({
          success: false,
          message: 'Session compromised — all sessions have been ended. Please log in again.',
          code: 'TOKEN_REUSE_DETECTED',
        });
      }
      return res.status(401).json({
        success: false,
        message: 'Refresh token has been revoked. Please log in again.',
        code: 'TOKEN_REVOKED',
      });
    }

    // All checks passed — issue new pair and rotate the old row.
    const newToken = generateToken(user.id);
    const newRefreshToken = await issueRefreshToken(user.id, req);
    // Decode just to recover the new JTI for the chain audit trail (cheap —
    // jwt.decode skips signature verification, but we just signed it).
    const newDecoded = jwt.decode(newRefreshToken) || {};
    await revokeRefreshToken(decoded.jti, newDecoded.jti || null);

    // D-1: refresh the cookies so the new pair takes effect on the next
    // request. The browser overwrites the old cookies in place because the
    // (name, path, domain) tuple matches.
    setAuthCookies(res, { accessToken: newToken, refreshToken: newRefreshToken });

    res.json({
      success: true,
      data: { token: newToken, refreshToken: newRefreshToken },
    });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Refresh token expired. Please login again.' });
    }
    res.status(401).json({ success: false, message: 'Invalid refresh token.' });
  }
};

/**
 * GET /api/auth/microsoft
 * Start Microsoft SSO flow — return the authorization URL.
 */
const microsoftAuthUrl = async (req, res) => {
  try {
    const config = await getTeamsConfig();
    if (!config.isConfigured) {
      return res.status(503).json({
        success: false,
        message: 'Microsoft integration is not configured. Ask your admin to set it up in Integrations.',
      });
    }
    if (!config.ssoEnabled) {
      return res.status(503).json({
        success: false,
        message: 'Microsoft SSO is not enabled. Ask your admin to enable it in Integrations.',
      });
    }

    const state = jwt.sign({ type: 'sso_state' }, process.env.JWT_SECRET, { expiresIn: '10m' });

    const authUrl = `${config.authUrl}/authorize?` + new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      redirect_uri: config.ssoRedirectUri,
      scope: config.ssoScopes.join(' '),
      state,
      response_mode: 'query',
      prompt: 'select_account',
    }).toString();

    res.json({ success: true, data: { authUrl } });
  } catch (error) {
    console.error('[Auth] Microsoft SSO URL error:', error);
    res.status(500).json({ success: false, message: 'Failed to start Microsoft sign-in.' });
  }
};

/**
 * GET /api/auth/microsoft/callback
 * Microsoft SSO callback — exchange code for tokens, find/create user, issue JWT.
 */
const microsoftCallback = async (req, res) => {
  const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';
  const { code, state, error: authError } = req.query;

  if (authError) {
    return res.redirect(`${CLIENT_URL}/login?sso=error&msg=${encodeURIComponent(authError)}`);
  }

  if (!code || !state) {
    return res.redirect(`${CLIENT_URL}/login?sso=error&msg=missing_params`);
  }

  try {
    // Verify state token
    try {
      const decoded = jwt.verify(state, process.env.JWT_SECRET);
      if (decoded.type !== 'sso_state') throw new Error('Invalid state');
    } catch {
      return res.redirect(`${CLIENT_URL}/login?sso=error&msg=invalid_state`);
    }

    const config = await getTeamsConfig();

    // Exchange code for tokens
    const tokenRes = await axios.post(
      `${config.authUrl}/token`,
      new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.ssoRedirectUri,
        scope: config.ssoScopes.join(' '),
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in, id_token } = tokenRes.data;

    // Decode id_token claims. NOTE: signature is not verified here because the token
    // was just received over a TLS-secured server-to-server token-exchange call; Microsoft
    // is the only party that could have produced it. We still validate iss/aud below.
    // For defense-in-depth a future change can verify the JWT signature via JWKS.
    let email, name, oid, iss, aud;
    if (id_token) {
      const payload = JSON.parse(Buffer.from(id_token.split('.')[1], 'base64').toString());
      email = (payload.email || payload.preferred_username || '').toLowerCase();
      name = payload.name || '';
      // Prefer the Azure AD object id (oid). NEVER fall back to `sub` — `sub` is
      // application-scoped and is not a stable cross-app identifier.
      oid = payload.oid || '';
      iss = payload.iss || '';
      aud = payload.aud || '';
    }

    // Fallback: fetch profile from Graph API (only if id_token didn't give us email/oid).
    if (!email || !oid) {
      try {
        const profileRes = await axios.get('https://graph.microsoft.com/v1.0/me', {
          headers: { Authorization: `Bearer ${access_token}` },
        });
        email = email || (profileRes.data.mail || profileRes.data.userPrincipalName || '').toLowerCase();
        name = name || profileRes.data.displayName || '';
        oid = oid || profileRes.data.id || '';
      } catch (profileErr) {
        console.error('[Auth] SSO profile fetch error:', profileErr.message);
        return res.redirect(`${CLIENT_URL}/login?sso=error&msg=profile_fetch_failed`);
      }
    }

    if (!email) {
      return res.redirect(`${CLIENT_URL}/login?sso=error&msg=no_email`);
    }

    // Validate id_token issuer + audience. This catches a token produced for a
    // different app or, in single-tenant mode, a different tenant.
    if (id_token && config.clientId) {
      if (aud && aud !== config.clientId) {
        console.error('[Auth] SSO rejected: id_token audience does not match client id.');
        return res.redirect(`${CLIENT_URL}/login?sso=error&msg=${encodeURIComponent('Invalid identity token.')}`);
      }
      // For single-tenant deployments (tenantId is a real GUID, not 'common'/'organizations'/'consumers'),
      // pin the issuer to that tenant. Multi-tenant deployments accept any verified Microsoft issuer.
      const tid = config.tenantId;
      const isSingleTenant = tid && !['common', 'organizations', 'consumers'].includes(tid);
      if (isSingleTenant && iss) {
        const expectedIssuers = [
          `https://login.microsoftonline.com/${tid}/v2.0`,
          `https://sts.windows.net/${tid}/`,
        ];
        if (!expectedIssuers.includes(iss)) {
          console.error(`[Auth] SSO rejected: unexpected id_token issuer (got=${iss}).`);
          return res.redirect(`${CLIENT_URL}/login?sso=error&msg=${encodeURIComponent('Invalid identity token.')}`);
        }
      }
    }

    // ---- Resolve the local user DETERMINISTICALLY ----
    // The previous implementation used `Op.or` between email and teamsUserId, which
    // returned the wrong row whenever two users matched (e.g. a stale duplicated
    // teamsUserId). We now resolve OID-first, then email, with explicit conflict
    // detection at every step. We use findAll (not findOne) so duplicates surface
    // instead of being silently swallowed.
    let user = null;
    let matchedBy = null;

    // Step 1 — OID lookup (Microsoft object id is the stable, primary identifier).
    if (oid) {
      const oidMatches = await User.findAll({ where: { teamsUserId: oid } });
      if (oidMatches.length > 1) {
        console.error(
          `[Auth] SSO security error: ${oidMatches.length} users share teamsUserId for ` +
            `incoming email=${email}. User ids=[${oidMatches.map((u) => u.id).join(',')}].`
        );
        return res.redirect(
          `${CLIENT_URL}/login?sso=error&msg=${encodeURIComponent(
            'Account conflict detected — multiple users are linked to this Microsoft identity. Contact your administrator.'
          )}`
        );
      }
      if (oidMatches.length === 1) {
        const candidate = oidMatches[0];
        // The OID-matched user's email should match the SSO email. If it doesn't,
        // the teamsUserId on this row is stale/wrong — refuse to log in.
        if ((candidate.email || '').toLowerCase() !== email) {
          console.error(
            `[Auth] SSO security error: OID matched user ${candidate.id} but email differs ` +
              `(db=${candidate.email}, sso=${email}). Refusing login.`
          );
          return res.redirect(
            `${CLIENT_URL}/login?sso=error&msg=${encodeURIComponent(
              'Account conflict detected — Microsoft identity does not match this account. Contact your administrator.'
            )}`
          );
        }
        user = candidate;
        matchedBy = 'oid';
      }
    }

    // Step 2 — Email lookup as a fallback for first-time linking.
    if (!user) {
      const emailMatches = await User.findAll({ where: { email } });
      if (emailMatches.length > 1) {
        console.error(`[Auth] SSO security error: duplicate emails detected for ${email}.`);
        return res.redirect(
          `${CLIENT_URL}/login?sso=error&msg=${encodeURIComponent(
            'Account conflict detected — multiple users have this email. Contact your administrator.'
          )}`
        );
      }
      if (emailMatches.length === 1) {
        const candidate = emailMatches[0];
        // If the candidate is already linked to a DIFFERENT Microsoft identity,
        // refuse — this prevents silently overwriting an existing link.
        if (candidate.teamsUserId && oid && candidate.teamsUserId !== oid) {
          console.error(
            `[Auth] SSO security error: email ${email} is already linked to a different ` +
              `Microsoft identity (db=${candidate.teamsUserId.slice(0, 6)}…, sso=${oid.slice(0, 6)}…).`
          );
          return res.redirect(
            `${CLIENT_URL}/login?sso=error&msg=${encodeURIComponent(
              'This account is linked to a different Microsoft identity. Contact your administrator.'
            )}`
          );
        }
        user = candidate;
        matchedBy = 'email';
      }
    }

    if (user) {
      // Update teams tokens. Only set teamsUserId when not already set, and only when
      // we have an OID — never blindly overwrite an existing link.
      const updates = {
        teamsAccessToken: access_token,
        teamsTokenExpiry: new Date(Date.now() + expires_in * 1000),
      };
      if (refresh_token) updates.teamsRefreshToken = refresh_token;
      if (oid && !user.teamsUserId) updates.teamsUserId = oid;
      // Only change authProvider if user has no local password set
      if (user.authProvider === 'local' && !user.password) updates.authProvider = 'microsoft';
      await user.update(updates);

      // Check account status
      if (!user.isActive) {
        return res.redirect(`${CLIENT_URL}/login?sso=error&msg=${encodeURIComponent('Account has been deactivated.')}`);
      }
      if (user.accountStatus === 'pending') {
        return res.redirect(`${CLIENT_URL}/login?sso=error&msg=${encodeURIComponent('Account is pending admin approval.')}`);
      }
      if (user.accountStatus === 'rejected') {
        return res.redirect(`${CLIENT_URL}/login?sso=error&msg=${encodeURIComponent('Account request was rejected.')}`);
      }
    } else {
      // No user matched — auto-create. Always role='member'; role is NEVER taken
      // from the Microsoft profile.
      user = await User.create({
        name: name || email.split('@')[0],
        email,
        password: null,
        authProvider: 'microsoft',
        role: 'member',
        teamsUserId: oid,
        teamsAccessToken: access_token,
        teamsRefreshToken: refresh_token,
        teamsTokenExpiry: new Date(Date.now() + expires_in * 1000),
        isActive: true,
        accountStatus: 'approved',
      });
      matchedBy = 'created';
    }

    console.log(`[Auth] SSO login resolved: user=${user.id} email=${user.email} matchedBy=${matchedBy}`);

    // Generate app JWT tokens. The refresh token is tracked in the
    // refresh_tokens table just like the local-login path so SSO sessions
    // share the same revoke / rotate / reuse-detect machinery.
    const token = generateToken(user.id);
    const appRefreshToken = await issueRefreshToken(user.id, req);

    // D-1: set httpOnly cookies BEFORE the redirect. Browsers honour
    // Set-Cookie on a 302 response — the next request to /login (and every
    // subsequent /api/* call) will carry the cookies automatically.
    setAuthCookies(res, { accessToken: token, refreshToken: appRefreshToken });

    // We still include the tokens in the redirect URL for the dual-track
    // migration: a frontend that hasn't been updated to read cookies will
    // pick the tokens out of the URL exactly as before. Once Phase 2 ships
    // (frontend uses cookies only) we can drop the query params here, which
    // also closes the "tokens leak into browser history / referer" issue.
    res.redirect(`${CLIENT_URL}/login?sso=success&token=${encodeURIComponent(token)}&refreshToken=${encodeURIComponent(appRefreshToken)}`);
  } catch (error) {
    console.error('[Auth] Microsoft SSO callback error:', error.response?.data || error.message);
    res.redirect(`${CLIENT_URL}/login?sso=error&msg=${encodeURIComponent('Authentication failed. Please try again.')}`);
  }
};

/**
 * GET /api/auth/sso-status
 * Check if Microsoft SSO is enabled (public — used by login page).
 */
const getSsoStatus = async (req, res) => {
  try {
    const config = await getTeamsConfig();
    res.json({
      success: true,
      data: { ssoEnabled: config.isConfigured && config.ssoEnabled },
    });
  } catch {
    res.json({ success: true, data: { ssoEnabled: false } });
  }
};

/**
 * GET /api/auth/assignable-users
 * Returns users that the current user can assign tasks to, based on org hierarchy.
 */
const getAssignableUsersList = async (req, res) => {
  try {
    const { getAssignableUsers } = require('../services/hierarchyService');
    const users = await getAssignableUsers(req.user);
    res.json({ success: true, data: { users } });
  } catch (error) {
    console.error('[Auth] getAssignableUsers error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch assignable users.' });
  }
};

module.exports = {
  register,
  login,
  getProfile,
  updateProfile,
  getAllUsers,
  getAssignableUsersList,
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
  // D-2 helpers exported so auth routes (logout) and other modules
  // (admin "logout everywhere") can revoke tokens cleanly.
  revokeRefreshToken,
  revokeAllRefreshTokensForUser,
};
