const express = require('express');
const { body, param } = require('express-validator');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const {
  getAccessRequests,
  createAccessRequest,
  approveRequest,
  rejectRequest,
  getPendingCount,
} = require('../controllers/accessRequestController');

const router = express.Router();

router.get('/', authenticate, getAccessRequests);
// Validator chains. The accessRequest controller does not currently consume
// validationResult, so these checks are defence-in-depth scaffolding.
router.post(
  '/',
  authenticate,
  [
    body('resourceType').isString().notEmpty().withMessage('resourceType is required'),
    body('resourceId').optional().isUUID().withMessage('resourceId must be a valid UUID'),
    body('requestType').isIn(['view', 'edit', 'assign', 'admin']).withMessage('requestType must be view|edit|assign|admin'),
    body('reason').optional().isString().isLength({ max: 2000 }).withMessage('reason must be ≤2000 chars'),
  ],
  createAccessRequest
);
router.put(
  '/:id/approve',
  authenticate,
  managerOrAdmin,
  [ param('id').isUUID().withMessage('id must be a valid UUID') ],
  approveRequest
);
router.put(
  '/:id/reject',
  authenticate,
  managerOrAdmin,
  [ param('id').isUUID().withMessage('id must be a valid UUID') ],
  rejectRequest
);
router.get('/pending/count', authenticate, managerOrAdmin, getPendingCount);

module.exports = router;
