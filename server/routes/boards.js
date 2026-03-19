const express = require('express');
const { body } = require('express-validator');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const {
  createBoard,
  getBoards,
  getBoard,
  updateBoard,
  deleteBoard,
  addMember,
  removeMember,
  reorderGroups,
  exportBoard,
  importTasks,
} = require('../controllers/boardController');

const router = express.Router();

// All board routes require authentication
router.use(authenticate);

// ─── POST /api/boards (manager/admin only) ───────────────────
router.post(
  '/',
  managerOrAdmin,
  [
    body('name')
      .trim()
      .notEmpty().withMessage('Board name is required')
      .isLength({ min: 1, max: 150 }).withMessage('Board name must be between 1 and 150 characters'),
    body('description')
      .optional()
      .trim(),
    body('color')
      .optional()
      .matches(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/).withMessage('Color must be a valid hex code'),
  ],
  createBoard
);

// ─── GET /api/boards ─────────────────────────────────────────
router.get('/', getBoards);

// ─── GET /api/boards/:id ─────────────────────────────────────
router.get('/:id', getBoard);

// ─── PUT /api/boards/:id (manager/admin only) ────────────────
router.put(
  '/:id',
  managerOrAdmin,
  [
    body('name')
      .optional()
      .trim()
      .isLength({ min: 1, max: 150 }).withMessage('Board name must be between 1 and 150 characters'),
    body('color')
      .optional()
      .matches(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/).withMessage('Color must be a valid hex code'),
  ],
  updateBoard
);

// ─── DELETE /api/boards/:id (manager/admin only) ─────────────
router.delete('/:id', managerOrAdmin, deleteBoard);

// ─── PUT /api/boards/:id/groups/reorder (manager/admin only) ─
router.put('/:id/groups/reorder', managerOrAdmin, reorderGroups);

// ─── POST /api/boards/:id/members (manager/admin only) ──────
router.post(
  '/:id/members',
  managerOrAdmin,
  [
    body('userId')
      .notEmpty().withMessage('userId is required')
      .isUUID().withMessage('userId must be a valid UUID'),
  ],
  addMember
);

// ─── DELETE /api/boards/:id/members/:userId (manager/admin) ──
router.delete('/:id/members/:userId', managerOrAdmin, removeMember);

// Export/Import
router.get('/:id/export', exportBoard);
router.post('/:id/import', managerOrAdmin, importTasks);

module.exports = router;
