const express = require('express');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { promoteUser, getPromotionHistory, getOrgChart, updateManager } = require('../controllers/promotionController');
const mrCtrl = require('../controllers/managerRelationController');
const router = express.Router();

// All endpoints below run through the permission engine so that explicit DENY
// overrides on org_chart.view / org_chart.manage are honored. The role-level
// middleware (managerOrAdmin) is kept as a fast pre-filter; the canonical
// permission resolution still lives in requirePermission().
router.post('/', authenticate, managerOrAdmin, requirePermission('org_chart', 'manage'), promoteUser);
router.get('/org-chart', authenticate, requirePermission('org_chart', 'view'), getOrgChart);
router.put('/update-manager', authenticate, managerOrAdmin, requirePermission('org_chart', 'manage'), updateManager);

// Multi-manager relation endpoints (under /api/promotions/relations/*)
router.get('/relations/:employeeId', authenticate, requirePermission('org_chart', 'view'), mrCtrl.getRelationsForEmployee);
router.post('/relations', authenticate, managerOrAdmin, requirePermission('org_chart', 'manage'), mrCtrl.addRelation);
router.put('/relations/:id', authenticate, managerOrAdmin, requirePermission('org_chart', 'manage'), mrCtrl.updateRelation);
router.delete('/relations/:id', authenticate, managerOrAdmin, requirePermission('org_chart', 'manage'), mrCtrl.removeRelation);
router.post('/relations/sync', authenticate, managerOrAdmin, requirePermission('org_chart', 'manage'), mrCtrl.syncFromManagerId);

// Keep this LAST — /:userId is a catch-all param route
router.get('/:userId', authenticate, requirePermission('org_chart', 'view'), getPromotionHistory);

module.exports = router;
