/**
 * teamsTokenStorage.js
 *
 * At-rest encryption wrapper for Microsoft Teams OAuth tokens
 * (User.teamsAccessToken, User.teamsRefreshToken).
 *
 * Backed by server/utils/encryption.js (AES-256-GCM). The encrypted
 * format produced by encrypt() is:
 *     <iv_hex(32 chars)>:<authTag_hex(32 chars)>:<ciphertext_hex>
 * i.e. three lower-case hex strings joined by ':' (IV=16 bytes,
 * AuthTag=16 bytes → 32 hex chars each).
 *
 * ──────────────────────────────────────────────────────────────────
 * DUAL-PATH READ (legacy plaintext compatibility)
 *
 * Production rows captured BEFORE this change went live contain
 * plaintext OAuth tokens. After the writes start producing ciphertext,
 * decrypt() of a still-plaintext row would throw and crash the
 * calendar/refresh path.
 *
 * decryptTeamsTokenSafe() therefore inspects the stored value:
 *   • Looks like the AES-GCM tuple →  decrypt() and return plaintext.
 *   • Anything else                →  return the stored value AS-IS.
 *
 * This dual path MUST be removed once the backfill
 * (server/migrations/run_017.js) has been executed and verified in
 * every environment. See server/migrations/017_README.md for the
 * cleanup checklist.
 * ──────────────────────────────────────────────────────────────────
 */

const { encrypt, decrypt } = require('./encryption');

// Format: 32 hex (IV) : 32 hex (authTag) : N hex (ciphertext, N>=2 and even)
// Anchored, case-insensitive. The ciphertext portion must be at least
// 2 hex chars (one byte) so an empty trailing segment is rejected.
const ENCRYPTED_FORMAT = /^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]{2,}$/i;

/**
 * Detect whether a stored token value is in the AES-GCM ciphertext
 * format produced by encryption.encrypt(). Plaintext OAuth tokens
 * (JWT-shaped, contain '.', '-', '_') will NEVER match this regex.
 *
 * @param {string|null|undefined} stored
 * @returns {boolean}
 */
function isEncryptedTeamsToken(stored) {
  if (stored === null || stored === undefined) return false;
  if (typeof stored !== 'string') return false;
  return ENCRYPTED_FORMAT.test(stored);
}

/**
 * Encrypt a Teams OAuth token before persistence.
 *
 * In production, refuses to silently no-op when ENCRYPTION_KEY is
 * missing (would otherwise downgrade the security posture). In dev,
 * propagates the underlying error from encryption.getKey() so the
 * misconfiguration is obvious.
 *
 * @param {string|null|undefined} plaintext
 * @returns {string|null} encrypted ciphertext or null when input is empty
 */
function encryptTeamsToken(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') {
    return null;
  }
  if (!process.env.ENCRYPTION_KEY) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        '[teamsTokenStorage] ENCRYPTION_KEY must be set in production. ' +
        'Refusing to persist Teams OAuth tokens without at-rest encryption.'
      );
    }
    // Non-production: let encrypt() throw its own descriptive error.
  }
  return encrypt(plaintext);
}

/**
 * Read a Teams OAuth token from storage with legacy-plaintext fallback.
 *
 *   • Encrypted (matches AES-GCM format)  →  decrypt() and return plaintext.
 *   • Anything else (legacy plaintext)    →  return as-is.
 *
 * Returns null when the input is null/undefined/empty.
 *
 * @param {string|null|undefined} stored
 * @returns {string|null} the plaintext token, or null
 */
function decryptTeamsTokenSafe(stored) {
  if (stored === null || stored === undefined || stored === '') {
    return null;
  }
  if (typeof stored !== 'string') return null;

  if (isEncryptedTeamsToken(stored)) {
    try {
      return decrypt(stored);
    } catch (err) {
      // Wrong key, tampered authTag, etc. Surface clearly — the caller
      // should treat this as "no usable token" (the Graph call will fail
      // with 401 and the user can reconnect).
      console.error('[teamsTokenStorage] Failed to decrypt stored token:', err.message);
      return null;
    }
  }

  // LEGACY plaintext path. Remove this branch after run_017.js has
  // backfilled all rows in every environment.
  return stored;
}

module.exports = {
  encryptTeamsToken,
  decryptTeamsTokenSafe,
  isEncryptedTeamsToken,
};
