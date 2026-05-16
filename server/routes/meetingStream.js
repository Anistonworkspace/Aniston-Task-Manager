const express = require('express');
const jwt = require('jsonwebtoken');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

const TICKET_TTL_SECONDS = 60;

/**
 * POST /api/meeting-stream/ticket
 *
 * Issue a short-lived (60s) WebSocket ticket so a cookie-authenticated
 * client can open /api/meeting-stream/ws without putting a long-lived
 * access JWT in the URL.
 *
 * The browser cannot set custom headers (Authorization) on a WebSocket
 * upgrade, and in dev the WS connects directly to :5000 while the auth
 * cookie is bound to the Vite origin (:3000) — so neither header nor
 * cookie reaches the upgrade handler in that path. The ticket bridges
 * both gaps: it rides in the query string and carries a distinct purpose
 * claim that the handshake validates.
 *
 * Authentication uses the standard `authenticate` middleware which reads
 * the access JWT from the httpOnly cookie (preferred) or the legacy
 * Authorization header.
 */
router.post('/ticket', authenticate, (req, res) => {
  const ticket = jwt.sign(
    { id: req.user.id, purpose: 'meeting-ws' },
    process.env.JWT_SECRET,
    { expiresIn: `${TICKET_TTL_SECONDS}s` }
  );
  return res.json({
    success: true,
    data: { ticket, expiresIn: TICKET_TTL_SECONDS },
  });
});

module.exports = router;
