const express = require('express');
const { body } = require('express-validator');
const { authenticate, managerOrAdmin, requireRole } = require('../middleware/auth');
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

// ─── PUT /api/tasks/bulk (assistant_manager/manager/admin) ───
router.put(
  '/bulk',
  requireRole('assistant_manager', 'manager', 'admin'),
  [
    body('taskIds')
      .isArray({ min: 1 }).withMessage('taskIds must be a non-empty array'),
    body('updates')
      .isObject().withMessage('updates must be an object'),
  ],
  bulkUpdateTasks
);

// ─── POST /api/tasks (admin, manager, assistant_manager only) ──
router.post(
  '/',
  requireRole('assistant_manager', 'manager', 'admin'),
  [
    body('title')
      .trim()
      .notEmpty().withMessage('Task title is required')
      .isLength({ min: 1, max: 300 }).withMessage('Task title must be between 1 and 300 characters'),
    body('boardId')
      .notEmpty().withMessage('boardId is required')
      .isUUID().withMessage('boardId must be a valid UUID'),
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
      .optional({ nullable: true })
      .isArray().withMessage('statusConfig must be an array'),
  ],
  createTask
);

// ─── GET /api/tasks ──────────────────────────────────────────
router.get('/', getTasks);

// ─── GET /api/tasks/:id (with visibility check) ─────────────
router.get('/:id', canViewTask, getTask);

// ─── PUT /api/tasks/:id/members (requires tasks.assign permission) ────────
router.put(
  '/:id/members',
  requirePermission('tasks', 'assign'),
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

// ─── DELETE /api/tasks/:id (assistant_manager/manager/admin) ──
router.delete('/:id', requireRole('assistant_manager', 'manager', 'admin'), deleteTask);

// ─── POST /api/tasks/:id/duplicate (assistant_manager+ only) ──
router.post('/:id/duplicate', requireRole('assistant_manager', 'manager', 'admin'), duplicateTask);

// ─── PUT /api/tasks/:id/move (assistant_manager/manager/admin) ──
router.put(
  '/:id/move',
  requireRole('assistant_manager', 'manager', 'admin'),
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
