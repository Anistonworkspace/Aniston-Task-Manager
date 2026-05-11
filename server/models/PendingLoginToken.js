const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * PendingLoginToken — short-lived single-use confirmation token issued when
 * a user successfully authenticates but another active session already
 * exists for that account.
 *
 * The raw token is returned ONCE in the login response body; only the
 * SHA-256 hash is persisted. The token grants exactly one action: "revoke
 * my other sessions and issue me a new one." It does NOT grant API
 * access on its own.
 *
 * Lifecycle
 * ---------
 *  - issued by POST /api/auth/login when SESSION_ALREADY_ACTIVE
 *  - consumed by POST /api/auth/login/force
 *  - one-shot: `usedAt` is set atomically with the consume UPDATE; a race
 *    that loses the UPDATE returns 0 rows and is rejected.
 *  - hard TTL: 5 minutes from creation. Expired rows are ignored at
 *    consume time and cleaned up lazily.
 *  - on consume failure (expired / used / wrong user state), the caller
 *    must re-enter their password to mint a fresh token.
 *
 * The SSO conflict path also uses this table — the raw token is delivered
 * via an httpOnly cookie rather than the response body so it never appears
 * in browser history.
 */
const PendingLoginToken = sequelize.define(
  'PendingLoginToken',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    // sha256(rawToken). Hex-encoded, 64 chars.
    tokenHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
      field: 'token_hash',
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: 'expires_at',
    },
    usedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'used_at',
    },
    // Diagnostic context — useful when investigating "who triggered the
    // force-logout?" incidents.
    ip: {
      type: DataTypes.STRING(45),
      allowNull: true,
    },
    userAgent: {
      type: DataTypes.STRING(255),
      allowNull: true,
      field: 'user_agent',
    },
    // 'local' for password login, 'sso' for Microsoft SSO. Drives which
    // confirm endpoint is allowed to consume the token.
    origin: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'local',
    },
  },
  {
    tableName: 'pending_login_tokens',
    timestamps: true,
    indexes: [
      { fields: ['token_hash'] },
      { fields: ['userId'] },
      { fields: ['expires_at'] },
    ],
  }
);

module.exports = PendingLoginToken;
