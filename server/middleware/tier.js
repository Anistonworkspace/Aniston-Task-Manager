'use strict';

/**
 * Tier-based route guards (Phase 5a of the role -> tier RBAC migration).
 *
 * Two factories:
 *   requireTier(n)         — exact tier match (e.g. requireTier(1) = T1 only)
 *   requireTierAtLeast(n)  — tier <= n (numerically smaller = more privileged)
 *
 * Both must be used AFTER the `authenticate` middleware (which populates
 * req.user). They use `resolveTier(user)` from server/config/tiers.js, so
 * they work whether or not migration 014 has been applied — the helper
 * falls back to legacy (role, isSuperAdmin) when the tier column is missing.
 *
 * Errors are returned via TierError so future Express handlers can convert
 * status + code uniformly.
 *
 * Logging mirrors the existing `requireRole` middleware in auth.js so audit
 * traces remain consistent across guards.
 */

const {
  resolveTier,
  isValidTier,
  hasTierAtLeast,
  TIER_LABELS,
} = require('../config/tiers');

function send(res, status, code, message) {
  return res.status(status).json({ success: false, code, message });
}

function logUnauthorized(req, expectedDescription) {
  // Match the format used by requireRole in auth.js:294 so log scrapers /
  // SIEM rules pick up both legacy and tier denials uniformly.
  console.warn(
    `[Auth] Unauthorized access attempt: user=${req.user?.id} ` +
    `tier=${resolveTier(req.user)} attempted=${req.method} ${req.originalUrl} ` +
    `expected=${expectedDescription}`
  );
}

/**
 * Allow only an exact tier. Most useful as `requireTier(1)` for genuinely
 * super-admin-only routes (system settings, integrations admin, API keys).
 *
 * Pass an array (or use the spread form) to allow several discrete tiers,
 * e.g. `requireTier([1, 3])` for routes that admit T1 and T3 but NOT T2.
 *
 * @param {number|number[]} tier
 * @returns {Function} Express middleware
 */
function requireTier(tier) {
  const allowed = Array.isArray(tier) ? tier : [tier];
  for (const t of allowed) {
    if (!isValidTier(t)) {
      throw new Error(`requireTier: invalid tier ${t}`);
    }
  }
  const description = `Tier ${allowed.join(' or Tier ')}`;

  return function tierGuard(req, res, next) {
    if (!req.user) {
      return send(res, 401, 'UNAUTH', 'Not authenticated.');
    }
    const userTier = resolveTier(req.user);
    if (allowed.includes(userTier)) return next();
    logUnauthorized(req, description);
    return send(res, 403, 'TIER_DENIED',
      `Access denied. ${description} required.`);
  };
}

/**
 * Allow any tier at or above the given level (numerically smaller wins).
 * Examples:
 *   requireTierAtLeast(1) — Tier 1 only
 *   requireTierAtLeast(2) — Tier 1 or Tier 2
 *   requireTierAtLeast(3) — Tier 1, 2, or 3
 *   requireTierAtLeast(4) — every authenticated user
 *
 * @param {number} requiredTier
 * @returns {Function} Express middleware
 */
function requireTierAtLeast(requiredTier) {
  if (!isValidTier(requiredTier)) {
    throw new Error(`requireTierAtLeast: invalid tier ${requiredTier}`);
  }
  const description = `${TIER_LABELS[requiredTier]} or higher`;

  return function tierAtLeastGuard(req, res, next) {
    if (!req.user) {
      return send(res, 401, 'UNAUTH', 'Not authenticated.');
    }
    if (hasTierAtLeast(req.user, requiredTier)) return next();
    logUnauthorized(req, description);
    return send(res, 403, 'TIER_DENIED',
      `Access denied. ${description} required.`);
  };
}

module.exports = { requireTier, requireTierAtLeast };
