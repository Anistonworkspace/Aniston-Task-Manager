const { AIConfig, AIProvider, User } = require('../models');
const { encrypt, decrypt, maskSecret } = require('../utils/encryption');
const aiService = require('../services/aiService');
const { logActivity } = require('../services/activityService');
const { buildAIContext } = require('../services/aiContextService');

// ────────────────────────────────────────────────────────────
// Legacy single-config endpoints (kept for backward compat)
// ────────────────────────────────────────────────────────────

/**
 * GET /api/ai/config
 * Return the active/default AI config (API key masked).
 * Now checks AIProvider first, falls back to legacy AIConfig.
 */
async function getConfig(req, res) {
  try {
    // Check new AIProvider table first
    let provider = await AIProvider.findOne({
      where: { isActive: true, isDefault: true },
      include: [{ model: User, as: 'configurer', attributes: ['id', 'name', 'email'] }],
    });
    if (!provider) {
      provider = await AIProvider.findOne({
        where: { isActive: true },
        include: [{ model: User, as: 'configurer', attributes: ['id', 'name', 'email'] }],
        order: [['createdAt', 'ASC']],
      });
    }

    if (provider) {
      let maskedKey = '';
      try {
        maskedKey = maskSecret(decrypt(provider.apiKey));
      } catch { maskedKey = '(encrypted)'; }

      return res.json({
        success: true,
        data: {
          id: provider.id,
          provider: provider.provider,
          apiKey: maskedKey,
          hasKey: true,
          model: provider.model,
          baseUrl: provider.baseUrl,
          isActive: provider.isActive,
          lastTestedAt: provider.lastTestedAt,
          configuredBy: provider.configuredBy,
          configurer: provider.configurer,
          createdAt: provider.createdAt,
          updatedAt: provider.updatedAt,
        },
      });
    }

    // Fallback to legacy AIConfig
    const config = await AIConfig.findOne({
      where: { isActive: true },
      include: [{ model: User, as: 'configurer', attributes: ['id', 'name', 'email'] }],
    });

    if (!config) {
      return res.json({ success: true, data: null });
    }

    let maskedKey = '';
    try {
      maskedKey = maskSecret(decrypt(config.apiKey));
    } catch { maskedKey = '(encrypted)'; }

    res.json({
      success: true,
      data: {
        id: config.id,
        provider: config.provider,
        apiKey: maskedKey,
        hasKey: true,
        model: config.model,
        baseUrl: config.baseUrl,
        isActive: config.isActive,
        lastTestedAt: config.lastTestedAt,
        configuredBy: config.configuredBy,
        configurer: config.configurer,
        createdAt: config.createdAt,
        updatedAt: config.updatedAt,
      },
    });
  } catch (error) {
    console.error('[AIController] getConfig error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch AI configuration.' });
  }
}

/**
 * POST /api/ai/config
 * Legacy save — creates in AIProvider table now.
 */
async function saveConfig(req, res) {
  try {
    const { provider, apiKey, model, baseUrl } = req.body;

    if (!provider) {
      return res.status(400).json({ success: false, message: 'Provider is required.' });
    }
    if (!apiKey) {
      return res.status(400).json({ success: false, message: 'API key is required.' });
    }

    const validProviders = ['deepseek', 'openai', 'anthropic', 'claude', 'gemini', 'custom'];
    if (!validProviders.includes(provider)) {
      return res.status(400).json({ success: false, message: `Invalid provider. Use: ${validProviders.join(', ')}` });
    }

    const encryptedKey = encrypt(apiKey);

    // Deactivate other default providers, set this as default
    await AIProvider.update({ isDefault: false }, { where: { isDefault: true } });

    const config = await AIProvider.create({
      provider,
      displayName: provider.charAt(0).toUpperCase() + provider.slice(1),
      apiKey: encryptedKey,
      model: model || '',
      baseUrl: baseUrl || '',
      isActive: true,
      isDefault: true,
      configuredBy: req.user.id,
    });

    res.json({
      success: true,
      message: 'AI configuration saved successfully.',
      data: {
        id: config.id,
        provider: config.provider,
        apiKey: maskSecret(apiKey),
        hasKey: true,
        model: config.model,
        baseUrl: config.baseUrl,
        isActive: config.isActive,
        lastTestedAt: config.lastTestedAt,
        configuredBy: config.configuredBy,
      },
    });
  } catch (error) {
    console.error('[AIController] saveConfig error:', error);
    res.status(500).json({ success: false, message: 'Failed to save AI configuration.' });
  }
}

/**
 * POST /api/ai/test
 * Test connection to a provider.
 */
async function testConfig(req, res) {
  try {
    const { provider, apiKey, model, baseUrl, providerId } = req.body;

    // If credentials provided, test those directly
    if (provider && apiKey) {
      const result = await aiService.testConnection(provider, apiKey, model, baseUrl);
      if (result.success && providerId) {
        await AIProvider.update({ lastTestedAt: new Date() }, { where: { id: providerId } });
      }
      const keySuffix = apiKey ? '...' + apiKey.slice(-4) : '(none)';
      return res.json({
        success: result.success,
        message: result.message,
        data: {
          responseTime: result.responseTime,
          diagnostics: { ...(result.diagnostics || {}), providerType: provider, model, baseUrl, keySuffix },
        },
      });
    }

    // If providerId given, test that saved provider
    if (providerId) {
      const config = await aiService.getProviderById(providerId);
      if (!config) {
        return res.status(400).json({ success: false, message: 'Provider not found or inactive.' });
      }
      const result = await aiService.testConnection(config.provider, config.apiKey, config.model, config.baseUrl);
      if (result.success) {
        await AIProvider.update({ lastTestedAt: new Date() }, { where: { id: providerId } });
      }
      const keySuffix = config.apiKey ? '...' + config.apiKey.slice(-4) : '(none)';
      return res.json({
        success: result.success,
        message: result.message,
        data: {
          responseTime: result.responseTime,
          diagnostics: { ...(result.diagnostics || {}), providerType: config.provider, model: config.model, baseUrl: config.baseUrl, keySuffix },
        },
      });
    }

    // Otherwise test the default active config
    const config = await aiService.getActiveConfig();
    if (!config) {
      return res.status(400).json({ success: false, message: 'No AI configuration found. Save a config first.' });
    }

    const result = await aiService.testConnection(config.provider, config.apiKey, config.model, config.baseUrl);

    if (result.success) {
      // Try updating in AIProvider first, then AIConfig
      const updated = await AIProvider.update({ lastTestedAt: new Date() }, { where: { id: config.id } });
      if (!updated[0]) {
        await AIConfig.update({ lastTestedAt: new Date() }, { where: { id: config.id } });
      }
    }

    const keySuffix = config.apiKey ? '...' + config.apiKey.slice(-4) : '(none)';
    res.json({
      success: result.success,
      message: result.message,
      data: {
        responseTime: result.responseTime,
        diagnostics: { ...(result.diagnostics || {}), providerType: config.provider, model: config.model, baseUrl: config.baseUrl, keySuffix },
      },
    });
  } catch (error) {
    console.error('[AIController] testConfig error:', error);
    res.status(500).json({ success: false, message: 'Failed to test AI connection.' });
  }
}

/**
 * DELETE /api/ai/config
 * Remove legacy AI configurations only.
 * Does NOT touch the active AIProvider table to prevent accidental data loss.
 */
async function deleteConfig(req, res) {
  try {
    const deleted = await AIConfig.destroy({ where: {} });

    logActivity({
      action: 'ai_config_deleted',
      description: `Legacy AI configurations removed (${deleted} record(s))`,
      entityType: 'ai_config',
      userId: req.user.id,
    });

    res.json({ success: true, message: `Legacy AI configuration removed (${deleted} record(s)). Active providers are not affected.` });
  } catch (error) {
    console.error('[AIController] deleteConfig error:', error);
    res.status(500).json({ success: false, message: 'Failed to remove AI configuration.' });
  }
}

// ────────────────────────────────────────────────────────────
// Multi-Provider CRUD Endpoints
// ────────────────────────────────────────────────────────────

/**
 * GET /api/ai/providers
 * List all AI providers (keys masked).
 */
async function getProviders(req, res) {
  try {
    const providers = await AIProvider.findAll({
      include: [{ model: User, as: 'configurer', attributes: ['id', 'name', 'email'] }],
      order: [['isDefault', 'DESC'], ['createdAt', 'ASC']],
    });

    const data = providers.map(p => {
      let maskedKey = '';
      try {
        maskedKey = maskSecret(decrypt(p.apiKey));
      } catch { maskedKey = '(encrypted)'; }

      return {
        id: p.id,
        provider: p.provider,
        displayName: p.displayName,
        apiKey: maskedKey,
        hasKey: true,
        model: p.model,
        baseUrl: p.baseUrl,
        isActive: p.isActive,
        isDefault: p.isDefault,
        lastTestedAt: p.lastTestedAt,
        configuredBy: p.configuredBy,
        configurer: p.configurer,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      };
    });

    res.json({ success: true, data });
  } catch (error) {
    console.error('[AIController] getProviders error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch AI providers.' });
  }
}

/**
 * POST /api/ai/providers
 * Create a new AI provider.
 */
async function createProvider(req, res) {
  try {
    const { provider, apiKey, model, baseUrl, displayName } = req.body;

    if (!provider) {
      return res.status(400).json({ success: false, message: 'Provider type is required.' });
    }
    if (!apiKey) {
      return res.status(400).json({ success: false, message: 'API key is required.' });
    }

    const validProviders = ['deepseek', 'openai', 'anthropic', 'claude', 'gemini', 'custom'];
    if (!validProviders.includes(provider)) {
      return res.status(400).json({ success: false, message: `Invalid provider. Use: ${validProviders.join(', ')}` });
    }

    const encryptedKey = encrypt(apiKey);

    // Check if this is the first provider — make it default
    const existingCount = await AIProvider.count();
    const isDefault = existingCount === 0;

    const newProvider = await AIProvider.create({
      provider,
      displayName: displayName || provider.charAt(0).toUpperCase() + provider.slice(1),
      apiKey: encryptedKey,
      model: model || '',
      baseUrl: baseUrl || '',
      isActive: true,
      isDefault,
      configuredBy: req.user.id,
    });

    logActivity({
      action: 'ai_provider_created',
      description: `AI provider added: ${provider}`,
      entityType: 'ai_provider',
      entityId: newProvider.id,
      userId: req.user.id,
    });

    res.status(201).json({
      success: true,
      message: `${provider} provider added successfully.`,
      data: {
        id: newProvider.id,
        provider: newProvider.provider,
        displayName: newProvider.displayName,
        apiKey: maskSecret(apiKey),
        hasKey: true,
        model: newProvider.model,
        baseUrl: newProvider.baseUrl,
        isActive: newProvider.isActive,
        isDefault: newProvider.isDefault,
        lastTestedAt: newProvider.lastTestedAt,
        configuredBy: newProvider.configuredBy,
        createdAt: newProvider.createdAt,
        updatedAt: newProvider.updatedAt,
      },
    });
  } catch (error) {
    console.error('[AIController] createProvider error:', error);
    res.status(500).json({ success: false, message: 'Failed to create AI provider.' });
  }
}

/**
 * PUT /api/ai/providers/:id
 * Update an existing AI provider.
 */
async function updateProvider(req, res) {
  try {
    const { id } = req.params;
    const { provider, apiKey, model, baseUrl, displayName, isActive } = req.body;

    const existing = await AIProvider.findByPk(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'AI provider not found.' });
    }

    const updates = {};
    if (provider !== undefined) updates.provider = provider;
    if (displayName !== undefined) updates.displayName = displayName;
    if (model !== undefined) updates.model = model;
    if (baseUrl !== undefined) updates.baseUrl = baseUrl;
    if (isActive !== undefined) updates.isActive = isActive;
    if (apiKey) {
      updates.apiKey = encrypt(apiKey);
    }

    await existing.update(updates);

    let maskedKey = '';
    try {
      maskedKey = apiKey ? maskSecret(apiKey) : maskSecret(decrypt(existing.apiKey));
    } catch { maskedKey = '(encrypted)'; }

    logActivity({
      action: 'ai_provider_updated',
      description: `AI provider updated: ${existing.provider}`,
      entityType: 'ai_provider',
      entityId: existing.id,
      userId: req.user.id,
    });

    res.json({
      success: true,
      message: 'AI provider updated successfully.',
      data: {
        id: existing.id,
        provider: existing.provider,
        displayName: existing.displayName,
        apiKey: maskedKey,
        hasKey: true,
        model: existing.model,
        baseUrl: existing.baseUrl,
        isActive: existing.isActive,
        isDefault: existing.isDefault,
        lastTestedAt: existing.lastTestedAt,
        configuredBy: existing.configuredBy,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
      },
    });
  } catch (error) {
    console.error('[AIController] updateProvider error:', error);
    res.status(500).json({ success: false, message: 'Failed to update AI provider.' });
  }
}

/**
 * DELETE /api/ai/providers/:id
 * Remove a specific AI provider.
 */
async function deleteProvider(req, res) {
  try {
    const { id } = req.params;
    const existing = await AIProvider.findByPk(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'AI provider not found.' });
    }

    const wasDefault = existing.isDefault;
    const providerName = existing.provider;
    await existing.destroy();

    // If deleted provider was default, promote the next active one
    if (wasDefault) {
      const next = await AIProvider.findOne({ where: { isActive: true }, order: [['createdAt', 'ASC']] });
      if (next) {
        await next.update({ isDefault: true });
      }
    }

    logActivity({
      action: 'ai_provider_deleted',
      description: `AI provider removed: ${providerName}`,
      entityType: 'ai_provider',
      entityId: id,
      userId: req.user.id,
    });

    res.json({ success: true, message: `${providerName} provider removed.` });
  } catch (error) {
    console.error('[AIController] deleteProvider error:', error);
    res.status(500).json({ success: false, message: 'Failed to remove AI provider.' });
  }
}

/**
 * POST /api/ai/providers/:id/set-default
 * Set a provider as the default.
 */
async function setDefaultProvider(req, res) {
  try {
    const { id } = req.params;
    const provider = await AIProvider.findByPk(id);
    if (!provider) {
      return res.status(404).json({ success: false, message: 'AI provider not found.' });
    }

    // Clear all defaults, set this one
    await AIProvider.update({ isDefault: false }, { where: {} });
    await provider.update({ isDefault: true, isActive: true });

    res.json({
      success: true,
      message: `${provider.provider} set as default provider.`,
    });
  } catch (error) {
    console.error('[AIController] setDefaultProvider error:', error);
    res.status(500).json({ success: false, message: 'Failed to set default provider.' });
  }
}

/**
 * POST /api/ai/providers/:id/toggle
 * Toggle a provider's active status.
 */
async function toggleProvider(req, res) {
  try {
    const { id } = req.params;
    const provider = await AIProvider.findByPk(id);
    if (!provider) {
      return res.status(404).json({ success: false, message: 'AI provider not found.' });
    }

    await provider.update({ isActive: !provider.isActive });

    res.json({
      success: true,
      message: `${provider.provider} ${provider.isActive ? 'activated' : 'deactivated'}.`,
      data: { isActive: provider.isActive },
    });
  } catch (error) {
    console.error('[AIController] toggleProvider error:', error);
    res.status(500).json({ success: false, message: 'Failed to toggle provider.' });
  }
}

/**
 * POST /api/ai/providers/:id/test
 * Test a specific provider's connection using its saved credentials.
 */
async function testProvider(req, res) {
  try {
    const { id } = req.params;
    const { apiKey: newApiKey } = req.body; // Optional: test with a new key before saving

    const provider = await AIProvider.findByPk(id);
    if (!provider) {
      return res.status(404).json({ success: false, message: 'AI provider not found.' });
    }

    let apiKey;
    if (newApiKey) {
      apiKey = newApiKey;
    } else {
      try {
        apiKey = decrypt(provider.apiKey);
      } catch {
        return res.status(400).json({ success: false, message: 'Could not decrypt stored API key.' });
      }
    }

    const result = await aiService.testConnection(provider.provider, apiKey, provider.model, provider.baseUrl);
    let autoPromoted = false;
    if (result.success) {
      await provider.update({ lastTestedAt: new Date() });

      // Auto-promote to default if the current default has never been tested successfully
      // and THIS provider just proved it works. This prevents the common scenario where
      // an admin adds and tests a new provider but forgets to set it as default,
      // then the AI assistant silently uses the old broken default.
      if (!provider.isDefault) {
        const currentDefault = await AIProvider.findOne({ where: { isDefault: true, isActive: true } });
        if (!currentDefault || !currentDefault.lastTestedAt) {
          await AIProvider.update({ isDefault: false }, { where: {} });
          await provider.update({ isDefault: true });
          autoPromoted = true;
          console.log(`[AIController] Auto-promoted provider "${provider.displayName || provider.provider}" to default (previous default was never tested).`);
        }
      }
    }

    // Include diagnostic metadata so frontend can render detailed info for admins
    const keySuffix = apiKey ? '...' + apiKey.slice(-4) : '(none)';
    const message = autoPromoted
      ? `${result.message} This provider has been automatically set as the default because the previous default was never tested.`
      : result.message;
    res.json({
      success: result.success,
      message,
      data: {
        responseTime: result.responseTime,
        autoPromoted,
        diagnostics: {
          ...(result.diagnostics || {}),
          providerType: provider.provider,
          model: provider.model,
          baseUrl: provider.baseUrl,
          keySuffix,
        },
      },
    });
  } catch (error) {
    console.error('[AIController] testProvider error:', error);
    res.status(500).json({ success: false, message: 'Failed to test provider connection.' });
  }
}

// ────────────────────────────────────────────────────────────
// Chat & Grammar endpoints (unchanged interface)
// ────────────────────────────────────────────────────────────

/**
 * POST /api/ai/chat
 * Send messages to the AI assistant with real, role-scoped page context.
 */
async function chatWithAI(req, res) {
  try {
    const { messages, context, providerId, pageState } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ success: false, message: 'Messages array is required.' });
    }

    // Filter out error-role messages that the frontend may have included
    const cleanMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant');

    // Build real, role-scoped data context from the database
    const route = pageState?.route || '';
    console.log('[AIChat] pageState received:', JSON.stringify(pageState));
    console.log('[AIChat] Resolved route for context:', route);

    const dataContext = await buildAIContext(req.user, route, pageState || {});
    console.log('[AIChat] dataContext length:', dataContext?.length || 0);
    console.log('[AIChat] dataContext preview:', (dataContext || '').slice(0, 300));

    // Combine static page description (for feature help) with real data
    const systemPrompt = buildSystemPrompt(req.user, context, dataContext);
    const reply = await aiService.chat(cleanMessages, systemPrompt, providerId);

    res.json({
      success: true,
      data: { message: reply },
    });
  } catch (error) {
    console.error('[AIController] chat error:', error.message);

    // Configuration errors thrown by aiService.chat() directly
    if (error.message?.includes('not configured') || error.message?.includes('not available')) {
      return res.status(400).json({ success: false, message: error.message });
    }

    // Unknown provider type
    if (error.message?.includes('Unknown AI provider type')) {
      return res.status(400).json({ success: false, message: error.message });
    }

    // Use shared classifyError for provider HTTP errors
    const { classifyError } = require('../services/aiService');
    const provInfo = error._providerInfo;
    const classified = classifyError(error, 0, provInfo || {});

    // Build a user-friendly message that identifies which provider failed
    const providerHint = provInfo
      ? ` (using ${provInfo.isDefault ? 'default ' : ''}provider "${provInfo.displayName}", model: ${provInfo.model || '(default)'}, key: ${provInfo.keySuffix})`
      : '';

    // Strip the "(0ms)" timing prefix from chat errors since it's meaningless here
    let userMessage = classified.message.replace(/\s*\(\d+ms\)/g, '');

    // For auth failures, add explicit guidance about checking the default provider
    if (classified.diagnostics?.failureType === 'authentication' && provInfo) {
      userMessage = `The API key for provider "${provInfo.displayName}" (key: ${provInfo.keySuffix}) is invalid or expired. `
        + `This is the ${provInfo.isDefault ? 'default' : 'active'} provider. `
        + `Go to Integrations → AI Provider and either update this provider's API key, or set a working provider as default.`;
    }

    const statusMap = {
      authentication: 401,
      billing: 402,
      permission: 403,
      rate_limit: 429,
      timeout: 504,
      network: 502,
    };
    const httpStatus = statusMap[classified.diagnostics?.failureType] || 500;
    res.status(httpStatus).json({ success: false, message: userMessage });
  }
}

/**
 * Build a system prompt that gives the AI both feature knowledge AND real scoped data.
 *
 * @param {object} user - Authenticated user
 * @param {string} staticContext - Static page description from the frontend (for feature help)
 * @param {string} dataContext - Real role-scoped data from aiContextService
 */
function buildSystemPrompt(user, staticContext, dataContext) {
  const roleName = user.role === 'assistant_manager' ? 'Assistant Manager' : user.role.charAt(0).toUpperCase() + user.role.slice(1);
  const hasLiveData = dataContext && !dataContext.startsWith('(') && dataContext.length > 20;

  return `You are the AI assistant for Aniston Project Hub. You have DIRECT ACCESS to the application database. Real data from the database is included below.

## YOUR #1 RULE

${hasLiveData ? `The section labeled "LIVE DATA FROM DATABASE" below contains REAL numbers queried from the database right now. This is not placeholder data. It is live and accurate.

**MANDATORY behavior when the user asks a data question (counts, metrics, task names, statuses, who is assigned, what is overdue, etc.):**
- Read the LIVE DATA section below.
- Find the answer in that data.
- State the exact number or fact in your FIRST sentence.
- Example: User asks "how many tasks are done?" → You see "Done tasks: 3" in the data → You answer: "There are 3 done tasks on this board."
- Example: User asks "any overdue tasks?" → You see "Overdue tasks: 0" → You answer: "There are no overdue tasks on this board right now."

**FORBIDDEN responses when live data exists:**
- "I don't have live access to the board data" — WRONG, you do. The data is below.
- "I can't query the board directly" — WRONG, the data was already queried for you.
- "Check the board header" / "Look at the Done column" / "Switch to Table view" — WRONG, just give the number.
- "I'm not able to pull the number" — WRONG, the number is right below in the data.
- Any response that tells the user to look something up manually when the answer is in the data below.

If the user asks about something NOT in the data, say you only have data for the current page and suggest they navigate there.` : `No live data is available for this page. Help with general feature questions and how-to guidance.`}

Current user: ${user.name}, Role: ${roleName}${user.isSuperAdmin ? ' (Super Admin)' : ''}

########## LIVE DATA FROM DATABASE (queried just now, role-scoped) ##########
${dataContext || '(No data for this page.)'}
########## END LIVE DATA ##########

${staticContext ? `\nPage guide: ${staticContext}` : ''}

Be concise and data-driven. Lead with the answer, not the explanation.`;
}

/**
 * POST /api/ai/grammar
 * Check and correct grammar, spelling, and punctuation.
 */
async function checkGrammar(req, res) {
  try {
    const { text } = req.body;
    if (!text || text.trim().length < 5) {
      return res.json({ success: true, data: { corrected: text, hasChanges: false } });
    }
    const prompt = 'Correct any grammar, spelling, and punctuation mistakes in the following text. Only return the corrected text, nothing else. Do not add explanations. If there are no errors, return the original text exactly as-is.';
    const corrected = await aiService.chat([{ role: 'user', content: text }], prompt);
    const hasChanges = corrected.trim() !== text.trim();
    res.json({ success: true, data: { corrected: corrected.trim(), hasChanges } });
  } catch (error) {
    console.error('[AI] Grammar check error:', error.message);
    res.status(500).json({ success: false, message: 'Grammar check failed' });
  }
}

module.exports = {
  getConfig,
  saveConfig,
  testConfig,
  deleteConfig,
  getProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  setDefaultProvider,
  toggleProvider,
  testProvider,
  chatWithAI,
  checkGrammar,
};
