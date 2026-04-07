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
  try {
    // Lazy-require to avoid circular dependency at startup
    const { IntegrationConfig } = require('../models');
    const dbConfig = await IntegrationConfig.findOne({ where: { provider: 'microsoft' } });

    if (dbConfig && dbConfig.clientId && dbConfig.clientSecret) {
      const clientId = decrypt(dbConfig.clientId);
      const clientSecret = decrypt(dbConfig.clientSecret);
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
      };
    }
  } catch (err) {
    // DB not ready yet (startup) or encryption key missing — fall back to env
    console.warn('[TeamsConfig] DB config unavailable, falling back to env:', err.message);
  }

  return envConfig;
}

// Export both: static for backward compat, async for new code
module.exports = envConfig;
module.exports.getTeamsConfig = getTeamsConfig;
