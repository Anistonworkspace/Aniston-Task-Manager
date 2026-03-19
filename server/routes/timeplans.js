const express = require('express');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const {
  createTimeBlock,
  getMyTimeBlocks,
  getEmployeeTimeBlocks,
  getTeamTimeBlocks,
  updateTimeBlock,
  deleteTimeBlock,
} = require('../controllers/timePlanController');

const router = express.Router();

router.use(authenticate);

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
