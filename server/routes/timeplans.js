const express = require('express');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const {
  createTimeBlock,
  getMyTimeBlocks,
  getEmployeeTimeBlocks,
  getTeamTimeBlocks,
  getPlannerPeople,
  updateTimeBlock,
  deleteTimeBlock,
  getMyCalendarEvents,
  getEmployeeCalendarEvents,
} = require('../controllers/timePlanController');

const router = express.Router();

router.use(authenticate);

// Cross-user reads (team/employee/calendar) are NOT gated by a blanket
// manager check anymore — the controller authorizes EACH target via
// plannerAccessService (subtree or explicit per-owner delegation), so a
// Tier 3 can see their own reports and a Tier 2 cannot reach outside their
// scope. Calendar data is sensitive, so the same per-target gate applies.

// M365 Calendar events (must be before /:id to avoid route conflicts)
router.get('/calendar-events', getMyCalendarEvents);
router.get('/calendar-events/:userId', getEmployeeCalendarEvents);

// Write endpoints require the matching semantic permission; the controller
// additionally enforces per-row ownership / delegation.
router.post('/', requirePermission('time_plan', 'create'), createTimeBlock);
router.get('/my', getMyTimeBlocks);

// View team & employee blocks (per-target authorization in the controller)
router.get('/team', getTeamTimeBlocks);
router.get('/people', getPlannerPeople);
router.get('/employee/:userId', getEmployeeTimeBlocks);

// Update & delete
router.put('/:id', requirePermission('time_plan', 'edit'), updateTimeBlock);
router.delete('/:id', requirePermission('time_plan', 'edit'), deleteTimeBlock);

module.exports = router;
