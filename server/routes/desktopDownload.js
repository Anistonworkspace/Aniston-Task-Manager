const express = require('express');
const { authenticate } = require('../middleware/auth');
const { getManifest, downloadInstaller } = require('../controllers/desktopDownloadController');

const router = express.Router();

// Both endpoints require an authenticated session. v1 policy is "any
// logged-in employee can download the desktop app" — there is no per-tier
// or per-permission gate beyond `authenticate`. The global `generalLimiter`
// in server.js (300/min/user) already covers basic abuse protection; the
// download itself is a one-time-per-laptop action in practice, so we do
// NOT pile on a stricter limiter here.
router.get('/manifest', authenticate, getManifest);
router.get('/download', authenticate, downloadInstaller);

module.exports = router;
