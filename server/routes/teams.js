const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { authenticate } = require('../middleware/auth');
const { User } = require('../models');
const { getTeamsConfig } = require('../config/teams');

const router = express.Router();

// ── OAuth state CSRF protection ─────────────────────────────
// Uses HMAC to sign the state parameter so the callback can verify it wasn't tampered with.
const STATE_SECRET = process.env.JWT_SECRET || 'teams-oauth-state-fallback';
function signState(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64');
  const hmac = crypto.createHmac('sha256', STATE_SECRET).update(data).digest('hex');
  return `${data}.${hmac}`;
}
function verifyState(state) {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [data, hmac] = parts;
  const expected = crypto.createHmac('sha256', STATE_SECRET).update(data).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(expected, 'hex'))) return null;
  try {
    return JSON.parse(Buffer.from(data, 'base64').toString());
  } catch {
    return null;
  }
}

/**
 * GET /api/teams/auth
 * Start OAuth flow — redirect to Microsoft login.
 */
router.get('/auth', authenticate, async (req, res) => {
  const teamsConfig = await getTeamsConfig();
  if (!teamsConfig.isConfigured) {
    return res.status(503).json({ success: false, message: 'Teams integration is not configured. Set it up in Integrations page.' });
  }

  const state = signState({ userId: req.user.id, ts: Date.now() });
  const authUrl = `${teamsConfig.authUrl}/authorize?` + new URLSearchParams({
    client_id: teamsConfig.clientId,
    response_type: 'code',
    redirect_uri: teamsConfig.redirectUri,
    scope: teamsConfig.scopes.join(' '),
    state,
    response_mode: 'query',
  }).toString();

  res.json({ success: true, data: { authUrl } });
});

/**
 * GET /api/teams/callback
 * OAuth callback — exchange code for tokens.
 * SECURITY: State parameter is HMAC-signed to prevent CSRF/token-swap attacks.
 */
router.get('/callback', async (req, res) => {
  const { code, state, error: authError } = req.query;

  const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';

  if (authError) {
    return res.redirect(`${clientUrl}/integrations?teams=error&msg=${encodeURIComponent(authError)}`);
  }

  if (!code || !state) {
    return res.redirect(`${clientUrl}/integrations?teams=error&msg=missing_params`);
  }

  // Verify HMAC-signed state to prevent CSRF
  const stateData = verifyState(state);
  if (!stateData || !stateData.userId) {
    console.warn(`[Teams] OAuth callback rejected: invalid or tampered state from ${req.ip}`);
    return res.redirect(`${clientUrl}/integrations?teams=error&msg=invalid_state`);
  }

  // Reject state tokens older than 10 minutes
  if (stateData.ts && Date.now() - stateData.ts > 10 * 60 * 1000) {
    console.warn(`[Teams] OAuth callback rejected: expired state (age=${Date.now() - stateData.ts}ms)`);
    return res.redirect(`${clientUrl}/integrations?teams=error&msg=state_expired`);
  }

  try {
    const { userId } = stateData;

    const teamsConfig = await getTeamsConfig();

    // Exchange code for tokens
    const tokenRes = await axios.post(`${teamsConfig.authUrl}/token`, new URLSearchParams({
      client_id: teamsConfig.clientId,
      client_secret: teamsConfig.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: teamsConfig.redirectUri,
      scope: teamsConfig.scopes.join(' '),
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const { access_token, refresh_token, expires_in } = tokenRes.data;

    // Get Microsoft user profile
    let teamsUserId = null;
    try {
      const profileRes = await axios.get('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      teamsUserId = profileRes.data.id;
    } catch {}

    // Save tokens to user
    await User.update({
      teamsAccessToken: access_token,
      teamsRefreshToken: refresh_token,
      teamsTokenExpiry: new Date(Date.now() + expires_in * 1000),
      teamsUserId,
    }, { where: { id: userId } });

    // Auto-sync M365 users on first connect (fire-and-forget)
    const connectingUser = await User.findByPk(userId, { attributes: ['role'] });
    if (['admin', 'manager'].includes(connectingUser?.role)) {
      const { syncUsersFromM365 } = require('../services/teamsUserSync');
      syncUsersFromM365().then(r => {
        console.log(`[Teams] Auto-sync on connect: ${r.created.length} created, ${r.existing.length} existing`);
      }).catch(e => {
        console.error('[Teams] Auto-sync on connect failed:', e.message);
      });
    }

    res.redirect(`${clientUrl}/integrations?teams=success`);
  } catch (err) {
    console.error('[Teams] OAuth callback error:', err.response?.data || err.message);
    res.redirect(`${clientUrl}/integrations?teams=error&msg=token_exchange_failed`);
  }
});

/**
 * GET /api/teams/status
 * Check if current user has Teams connected.
 */
router.get('/status', authenticate, async (req, res) => {
  const teamsConfig = await getTeamsConfig();
  const user = await User.findByPk(req.user.id, {
    attributes: ['teamsUserId', 'teamsAccessToken', 'teamsTokenExpiry'],
  });

  const connected = !!(user?.teamsAccessToken);
  const expired = user?.teamsTokenExpiry && new Date(user.teamsTokenExpiry) < new Date();
  const configValid = teamsConfig.isConfigured && !!teamsConfig.tenantId;

  // Count M365-synced users for admin dashboard
  let usersSynced = 0;
  try {
    usersSynced = await User.count({ where: { authProvider: 'microsoft' } });
  } catch (_) { /* ignore */ }

  res.json({
    success: true,
    data: {
      configured: teamsConfig.isConfigured,
      configValid,
      connected,
      expired: connected && expired,
      teamsUserId: user?.teamsUserId || null,
      ssoEnabled: teamsConfig.ssoEnabled ?? false,
      usersSynced,
    },
  });
});

/**
 * POST /api/teams/disconnect
 * Disconnect Teams integration for current user.
 */
router.post('/disconnect', authenticate, async (req, res) => {
  await User.update({
    teamsAccessToken: null,
    teamsRefreshToken: null,
    teamsTokenExpiry: null,
    teamsUserId: null,
  }, { where: { id: req.user.id } });

  res.json({ success: true, message: 'Teams disconnected successfully.' });
});

/**
 * POST /api/teams/sync-task/:taskId
 * Manually sync a task to Teams calendar.
 */
router.post('/sync-task/:taskId', authenticate, async (req, res) => {
  const calendarService = require('../services/calendarService');
  try {
    const eventId = await calendarService.syncToTeamsCalendar(req.params.taskId, req.user.id);
    if (eventId) {
      res.json({ success: true, message: 'Task synced to Teams calendar.', data: { eventId } });
    } else {
      res.status(400).json({ success: false, message: 'Could not sync. Ensure Teams is connected and task has scheduled times.' });
    }
  } catch (err) {
    console.error('[Teams] Sync error:', err);
    res.status(500).json({ success: false, message: 'Failed to sync task.' });
  }
});

/**
 * POST /api/teams/sync-users
 * Sync all M365 tenant users into local database (admin only).
 */
router.post('/sync-users', authenticate, async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Admin access required.' });
  }

  try {
    const { syncUsersFromM365 } = require('../services/teamsUserSync');
    const results = await syncUsersFromM365();
    res.json({
      success: true,
      message: `Sync complete: ${results.created.length} new users, ${results.existing.length} existing, ${results.failed.length} failed.`,
      data: results,
    });
  } catch (err) {
    console.error('[Teams] User sync error:', err.response?.data || err.message);
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ success: false, message: `Sync failed: ${msg}` });
  }
});

/**
 * GET /api/teams/preview-users
 * Preview M365 users without creating them (admin only).
 */
router.get('/preview-users', authenticate, async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Admin access required.' });
  }

  try {
    const { fetchM365Users } = require('../services/teamsUserSync');
    const users = await fetchM365Users();
    res.json({
      success: true,
      data: {
        users: users.map(u => ({
          teamsId: u.id,
          name: u.displayName,
          email: u.mail,
          department: u.department,
          jobTitle: u.jobTitle,
        })),
        total: users.length,
      },
    });
  } catch (err) {
    console.error('[Teams] Preview error:', err.response?.data || err.message);
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ success: false, message: `Failed to fetch M365 users: ${msg}` });
  }
});

/**
 * POST /api/teams/sync-status
 * Sync active/disabled status from M365 for all Microsoft-linked users (admin only).
 */
router.post('/sync-status', authenticate, async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Admin access required.' });
  }

  try {
    const { syncUserActiveStatus } = require('../services/teamsUserSync');
    const results = await syncUserActiveStatus();
    res.json({
      success: true,
      message: `Status sync complete: ${results.activated.length} activated, ${results.deactivated.length} deactivated, ${results.unchanged} unchanged.`,
      data: results,
    });
  } catch (err) {
    console.error('[Teams] Status sync error:', err.response?.data || err.message);
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ success: false, message: `Status sync failed: ${msg}` });
  }
});

/**
 * GET /api/teams/notification-stats
 * Get Teams notification delivery stats for admin dashboard.
 */
router.get('/notification-stats', authenticate, async (req, res) => {
  if (!['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Admin access required.' });
  }

  try {
    const { getNotificationStats } = require('../services/teamsNotificationService');
    const stats = await getNotificationStats();
    res.json({ success: true, data: stats });
  } catch (err) {
    console.error('[Teams] Notification stats error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch notification stats.' });
  }
});

module.exports = router;
