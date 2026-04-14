const express = require('express');
const { authenticate, strictAdminOnly } = require('../middleware/auth');
const {
  submitFeedback,
  getAllFeedback,
  updateFeedback,
  deleteFeedback,
  getFeedbackStats,
} = require('../controllers/feedbackController');

const router = express.Router();

router.post('/', authenticate, submitFeedback);
router.get('/stats', authenticate, strictAdminOnly, getFeedbackStats);
router.get('/', authenticate, strictAdminOnly, getAllFeedback);
router.put('/:id', authenticate, strictAdminOnly, updateFeedback);
router.delete('/:id', authenticate, strictAdminOnly, deleteFeedback);

module.exports = router;
