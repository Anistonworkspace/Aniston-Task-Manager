const express = require('express');
const { body } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { createSubtask, getSubtasks, updateSubtask, deleteSubtask } = require('../controllers/subtaskController');

const router = express.Router();

// All routes require authentication. Per-action authorization (board access,
// canAssignTo, member-vs-creator) lives in the controller because it needs
// the loaded subtask + parent task to make the decision.
router.use(authenticate);

const STATUS_VALUES = ['not_started', 'working_on_it', 'stuck', 'done'];
const PRIORITY_VALUES = ['low', 'medium', 'high', 'critical'];

router.post(
  '/',
  [
    body('title').trim().isLength({ min: 1, max: 300 }).withMessage('Title is required (1-300 chars)'),
    body('taskId').isUUID().withMessage('Valid taskId is required'),
    body('assignedTo').optional({ nullable: true, checkFalsy: true }).isUUID().withMessage('assignedTo must be a valid UUID'),
    body('priority').optional({ nullable: true }).isIn([...PRIORITY_VALUES]).withMessage('Invalid priority'),
    body('description').optional({ nullable: true }).isLength({ max: 5000 }),
    body('dueDate').optional({ nullable: true, checkFalsy: true }).isISO8601().withMessage('Invalid due date'),
  ],
  createSubtask
);

router.get('/', getSubtasks);

router.put(
  '/:id',
  [
    body('title').optional().trim().isLength({ min: 1, max: 300 }),
    body('description').optional({ nullable: true }).isLength({ max: 5000 }),
    body('status').optional().isIn(STATUS_VALUES),
    body('priority').optional({ nullable: true }).isIn([null, ...PRIORITY_VALUES]),
    body('progress').optional().isInt({ min: 0, max: 100 }).withMessage('Progress must be 0–100'),
    body('assignedTo').optional({ nullable: true, checkFalsy: true }).isUUID(),
    body('dueDate').optional({ nullable: true, checkFalsy: true }).isISO8601(),
    body('position').optional().isInt({ min: 0 }),
  ],
  updateSubtask
);

// Delete authorization (member self-creator vs privileged role) is enforced
// inside the controller. Keeping the route open to authenticated users so
// members can clean up subtasks they created on their own task.
router.delete('/:id', deleteSubtask);

module.exports = router;
