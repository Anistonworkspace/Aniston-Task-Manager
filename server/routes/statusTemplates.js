const express = require('express');
const { body, param } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const ctrl = require('../controllers/statusTemplateController');

const router = express.Router();

// Phase 2 — Status Tile Group routes (board-scoped only).
//
// All routes require an authenticated user. The view paths additionally
// gate on `boardVisibilityService.canUserSeeBoard` inside the controller;
// the write paths gate on `canManageBoard` (Tier 1/2 or board creator).
// We DO NOT pre-mount `requireTier(2)` on the router because the board
// creator carve-out lets a Tier 3/4 actor manage templates on their own
// board — the controller is the single source of truth for that gate.

const writeValidators = [
  body('name').isString().trim().isLength({ min: 1, max: 100 })
    .withMessage('Template name is required (1–100 chars).'),
  body('statuses').isArray({ min: 1, max: 50 })
    .withMessage('Provide between 1 and 50 statuses.'),
  body('defaultStatusKey').isString().trim().isLength({ min: 1, max: 50 })
    .withMessage('defaultStatusKey is required.'),
  body('isDefault').optional().isBoolean()
    .withMessage('isDefault must be a boolean.'),
];

router.get('/', authenticate, ctrl.list);

router.post(
  '/',
  authenticate,
  [
    body('boardId').isUUID().withMessage('boardId must be a valid UUID.'),
    ...writeValidators,
  ],
  ctrl.create,
);

router.put(
  '/:id',
  authenticate,
  [
    param('id').isUUID().withMessage('id must be a valid UUID.'),
    ...writeValidators,
  ],
  ctrl.update,
);

router.delete(
  '/:id',
  authenticate,
  [param('id').isUUID().withMessage('id must be a valid UUID.')],
  ctrl.remove,
);

router.post(
  '/:id/set-default',
  authenticate,
  [param('id').isUUID().withMessage('id must be a valid UUID.')],
  ctrl.setDefault,
);

module.exports = router;
