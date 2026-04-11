const express = require('express');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const { promoteUser, getPromotionHistory, getOrgChart, updateManager } = require('../controllers/promotionController');
const mrCtrl = require('../controllers/managerRelationController');
const router = express.Router();

router.post('/', authenticate, managerOrAdmin, promoteUser);
// Org chart exposes full hierarchy — restrict to management roles
router.get('/org-chart', authenticate, managerOrAdmin, getOrgChart);
router.put('/update-manager', authenticate, managerOrAdmin, updateManager);

// Multi-manager relation endpoints (under /api/promotions/relations/*)
router.get('/relations/:employeeId', authenticate, mrCtrl.getRelationsForEmployee);
router.post('/relations', authenticate, managerOrAdmin, mrCtrl.addRelation);
router.put('/relations/:id', authenticate, managerOrAdmin, mrCtrl.updateRelation);
router.delete('/relations/:id', authenticate, managerOrAdmin, mrCtrl.removeRelation);
router.post('/relations/sync', authenticate, managerOrAdmin, mrCtrl.syncFromManagerId);

// Keep this LAST — /:userId is a catch-all param route
router.get('/:userId', authenticate, getPromotionHistory);

module.exports = router;
