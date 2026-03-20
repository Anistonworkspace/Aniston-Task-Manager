const express = require('express');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
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

// My time blocks
router.post('/', createTimeBlock);
router.get('/my', getMyTimeBlocks);

// Manager/Admin: view team & employee blocks
router.get('/team', managerOrAdmin, getTeamTimeBlocks);
router.get('/employee/:userId', managerOrAdmin, getEmployeeTimeBlocks);

// Update & delete
router.put('/:id', updateTimeBlock);
router.delete('/:id', deleteTimeBlock);

module.exports = router;
