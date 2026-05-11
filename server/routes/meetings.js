const express = require('express');
const { body } = require('express-validator');
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

// Validator chain. The meeting controller does not currently consume
// validationResult, so these checks are defence-in-depth scaffolding.
const meetingValidators = [
  body('title').isString().trim().isLength({ min: 1, max: 200 }).withMessage('title is required (1-200 chars)'),
  body('date').isISO8601().withMessage('date must be ISO8601'),
  body('startTime').optional().isString(),
  body('endTime').optional().isString(),
  body('location').optional().isString().isLength({ max: 500 }).withMessage('location must be ≤500 chars'),
  body('type').optional().isString(),
  body('status').optional().isString(),
];

router.use(authenticate);

router.get('/my', getMyMeetings);
router.get('/team', managerOrAdmin, getTeamMeetings);
// assistant_manager can create own meetings, ownership enforced in controller
router.post('/', meetingValidators, createMeeting);
router.put('/:id', meetingValidators, updateMeeting);
router.put('/:id/respond', respondToMeeting);
router.delete('/:id', deleteMeeting);

module.exports = router;
