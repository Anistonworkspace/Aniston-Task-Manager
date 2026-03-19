const express = require('express');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const { getWatchers, toggleWatch, isWatching } = require('../controllers/taskWatcherController');
const { submitForApproval, approveTask, requestChanges, getPendingApprovals, getWorkflowItems } = require('../controllers/approvalController');
const { setRecurrence, getRecurrence } = require('../controllers/recurringTaskController');

const router = express.Router();

// Static routes MUST come before parameterized routes
router.get('/pending-approvals', authenticate, managerOrAdmin, getPendingApprovals);
router.get('/workflow-items', authenticate, getWorkflowItems);

// Task Watchers (parameterized)
router.get('/:taskId/watchers', authenticate, getWatchers);
router.post('/:taskId/watch', authenticate, toggleWatch);
router.get('/:taskId/watching', authenticate, isWatching);

// Approval Workflow (parameterized)
router.post('/:id/submit-approval', authenticate, submitForApproval);
router.post('/:id/approve', authenticate, managerOrAdmin, approveTask);
router.post('/:id/request-changes', authenticate, managerOrAdmin, requestChanges);

// Recurring Tasks (parameterized)
router.put('/:id/recurrence', authenticate, managerOrAdmin, setRecurrence);
router.get('/:id/recurrence', authenticate, getRecurrence);

module.exports = router;
