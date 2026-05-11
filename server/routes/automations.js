const express = require('express');
const { body } = require('express-validator');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const { getAutomations, createAutomation, updateAutomation, deleteAutomation } = require('../controllers/automationController');
const router = express.Router();

// Validator chain. The automation controller does not currently consume
// validationResult, so these checks are defence-in-depth scaffolding for
// when a global handler is wired in.
const automationValidators = [
  body('name').isString().trim().notEmpty().isLength({ max: 200 }).withMessage('name is required (max 200 chars)'),
  body('trigger').isString().isLength({ max: 100 }).withMessage('trigger is required (max 100 chars)'),
  body('action').isString().isLength({ max: 100 }).withMessage('action is required (max 100 chars)'),
  body('boardId').isUUID().withMessage('boardId must be a valid UUID'),
];

router.use(authenticate);
router.get('/', getAutomations);
router.post('/', managerOrAdmin, automationValidators, createAutomation);
router.put('/:id', managerOrAdmin, automationValidators, updateAutomation);
router.delete('/:id', managerOrAdmin, deleteAutomation);
module.exports = router;
