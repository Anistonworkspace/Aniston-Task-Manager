/**
 * Microsoft Graph API Client for Teams Chat Notifications
 *
 * Hybrid approach:
 *   1. App-level token (client credentials) — creates 1:1 chats, resolves users
 *   2. Delegated token (from a Teams-connected admin/manager) — sends messages
 *
 * This avoids needing the ChatMessage.Send application permission, which
 * requires a Teams bot registration. Instead, messages are sent on behalf of
 * a connected admin whose delegated token includes Chat.ReadWrite.
 *
 * Required Azure AD Application Permissions (with admin consent):
 *   - Chat.Create          — create 1:1 chats between users
 *   - User.Read.All        — resolve user emails to Azure AD IDs
 *
 * The delegated token is obtained from a Teams-connected admin's stored
 * OAuth credentials (teamsAccessToken / teamsRefreshToken in the users table).
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
 * Make an authenticated request to Microsoft Graph API using the app token.
 */
async function graphRequest(method, path, data = null) {
  const token = await getAppToken();
  return graphRequestWithToken(method, path, data, token);
}

/**
 * Make an authenticated request to Microsoft Graph API using a specific token.
 */
async function graphRequestWithToken(method, path, data, token) {
  const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;

  const reqConfig = {
    method,
    url,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  };

  if (data) reqConfig.data = data;

  return axios(reqConfig);
}

/**
 * Get a valid delegated access token from a Teams-connected admin/manager.
 * Tries to find any admin or manager with a valid (or refreshable) Teams token.
 * Returns { token, senderTeamsId } or null if no connected sender is available.
 */
async function getDelegatedSenderToken() {
  const { User } = require('../models');
  const { Op } = require('sequelize');
  const config = await getTeamsConfig();

  // Find admins/managers with Teams tokens, preferring admins first
  const candidates = await User.findAll({
    where: {
      teamsAccessToken: { [Op.ne]: null },
      teamsUserId: { [Op.ne]: null },
      isActive: true,
      role: { [Op.in]: ['admin', 'manager'] },
    },
    attributes: ['id', 'teamsUserId', 'teamsAccessToken', 'teamsRefreshToken', 'teamsTokenExpiry', 'role'],
    order: [['role', 'ASC']], // admin sorts before manager
    limit: 5,
  });

  for (const user of candidates) {
    let token = user.teamsAccessToken;

    // Check if token is expired (with 5 min buffer)
    if (user.teamsTokenExpiry && new Date(user.teamsTokenExpiry) < new Date(Date.now() + 5 * 60 * 1000)) {
      if (!user.teamsRefreshToken) continue;

      // Refresh the token
      try {
        const res = await axios.post(`${config.authUrl}/token`, new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: user.teamsRefreshToken,
        }).toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10000,
        });

        await user.update({
          teamsAccessToken: res.data.access_token,
          teamsRefreshToken: res.data.refresh_token || user.teamsRefreshToken,
          teamsTokenExpiry: new Date(Date.now() + res.data.expires_in * 1000),
        });

        token = res.data.access_token;
      } catch (err) {
        logger.warn(`[TeamsGraph] Token refresh failed for sender ${user.id}:`, err.message);
        continue;
      }
    }

    return { token, senderTeamsId: user.teamsUserId };
  }

  return null;
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
 * Send an Adaptive Card to a user's Teams chat.
 *
 * Strategy (in order of preference):
 *   1. App-level: If ChatMessage.Send application permission is granted,
 *      create a chat between a sender and the target user, then send using
 *      the app token directly.
 *   2. Delegated fallback: If app-level send fails with 403, try using a
 *      delegated token from a Teams-connected admin/manager.
 *
 * @param {string} userTeamsId - The target user's Azure AD object ID
 * @param {object} adaptiveCard - The Adaptive Card JSON payload
 * @returns {object} The sent message data from Graph API
 */
async function sendChatMessage(userTeamsId, adaptiveCard) {
  // Find a sender — use a delegated admin token if available, otherwise
  // we still need two members for the chat creation
  const sender = await getDelegatedSenderToken();

  // Determine the sender's Teams ID — we need a second user for the 1:1 chat
  let senderTeamsId;
  if (sender) {
    senderTeamsId = sender.senderTeamsId;
  } else {
    // Fall back to finding any other user in the org to pair with
    const { User } = require('../models');
    const { Op } = require('sequelize');
    const otherUser = await User.findOne({
      where: {
        teamsUserId: { [Op.ne]: null, [Op.ne]: userTeamsId },
        isActive: true,
      },
      attributes: ['teamsUserId'],
    });
    if (!otherUser) {
      throw new Error('No sender available for Teams chat. At least one admin must connect Teams.');
    }
    senderTeamsId = otherUser.teamsUserId;
  }

  // Step 1: Create a 1:1 chat between sender and target user (app token)
  const chatResponse = await graphRequest('POST', '/chats', {
    chatType: 'oneOnOne',
    members: [
      {
        '@odata.type': '#microsoft.graph.aadUserConversationMember',
        roles: ['owner'],
        'user@odata.bind': `${GRAPH_BASE}/users('${senderTeamsId}')`,
      },
      {
        '@odata.type': '#microsoft.graph.aadUserConversationMember',
        roles: ['owner'],
        'user@odata.bind': `${GRAPH_BASE}/users('${userTeamsId}')`,
      },
    ],
  });

  const chatId = chatResponse.data.id;

  // Step 2: Try sending with app token first (requires ChatMessage.Send permission)
  try {
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
  } catch (appErr) {
    // If app-level send fails with 403, try delegated token
    if (appErr.response?.status === 403 && sender) {
      logger.info('[TeamsGraph] App-level ChatMessage.Send not available, using delegated token fallback');
      const messageResponse = await graphRequestWithToken('POST', `/chats/${chatId}/messages`, {
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
      }, sender.token);
      return messageResponse.data;
    }
    throw appErr;
  }
}

/**
 * Check if the Teams Graph API integration is properly configured and can authenticate.
 * Returns { configured, authenticated, hasSender, error? }
 */
async function checkConnection() {
  try {
    const config = await getTeamsConfig();
    if (!config.isConfigured) {
      return { configured: false, authenticated: false, hasSender: false };
    }

    // Try to get an app token to verify credentials work
    await getAppToken();

    // Check if we have a delegated sender available
    const sender = await getDelegatedSenderToken();

    return { configured: true, authenticated: true, hasSender: !!sender };
  } catch (err) {
    return {
      configured: true,
      authenticated: false,
      hasSender: false,
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
