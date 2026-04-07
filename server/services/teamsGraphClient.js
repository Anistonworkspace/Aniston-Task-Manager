/**
 * Microsoft Graph API Client for Teams Chat Notifications
 *
 * Uses the client credentials flow (app-level permissions) to send
 * Adaptive Cards directly into users' Teams 1:1 chats.
 *
 * Required Azure AD Application Permissions (with admin consent):
 *   - Chat.Create          — create 1:1 chats with users
 *   - ChatMessage.Send     — send messages in chats
 *   - User.Read.All        — resolve user emails to Azure AD IDs
 *
 * Azure AD Setup:
 *   1. Go to Azure Portal → App Registrations → find the existing SSO app.
 *   2. Under API Permissions, add the above Application permissions.
 *   3. Click "Grant admin consent" for the tenant.
 *   4. Under Certificates & Secrets, create/use a client secret.
 *   5. Set env vars: TEAMS_CLIENT_ID, TEAMS_CLIENT_SECRET, TEAMS_TENANT_ID.
 */

const axios = require('axios');
const { getTeamsConfig } = require('../config/teams');
const logger = require('../utils/logger');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// In-memory token cache (single app token, refreshed on expiry)
let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Get an application-level access token using the OAuth 2.0 client credentials flow.
 * Caches the token in memory until it expires.
 */
async function getAppToken() {
  const now = Date.now();
  if (cachedToken && tokenExpiresAt > now + 60000) {
    return cachedToken;
  }

  const config = await getTeamsConfig();
  if (!config.isConfigured) {
    throw new Error('Teams integration is not configured. Set TEAMS_CLIENT_ID and TEAMS_CLIENT_SECRET.');
  }

  const tokenUrl = `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`;

  const params = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const response = await axios.post(tokenUrl, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000,
  });

  cachedToken = response.data.access_token;
  tokenExpiresAt = now + (response.data.expires_in * 1000);
  return cachedToken;
}

/**
 * Make an authenticated request to Microsoft Graph API.
 */
async function graphRequest(method, path, data = null) {
  const token = await getAppToken();
  const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;

  const config = {
    method,
    url,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  };

  if (data) config.data = data;

  return axios(config);
}

/**
 * Resolve a user's email address to their Microsoft/Azure AD user ID.
 * Returns null if the user is not found (e.g., left the org, no Teams license).
 */
async function getUserTeamsId(email) {
  try {
    const response = await graphRequest('GET', `/users/${encodeURIComponent(email)}`);
    return response.data.id;
  } catch (err) {
    if (err.response?.status === 404) {
      logger.warn(`[TeamsGraph] User not found in Azure AD: ${email}`);
      return null;
    }
    throw err;
  }
}

/**
 * Create (or retrieve) a 1:1 chat between the app/bot and a user,
 * then send an Adaptive Card message into that chat.
 *
 * @param {string} userTeamsId - The user's Azure AD object ID
 * @param {object} adaptiveCard - The Adaptive Card JSON payload
 * @returns {object} The sent message data from Graph API
 */
async function sendChatMessage(userTeamsId, adaptiveCard) {
  // Step 1: Create a 1:1 chat (idempotent — returns existing chat if one exists)
  const chatResponse = await graphRequest('POST', '/chats', {
    chatType: 'oneOnOne',
    members: [
      {
        '@odata.type': '#microsoft.graph.aadUserConversationMember',
        roles: ['owner'],
        'user@odata.bind': `${GRAPH_BASE}/users('${userTeamsId}')`,
      },
    ],
  });

  const chatId = chatResponse.data.id;

  // Step 2: Send the Adaptive Card as a message in the chat
  const messageResponse = await graphRequest('POST', `/chats/${chatId}/messages`, {
    body: {
      contentType: 'html',
      content: '<attachment id="adaptiveCard"></attachment>',
    },
    attachments: [
      {
        id: 'adaptiveCard',
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: JSON.stringify(adaptiveCard),
      },
    ],
  });

  return messageResponse.data;
}

/**
 * Check if the Teams Graph API integration is properly configured and can authenticate.
 * Returns { configured, authenticated, error? }
 */
async function checkConnection() {
  try {
    const config = await getTeamsConfig();
    if (!config.isConfigured) {
      return { configured: false, authenticated: false };
    }

    // Try to get an app token to verify credentials work
    await getAppToken();
    return { configured: true, authenticated: true };
  } catch (err) {
    return {
      configured: true,
      authenticated: false,
      error: err.message,
    };
  }
}

/**
 * Invalidate the cached token (useful if permissions change).
 */
function clearTokenCache() {
  cachedToken = null;
  tokenExpiresAt = 0;
}

module.exports = {
  getAppToken,
  getUserTeamsId,
  sendChatMessage,
  checkConnection,
  clearTokenCache,
};
