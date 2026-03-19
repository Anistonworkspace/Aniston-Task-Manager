const jwt = require('jsonwebtoken');
const { User } = require('../models');
const { validationResult } = require('express-validator');
const { Op } = require('sequelize');

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
 * Generate a signed JWT for a given user id.
 */
const generateToken = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '1d',
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

    const user = await User.findOne({ where: { email: email.toLowerCase() } });
    if (!user) {
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

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    const token = generateToken(user.id);

    res.json({
      success: true,
      message: 'Login successful.',
      data: { user: user.toJSON(), token },
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

    // Generate reset token (valid 1 hour)
    const resetToken = jwt.sign({ id: user.id, type: 'reset' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const resetUrl = `${process.env.CLIENT_URL || 'http://localhost:3000'}/reset-password?token=${resetToken}`;

    // In production, send email. For now, return the token directly.
    console.log(`[Auth] Password reset requested for ${email}. Reset URL: ${resetUrl}`);

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

module.exports = { register, login, getProfile, updateProfile, getAllUsers, uploadAvatar, forgotPassword, resetPassword, getPendingAccounts, approveAccount, rejectAccount };
