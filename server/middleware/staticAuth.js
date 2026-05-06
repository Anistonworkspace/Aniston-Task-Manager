'use strict';

/**
 * Authentication for the /uploads static directory (Phase 5e — closes audit
 * P0-1).
 *
 * Previously the directory was served by `express.static(getUploadDir())`
 * with NO authentication, so any unauthenticated request could fetch any
 * file by guessing the filename (timestamp + ~30 bits of randomness).
 *
 * This middleware requires a JWT, accepted via either:
 *   - `Authorization: Bearer <token>` header (for fetch / API consumers), or
 *   - `?token=<jwt>` query parameter (so plain <img src=...> tags work
 *     after the frontend appends the token to upload URLs).
 *
 * Per-file authorization (e.g. canAccessTask) is a follow-up: this is a
 * baseline gate that blocks anonymous downloads. Authenticated download
 * via the API path (/api/files/:id/download) already enforces per-file
 * RBAC; this middleware is the safety net for direct /uploads URLs that
 * still leak through DB rows / CSV exports / socket events.
 */

const jwt = require('jsonwebtoken');
const { User } = require('../models');

function send401(res, msg) {
  res.status(401).json({ success: false, message: msg });
}

async function authenticateForStatic(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const headerToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : null;
  const queryToken =
    typeof req.query.token === 'string' && req.query.token.length > 0
      ? req.query.token
      : null;
  const token = headerToken || queryToken;

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
