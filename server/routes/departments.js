const express = require('express');
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

router.use(authenticate);

router.post('/sync-from-users', managerOrAdmin, syncFromUsers);
router.get('/', getDepartments);
router.get('/:id', getDepartment);
router.post('/', managerOrAdmin, createDepartment);
router.put('/:id', managerOrAdmin, updateDepartment);
router.put('/:id/assign', managerOrAdmin, assignUsers);
router.delete('/:id', adminOnly, deleteDepartment);

module.exports = router;
