'use strict';

/**
 * /api/users/mentions — feat/docs-personal-notion Phase 4.
 *
 *   GET /api/users/mentions?q=&limit=
 *
 * Mounted at `/api/users/mentions` in server.js, BEFORE the `/api/users`
 * router so the `/:id` catch-all in users.js doesn't shadow this. With
 * Express's "longest static prefix wins" routing, `mentions` falls into
 * this router before the users router gets a chance to interpret it as
 * an :id param.
 *
 * Rate limited per IP — 60/min is generous for a typeahead picker the
 * frontend already debounces to 250ms (~4 req/sec worst case).
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { searchMentionableUsers } = require('../controllers/userMentionController');

const mentionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, _next, options) => {
    const retryAfterSec = Math.ceil(options.windowMs / 1000);
    res.set('Retry-After', String(retryAfterSec));
    res.status(429).json({
      success: false,
      code: 'rate_limited',
      bucket: 'user_mentions',
      message: 'You are searching too quickly. Please slow down.',
      retryAfter: retryAfterSec,
    });
  },
});

router.use(authenticate);
router.use(mentionLimiter);

// GET /  → handled at `/api/users/mentions` because of the mount prefix.
router.get('/', searchMentionableUsers);

module.exports = router;
