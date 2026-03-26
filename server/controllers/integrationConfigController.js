const axios = require('axios');
const { IntegrationConfig } = require('../models');
const { encrypt, decrypt, maskSecret } = require('../utils/encryption');

/**
 * GET /api/integrations/config/:provider
 * Get integration config (admin only). Client secret is masked.
 */
const getConfig = async (req, res) => {
  try {
    const { provider } = req.params;
    let config = await IntegrationConfig.findOne({ where: { provider } });

    // Auto-migrate from .env if no DB config exists but env vars are set
    if (!config && provider === 'microsoft' && process.env.TEAMS_CLIENT_ID && process.env.TEAMS_CLIENT_SECRET) {
      try {
        config = await IntegrationConfig.create({
          provider,
          clientId: encrypt(process.env.TEAMS_CLIENT_ID),
          clientSecret: encrypt(process.env.TEAMS_CLIENT_SECRET),
          tenantId: process.env.TEAMS_TENANT_ID || 'common',
          redirectUri: process.env.TEAMS_REDIRECT_URI || 'http://localhost:5000/api/teams/callback',
          ssoRedirectUri: process.env.TEAMS_SSO_REDIRECT_URI || 'http://localhost:5000/api/auth/microsoft/callback',
          ssoEnabled: false,
          isActive: true,
        });
        console.log('[IntegrationConfig] Auto-migrated Microsoft config from .env to database');
      } catch (migrateErr) {
        console.error('[IntegrationConfig] Auto-migrate failed:', migrateErr.message);
      }
    }

    if (!config) {
      return res.json({
        success: true,
        data: {
          provider,
          isConfigured: false,
          clientId: '',
          clientSecret: '',
          tenantId: '',
          redirectUri: '',
          ssoRedirectUri: '',
          ssoEnabled: false,
          hasSecret: false,
        },
      });
    }

    const decryptedClientId = decrypt(config.clientId);
    const decryptedSecret = decrypt(config.clientSecret);

    res.json({
      success: true,
      data: {
        provider: config.provider,
        isConfigured: !!(decryptedClientId && decryptedSecret),
        clientId: decryptedClientId || '',
        clientSecret: maskSecret(decryptedSecret),
        tenantId: config.tenantId || '',
        redirectUri: config.redirectUri || '',
        ssoRedirectUri: config.ssoRedirectUri || '',
        ssoEnabled: config.ssoEnabled,
        hasSecret: !!decryptedSecret,
        updatedAt: config.updatedAt,
      },
    });
  } catch (error) {
    console.error('[IntegrationConfig] getConfig error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch integration config.' });
  }
};

/**
 * POST /api/integrations/config/:provider
 * Create or update integration config (admin only).
 */
const saveConfig = async (req, res) => {
  try {
    const { provider } = req.params;
    const { clientId, clientSecret, tenantId, redirectUri, ssoRedirectUri, ssoEnabled } = req.body;

    if (!clientId || !tenantId) {
      return res.status(400).json({
        success: false,
        message: 'Client ID and Tenant ID are required.',
      });
    }

    let config = await IntegrationConfig.findOne({ where: { provider } });
    const wasSsoEnabled = config?.ssoEnabled ?? false;

    const encryptedClientId = encrypt(clientId);

    // Only update secret if a new (unmasked) value is provided
    let encryptedSecret;
    if (clientSecret && !clientSecret.startsWith('••••')) {
      encryptedSecret = encrypt(clientSecret);
    } else if (config) {
      encryptedSecret = config.clientSecret; // Keep existing
    } else {
      return res.status(400).json({
        success: false,
        message: 'Client Secret is required for initial setup.',
      });
    }

    const data = {
      provider,
      clientId: encryptedClientId,
      clientSecret: encryptedSecret,
      tenantId,
      redirectUri: redirectUri || `${req.protocol}://${req.get('host')}/api/teams/callback`,
      ssoRedirectUri: ssoRedirectUri || `${req.protocol}://${req.get('host')}/api/auth/microsoft/callback`,
      ssoEnabled: ssoEnabled ?? false,
      configuredBy: req.user.id,
    };

    if (config) {
      await config.update(data);
    } else {
      config = await IntegrationConfig.create(data);
    }

    // Auto-sync M365 users when SSO is first enabled
    let autoSyncTriggered = false;
    if (ssoEnabled && !wasSsoEnabled && provider === 'microsoft') {
      try {
        const { syncUsersFromM365 } = require('../services/teamsUserSync');
        // Fire-and-forget — don't block the response
        syncUsersFromM365().then(result => {
          console.log(`[IntegrationConfig] Auto-sync complete: ${result.created.length} created, ${result.existing.length} existing`);
        }).catch(err => {
          console.error('[IntegrationConfig] Auto-sync failed:', err.message);
        });
        autoSyncTriggered = true;
      } catch (err) {
        console.error('[IntegrationConfig] Could not trigger auto-sync:', err.message);
      }
    }

    res.json({
      success: true,
      message: autoSyncTriggered
        ? 'Configuration saved. M365 user sync has been triggered automatically.'
        : 'Integration configuration saved successfully.',
      autoSyncTriggered,
      data: {
        provider: config.provider,
        isConfigured: true,
        clientId,
        clientSecret: maskSecret(clientSecret && !clientSecret.startsWith('••••') ? clientSecret : decrypt(config.clientSecret)),
        tenantId: config.tenantId,
        redirectUri: config.redirectUri,
        ssoRedirectUri: config.ssoRedirectUri,
        ssoEnabled: config.ssoEnabled,
        hasSecret: true,
      },
    });
  } catch (error) {
    console.error('[IntegrationConfig] saveConfig error:', error);
    res.status(500).json({ success: false, message: 'Failed to save integration config.' });
  }
};

/**
 * DELETE /api/integrations/config/:provider
 * Remove integration config (admin only).
 */
const deleteConfig = async (req, res) => {
  try {
    const { provider } = req.params;
    const deleted = await IntegrationConfig.destroy({ where: { provider } });

    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Configuration not found.' });
    }

    res.json({ success: true, message: 'Integration configuration removed.' });
  } catch (error) {
    console.error('[IntegrationConfig] deleteConfig error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete integration config.' });
  }
};

/**
 * GET /api/integrations/config/:provider/test
 * Test connection by attempting to get an app token from Microsoft (admin only).
 */
const testConnection = async (req, res) => {
  try {
    const { provider } = req.params;
    const config = await IntegrationConfig.findOne({ where: { provider } });

    if (!config) {
      return res.status(404).json({ success: false, message: 'No configuration found. Save configuration first.' });
    }

    const clientId = decrypt(config.clientId);
    const clientSecret = decrypt(config.clientSecret);
    const tenantId = config.tenantId;

    if (!clientId || !clientSecret || !tenantId) {
      return res.status(400).json({ success: false, message: 'Incomplete configuration.' });
    }

    // Try to get an app token from Microsoft
    const tokenRes = await axios.post(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
        scope: 'https://graph.microsoft.com/.default',
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
    );

    if (tokenRes.data.access_token) {
      res.json({ success: true, message: 'Connection successful! Azure AD credentials are valid.' });
    } else {
      res.status(400).json({ success: false, message: 'Could not obtain access token.' });
    }
  } catch (error) {
    const errMsg = error.response?.data?.error_description || error.response?.data?.error || error.message;
    console.error('[IntegrationConfig] testConnection error:', errMsg);
    res.status(400).json({
      success: false,
      message: `Connection failed: ${errMsg}`,
    });
  }
};

module.exports = { getConfig, saveConfig, deleteConfig, testConnection };
