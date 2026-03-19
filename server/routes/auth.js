const express = require('express');
const { body } = require('express-validator');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const {
  register,
  login,
  getProfile,
  updateProfile,
  getAllUsers,
  uploadAvatar,
  forgotPassword,
  resetPassword,
  getPendingAccounts,
  approveAccount,
  rejectAccount,
} = require('../controllers/authController');
const { upload, handleMulterError } = require('../middleware/upload');

const router = express.Router();

// ─── POST /api/auth/register ─────────────────────────────────
router.post(
  '/register',
  [
    body('name')
      .trim()
      .notEmpty().withMessage('Name is required')
      .isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters'),
    body('email')
      .trim()
      .notEmpty().withMessage('Email is required')
      .isEmail().withMessage('Must be a valid email address')
      .normalizeEmail(),
    body('password')
      .notEmpty().withMessage('Password is required')
      .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
      .matches(/[A-Z]/).withMessage('Password must contain an uppercase letter')
      .matches(/[a-z]/).withMessage('Password must contain a lowercase letter')
      .matches(/\d/).withMessage('Password must contain a number')
      .matches(/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/).withMessage('Password must contain a special character'),
    body('department')
      .optional()
      .trim()
      .isLength({ max: 100 }).withMessage('Department must be at most 100 characters'),
  ],
  register
);

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
      .isLength({ min: 6 }).withMessage('New password must be at least 6 characters'),
  ],
  updateProfile
);

// ─── POST /api/auth/forgot-password ──────────────────────────
router.post('/forgot-password', forgotPassword);

// ─── POST /api/auth/reset-password ───────────────────────────
router.post('/reset-password', resetPassword);

// ─── POST /api/auth/avatar ────────────────────────────────────
router.post('/avatar', authenticate, upload.single('avatar'), handleMulterError, uploadAvatar);

// ─── GET /api/auth/users ─────────────────────────────────────
router.get('/users', authenticate, getAllUsers);

// ─── Account Approval (admin/manager only) ───────────────────
router.get('/pending-accounts', authenticate, managerOrAdmin, getPendingAccounts);
router.put('/approve/:userId', authenticate, managerOrAdmin, approveAccount);
router.put('/reject/:userId', authenticate, managerOrAdmin, rejectAccount);

module.exports = router;
