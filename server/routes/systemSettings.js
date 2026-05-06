const express = require('express');
const { authenticate, superAdminOnly } = require('../middleware/auth');
const {
  getSessionTimeout,
  updateSessionTimeout,
} = require('../controllers/systemSettingsController');

const router = express.Router();

// GET is open to any authenticated user — every client needs the value to
// drive its inactivity logout. The response only contains the timeout (no
// secrets) so this is safe to expose broadly.
router.get('/session-timeout', authenticate, getSessionTimeout);

// PUT is locked to Super Admins. Regular admins (role='admin') are explicitly
// excluded — this is enforced at the middleware layer, not just by hiding UI.
router.put('/session-timeout', authenticate, superAdminOnly, updateSessionTimeout);

module.exports = router;
