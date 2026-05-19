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
    const { messages, context, providerId, pageState, scope, scopeId } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ success: false, message: 'Messages array is required.' });
    }

    // Filter out error-role messages that the frontend may have included
    const cleanMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant');

    // Build real, role-scoped data context from the database
    const route = pageState?.route || '';
    console.log('[AIChat] pageState received:', JSON.stringify(pageState), '| scope:', scope, '| scopeId:', scopeId);

    const dataContext = await buildAIContext(req.user, route, pageState || {});
    console.log('[AIChat] dataContext length:', dataContext?.length || 0);

    // Plan A Slice 1: when the client sends `scope` + `scopeId` (e.g. from
    // the scoped Sidekick), prepend a focused scope-specific context to the
    // system prompt. Falls back to empty string when the scope is unknown
    // or the user can't see the resource — the route-based context still
    // applies in that case.
    let scopeContext = '';
    if (scope) {
      try {
        const { buildScopeContext } = require('../services/aiScopeContextService');
        scopeContext = await buildScopeContext(req.user, { scope, scopeId, params: pageState || {} });
        console.log('[AIChat] scopeContext length:', scopeContext?.length || 0);
      } catch (err) {
        console.warn('[AIChat] scope context failed (non-fatal):', err.message);
      }
    }

    // Combine static page description (for feature help) with real data
    const systemPrompt = buildSystemPrompt(req.user, context, dataContext, scopeContext);
    const reply = await aiService.chat(cleanMessages, systemPrompt, providerId);

    res.json({
      success: true,
      data: { message: reply },
    });
  } catch (error) {
    const safeLogger = require('../utils/safeLogger');
    safeLogger.warn('[AIController] chat error', { err: error });

    // Configuration / provider-availability errors thrown by aiService.chat().
    // The strings in error.message are app-controlled (see aiService.js where
    // these are thrown) and safe to surface to the admin who triggered the
    // request — but we send canonical text rather than echoing the raw
    // message so a future change in aiService can't accidentally introduce
    // provider-detail leakage into this response path.
    if (error.message?.includes('not configured') || error.message?.includes('not available')) {
      return res.status(400).json({
        success: false,
        code: 'AI_NOT_CONFIGURED',
        message: 'AI is not configured. Ask an admin to set up AI in Integrations.',
      });
    }

    // Unknown provider type — admin selected a provider type the backend
    // does not support.
    if (error.message?.includes('Unknown AI provider type')) {
      return res.status(400).json({
        success: false,
        code: 'AI_PROVIDER_UNSUPPORTED',
        message: 'The selected AI provider type is not supported.',
      });
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
 * Plan A Slice 2 — one-shot AI endpoints.
 *
 * These are thin wrappers around aiSummaryService. They exist as dedicated
 * routes (not "scoped chat") because they return structured payloads:
 *   - text summaries          → { success, data: { summary } }
 *   - priority suggestions    → { success, data: { priority, reason, suggestedDueDate } }
 *   - week plans              → { success, data: { schedule: [...], notes } }
 *
 * Frontend callers can render these inline (Popovers, badges) without
 * opening the Sidekick chat panel.
 */

async function summarizeTaskEndpoint(req, res) {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, message: 'Task id is required.' });
    const { summarizeTaskWithAI, AiScopeUnavailableError } = require('../services/aiSummaryService');
    try {
      const out = await summarizeTaskWithAI(req.user, id, { providerId: req.body?.providerId });
      res.json({ success: true, data: out });
    } catch (err) {
      if (err instanceof AiScopeUnavailableError) {
        return res.status(404).json({ success: false, code: err.code, message: err.message });
      }
      throw err;
    }
  } catch (err) {
    handleAiEndpointError(res, err);
  }
}

async function summarizeBoardEndpoint(req, res) {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, message: 'Board id is required.' });
    const { summarizeBoardWithAI, AiScopeUnavailableError } = require('../services/aiSummaryService');
    try {
      const out = await summarizeBoardWithAI(req.user, id, { providerId: req.body?.providerId });
      res.json({ success: true, data: out });
    } catch (err) {
      if (err instanceof AiScopeUnavailableError) {
        return res.status(404).json({ success: false, code: err.code, message: err.message });
      }
      throw err;
    }
  } catch (err) {
    handleAiEndpointError(res, err);
  }
}

/**
 * POST /api/ai/extract-actions
 * body: { text, providerId? }
 *
 * Notetaker companion — pulls structured action items out of a meeting
 * transcript. Returns { actions: [{title, owner?, dueDate?, priority?}] }.
 * Stateless; uses no task/board context (owner names are free-text the
 * caller can resolve to real users when they click "Create task").
 */
async function extractActionsEndpoint(req, res) {
  try {
    const { text, providerId } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({
        success: false,
        message: 'text is required.',
        code: 'invalid_input',
      });
    }
    const { extractActionItemsWithAI } = require('../services/aiSummaryService');
    const out = await extractActionItemsWithAI({ text }, { providerId });
    res.json({ success: true, data: out });
  } catch (err) {
    handleAiEndpointError(res, err);
  }
}

/**
 * POST /api/ai/inline-edit
 * body: { text, mode, providerId? }
 *
 * Phase E — "select text in editor → AI transform" endpoint. Stateless;
 * does NOT load any task/board/doc context. Caller-supplied text is the
 * full input. Per-user rate-limited via the aiUserLimiter on the route.
 *
 * mode is one of the keys in INLINE_MODES (improve/shorter/longer/grammar/
 * continue/casual/professional). Anything else → 400.
 */
async function inlineEditEndpoint(req, res) {
  try {
    const { text, mode, providerId } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({
        success: false,
        message: 'text is required.',
        code: 'invalid_input',
      });
    }
    if (typeof mode !== 'string' || !mode.trim()) {
      return res.status(400).json({
        success: false,
        message: 'mode is required.',
        code: 'invalid_input',
      });
    }
    const { transformInlineWithAI, INLINE_MODES } = require('../services/aiSummaryService');
    if (!INLINE_MODES[mode]) {
      return res.status(400).json({
        success: false,
        message: `Unknown mode. Allowed: ${Object.keys(INLINE_MODES).join(', ')}.`,
        code: 'invalid_mode',
      });
    }
    const out = await transformInlineWithAI({ text, mode }, { providerId });
    res.json({ success: true, data: out });
  } catch (err) {
    handleAiEndpointError(res, err);
  }
}

/**
 * POST /api/ai/summarize/doc/:id
 *
 * Loads the doc, verifies the caller can see its workspace (same gate as
 * doc reads), then asks the model for a short Markdown summary. Returns
 * 404 if the doc doesn't exist, 403 if not visible. Plain-text-only — the
 * Tiptap JSON envelope would burn tokens on structure that doesn't change
 * the summary.
 */
async function summarizeDocEndpoint(req, res) {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ success: false, message: 'Doc id is required.' });
    const { Doc, Workspace, User, Board } = require('../models');
    const doc = await Doc.findByPk(id);
    if (!doc) return res.status(404).json({ success: false, message: 'Doc not found.' });

    // Workspace visibility mirrors docController.canCallerSeeWorkspace —
    // including the board-membership branch (May 2026) so Tier 4 users
    // who reach the workspace through any visible board can also use the
    // doc Summarize action.
    const u = req.user;
    let allowed = false;
    if (u?.isSuperAdmin || u?.role === 'admin' || u?.role === 'manager') allowed = true;
    if (!allowed) {
      const ws = await Workspace.findByPk(doc.workspaceId, {
        include: [{ model: User, as: 'workspaceMembers', attributes: ['id'], required: false }],
      });
      if (ws && (ws.createdBy === u.id
        || (ws.workspaceMembers || []).some((m) => m.id === u.id))) {
        allowed = true;
      }
    }
    if (!allowed) {
      // Board-membership path — same rule the docs API uses.
      try {
        const boardVisibility = require('../services/boardVisibilityService');
        const visibleBoardIds = await boardVisibility.getVisibleBoardIdsForUser(u, { includeArchived: false });
        if (visibleBoardIds && visibleBoardIds.size > 0) {
          const wsBoards = await Board.findAll({
            where: { workspaceId: doc.workspaceId, isArchived: false },
            attributes: ['id'],
            raw: true,
          });
          if (wsBoards.some((b) => visibleBoardIds.has(b.id))) allowed = true;
        }
      } catch (_) { /* best-effort */ }
    }
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'You do not have access to this doc.' });
    }

    const { summarizeDocWithAI, AiScopeUnavailableError } = require('../services/aiSummaryService');
    try {
      const out = await summarizeDocWithAI(req.user, doc, { providerId: req.body?.providerId });
      res.json({ success: true, data: out });
    } catch (err) {
      if (err instanceof AiScopeUnavailableError) {
        return res.status(404).json({ success: false, code: err.code, message: err.message });
      }
      throw err;
    }
  } catch (err) {
    handleAiEndpointError(res, err);
  }
}

async function suggestPriorityEndpoint(req, res) {
  try {
    const { taskTitle, taskDescription, boardId, providerId } = req.body || {};
    if (!taskTitle || typeof taskTitle !== 'string' || taskTitle.length > 400) {
      return res.status(400).json({
        success: false,
        message: 'taskTitle is required (max 400 chars).',
      });
    }
    const { suggestPriorityWithAI } = require('../services/aiSummaryService');
    const out = await suggestPriorityWithAI(req.user, { taskTitle, taskDescription, boardId }, { providerId });
    res.json({ success: true, data: out });
  } catch (err) {
    handleAiEndpointError(res, err);
  }
}

async function planWeekEndpoint(req, res) {
  try {
    const { taskIds, providerId } = req.body || {};
    if (taskIds && !Array.isArray(taskIds)) {
      return res.status(400).json({ success: false, message: 'taskIds must be an array of strings.' });
    }
    const { planWeekWithAI } = require('../services/aiSummaryService');
    const out = await planWeekWithAI(req.user, { taskIds }, { providerId });
    res.json({ success: true, data: out });
  } catch (err) {
    handleAiEndpointError(res, err);
  }
}

/**
 * Shared error response for the one-shot AI endpoints. Mirrors the shape
 * chatWithAI uses so frontend error-mapping stays uniform.
 */
function handleAiEndpointError(res, error) {
  const safeLogger = require('../utils/safeLogger');
  safeLogger.warn('[AIController] one-shot error', { err: error });

  if (error?.message?.includes('not configured') || error?.message?.includes('not available')) {
    return res.status(400).json({
      success: false,
      code: 'AI_NOT_CONFIGURED',
      message: 'AI is not configured. Ask an admin to set up AI in Integrations.',
    });
  }
  if (error?.message?.includes('Unknown AI provider type')) {
    return res.status(400).json({
      success: false,
      code: 'AI_PROVIDER_UNSUPPORTED',
      message: 'The selected AI provider type is not supported.',
    });
  }

  const { classifyError } = require('../services/aiService');
  const provInfo = error?._providerInfo;
  const classified = classifyError(error, 0, provInfo || {});
  let userMessage = (classified?.message || 'AI request failed.').replace(/\s*\(\d+ms\)/g, '');
  if (classified?.diagnostics?.failureType === 'authentication' && provInfo) {
    userMessage = `The API key for provider "${provInfo.displayName}" is invalid or expired. Update it in Integrations → AI Provider.`;
  }
  const statusMap = {
    authentication: 401,
    billing: 402,
    permission: 403,
    rate_limit: 429,
    timeout: 504,
    network: 502,
  };
  const httpStatus = statusMap[classified?.diagnostics?.failureType] || 500;
  res.status(httpStatus).json({ success: false, message: userMessage });
}

/**
 * Build a system prompt that gives the AI both feature knowledge AND real scoped data.
 *
 * @param {object} user - Authenticated user
 * @param {string} staticContext - Static page description from the frontend (for feature help)
 * @param {string} dataContext - Real role-scoped data from aiContextService
 * @param {string} scopeContext - Optional focused context from aiScopeContextService
 *                                (task / board / planning) — when present, it takes
 *                                precedence over the route-based dataContext for the
 *                                "answer using THIS data" instructions.
 */
function buildSystemPrompt(user, staticContext, dataContext, scopeContext = '') {
  const roleName = user.role === 'assistant_manager' ? 'Assistant Manager' : user.role.charAt(0).toUpperCase() + user.role.slice(1);
  const hasLiveData = dataContext && !dataContext.startsWith('(') && dataContext.length > 20;
  const hasScope = !!(scopeContext && scopeContext.length > 20);

  return `You are the AI Sidekick inside Aniston Project Hub — an internal task-management application built by Aniston Technologies LLP. You have DIRECT ACCESS to the application database. Real data from the database is included below.

## ABOUT THIS APP (read before answering ANYTHING)

You are NOT monday.com, Jira, Asana, Trello, ClickUp, Notion, Linear, or any other external SaaS. You are a self-contained product. Some boards in this app may be **named** "monday.com" or similar — those are just user-chosen labels for internal boards. They do NOT mean the data lives in an external service. Every task, board, workspace, doc, and user you see below lives inside THIS application's PostgreSQL database.

**MANDATORY when explaining how to do something:**
- Describe steps using THIS app's actual UI: the left Sidebar (Workflows, Forms, Reviews, Approvals & Requests, Recurring Work, Workspaces, Docs), the board's Main table / Gantt / Calendar / Kanban tabs, the "+ New group" / "+ New task" buttons, the Status column, the Owner column, the task row (click to open the TaskModal), and the Sidekick panel itself.
- When the user asks "how do I do X" for a feature this app doesn't have, say so plainly — don't invent a feature or borrow one from another tool.
- When the user asks about a specific task (TASK SCOPE below), describe what THEY need to do to complete the task as it is written — don't reinterpret the task title as an instruction to use external software.

**FORBIDDEN:**
- Saying "Open the task in monday.com" or "in Jira" or "in [external tool]" — the task is right here, in this app.
- Telling the user to "Use the Duplicate/Clone option (usually found in the task's menu)" or any other speculative "usually found in…" phrasing. Either you know this app has the feature (then name the exact UI element) or you don't (then say so).
- Referring users to external documentation, monday.com help articles, or third-party tutorials.
- Treating a board name like "monday.com" as a reference to the external SaaS. It's just a board.

## YOUR #1 RULE

${hasScope ? `The section labeled "SCOPED CONTEXT" below is the SPECIFIC thing the user is asking about right now (a particular task, board, document, or their own workload). Answer questions using THAT data first. The general "LIVE DATA FROM DATABASE" section is supplementary background. Earlier turns in this chat (if any) may have lacked context — IGNORE any apologies or "I don't have access" statements you made before. The SCOPED CONTEXT below is the current source of truth.

**MANDATORY behavior:**
- Read the SCOPED CONTEXT below carefully.
- Answer the user's question using facts from that section.
- When summarizing, lead with the bottom line in your FIRST sentence (e.g. "This task is stuck waiting on legal review" — not "Sure! Here's a summary…").
- When suggesting a plan or priority, base it on the dates, statuses, and dependencies actually present in the SCOPED CONTEXT.
- For DOC SCOPE: quote the user's own words from the doc body when answering — they want to see their content reflected back. If the body is empty, say so plainly ("Your doc is currently empty — write something first.") instead of asking them to paste it.
- **For PLANNING SCOPE: when the user asks "how many" / count questions (e.g. "how many overdue", "how many due this week"), QUOTE the number from the "AUTHORITATIVE COUNTS" block at the top of the scoped context. Do NOT count items in the detail bullet list below it — the bullet list is a sample. The AUTHORITATIVE COUNTS line is the exact total the My Work page shows. If the question is "how many overdue tasks?" and AUTHORITATIVE COUNTS says "Overdue: 50", answer "You have 50 overdue tasks." Never substitute a different number just because the bullet list under "OVERDUE" appears to show fewer items.**

**FORBIDDEN:**
- "I don't have access to this task/board/doc/note" — you do, it's below.
- "Could you paste the contents?" / "Share the text you wrote" — the contents ARE the SCOPED CONTEXT below.
- Asking the user for information that's already in the SCOPED CONTEXT.
- Generic advice that doesn't reference the specific items below.
- Counting bullet rows under OVERDUE/DUE TODAY/etc. instead of reading the AUTHORITATIVE COUNTS line above them.
` : hasLiveData ? `The section labeled "LIVE DATA FROM DATABASE" below contains REAL numbers queried from the database right now. This is not placeholder data. It is live and accurate.

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

${hasScope ? `########## SCOPED CONTEXT (focus of this conversation) ##########
${scopeContext}
########## END SCOPED CONTEXT ##########

` : ''}########## LIVE DATA FROM DATABASE (queried just now, role-scoped) ##########
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
  // Plan A Slice 2 — one-shot endpoints
  summarizeTaskEndpoint,
  summarizeBoardEndpoint,
  summarizeDocEndpoint,
  suggestPriorityEndpoint,
  planWeekEndpoint,
  inlineEditEndpoint,
  extractActionsEndpoint,
};
