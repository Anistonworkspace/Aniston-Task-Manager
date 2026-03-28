const jwt = require('jsonwebtoken');
const axios = require('axios');
const { User } = require('../models');
const { validationResult } = require('express-validator');
const { Op } = require('sequelize');
const { getTeamsConfig } = require('../config/teams');

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

/**
 * Generate a long-lived refresh token (7 days).
 */
const generateRefreshToken = (userId) =>
  jwt.sign({ id: userId, type: 'refresh' }, process.env.JWT_SECRET, {
    expiresIn: '7d',
  });

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
 */
const login = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, password } = req.body;

    // Normalize email: trim + lowercase for case-insensitive match
    const normalizedEmail = email.trim().toLowerCase();

    const user = await User.findOne({ where: { email: normalizedEmail } });
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'No account found with this email address. Please check your email.',
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

    // Block password login for ALL Microsoft SSO users, regardless of residual password hash
    if (user.authProvider === 'microsoft') {
      return res.status(400).json({
        success: false,
        message: 'This account uses Microsoft SSO. Please click "Sign in with Microsoft" to log in.',
      });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Incorrect password. Please check your password and try again. Tip: verify Caps Lock and keyboard layout.',
      });
    }

    const token = generateToken(user.id);
    const refreshToken = generateRefreshToken(user.id);

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

    const allowedFields = ['name', 'avatar', 'department', 'designation', 'departmentId'];
    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    // Block password change for Microsoft SSO users
    if (req.body.newPassword && req.user.authProvider === 'microsoft') {
      return res.status(400).json({
        success: false,
        message: 'Your account uses Microsoft SSO. To change your password, visit https://myaccount.microsoft.com/security-info',
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

    const users = await User.findAll({
      where,
      attributes: ['id', 'name', 'email', 'avatar', 'role', 'department'],
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

    const avatarUrl = `/uploads/${req.file.filename}`;
    await req.user.update({ avatar: avatarUrl });
    await req.user.reload();

    res.json({
      success: true,
      message: 'Avatar updated successfully.',
      data: { user: req.user.toJSON(), avatarUrl },
    });
  } catch (error) {
    console.error('[Auth] UploadAvatar error:', error);
    res.status(500).json({ success: false, message: 'Server error uploading avatar.' });
  }
};

/**
 * POST /api/auth/forgot-password
 * Generate a reset token (stored as JWT with short expiry).
 */
const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });

    const user = await User.findOne({ where: { email: email.toLowerCase() } });
    if (!user) {
      // Don't reveal if email exists
      return res.json({ success: true, message: 'If that email exists, a reset link has been generated.' });
    }

    // Redirect Microsoft SSO users to Microsoft's password reset
    if (user.authProvider === 'microsoft') {
      return res.json({
        success: true,
        message: 'This account uses Microsoft SSO. Please reset your password at Microsoft: https://passwordreset.microsoftonline.com/',
        data: { ssoRedirect: 'https://passwordreset.microsoftonline.com/' },
      });
    }

    // Generate reset token (valid 1 hour)
    const resetToken = jwt.sign({ id: user.id, type: 'reset' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const resetUrl = `${process.env.CLIENT_URL || 'http://localhost:3000'}/reset-password?token=${resetToken}`;

    // In production, send email. For now, log only in development.
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[Auth] Password reset requested for ${email}. Reset URL: ${resetUrl}`);
    }

    res.json({
      success: true,
      message: 'If that email exists, a reset link has been generated.',
      data: process.env.NODE_ENV === 'development' ? { resetUrl } : {},
    });
  } catch (error) {
    console.error('[Auth] ForgotPassword error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * POST /api/auth/reset-password
 * Reset password using token.
 */
const resetPassword = async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ success: false, message: 'Token and new password are required.' });
    }
    const pwError = validatePassword(newPassword);
    if (pwError) {
      return res.status(400).json({ success: false, message: pwError });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'reset') {
      return res.status(400).json({ success: false, message: 'Invalid reset token.' });
    }

    const user = await User.findByPk(decoded.id);
    if (!user) return res.status(400).json({ success: false, message: 'Invalid reset token.' });

    if (user.authProvider === 'microsoft') {
      return res.status(400).json({
        success: false,
        message: 'This account uses Microsoft SSO. Please reset your password at https://passwordreset.microsoftonline.com/',
      });
    }

    // Single-use enforcement: reject if the user record was updated after the token was issued.
    // A successful reset updates updatedAt, so re-use of the same token is caught here.
    const tokenIssuedAt = decoded.iat * 1000; // iat is in seconds, convert to ms
    const userUpdatedAt = new Date(user.updatedAt).getTime();
    if (userUpdatedAt > tokenIssuedAt) {
      return res.status(400).json({
        success: false,
        message: 'Reset link has already been used. Please request a new one.',
      });
    }

    await user.update({ password: newPassword });

    res.json({ success: true, message: 'Password reset successfully. You can now login.' });
  } catch (error) {
    if (error.name === 'TokenExpiredError' || error.name === 'JsonWebTokenError') {
      return res.status(400).json({ success: false, message: 'Reset link is invalid or has expired. Please request a new one.' });
    }
    console.error('[Auth] ResetPassword error:', error);
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
 */
const rejectAccount = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    await user.destroy();
    res.json({ success: true, message: `Account request from ${user.name} has been rejected and removed.` });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * POST /api/auth/refresh
 * Exchange a valid refresh token for new access + refresh tokens.
 */
const refreshTokenEndpoint = async (req, res) => {
  try {
    const { refreshToken } = req.body;
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

    const newToken = generateToken(user.id);
    const newRefreshToken = generateRefreshToken(user.id);

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

    // Decode id_token to get user info
    let email, name, oid;
    if (id_token) {
      const payload = JSON.parse(Buffer.from(id_token.split('.')[1], 'base64').toString());
      email = (payload.email || payload.preferred_username || '').toLowerCase();
      name = payload.name || '';
      oid = payload.oid || payload.sub || '';
    }

    // Fallback: fetch profile from Graph API
    if (!email) {
      try {
        const profileRes = await axios.get('https://graph.microsoft.com/v1.0/me', {
          headers: { Authorization: `Bearer ${access_token}` },
        });
        email = (profileRes.data.mail || profileRes.data.userPrincipalName || '').toLowerCase();
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

    // Find user by email or teamsUserId
    let user = await User.findOne({
      where: {
        [Op.or]: [
          { email },
          ...(oid ? [{ teamsUserId: oid }] : []),
        ],
      },
    });

    if (user) {
      // Update teams tokens and teamsUserId
      const updates = {
        teamsAccessToken: access_token,
        teamsTokenExpiry: new Date(Date.now() + expires_in * 1000),
      };
      if (refresh_token) updates.teamsRefreshToken = refresh_token;
      if (oid && !user.teamsUserId) updates.teamsUserId = oid;
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
      // Auto-create new user
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
    }

    // Generate app JWT tokens
    const token = generateToken(user.id);
    const appRefreshToken = generateRefreshToken(user.id);

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

module.exports = { register, login, getProfile, updateProfile, getAllUsers, uploadAvatar, forgotPassword, resetPassword, getPendingAccounts, approveAccount, rejectAccount, refreshTokenEndpoint, microsoftAuthUrl, microsoftCallback, getSsoStatus };
