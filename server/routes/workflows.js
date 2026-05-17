'use strict';

/**
 * /api/workflows — Phase W1 Workflow Canvas REST surface.
 *
 * All routes are behind `authenticate`. Per-resource RBAC (workspace
 * membership + creator/admin/manager for destructive ops) is enforced
 * inside the controller — mirrors the docCommentController pattern.
 *
 * Coexists with /api/automations (legacy automation engine). Both routes
 * + both engines stay live.
 */

const express = require('express');
const { authenticate } = require('../middleware/auth');
const ctrl = require('../controllers/workflowController');

const router = express.Router();

router.use(authenticate);

// workflows
router.get('/', ctrl.listWorkflows);
router.post('/', ctrl.createWorkflow);
router.get('/:id', ctrl.getWorkflow);
router.patch('/:id', ctrl.updateWorkflow);
router.delete('/:id', ctrl.deleteWorkflow);

// nodes
router.post('/:id/nodes', ctrl.createNode);
router.patch('/:id/nodes/:nodeId', ctrl.updateNode);
router.delete('/:id/nodes/:nodeId', ctrl.deleteNode);

// edges
router.post('/:id/edges', ctrl.createEdge);
router.delete('/:id/edges/:edgeId', ctrl.deleteEdge);

// runs (read-only audit log)
router.get('/:id/runs', ctrl.listRuns);

// Phase W2 — author-driven synthetic run. Returns the WorkflowRun result
// inline so the canvas can show "ran in 142ms — 3 actions, status: ok".
router.post('/:id/test-run', ctrl.testRunWorkflow);

module.exports = router;
