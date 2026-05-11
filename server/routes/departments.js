const express = require('express');
const { body } = require('express-validator');
const { authenticate, managerOrAdmin, adminOnly } = require('../middleware/auth');
const {
  createDepartment,
  getDepartments,
  getDepartment,
  updateDepartment,
  deleteDepartment,
  assignUsers,
  syncFromUsers,
} = require('../controllers/departmentController');

const router = express.Router();

// Validator chain. The department controller does not currently consume
// validationResult, so these checks are defence-in-depth scaffolding.
const departmentValidators = [
  body('name').isString().trim().isLength({ min: 1, max: 100 }).withMessage('name is required (1-100 chars)'),
  body('description').optional().isString().isLength({ max: 2000 }).withMessage('description must be ≤2000 chars'),
  body('color').optional().isString().isLength({ max: 20 }).withMessage('color must be ≤20 chars'),
  body('head').optional().isUUID().withMessage('head must be a valid UUID'),
];

router.use(authenticate);

router.post('/sync-from-users', managerOrAdmin, syncFromUsers);
router.get('/', getDepartments);
router.get('/:id', getDepartment);
router.post('/', managerOrAdmin, departmentValidators, createDepartment);
router.put('/:id', managerOrAdmin, departmentValidators, updateDepartment);
router.put('/:id/assign', managerOrAdmin, assignUsers);
router.delete('/:id', adminOnly, deleteDepartment);

module.exports = router;
