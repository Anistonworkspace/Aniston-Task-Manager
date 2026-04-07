const express = require('express');
const { body } = require('express-validator');
const { authenticate, managerOrAdmin, requireRole } = require('../middleware/auth');
const { attachTaskPermissions, canViewTask } = require('../middleware/taskPermissions');
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

// ─── PUT /api/tasks/bulk (manager/admin only) ────────────────
router.put(
  '/bulk',
  managerOrAdmin,
  [
    body('taskIds')
      .isArray({ min: 1 }).withMessage('taskIds must be a non-empty array'),
    body('updates')
      .isObject().withMessage('updates must be an object'),
  ],
  bulkUpdateTasks
);

// ─── POST /api/tasks (assistant_manager, manager, admin only — employees cannot create) ──
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
      .isIn(['not_started', 'ready_to_start', 'working_on_it', 'in_progress', 'waiting_for_review', 'pending_deploy', 'stuck', 'done', 'review']).withMessage('Invalid status value'),
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
  ],
  createTask
);

// ─── GET /api/tasks ──────────────────────────────────────────
router.get('/', getTasks);

// ─── GET /api/tasks/:id (with visibility check) ─────────────
router.get('/:id', canViewTask, getTask);

// ─── PUT /api/tasks/:id/members (assistant_manager+) ────────
router.put(
  '/:id/members',
  managerOrAdmin,
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
      .isIn(['not_started', 'ready_to_start', 'working_on_it', 'in_progress', 'waiting_for_review', 'pending_deploy', 'stuck', 'done', 'review']).withMessage('Invalid status value'),
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
  ],
  updateTask
);

// ─── DELETE /api/tasks/:id (manager/admin only) ──────────────
router.delete('/:id', managerOrAdmin, deleteTask);

// ─── POST /api/tasks/:id/duplicate (assistant_manager+ only) ──
router.post('/:id/duplicate', requireRole('assistant_manager', 'manager', 'admin'), duplicateTask);

// ─── PUT /api/tasks/:id/move (manager/admin only) ────────────
router.put(
  '/:id/move',
  managerOrAdmin,
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
