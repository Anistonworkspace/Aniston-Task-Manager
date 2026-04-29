const express = require('express');
const { authenticate } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const {
  submitFeedback,
  getAllFeedback,
  updateFeedback,
  deleteFeedback,
  getFeedbackStats,
} = require('../controllers/feedbackController');

const router = express.Router();

// Submitting feedback uses the dedicated `feedback.create` action so it can be
// scoped per-role / denied per-user. Default role matrix grants this to all.
router.post('/', authenticate, requirePermission('feedback', 'create'), submitFeedback);

// Reading and acting on existing feedback. `view` lets you read the list and
// stats; `manage` is required to update status/notes or delete. Members can be
// granted either via PermissionGrant; a deny override removes them.
router.get('/stats', authenticate, requirePermission('feedback', 'view'), getFeedbackStats);
router.get('/', authenticate, requirePermission('feedback', 'view'), getAllFeedback);
router.put('/:id', authenticate, requirePermission('feedback', 'manage'), updateFeedback);
router.delete('/:id', authenticate, requirePermission('feedback', 'manage'), deleteFeedback);

module.exports = router;
