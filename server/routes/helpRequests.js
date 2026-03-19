const express = require('express');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const { createHelpRequest, getHelpRequests, updateStatus, getMyPendingHelp } = require('../controllers/helpRequestController');
const router = express.Router();

router.post('/', authenticate, createHelpRequest);
router.get('/', authenticate, getHelpRequests);
router.get('/my-pending', authenticate, getMyPendingHelp);
router.put('/:id/status', authenticate, updateStatus);

module.exports = router;
