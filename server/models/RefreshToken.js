const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * RefreshToken — one row per issued refresh JWT.
 *
 * Why this exists
 * ---------------
 * Refresh tokens are JWTs signed with JWT_SECRET and a 7-day expiry. Without a
 * server-side record we cannot:
 *   1. Rotate them (issue new + invalidate old).
 *   2. Revoke them on logout / password change before natural expiry.
 *   3. Detect token-reuse attacks (a thief uses an already-rotated token).
 *
 * Each JWT we issue now embeds a `jti` (JWT ID) UUID claim. The same UUID is
 * the primary key here. To validate a refresh token we (a) verify the JWT
 * signature/expiry as before, then (b) look up the JTI here and confirm
 * `revokedAt IS NULL`. On rotation we set `replacedByJti` on the old row and
 * insert a new row for the rotated token.
 *
 * Reuse detection
 * ---------------
 * If an old (already-rotated, `replacedByJti IS NOT NULL`) token is presented
 * for refresh, that's a strong signal someone has the token they shouldn't.
 * We treat it as a session compromise: revoke EVERY active refresh token for
 * the user (chain-wide kill) and force re-login. This is the same pattern
 * Google / Auth0 use.
 *
 * Garbage collection
 * ------------------
 * Expired rows pile up over time. The weekly VACUUM ANALYZE job
 * (jobs/vacuumAnalyzeJob.js) deletes any row where
 * `expiresAt < now() - interval '14 days'` so we keep ~2 weeks of audit trail
 * for forensic purposes (more than enough to investigate a stolen-token
 * incident reported within the SLA).
 */
const RefreshToken = sequelize.define(
  'RefreshToken',
  {
    // The JWT ID claim. We use the JTI itself as the PK so the validator can
    // do a single PK lookup instead of a secondary index.
    jti: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    issuedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    revokedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    // When this token was rotated, the JTI of the new replacement token. Used
    // for reuse detection: presenting a token whose row has this set means
    // someone is replaying a token that was already exchanged.
    replacedByJti: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    // Diagnostic context — useful for forensics. Both nullable; not all
    // issuance paths have a User-Agent (e.g. SSO callback redirects).
    userAgent: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    ip: {
      type: DataTypes.STRING(45), // IPv4 or IPv6 textual form
      allowNull: true,
    },
  },
  {
    tableName: 'refresh_tokens',
    timestamps: true,
    indexes: [
      { fields: ['userId'] },
      { fields: ['expiresAt'] },
      { fields: ['revokedAt'] },
    ],
  }
);

module.exports = RefreshToken;
