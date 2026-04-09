/**
 * Microsoft Graph API Client for Teams Chat Notifications
 *
 * Uses application permissions (client credentials flow) for all operations.
 * No admin needs to "connect" Teams — the app acts on its own behalf.
 *
 * Required Azure AD Application Permissions (with admin consent):
 *   - Chat.Create          — create 1:1 chats between users
 *   - ChatMessage.Send     — send messages to chats
 *   - User.Read.All        — resolve user emails to Azure AD IDs
 *
 * Azure AD Setup:
 *   1. Go to Azure Portal → App Registrations → find the existing app.
 *   2. Under API Permissions, add the three Application permissions above.
 *   3. Click "Grant admin consent for [tenant]".
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
 * Find a sender user's Azure AD ID for creating 1:1 chats.
 * A 1:1 chat requires two members — the sender is the "other side" of the chat
 * with the target user. Prefers admins, then managers.
 *
 * Resolution order:
 *   1. Any user in the DB who already has a stored teamsUserId
 *   2. Resolve an admin/manager's email via Graph API (User.Read.All) and cache it
 *
 * @param {string} excludeTeamsId - Target user's Teams ID (must not be the same as sender)
 * @returns {string} The sender's Azure AD user ID
 */
async function findSenderTeamsId(excludeTeamsId) {
  const { User } = require('../models');
  const { Op } = require('sequelize');

  // 1. Check DB for any user with a stored teamsUserId (fast path)
  const storedUser = await User.findOne({
    where: {
      teamsUserId: { [Op.not]: null, [Op.ne]: excludeTeamsId },
      isActive: true,
    },
    attributes: ['teamsUserId'],
    order: [['role', 'ASC']], // admin < manager < member — prefer admins
  });

  if (storedUser) return storedUser.teamsUserId;

  // 2. No stored ID — resolve an admin/manager's email via Graph API
  const adminUser = await User.findOne({
    where: {
      role: { [Op.in]: ['admin', 'manager'] },
      isActive: true,
      email: { [Op.not]: null },
    },
    attributes: ['id', 'email'],
    order: [['role', 'ASC']],
  });

  if (!adminUser) {
    throw new Error('No active admin/manager user found to use as chat sender.');
  }

  const resolvedId = await getUserTeamsId(adminUser.email);
  if (!resolvedId) {
    throw new Error(`Could not resolve Teams ID for ${adminUser.email}. Ensure they exist in Azure AD with a Teams license.`);
  }

  // Cache the resolved ID so future sends don't need a Graph API call
  await User.update({ teamsUserId: resolvedId }, { where: { id: adminUser.id } });
  logger.info(`[TeamsGraph] Resolved and cached Teams ID for sender ${adminUser.email}`);

  return resolvedId;
}

/**
 * Send an Adaptive Card to a user's Teams chat.
 *
 * Uses app-level permissions only (Chat.Create + ChatMessage.Send).
 * Creates a 1:1 chat between a sender (admin/manager) and the target user,
 * then sends the Adaptive Card message to that chat.
 *
 * @param {string} userTeamsId - The target user's Azure AD object ID
 * @param {object} adaptiveCard - The Adaptive Card JSON payload
 * @returns {object} The sent message data from Graph API
 */
async function sendChatMessage(userTeamsId, adaptiveCard) {
  // Find a sender for the 1:1 chat (resolves via DB or Graph API)
  const senderTeamsId = await findSenderTeamsId(userTeamsId);

  // Step 1: Create a 1:1 chat between sender and target user
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

  // Step 2: Send the Adaptive Card message (ChatMessage.Send app permission)
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
