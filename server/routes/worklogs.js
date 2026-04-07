const express = require('express');
const { body } = require('express-validator');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const {
  createWorkLog,
  getWorkLogs,
  updateWorkLog,
  deleteWorkLog,
} = require('../controllers/worklogController');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Create work log (any authenticated user, RBAC in controller)
router.post(
  '/',
  [
    body('content').trim().isLength({ min: 1, max: 5000 }).withMessage('Content is required (max 5000 chars).'),
    body('taskId').isUUID().withMessage('Valid taskId is required.'),
    body('date').optional().isDate().withMessage('Date must be valid (YYYY-MM-DD).'),
  ],
  createWorkLog,
);

// Get work logs (RBAC in controller)
router.get('/', getWorkLogs);

// Update work log (RBAC in controller)
router.put(
  '/:id',
  [body('content').optional().trim().isLength({ min: 1, max: 5000 })],
  updateWorkLog,
);

// Delete work log (manager/admin only)
router.delete('/:id', managerOrAdmin, deleteWorkLog);

module.exports = router;
