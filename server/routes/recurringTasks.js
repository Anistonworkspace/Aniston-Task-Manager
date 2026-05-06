/**
 * Routes — Daily Work / Recurring Work workflow.
 *
 * All endpoints require authentication. The `tasks.create` permission is the
 * entry-level gate (members get it by default; admins can deny it per-user
 * via a PermissionGrant). Per-template authorization (who can edit, who can
 * target which assignee) is enforced inside the controller via
 * hierarchyService — see recurringTemplateController.js for details.
 *
 * Mounted at: /api/recurring-tasks
 */

const express = require('express');
const { body, param } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const {
  createTemplate,
  listTemplates,
  getTemplate,
  updateTemplate,
  pauseTemplate,
  resumeTemplate,
  archiveTemplate,
  generateNow,
} = require('../controllers/recurringTemplateController');

const router = express.Router();

// All routes require an authenticated user.
router.use(authenticate);

// ─── Read endpoints ─────────────────────────────────────────────────────────
// All authenticated users may LIST/GET. Visibility is filtered server-side
// (members see only their own templates).
router.get('/', listTemplates);
router.get(
  '/:id',
  [param('id').isUUID().withMessage('id must be a UUID')],
  getTemplate
);

// ─── Write endpoints ────────────────────────────────────────────────────────
// `tasks.create` is the entry-level gate. Members hold it by default; the
// controller still enforces "members can only target self" on top.
router.post(
  '/',
  requirePermission('tasks', 'create'),
  [
    body('title')
      .isString().withMessage('title must be a string')
      .bail()
      .trim()
      .isLength({ min: 1, max: 300 }).withMessage('title must be 1–300 characters'),
    body('boardId').isUUID().withMessage('boardId must be a UUID'),
    body('assigneeId').isUUID().withMessage('assigneeId must be a UUID'),
    body('frequency')
      .isIn(['daily', 'weekdays', 'weekly', 'monthly', 'custom'])
      .withMessage('frequency must be daily | weekdays | weekly | monthly | custom'),
    body('startDate')
      .matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('startDate must be YYYY-MM-DD'),
    body('dueTime')
      .optional()
      .matches(/^\d{1,2}:\d{2}(:\d{2})?$/).withMessage('dueTime must be HH:mm[:ss]'),
    body('endDate')
      .optional({ nullable: true })
      .custom((val) => val === null || val === '' || /^\d{4}-\d{2}-\d{2}$/.test(val))
      .withMessage('endDate must be YYYY-MM-DD or null'),
    body('priority')
      .optional()
      .isIn(['low', 'medium', 'high', 'critical']),
    body('escalateIfMissed').optional().isBoolean(),
    body('escalationTargets').optional().isArray(),
    body('weekdays').optional().isArray(),
    body('dayOfMonth').optional({ nullable: true }).isInt({ min: 1, max: 31 }),
    body('daysOfMonth').optional({ nullable: true }).isArray()
      .withMessage('daysOfMonth must be an array of integers 1–31'),
    body('daysOfMonth.*').optional().isInt({ min: 1, max: 31 })
      .withMessage('daysOfMonth values must be integers between 1 and 31'),
    body('timezone').optional().isString().isLength({ min: 1, max: 64 }),
  ],
  createTemplate
);

router.patch(
  '/:id',
  requirePermission('tasks', 'create'),
  [
    param('id').isUUID().withMessage('id must be a UUID'),
    body('title').optional().isString().trim().isLength({ min: 1, max: 300 }),
    body('boardId').optional().isUUID(),
    body('assigneeId').optional().isUUID(),
    body('frequency').optional().isIn(['daily', 'weekdays', 'weekly', 'monthly', 'custom']),
    body('startDate').optional().matches(/^\d{4}-\d{2}-\d{2}$/),
    body('endDate')
      .optional({ nullable: true })
      .custom((val) => val === null || val === '' || /^\d{4}-\d{2}-\d{2}$/.test(val)),
    body('dueTime').optional().matches(/^\d{1,2}:\d{2}(:\d{2})?$/),
    body('priority').optional().isIn(['low', 'medium', 'high', 'critical']),
    body('escalateIfMissed').optional().isBoolean(),
    body('escalationTargets').optional().isArray(),
    body('weekdays').optional().isArray(),
    body('dayOfMonth').optional({ nullable: true }).isInt({ min: 1, max: 31 }),
    body('daysOfMonth').optional({ nullable: true }).isArray()
      .withMessage('daysOfMonth must be an array of integers 1–31'),
    body('daysOfMonth.*').optional().isInt({ min: 1, max: 31 })
      .withMessage('daysOfMonth values must be integers between 1 and 31'),
    body('timezone').optional().isString().isLength({ min: 1, max: 64 }),
    body('isActive').optional().isBoolean(),
  ],
  updateTemplate
);

router.post(
  '/:id/pause',
  requirePermission('tasks', 'create'),
  [param('id').isUUID()],
  pauseTemplate
);
router.post(
  '/:id/resume',
  requirePermission('tasks', 'create'),
  [param('id').isUUID()],
  resumeTemplate
);
router.post(
  '/:id/archive',
  requirePermission('tasks', 'create'),
  [param('id').isUUID()],
  archiveTemplate
);
// DELETE is an alias for archive (soft-delete) — the spec lists both.
router.delete(
  '/:id',
  requirePermission('tasks', 'create'),
  [param('id').isUUID()],
  archiveTemplate
);

// Admin-only utility: force a generation cycle for one template. Useful for
// tests and for catch-up after cron downtime. Phase 5e — closes audit P0-9
// (route was previously authenticated only; the comment promised admin-only
// but the middleware did not enforce it). Tier 1 only.
const { requireTier } = require('../middleware/tier');
router.post(
  '/:id/generate-now',
  requireTier(1),
  [param('id').isUUID()],
  generateNow
);

module.exports = router;
