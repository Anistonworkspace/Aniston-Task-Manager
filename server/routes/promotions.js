const express = require('express');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const { promoteUser, getPromotionHistory, getOrgChart, updateManager } = require('../controllers/promotionController');
const router = express.Router();

router.post('/', authenticate, managerOrAdmin, promoteUser);
router.get('/org-chart', authenticate, getOrgChart);
router.get('/:userId', authenticate, getPromotionHistory);
router.put('/update-manager', authenticate, managerOrAdmin, updateManager);

module.exports = router;
