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
router.get('/director', getDirectorDashboard);

module.exports = router;
