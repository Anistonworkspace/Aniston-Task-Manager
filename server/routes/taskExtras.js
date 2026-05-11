const express = require('express');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const { getWatchers, toggleWatch, isWatching } = require('../controllers/taskWatcherController');
const {
  submitForApproval,
  approveTask,
  rejectTask,
  requestChanges,
  getPendingApprovals,
  getWorkflowItems,
  getApprovalChain,
  getApprovalPreview,
  getMyFeedback,
  getActionablePendingCounts,
} = require('../controllers/approvalController');
const { setRecurrence, getRecurrence } = require('../controllers/recurringTaskController');

const router = express.Router();

// Static routes MUST come before parameterized routes.
// /pending-approvals is no longer gated by managerOrAdmin — the controller now
// returns only tasks where the caller is the *current* approver, so any user
// in any chain (including non-managers if the org has unusual managerId
// configurations) sees their own queue and nobody else's.
router.get('/pending-approvals', authenticate, getPendingApprovals);
router.get('/workflow-items', authenticate, getWorkflowItems);
// Lightweight aggregate count for the global sidebar badge — see controller
// header for the count semantics. Counts only items the caller can act on.
router.get('/pending-counts', authenticate, getActionablePendingCounts);
// Submitter-side visibility: feedback I sent and what's been done with it.
// Authorization is enforced by data filter (caller's userId), not middleware.
router.get('/my-feedback', authenticate, getMyFeedback);
// Static — preview the calling user's next approver before they submit.
router.get('/approval-preview', authenticate, getApprovalPreview);

// Task Watchers (parameterized)
router.get('/:taskId/watchers', authenticate, getWatchers);
router.post('/:taskId/watch', authenticate, toggleWatch);
router.get('/:taskId/watching', authenticate, isWatching);

// Approval Workflow (parameterized).
// Authorization is enforced inside the controller via the "current approver
// only" check against task_approval_flows, which is stricter than role-based
// middleware and prevents privilege escalation regardless of caller's role.
router.post('/:id/submit-approval', authenticate, submitForApproval);
router.post('/:id/approve', authenticate, approveTask);
router.post('/:id/reject', authenticate, rejectTask);
router.post('/:id/request-changes', authenticate, requestChanges);
router.get('/:id/approval-chain', authenticate, getApprovalChain);

// Recurring Tasks (parameterized)
router.put('/:id/recurrence', authenticate, managerOrAdmin, setRecurrence);
router.get('/:id/recurrence', authenticate, getRecurrence);

module.exports = router;
