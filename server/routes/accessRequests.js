const express = require('express');
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
router.post('/', authenticate, createAccessRequest);
router.put('/:id/approve', authenticate, managerOrAdmin, approveRequest);
router.put('/:id/reject', authenticate, managerOrAdmin, rejectRequest);
router.get('/pending/count', authenticate, managerOrAdmin, getPendingCount);

module.exports = router;
