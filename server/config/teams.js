const { decrypt } = require('../utils/encryption');

// Static fallback config from environment variables
const envConfig = {
  clientId: process.env.TEAMS_CLIENT_ID || '',
  clientSecret: process.env.TEAMS_CLIENT_SECRET || '',
  tenantId: process.env.TEAMS_TENANT_ID || 'common',
  redirectUri: process.env.TEAMS_REDIRECT_URI || 'http://localhost:5000/api/teams/callback',
  ssoRedirectUri: process.env.TEAMS_SSO_REDIRECT_URI || 'http://localhost:5000/api/auth/microsoft/callback',
  scopes: ['Calendars.ReadWrite', 'User.Read', 'offline_access'],
  ssoScopes: ['openid', 'profile', 'email', 'User.Read', 'offline_access'],
  graphUrl: 'https://graph.microsoft.com/v1.0',
  get authUrl() {
    return `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0`;
  },
  get isConfigured() {
    return !!(this.clientId && this.clientSecret);
  },
  ssoEnabled: false,
};

/**
 * Get Teams/Microsoft config from the database (IntegrationConfig table).
 * Falls back to environment variables if no DB config exists.
 * Returns a config object with the same shape as envConfig.
 */
async function getTeamsConfig() {
  let dbConfig;
  try {
    // Lazy-require to avoid circular dependency at startup
    const { IntegrationConfig } = require('../models');
    dbConfig = await IntegrationConfig.findOne({ where: { provider: 'microsoft' } });
  } catch (err) {
    // DB not ready (startup) or table missing — fall back silently to env.
    // This is an expected transient state, NOT a misconfiguration, so a noisy
    // log here would just create false alarms during boot.
    console.warn('[TeamsConfig] DB lookup failed, falling back to env:', err.message);
    return envConfig;
  }

  // No row at all → admin has not configured Microsoft yet. Silent fallback is
  // correct here too: the admin will see "Not configured" in the Integrations
  // page and the login page will hide the SSO button. No log spam needed.
  if (!dbConfig) return envConfig;

  // Row exists but credentials are blank → same as "not configured".
  if (!dbConfig.clientId || !dbConfig.clientSecret) return envConfig;

  // Row exists with credentials. Decrypting them is the surface where the
  // silent-failure bug lived: previously a wrong/rotated ENCRYPTION_KEY would
  // throw inside this function's outer try, get logged at WARN level next to
  // a generic "DB config unavailable" message, and the SSO button would
  // disappear with NO actionable signal for the admin. We now isolate the
  // decrypt step and log its failure at ERROR level with the real cause so
  // it shows up in production log scans, AND we mark the returned config as
  // `decryptFailed: true` so the admin Integrations endpoint can surface it
  // in the UI instead of silently 500-ing.
  let clientId, clientSecret;
  try {
    clientId = decrypt(dbConfig.clientId);
    clientSecret = decrypt(dbConfig.clientSecret);
  } catch (err) {
    console.error(
      '[TeamsConfig] Failed to decrypt Microsoft credentials — SSO will be disabled. ' +
      'Most likely cause: ENCRYPTION_KEY env var is missing or differs from the value ' +
      'used when the credentials were saved. Fix: set the correct ENCRYPTION_KEY and ' +
      'have an admin re-save Microsoft credentials in Integrations. Underlying error: ' +
      err.message
    );
    return { ...envConfig, decryptFailed: true };
  }

  const tenantId = dbConfig.tenantId || 'common';

  // Auto-correct redirect URIs that were saved pointing to the client dev port (3000)
  // instead of the server port (5000). This fixes configs saved before the bug was patched.
  const fixPort = (uri) => uri ? uri.replace(/:3000\//, ':5000/') : uri;

  return {
    clientId,
    clientSecret,
    tenantId,
    redirectUri: fixPort(dbConfig.redirectUri) || envConfig.redirectUri,
    ssoRedirectUri: fixPort(dbConfig.ssoRedirectUri) || envConfig.ssoRedirectUri,
    scopes: envConfig.scopes,
    ssoScopes: envConfig.ssoScopes,
    graphUrl: envConfig.graphUrl,
    get authUrl() {
      return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0`;
    },
    get isConfigured() {
      return !!(clientId && clientSecret);
    },
    ssoEnabled: dbConfig.ssoEnabled ?? false,
    decryptFailed: false,
  };
}

// Export both: static for backward compat, async for new code
module.exports = envConfig;
module.exports.getTeamsConfig = getTeamsConfig;
