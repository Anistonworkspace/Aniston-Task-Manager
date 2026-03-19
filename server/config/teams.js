module.exports = {
  clientId: process.env.TEAMS_CLIENT_ID || '',
  clientSecret: process.env.TEAMS_CLIENT_SECRET || '',
  tenantId: process.env.TEAMS_TENANT_ID || 'common',
  redirectUri: process.env.TEAMS_REDIRECT_URI || 'http://localhost:5000/api/teams/callback',
  scopes: ['Calendars.ReadWrite', 'User.Read', 'offline_access'],
  graphUrl: 'https://graph.microsoft.com/v1.0',
  get authUrl() {
    return `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0`;
  },
  get isConfigured() {
    return !!(this.clientId && this.clientSecret);
  },
};
