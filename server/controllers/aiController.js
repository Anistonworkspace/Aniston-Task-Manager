const { AIConfig, AIProvider, User } = require('../models');
const { encrypt, decrypt, maskSecret } = require('../utils/encryption');
const aiService = require('../services/aiService');
const { logActivity } = require('../services/activityService');

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
      return res.json({ success: result.success, message: result.message, data: { responseTime: result.responseTime } });
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
      return res.json({ success: result.success, message: result.message, data: { responseTime: result.responseTime } });
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

    res.json({ success: result.success, message: result.message, data: { responseTime: result.responseTime } });
  } catch (error) {
    console.error('[AIController] testConfig error:', error);
    res.status(500).json({ success: false, message: 'Failed to test AI connection.' });
  }
}

/**
 * DELETE /api/ai/config
 * Remove all AI configurations (legacy + new).
 */
async function deleteConfig(req, res) {
  try {
    await AIConfig.destroy({ where: {} });
    await AIProvider.destroy({ where: {} });

    logActivity({
      action: 'ai_config_deleted',
      description: 'All AI configurations deleted',
      entityType: 'ai_config',
      userId: req.user.id,
    });

    res.json({ success: true, message: 'AI configuration removed.' });
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
    if (result.success) {
      await provider.update({ lastTestedAt: new Date() });
    }

    res.json({ success: result.success, message: result.message, data: { responseTime: result.responseTime } });
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
 * Send messages to the AI assistant.
 */
async function chatWithAI(req, res) {
  try {
    const { messages, context, providerId } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ success: false, message: 'Messages array is required.' });
    }

    const systemPrompt = buildSystemPrompt(req.user, context);
    const reply = await aiService.chat(messages, systemPrompt, providerId);

    res.json({
      success: true,
      data: { message: reply },
    });
  } catch (error) {
    console.error('[AIController] chat error:', error);

    if (error.message?.includes('not configured')) {
      return res.status(400).json({ success: false, message: error.message });
    }
    if (error.response?.status === 401) {
      return res.status(400).json({ success: false, message: 'AI API key is invalid or expired. Ask an admin to update it.' });
    }
    if (error.response?.status === 429) {
      return res.status(429).json({ success: false, message: 'AI rate limit reached. Please try again in a moment.' });
    }
    if (error.code === 'ECONNABORTED') {
      return res.status(504).json({ success: false, message: 'AI request timed out. Please try again.' });
    }

    res.status(500).json({ success: false, message: 'Failed to get AI response. Please try again.' });
  }
}

/**
 * Build a system prompt that gives the AI context about the user and their current page.
 */
function buildSystemPrompt(user, context) {
  return `You are an AI assistant for Aniston Project Hub, a Monday.com-style task management platform.

Your role:
- Help users navigate and use the platform effectively
- Answer questions about tasks, boards, meetings, time planning, and team management
- Provide tips on productivity and task management best practices
- Help with understanding features like RBAC, automations, dashboards, and integrations
- Be concise, helpful, and friendly
- When a user asks about a page, use the context below to give specific guidance about what they can do on that page

Current user: ${user.name} (${user.email}), Role: ${user.role}
${context ? `\nCurrent page context:\n${context}` : ''}

Platform features include: Task boards with drag-drop, Kanban view, calendar view, timeline/Gantt charts, subtasks, work logs, comments, file attachments, notifications, team dashboards, time planning, weekly reviews, meeting scheduling, department management, automations, board templates, bulk actions, dark mode, keyboard shortcuts, Microsoft Teams integration, voice notes, AI assistant, and feedback system.

Roles:
- Admin: Full system access - manage users, departments, boards, tasks, meetings, reviews, time plans, settings, integrations
- Manager: Team lead - manage boards, assign tasks, view dashboards, schedule meetings, view team time plans and reviews
- Assistant Manager: Similar to manager with slightly limited permissions
- Member/Employee: Individual contributor - work on assigned tasks, update status, subtasks, work logs, time plan, view own reviews

How to assign tasks: Click Owner column on task row (searchable dropdown), or open TaskModal and set Owner field. Tasks can also be delegated between employees.

Key keyboard shortcuts: ? for help, Ctrl+K for global search, Ctrl+Z for undo, Ctrl+Y for redo.

Keep responses concise (1-3 paragraphs max unless the user asks for detailed help). Use markdown formatting when helpful.`;
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
