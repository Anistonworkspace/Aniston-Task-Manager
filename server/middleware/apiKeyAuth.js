const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { User, ApiKey } = require('../models');

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Authenticate via API Key (X-API-Key header) OR JWT Bearer token.
 * - API Key: validated against database api_keys table (primary) or HRMS_API_KEY env var (legacy fallback)
 * - JWT: validated using existing JWT auth logic (logged-in user)
 * Sets req.authMethod to 'apiKey' or 'jwt' on success.
 */
const apiKeyOrJwt = async (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  const authHeader = req.headers.authorization;

  // ─── Try API Key first ──────────────────────────────────────
  if (apiKey) {
    // 1) Check database-managed keys
    try {
      const keyHashed = hashKey(apiKey);
      const dbKey = await ApiKey.findOne({ where: { keyHash: keyHashed } });

      if (dbKey) {
        if (!dbKey.isActive) {
          return res.status(401).json({ success: false, message: 'API key has been disabled.' });
        }
        if (dbKey.expiresAt && new Date(dbKey.expiresAt) <= new Date()) {
          return res.status(401).json({ success: false, message: 'API key has expired.' });
        }

        // Update last used timestamp (fire-and-forget)
        dbKey.lastUsedAt = new Date();
        dbKey.save().catch(() => {});

        req.authMethod = 'apiKey';
        req.apiKeyId = dbKey.id;
        return next();
      }
    } catch (err) {
      console.error('[apiKeyAuth] DB lookup error:', err.message);
      // Fall through to legacy check
    }

    // 2) Legacy fallback: HRMS_API_KEY env var
    const validKey = process.env.HRMS_API_KEY;
    if (validKey && apiKey.length === validKey.length) {
      try {
        if (crypto.timingSafeEqual(Buffer.from(apiKey), Buffer.from(validKey))) {
          req.authMethod = 'apiKey';
          return next();
        }
      } catch (e) {
        // length mismatch or buffer error — fall through
      }
    }

    return res.status(401).json({ success: false, message: 'Invalid API key.' });
  }

  // ─── Fall back to JWT Bearer token ──────────────────────────
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.split(' ')[1];
      if (!token) {
        return res.status(401).json({ success: false, message: 'Malformed authorization header.' });
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findByPk(decoded.id);

      if (!user) {
        return res.status(401).json({ success: false, message: 'Token is valid but user no longer exists.' });
      }

      if (!user.isActive) {
        return res.status(403).json({ success: false, message: 'Account has been deactivated.' });
      }

      req.user = user;
      req.authMethod = 'jwt';
      return next();
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({ success: false, message: 'Token has expired.' });
      }
      if (error.name === 'JsonWebTokenError') {
        return res.status(401).json({ success: false, message: 'Invalid token.' });
      }
      return res.status(500).json({ success: false, message: 'Authentication error.' });
    }
  }

  // ─── No auth provided ──────────────────────────────────────
  return res.status(401).json({
    success: false,
    message: 'Authentication required. Provide X-API-Key header or Bearer token.',
  });
};

module.exports = { apiKeyOrJwt };
