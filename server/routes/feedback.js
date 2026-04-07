const express = require('express');
const { authenticate, adminOnly } = require('../middleware/auth');
const {
  submitFeedback,
  getAllFeedback,
  updateFeedback,
  deleteFeedback,
  getFeedbackStats,
} = require('../controllers/feedbackController');

const router = express.Router();

router.post('/', authenticate, submitFeedback);
router.get('/stats', authenticate, adminOnly, getFeedbackStats);
router.get('/', authenticate, adminOnly, getAllFeedback);
router.put('/:id', authenticate, adminOnly, updateFeedback);
router.delete('/:id', authenticate, adminOnly, deleteFeedback);

module.exports = router;
