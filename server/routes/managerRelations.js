const express = require('express');
const router = express.Router();
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const ctrl = require('../controllers/managerRelationController');

// Audit B5 fix — every route now goes through requirePermission so explicit
// DENY overrides on org_chart are honoured here too. Previously these routes
// were guarded only by managerOrAdmin, which meant a Tier-2 user with their
// org_chart.manage permission DENY'd via PermissionGrant could still mutate
// the org chart through this surface (since the controller never consulted
// the permission engine). Mirrors the gates already applied to the canonical
// /api/promotions/relations/* routes.

// Get all manager relations for an employee
router.get('/:employeeId', authenticate, requirePermission('org_chart', 'view'), ctrl.getRelationsForEmployee);

// Add a new manager relation
router.post('/', authenticate, managerOrAdmin, requirePermission('org_chart', 'manage'), ctrl.addRelation);

// Update a relation (change type or primary flag)
router.put('/:id', authenticate, managerOrAdmin, requirePermission('org_chart', 'manage'), ctrl.updateRelation);

// Remove a manager relation
router.delete('/:id', authenticate, managerOrAdmin, requirePermission('org_chart', 'manage'), ctrl.removeRelation);

// Sync existing managerId data into the junction table (admin migration helper)
router.post('/sync', authenticate, managerOrAdmin, requirePermission('org_chart', 'manage'), ctrl.syncFromManagerId);

module.exports = router;
