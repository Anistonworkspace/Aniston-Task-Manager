const express = require('express');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const {
  createMeeting,
  getMyMeetings,
  getTeamMeetings,
  updateMeeting,
  respondToMeeting,
  deleteMeeting,
} = require('../controllers/meetingController');

const router = express.Router();

router.use(authenticate);

router.get('/my', getMyMeetings);
router.get('/team', managerOrAdmin, getTeamMeetings);
// assistant_manager can create own meetings, ownership enforced in controller
router.post('/', createMeeting);
router.put('/:id', updateMeeting);
router.put('/:id/respond', respondToMeeting);
router.delete('/:id', deleteMeeting);

module.exports = router;
