const express = require('express');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const {
  createTimeBlock,
  getMyTimeBlocks,
  getEmployeeTimeBlocks,
  getTeamTimeBlocks,
  updateTimeBlock,
  deleteTimeBlock,
  getMyCalendarEvents,
  getEmployeeCalendarEvents,
} = require('../controllers/timePlanController');

const router = express.Router();

router.use(authenticate);

// M365 Calendar events (must be before /:id to avoid route conflicts)
router.get('/calendar-events', getMyCalendarEvents);
router.get('/calendar-events/:userId', managerOrAdmin, getEmployeeCalendarEvents);

// My time blocks — write endpoints require time_plan.edit permission;
// the controller still enforces per-row ownership.
router.post('/', requirePermission('time_plan', 'edit'), createTimeBlock);
router.get('/my', getMyTimeBlocks);

// Manager/Admin: view team & employee blocks
router.get('/team', managerOrAdmin, getTeamTimeBlocks);
router.get('/employee/:userId', managerOrAdmin, getEmployeeTimeBlocks);

// Update & delete
router.put('/:id', requirePermission('time_plan', 'edit'), updateTimeBlock);
router.delete('/:id', requirePermission('time_plan', 'edit'), deleteTimeBlock);

module.exports = router;
