const express = require('express');
const router = express.Router();
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const ctrl = require('../controllers/managerRelationController');

// Get all manager relations for an employee
router.get('/:employeeId', authenticate, ctrl.getRelationsForEmployee);

// Add a new manager relation
router.post('/', authenticate, managerOrAdmin, ctrl.addRelation);

// Update a relation (change type or primary flag)
router.put('/:id', authenticate, managerOrAdmin, ctrl.updateRelation);

// Remove a manager relation
router.delete('/:id', authenticate, managerOrAdmin, ctrl.removeRelation);

// Sync existing managerId data into the junction table (admin migration helper)
router.post('/sync', authenticate, managerOrAdmin, ctrl.syncFromManagerId);

module.exports = router;
