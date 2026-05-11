const express = require('express');
const { body } = require('express-validator');
const { authenticate, requireRole } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const {
  createBoard,
  getBoards,
  getBoard,
  updateBoard,
  deleteBoard,
  addMember,
  removeMember,
  reorderGroups,
  addGroup,
  renameGroup,
  exportBoard,
  importTasks,
} = require('../controllers/boardController');

const router = express.Router();

// All board routes require authentication
router.use(authenticate);

// Board mutation guard: manager and admin only. Used for STRUCTURAL board
// changes (member management, group reordering, CSV import) where members
// and assistant managers must NOT be able to act. boards.create is gated
// separately via requirePermission so the permission matrix can flip it on
// per-role without weakening the structural guard.
const boardMutate = requireRole('manager', 'admin');

// ─── POST /api/boards (any authenticated user with boards.create) ─────────
//   Members and assistant managers now get boards.create=true by default in
//   the permission matrix. The controller still verifies that non-admin /
//   non-manager actors have access to the target workspace before persisting,
//   so the API cannot be used to drop a board into a workspace the caller
//   cannot see. Admin / manager / super admin retain unrestricted creation.
router.post(
  '/',
  requirePermission('boards', 'create'),
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
    body('workspaceId')
      .optional({ nullable: true, checkFalsy: true })
      .isUUID().withMessage('workspaceId must be a valid UUID'),
  ],
  createBoard
);

// ─── GET /api/boards ─────────────────────────────────────────
router.get('/', getBoards);

// ─── GET /api/boards/:id ─────────────────────────────────────
router.get('/:id', getBoard);

// ─── PUT /api/boards/:id ─────────────────────────────────────
// Permission is enforced field-by-field in the controller. Admins, managers,
// assistant managers and super admins may touch any allowed field; explicit
// board members may only update the structural subset (customColumns). Other
// roles get 403 from the controller.
router.put(
  '/:id',
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

// ─── DELETE /api/boards/:id (manager/admin only) ─
router.delete('/:id', requireRole('manager', 'admin'), deleteBoard);

// ─── POST /api/boards/:id/groups (any authenticated user with board access) ─
//   Appends a single group to the board's groups JSONB. Permitted for any
//   user the boardVisibilityService says can REACH this board — including
//   members and assistant managers — so they can add a sprint/section to a
//   board they are working on. The controller validates board access via
//   boardVisibilityService.canUserSeeBoard so the API matches sidebar
//   visibility exactly. Renaming, archiving and reordering groups continue
//   to require the structural board guard (PUT /:id and the route below).
router.post(
  '/:id/groups',
  [
    body('title')
      .trim()
      .notEmpty().withMessage('Group title is required')
      .isLength({ min: 1, max: 80 }).withMessage('Group title must be between 1 and 80 characters'),
    body('color')
      .optional()
      .matches(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/).withMessage('Color must be a valid hex code'),
  ],
  addGroup
);

// ─── PATCH /api/boards/:id/groups/:groupId ───────────────────
//   Rename / recolor a single group on a board. Permitted for any user the
//   boardVisibilityService.canUserSeeBoard rule lets through (members /
//   assistant managers / managers / admins / super admin). Distinct from the
//   structural PUT /:id endpoint so we can grant rename without granting
//   add/remove/reorder via the same permission tier.
router.patch(
  '/:id/groups/:groupId',
  [
    body('title')
      .optional()
      .trim()
      .isLength({ min: 1, max: 80 }).withMessage('Group title must be between 1 and 80 characters'),
    body('color')
      .optional()
      .matches(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/).withMessage('Color must be a valid hex code'),
  ],
  renameGroup
);

// ─── PUT /api/boards/:id/groups/reorder ─────────────────────
//   Reorder the existing groups on a board. Permitted for any user the
//   boardVisibilityService.canUserSeeBoard rule lets through — group order
//   is a board-global property (every viewer sees the same order), so all
//   tiers from member upward may rearrange. The controller validates that
//   incoming IDs are a permutation of the board's existing groups so this
//   endpoint cannot be used to add/remove groups (those live on POST
//   /:id/groups and the archive flow). Companion to addGroup/renameGroup.
router.put('/:id/groups/reorder', reorderGroups);

// ─── POST /api/boards/:id/members (manager/admin only) ──────
router.post(
  '/:id/members',
  boardMutate,
  [
    body('userId')
      .notEmpty().withMessage('userId is required')
      .isUUID().withMessage('userId must be a valid UUID'),
  ],
  addMember
);

// ─── DELETE /api/boards/:id/members/:userId (manager/admin) ──
router.delete('/:id/members/:userId', boardMutate, removeMember);

// Export/Import — export requires board-level access (checked in controller); import requires manager+
router.get('/:id/export', exportBoard);
router.post('/:id/import', boardMutate, importTasks);

module.exports = router;
