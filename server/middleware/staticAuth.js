'use strict';

/**
 * Authentication for the /uploads static directory (Phase 5e — closes audit
 * P0-1).
 *
 * Previously the directory was served by `express.static(getUploadDir())`
 * with NO authentication, so any unauthenticated request could fetch any
 * file by guessing the filename (timestamp + ~30 bits of randomness).
 *
 * This middleware requires a JWT, accepted via three sources (preferred
 * order): the new D-1 httpOnly access cookie, the legacy Authorization
 * header, or a `?token=` query param (so older `<img src>` URLs keep
 * working through the migration window).
 *
 * Per-file authorization (e.g. canAccessTask) is a follow-up: this is a
 * baseline gate that blocks anonymous downloads. Authenticated download
 * via the API path (/api/files/:id/download) already enforces per-file
 * RBAC; this middleware is the safety net for direct /uploads URLs that
 * still leak through DB rows / CSV exports / socket events.
 */

const jwt = require('jsonwebtoken');
const { User } = require('../models');
const { getAccessTokenFromRequest } = require('../utils/authCookies');

function send401(res, msg) {
  res.status(401).json({ success: false, message: msg });
}

async function authenticateForStatic(req, res, next) {
  // Cookie-or-Bearer comes from the shared helper. Query-string fallback is
  // kept here because the helper deliberately doesn't support it (no API
  // consumer should accept tokens via URLs in 2026 — that's an /uploads-only
  // historic quirk for inline <img> tags pre-D-1).
  const cookieOrHeader = getAccessTokenFromRequest(req);
  const queryToken =
    typeof req.query.token === 'string' && req.query.token.length > 0
      ? req.query.token
      : null;
  const token = cookieOrHeader || queryToken;

  if (!token) {
    return send401(res, 'Authentication required to access uploaded files.');
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type === 'refresh') {
      return send401(res, 'Refresh tokens are not accepted on /uploads.');
    }
    const user = await User.findByPk(decoded.id, {
      attributes: ['id', 'isActive'],
    });
    if (!user || !user.isActive) {
      return send401(res, 'Invalid token.');
    }
    // Attach minimal user record so downstream loggers (if any) can audit.
    req.user = user;
    next();
  } catch (err) {
    return send401(res, 'Invalid or expired token.');
  }
}

module.exports = { authenticateForStatic };
