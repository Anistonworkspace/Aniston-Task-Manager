'use strict';

/**
 * /api/forms — Phase F1 Forms surface.
 *
 * The PUBLIC submit/preview endpoints (POST /public/:slug/submit and
 * GET /public/:slug) are mounted BEFORE the global `authenticate` middleware
 * so anonymous submitters never hit the JWT guard. Everything else (CRUD +
 * submissions list) requires auth and per-workspace RBAC inside the
 * controller — same pattern as workflowController.
 */

const express = require('express');
const { authenticate } = require('../middleware/auth');
const ctrl = require('../controllers/formController');

const router = express.Router();

// ─── public surface (NO auth) ─────────────────────────────────────────
// Order matters: these must register before `router.use(authenticate)` below.
router.get('/public/:slug', ctrl.getPublicForm);
router.post('/public/:slug/submit', ctrl.submitPublicForm);

// ─── authenticated surface ────────────────────────────────────────────
router.use(authenticate);

router.get('/', ctrl.listForms);
router.post('/', ctrl.createForm);
router.get('/:id', ctrl.getForm);
router.patch('/:id', ctrl.updateForm);
router.delete('/:id', ctrl.deleteForm);

router.get('/:id/submissions', ctrl.listSubmissions);
router.post('/:id/submissions/:submissionId/promote', ctrl.promoteSubmission);

module.exports = router;
