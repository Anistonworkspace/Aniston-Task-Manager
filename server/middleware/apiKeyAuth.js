const jwt = require('jsonwebtoken');
const { User } = require('../models');

/**
 * Authenticate via API Key (X-API-Key header) OR JWT Bearer token.
 * - API Key: validated against HRMS_API_KEY env var (server-to-server)
 * - JWT: validated using existing JWT auth logic (logged-in user)
 * Sets req.authMethod to 'apiKey' or 'jwt' on success.
 */
const apiKeyOrJwt = async (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  const authHeader = req.headers.authorization;

  // ─── Try API Key first ──────────────────────────────────────
  if (apiKey) {
    const validKey = process.env.HRMS_API_KEY;
    if (!validKey) {
      return res.status(500).json({
        success: false,
        message: 'HRMS API key not configured on server.',
      });
    }

    // Constant-time comparison to prevent timing attacks
    if (apiKey.length !== validKey.length || !require('crypto').timingSafeEqual(Buffer.from(apiKey), Buffer.from(validKey))) {
      return res.status(401).json({
        success: false,
        message: 'Invalid API key.',
      });
    }

    req.authMethod = 'apiKey';
    return next();
  }

  // ─── Fall back to JWT Bearer token ──────────────────────────
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.split(' ')[1];
      if (!token) {
        return res.status(401).json({
          success: false,
          message: 'Malformed authorization header.',
        });
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findByPk(decoded.id);

      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'Token is valid but user no longer exists.',
        });
      }

      if (!user.isActive) {
        return res.status(403).json({
          success: false,
          message: 'Account has been deactivated.',
        });
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
