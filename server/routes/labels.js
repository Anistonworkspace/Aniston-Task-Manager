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

// Read operations: any authenticated user
router.get('/', authenticate, getLabels);
router.get('/task/:taskId', authenticate, getTaskLabels);

// Write operations: manager+ only
router.post('/', authenticate, managerOrAdmin, labelValidators, createLabel);
router.put('/:id', authenticate, managerOrAdmin, labelValidators, updateLabel);
router.delete('/:id', authenticate, managerOrAdmin, deleteLabel);
router.post('/assign', authenticate, managerOrAdmin, assignLabel);
router.post('/unassign', authenticate, managerOrAdmin, unassignLabel);

module.exports = router;
