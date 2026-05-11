const express = require('express');
const { body } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { attachTaskPermissions, canViewTask } = require('../middleware/taskPermissions');
const { requirePermission } = require('../middleware/permissions');
const {
  createTask,
  getTasks,
  getTask,
  updateTask,
  deleteTask,
  moveTask,
  bulkUpdateTasks,
  reorderTasks,
  duplicateTask,
  checkConflicts,
  autoReschedule,
  scheduleSummary,
  manageTaskMembers,
} = require('../controllers/taskController');
const { getCrossTeamDependencies } = require('../controllers/dependencyController');
const { recordReceipt } = require('../controllers/taskReceiptController');

const router = express.Router();

// All task routes require authentication + permission context
router.use(authenticate);
router.use(attachTaskPermissions);

// ─── GET /api/tasks/cross-team-deps (must be before /:id) ────
router.get('/cross-team-deps', getCrossTeamDependencies);

// ─── POST /api/tasks/check-conflicts (must be before /:id) ──
router.post('/check-conflicts', checkConflicts);

// ─── POST /api/tasks/auto-reschedule (must be before /:id) ──
router.post('/auto-reschedule', autoReschedule);

// ─── GET /api/tasks/schedule-summary (must be before /:id) ──
router.get('/schedule-summary', scheduleSummary);

// ─── PUT /api/tasks/reorder (all authenticated users) ────────
router.put('/reorder', reorderTasks);

// ─── PUT /api/tasks/bulk (anyone with tasks.edit; per-task permission still
//     enforced inside the controller for any assignment changes). ──────────
router.put(
  '/bulk',
  requirePermission('tasks', 'edit'),
  [
    body('taskIds')
      .isArray({ min: 1 }).withMessage('taskIds must be a non-empty array'),
    body('updates')
      .isObject().withMessage('updates must be an object'),
  ],
  bulkUpdateTasks
);

// ─── POST /api/tasks (anyone with tasks.create — including members for self) ──
//   Members get tasks.create=true by default; the controller enforces that
//   they can only assign themselves unless tasks.assign_others is granted.
//
// Validation philosophy: be FORGIVING about fields the user did not actively
// pick on the quick-create path (description='', status='', priority=null,
// dueDate='', dates as null). The inline "+ Add task" row is the most common
// flow and serializes empty strings for optional inputs in some clients;
// production 400 reports almost always traced back to express-validator
// rejecting an empty string where the controller would have happily defaulted
// it. `optional({ nullable: true, checkFalsy: true })` skips the chain when
// the value is undefined, null, '', 0, or false — exactly the "user didn't
// pick this" set. Required fields (title, boardId) still get strict checks.
router.post(
  '/',
  requirePermission('tasks', 'create'),
  [
    body('title')
      .trim()
      .notEmpty().withMessage('Task title is required.')
      .isLength({ min: 1, max: 300 }).withMessage('Task title must be between 1 and 300 characters.'),
    body('description')
      .optional({ nullable: true, checkFalsy: true })
      .isString().withMessage('Description must be text.')
      .isLength({ max: 10000 }).withMessage('Description must be 10,000 characters or fewer.'),
    body('boardId')
      .notEmpty().withMessage('Task could not be created: board is missing from the request.')
      .isUUID().withMessage('Task could not be created: board reference is not a valid id.'),
    body('groupId')
      .optional({ nullable: true, checkFalsy: true })
      .isString().withMessage('Task could not be created: group reference must be text.')
      .isLength({ max: 100 }).withMessage('Task could not be created: group reference is too long.'),
    body('status')
      .optional({ nullable: true, checkFalsy: true })
      .isString().withMessage('status must be a string.')
      .trim()
      .isLength({ min: 1, max: 50 }).withMessage('status must be between 1 and 50 characters.'),
    body('priority')
      .optional({ nullable: true, checkFalsy: true })
      .isIn(['low', 'medium', 'high', 'critical']).withMessage('priority must be low, medium, high, or critical.'),
    body('assignedTo')
      .optional({ nullable: true }),
    body('supervisors')
      .optional()
      .isArray().withMessage('supervisors must be an array.'),
    body('dueDate')
      .optional({ nullable: true, checkFalsy: true })
      .isISO8601().withMessage('dueDate must be a valid date.'),
    body('startDate')
      .optional({ nullable: true, checkFalsy: true })
      .isISO8601().withMessage('startDate must be a valid date.'),
    body('statusConfig')
      .optional({ nullable: true })
      .isArray().withMessage('statusConfig must be an array.'),
  ],
  createTask
);

// ─── GET /api/tasks ──────────────────────────────────────────
router.get('/', getTasks);

// ─── GET /api/tasks/:id (with visibility check) ─────────────
router.get('/:id', canViewTask, getTask);

// ─── POST /api/tasks/:id/receipt ─────────────────────────────────────────
// Records per-assignee delivered/seen acknowledgement for the WhatsApp-style
// receipt UI. The controller enforces that only assignees can write their own
// receipt state.
router.post(
  '/:id/receipt',
  [
    body('event')
      .optional()
      .isIn(['seen', 'delivered']).withMessage('event must be "seen" or "delivered"'),
  ],
  recordReceipt
);

// ─── PUT /api/tasks/:id/members (requires tasks.assign_others) ────────────
//   Adding/removing OTHERS as assignees/supervisors is a privileged action;
//   the route gate uses assign_others. (Self-assign goes through PUT /:id.)
router.put(
  '/:id/members',
  requirePermission('tasks', 'assign_others'),
  [
    body('assignees').optional().isArray().withMessage('assignees must be an array'),
    body('supervisors').optional().isArray().withMessage('supervisors must be an array'),
  ],
  manageTaskMembers
);

// ─── PUT /api/tasks/:id ──────────────────────────────────────
router.put(
  '/:id',
  [
    body('title')
      .optional()
      .trim()
      .isLength({ min: 1, max: 300 }).withMessage('Task title must be between 1 and 300 characters'),
    body('status')
      .optional()
      .isString().withMessage('status must be a string')
      .trim()
      .isLength({ min: 1, max: 50 }).withMessage('status must be between 1 and 50 characters'),
    body('priority')
      .optional()
      .isIn(['low', 'medium', 'high', 'critical']).withMessage('Invalid priority value'),
    body('assignedTo')
      .optional({ nullable: true }),
    body('supervisors')
      .optional()
      .isArray().withMessage('supervisors must be an array'),
    body('dueDate')
      .optional({ nullable: true })
      .isISO8601().withMessage('dueDate must be a valid date'),
    body('startDate')
      .optional({ nullable: true })
      .isISO8601().withMessage('startDate must be a valid date'),
    body('statusConfig')
      .optional({ nullable: true }),
  ],
  updateTask
);

// ─── DELETE /api/tasks/:id (requires tasks.delete) ──
//   Members do not get tasks.delete by default (they can only archive their
//   own tasks via the controller's per-task action check).
router.delete('/:id', requirePermission('tasks', 'delete'), deleteTask);

// ─── POST /api/tasks/:id/duplicate (requires tasks.create) ──
router.post('/:id/duplicate', requirePermission('tasks', 'create'), duplicateTask);

// ─── PUT /api/tasks/:id/move (requires tasks.edit; per-task check inside) ──
router.put(
  '/:id/move',
  requirePermission('tasks', 'edit'),
  [
    body('groupId')
      .optional()
      .trim()
      .notEmpty().withMessage('groupId cannot be empty'),
    body('position')
      .optional()
      .isInt({ min: 0 }).withMessage('position must be a non-negative integer'),
  ],
  moveTask
);

module.exports = router;
