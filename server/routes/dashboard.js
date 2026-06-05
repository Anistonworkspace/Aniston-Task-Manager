const express = require('express');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const { getDashboardStats, getMemberTasks, getEnterpriseDashboard, getRoleDashboard } = require('../controllers/dashboardController');

const router = express.Router();

router.use(authenticate);

router.get('/stats', getDashboardStats);
router.get('/role', getRoleDashboard);
router.get('/enterprise', managerOrAdmin, getEnterpriseDashboard);
// No coarse managerOrAdmin gate here: getMemberTasks enforces per-member
// authorization itself (it 403s unless the requested user is inside the
// viewer's reporting subtree — see the getVisibleUserIdsForViewer check).
// The route guard would otherwise block Tier 3 from drilling into members
// that ARE in their hierarchy. Mirrors the unguarded /stats endpoint.
router.get('/member/:userId/tasks', getMemberTasks);
// /director endpoint retired — Director Dashboard module removed.
router.get('/director', (_req, res) => res.status(410).json({ success: false, message: 'Director Dashboard has been removed.' }));

module.exports = router;
