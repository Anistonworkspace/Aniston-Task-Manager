const express = require('express');
const axios = require('axios');
const { authenticate } = require('../middleware/auth');
const { User } = require('../models');
const teamsConfig = require('../config/teams');

const router = express.Router();

/**
 * GET /api/teams/auth
 * Start OAuth flow — redirect to Microsoft login.
 */
router.get('/auth', authenticate, (req, res) => {
  if (!teamsConfig.isConfigured) {
    return res.status(503).json({ success: false, message: 'Teams integration is not configured. Set TEAMS_CLIENT_ID and TEAMS_CLIENT_SECRET.' });
  }

  const state = Buffer.from(JSON.stringify({ userId: req.user.id })).toString('base64');
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
 */
router.get('/callback', async (req, res) => {
  const { code, state, error: authError } = req.query;

  if (authError) {
    return res.redirect(`${process.env.CLIENT_URL || 'http://localhost:3000'}/profile?teams=error&msg=${encodeURIComponent(authError)}`);
  }

  if (!code || !state) {
    return res.redirect(`${process.env.CLIENT_URL || 'http://localhost:3000'}/profile?teams=error&msg=missing_params`);
  }

  try {
    const stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    const { userId } = stateData;

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

    res.redirect(`${process.env.CLIENT_URL || 'http://localhost:3000'}/profile?teams=success`);
  } catch (err) {
    console.error('[Teams] OAuth callback error:', err.response?.data || err.message);
    res.redirect(`${process.env.CLIENT_URL || 'http://localhost:3000'}/profile?teams=error&msg=token_exchange_failed`);
  }
});

/**
 * GET /api/teams/status
 * Check if current user has Teams connected.
 */
router.get('/status', authenticate, async (req, res) => {
  const user = await User.findByPk(req.user.id, {
    attributes: ['teamsUserId', 'teamsAccessToken', 'teamsTokenExpiry'],
  });

  const connected = !!(user?.teamsAccessToken);
  const expired = user?.teamsTokenExpiry && new Date(user.teamsTokenExpiry) < new Date();

  res.json({
    success: true,
    data: {
      configured: teamsConfig.isConfigured,
      connected,
      expired: connected && expired,
      teamsUserId: user?.teamsUserId || null,
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
  if (req.user.role !== 'admin') {
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
  if (req.user.role !== 'admin') {
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

module.exports = router;
