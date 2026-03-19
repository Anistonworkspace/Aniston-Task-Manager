const express = require('express');
const { authenticate, managerOrAdmin } = require('../middleware/auth');
const { requestExtension, getExtensions, approveExtension, rejectExtension } = require('../controllers/dueDateExtensionController');
const router = express.Router();

router.post('/', authenticate, requestExtension);
router.get('/', authenticate, getExtensions);
router.put('/:id/approve', authenticate, managerOrAdmin, approveExtension);
router.put('/:id/reject', authenticate, managerOrAdmin, rejectExtension);

module.exports = router;
