'use strict';

/**
 * /api/workflows — Phase W1 Workflow Canvas REST surface.
 *
 * Layered gating (May-19 audit hardening):
 *   1. authenticate                         — JWT required.
 *   2. requirePermission('workflows', ...)  — DENY > GRANT > base.
 *      Tier 1/2 have base access; Tier 3/4 require an explicit
 *      `workflows.view` (etc.) grant via PermissionGrant.
 *   3. Per-resource RBAC (workspace membership + creator/admin/manager for
 *      destructive ops) is still enforced inside the controller as defense
 *      in depth — the controller checks survive even if a permission row
 *      gets mis-issued for a workspace the user shouldn't see.
 *
 * Test-run rate limit is applied in Phase 6c (express-rate-limit per-user)
 * to prevent fan-out spam to Teams / notifications / task mutations.
 *
 * Coexists with /api/automations (legacy automation engine). Both routes
 * + both engines stay live.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const ctrl = require('../controllers/workflowController');

const router = express.Router();

router.use(authenticate);

// May-19 audit P1-10 — per-user rate limit on test-run. Test runs execute
// REAL actions (Teams webhook posts, notifications, task mutations) so a
// spamming author could fan out fast. 10/min/user mirrors the AI grammar
// limiter shape: authenticated route → keyed by req.user.id, with req.ip
// as a defensive fallback.
const testRunLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user?.id ? `wf-test-run:${req.user.id}` : ipKeyGenerator(req.ip)),
  message: {
    success: false,
    code: 'rate_limited',
    message: 'Too many test runs. Please wait a moment before trying again.',
  },
});

// workflows
router.get('/',           requirePermission('workflows', 'view'),    ctrl.listWorkflows);
router.post('/',          requirePermission('workflows', 'create'),  ctrl.createWorkflow);
router.get('/:id',        requirePermission('workflows', 'view'),    ctrl.getWorkflow);
router.patch('/:id',      requirePermission('workflows', 'edit'),    ctrl.updateWorkflow);
router.delete('/:id',     requirePermission('workflows', 'delete'),  ctrl.deleteWorkflow);

// nodes
router.post('/:id/nodes',                requirePermission('workflows', 'edit'), ctrl.createNode);
router.patch('/:id/nodes/:nodeId',       requirePermission('workflows', 'edit'), ctrl.updateNode);
router.delete('/:id/nodes/:nodeId',      requirePermission('workflows', 'edit'), ctrl.deleteNode);

// edges
router.post('/:id/edges',                requirePermission('workflows', 'edit'), ctrl.createEdge);
router.delete('/:id/edges/:edgeId',      requirePermission('workflows', 'edit'), ctrl.deleteEdge);

// runs (read-only audit log)
router.get('/:id/runs',   requirePermission('workflows', 'view'),    ctrl.listRuns);

// Phase W2 — author-driven synthetic run. Returns the WorkflowRun result
// inline so the canvas can show "ran in 142ms — 3 actions, status: ok".
// Rate-limited per-user via testRunLimiter to prevent action-spam fan-out.
router.post(
  '/:id/test-run',
  testRunLimiter,
  requirePermission('workflows', 'test_run'),
  ctrl.testRunWorkflow,
);

module.exports = router;
