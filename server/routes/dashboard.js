const express = require('express');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const { getDashboardStats, getMemberTasks, getEnterpriseDashboard, getRoleDashboard } = require('../controllers/dashboardController');

const router = express.Router();

router.use(authenticate);

router.get('/stats', getDashboardStats);
router.get('/role', getRoleDashboard);
router.get('/enterprise', managerOrAdmin, getEnterpriseDashboard);
router.get('/member/:userId/tasks', managerOrAdmin, getMemberTasks);
// /director endpoint retired — Director Dashboard module removed.
router.get('/director', (_req, res) => res.status(410).json({ success: false, message: 'Director Dashboard has been removed.' }));

module.exports = router;
