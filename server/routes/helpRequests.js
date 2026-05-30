const express = require('express');
const { body, param } = require('express-validator');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const { createHelpRequest, getHelpRequests, updateStatus, getMyPendingHelp, archiveHelpRequest } = require('../controllers/helpRequestController');
const router = express.Router();

// Validator chains. The helpRequest controller does not currently consume
// validationResult, so these checks are defence-in-depth scaffolding.
router.post(
  '/',
  authenticate,
  [
    body('taskId').isUUID().withMessage('taskId must be a valid UUID'),
    body('requestedTo').isUUID().withMessage('requestedTo must be a valid UUID'),
    body('description').isString().trim().isLength({ min: 1, max: 2000 }).withMessage('description is required (1-2000 chars)'),
    body('urgency').optional().isIn(['low', 'medium', 'high', 'critical']).withMessage('urgency must be low|medium|high|critical'),
  ],
  createHelpRequest
);
router.get('/', authenticate, getHelpRequests);
router.get('/my-pending', authenticate, getMyPendingHelp);
// Status update — controller enforces: only helper (requestedTo) or manager+ can update.
// 'rejected' is additionally gated to the helper only inside the controller.
router.put(
  '/:id/status',
  authenticate,
  [
    param('id').isUUID().withMessage('id must be a valid UUID'),
    body('status').optional().isIn(['pending', 'in_review', 'meeting_scheduled', 'resolved', 'rejected'])
      .withMessage('invalid status'),
    body('rejectionReason').optional().isString().trim().isLength({ min: 1, max: 1000 })
      .withMessage('rejectionReason must be 1-1000 chars'),
  ],
  updateStatus
);
router.put(
  '/:id/archive',
  authenticate,
  [ param('id').isUUID().withMessage('id must be a valid UUID') ],
  archiveHelpRequest
);

module.exports = router;
