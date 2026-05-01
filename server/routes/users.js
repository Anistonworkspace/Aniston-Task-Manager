const express = require('express');
const { body } = require('express-validator');
const { authenticate, adminOnly, managerOrAdmin } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const {
  createUser,
  getAllUsersAdmin,
  updateUser,
  resetPassword,
  toggleUserStatus,
  getMyTeam,
  deleteUser,
} = require('../controllers/userController');

const router = express.Router();

router.use(authenticate);

// POST /api/users — Admin/Manager creates a user
router.post(
  '/',
  managerOrAdmin,
  requirePermission('users', 'create'),
  [
    body('name').trim().isLength({ min: 2, max: 100 }).withMessage('Name must be 2-100 characters.'),
    body('email').isEmail().withMessage('Valid email is required.'),
    body('password')
      .isLength({ min: 8 }).withMessage('Password must be at least 8 characters.')
      .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter.')
      .matches(/[a-z]/).withMessage('Password must contain at least one lowercase letter.')
      .matches(/[0-9]/).withMessage('Password must contain at least one number.')
      .matches(/[!@#$%^&*(),.?":{}|<>]/).withMessage('Password must contain at least one special character.'),
    body('role').optional().isIn(['admin', 'manager', 'assistant_manager', 'member']).withMessage('Invalid role.'),
    body('department').optional().trim().isLength({ max: 100 }),
    body('designation').optional().trim().isLength({ max: 100 }),
  ],
  createUser
);

// GET /api/users/my-team — Manager/Admin gets their hierarchical team members
router.get('/my-team', managerOrAdmin, requirePermission('users', 'view'), getMyTeam);

// GET /api/users — Admin/Manager lists all users
router.get('/', managerOrAdmin, requirePermission('users', 'view'), getAllUsersAdmin);

// PUT /api/users/:id — Admin/Manager updates user details
router.put(
  '/:id',
  managerOrAdmin,
  requirePermission('users', 'edit'),
  [
    body('name').optional().trim().isLength({ min: 2, max: 100 }),
    body('email').optional().isEmail(),
    body('role').optional().isIn(['admin', 'manager', 'assistant_manager', 'member']),
    body('department').optional({ nullable: true }).trim().isLength({ max: 100 }),
    body('designation').optional({ nullable: true }).trim().isLength({ max: 100 }),
    body('hierarchyLevel').optional({ nullable: true }).isString().isLength({ max: 50 }),
    body('isActive').optional().isBoolean(),
    body('isSuperAdmin').optional().isBoolean(),
  ],
  updateUser
);

// PUT /api/users/:id/reset-password — Admin resets password
router.put(
  '/:id/reset-password',
  adminOnly,
  requirePermission('users', 'manage'),
  [
    body('newPassword')
      .isStrongPassword({ minLength: 8, minLowercase: 1, minUppercase: 1, minNumbers: 1, minSymbols: 1 })
      .withMessage('Password must be at least 8 characters and contain uppercase, lowercase, number, and special character.'),
  ],
  resetPassword
);

// PUT /api/users/:id/toggle-status — Admin activates/deactivates user
router.put('/:id/toggle-status', adminOnly, requirePermission('users', 'manage'), toggleUserStatus);

// DELETE /api/users/:id — Admin permanently deletes user
router.delete('/:id', adminOnly, requirePermission('users', 'delete'), deleteUser);

module.exports = router;
