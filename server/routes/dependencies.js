const express = require('express');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const {
  getTaskDependencies,
  createDependency,
  createDependencyOrRequest,
  removeDependency,
  delegateTask,
  assignDependency,
  archiveDependency,
} = require('../controllers/dependencyController');
const dependencyRequestController = require('../controllers/dependencyRequestController');
const drPerm = require('../middleware/dependencyRequestPermissions');

const router = express.Router();

router.use(authenticate);

// ─── Parent-task-scoped dependency endpoints ─────────────────
// GET stays a single endpoint that returns BOTH legacy task-to-task links
// (`blockedBy`/`blocking`) and new DependencyRequest rows
// (`dependencyRequests`). Frontend can consume incrementally.
router.get(
  '/tasks/:taskId/dependencies',
  drPerm.loadParentTask,
  drPerm.requireParentTaskView,
  getTaskDependencies,
);

// POST dispatches based on body shape:
//   { dependsOnTaskId }         → legacy task-to-task link
//   { assignedToUserId, title } → new DependencyRequest (default path)
// Both branches require parent-task create access.
router.post(
  '/tasks/:taskId/dependencies',
  drPerm.loadParentTask,
  drPerm.requireParentTaskCreateAccess,
  createDependencyOrRequest,
);

// Legacy Add Dependency dialog endpoint — still creates a DependencyRequest
// under the hood. Same access gate as the canonical create.
router.post(
  '/tasks/:taskId/dependencies/assign',
  drPerm.loadParentTask,
  drPerm.requireParentTaskCreateAccess,
  assignDependency,
);

// Read-only list of dependency requests rooted at a parent.
router.get(
  '/tasks/:taskId/dependency-requests',
  drPerm.loadParentTask,
  drPerm.requireParentTaskView,
  dependencyRequestController.listForTask,
);

// Legacy DELETE — removes a TaskDependency link. Restricted to managers.
router.delete('/tasks/:taskId/dependencies/:dependencyId', managerOrAdmin, removeDependency);
// Legacy archive — TaskDependency archive flag (used by the cross-team page).
router.put('/tasks/:taskId/dependencies/:dependencyId/archive', archiveDependency);

// ─── Owner-side / requester-side dependency request endpoints ──
// Mounted as bare URLs because the parent app mounts this router at /api.
// These return only the current user's own data so they don't need a per-row
// auth guard — the controller scopes the query by user id.
router.get('/dependencies/assigned-to-me', dependencyRequestController.listAssignedToMe);
router.get('/dependencies/created-by-me',  dependencyRequestController.listCreatedByMe);
// Lightweight count for the global header badge — see controller header.
router.get('/dependencies/assigned-active-count', dependencyRequestController.countActiveAssignedToMe);

// Per-row endpoints — load the row first, then check the appropriate guard.
router.get(
  '/dependencies/:dependencyId',
  drPerm.loadDependencyRequest,
  drPerm.requireRequestParty,
  dependencyRequestController.getOne,
);

router.patch(
  '/dependencies/:dependencyId/status',
  drPerm.loadDependencyRequest,
  // Transition-level authorisation lives in the controller (it depends on
  // the requested status, which the middleware doesn't see). The loader
  // alone is enough at the route level.
  dependencyRequestController.updateStatus,
);

router.patch(
  '/dependencies/:dependencyId',
  drPerm.loadDependencyRequest,
  drPerm.requireRequestManager,
  dependencyRequestController.updateDetails,
);

router.put(
  '/dependencies/:dependencyId/archive',
  drPerm.loadDependencyRequest,
  drPerm.requireRequestArchiver,
  dependencyRequestController.archiveDependency,
);

router.delete(
  '/dependencies/:dependencyId',
  drPerm.loadDependencyRequest,
  drPerm.requireRequestManager,
  dependencyRequestController.cancelDependency,
);

// ─── Delegation (kept as-is) ─────────────────────────────────
router.post('/tasks/:taskId/delegate', delegateTask);

module.exports = router;
