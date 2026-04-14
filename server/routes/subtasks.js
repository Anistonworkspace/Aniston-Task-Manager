const express = require('express');
const { body } = require('express-validator');
const { authenticate, requireRole } = require('../middleware/auth');
const { createSubtask, getSubtasks, updateSubtask, deleteSubtask } = require('../controllers/subtaskController');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// POST /api/subtasks — members can add subtasks to their own tasks, manager/admin to any
router.post(
  '/',
  [
    body('title').trim().isLength({ min: 1, max: 300 }).withMessage('Title is required (1-300 chars)'),
    body('taskId').isUUID().withMessage('Valid taskId is required'),
    body('assignedTo').optional({ nullable: true }).isUUID().withMessage('assignedTo must be a valid UUID'),
  ],
  createSubtask
);

// GET /api/subtasks?taskId=xxx — all authenticated users
router.get('/', getSubtasks);

// PUT /api/subtasks/:id — members can only update status, manager/admin can update all
router.put(
  '/:id',
  [
    body('title').optional().trim().isLength({ min: 1, max: 300 }),
    body('status').optional().isIn(['not_started', 'working_on_it', 'stuck', 'done']),
    body('assignedTo').optional({ nullable: true }).isUUID(),
  ],
  updateSubtask
);

// DELETE /api/subtasks/:id — assistant_manager/manager/admin (part of full task CRUD)
router.delete('/:id', requireRole('assistant_manager', 'manager', 'admin'), deleteSubtask);

module.exports = router;
