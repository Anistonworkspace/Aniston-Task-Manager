const express = require('express');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const { getDashboardStats, getMemberTasks, getEnterpriseDashboard, getRoleDashboard } = require('../controllers/dashboardController');
const { getDirectorDashboard } = require('../controllers/directorDashboardController');

const router = express.Router();

router.use(authenticate);

router.get('/stats', getDashboardStats);
router.get('/role', getRoleDashboard);
router.get('/enterprise', managerOrAdmin, getEnterpriseDashboard);
router.get('/member/:userId/tasks', managerOrAdmin, getMemberTasks);
// Director dashboard restricted to management roles
router.get('/director', managerOrAdmin, getDirectorDashboard);

module.exports = router;
