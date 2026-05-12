const express = require('express');
const { body } = require('express-validator');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const { getLabels, createLabel, updateLabel, deleteLabel, assignLabel, unassignLabel, getTaskLabels } = require('../controllers/labelController');
const router = express.Router();

// Validator chain. The label controller does not currently consume
// validationResult, so these checks are defence-in-depth scaffolding.
const labelValidators = [
  body('name').isString().trim().isLength({ min: 1, max: 100 }).withMessage('name is required (1-100 chars)'),
  body('color').optional().isString().isLength({ max: 20 }).withMessage('color must be ≤20 chars'),
  body('boardId').isUUID().withMessage('boardId must be a valid UUID'),
];

// Read operations: any authenticated user. Board visibility is enforced
// inside the controller.
router.get('/', authenticate, getLabels);
router.get('/task/:taskId', authenticate, getTaskLabels);

// Task-scoped writes — POST /, /assign, /unassign — are open to ANY
// authenticated user (Tier 1..4). Per-row authorization is enforced inside
// the controller via taskVisibilityService.canViewTask, which is the
// canonical "can this viewer see this task?" predicate (same gate used by
// the row-render path). The rule expressed at the route layer is therefore:
// "you must be logged in." The detailed gate ("you must be able to see
// THIS task") lives in the controller where it has the task id in hand.
//
// Why no `managerOrAdmin` here: labels are task-level metadata, not a
// board-management surface. A Tier 4 assignee adding "needs-design-review"
// to a task they own is a normal collaboration action; gating it on the
// manager role made label-cells useless for the bulk of users.
router.post('/', authenticate, labelValidators, createLabel);
router.post('/assign', authenticate, assignLabel);
router.post('/unassign', authenticate, unassignLabel);

// Label-LIBRARY mutations (rename / recolor / delete) stay admin-only —
// these change a shared resource that affects every task on the board,
// so the audit's manager-tier guard is preserved.
router.put('/:id', authenticate, managerOrAdmin, labelValidators, updateLabel);
router.delete('/:id', authenticate, managerOrAdmin, deleteLabel);

module.exports = router;
