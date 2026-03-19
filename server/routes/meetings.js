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
router.post('/', managerOrAdmin, createMeeting);
router.put('/:id', updateMeeting);
router.put('/:id/respond', respondToMeeting);
router.delete('/:id', deleteMeeting);

module.exports = router;
