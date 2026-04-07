const { AIConfig, User } = require('../models');
const { encrypt, decrypt, maskSecret } = require('../utils/encryption');
const aiService = require('../services/aiService');
const { logActivity } = require('../services/activityService');

/**
 * GET /api/ai/config
 * Return the active AI config (API key masked).
 */
async function getConfig(req, res) {
  try {
    const config = await AIConfig.findOne({
      where: { isActive: true },
      include: [{ model: User, as: 'configurer', attributes: ['id', 'name', 'email'] }],
    });

    if (!config) {
      return res.json({ success: true, data: null });
    }

    // Decrypt and mask API key for display
    let maskedKey = '';
    try {
      const plainKey = decrypt(config.apiKey);
      maskedKey = maskSecret(plainKey);
    } catch {
      maskedKey = '(encrypted)';
    }

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
 * Save / update AI configuration (admin only).
 * Encrypts the API key before storing.
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

    const validProviders = ['deepseek', 'openai', 'claude', 'gemini'];
    if (!validProviders.includes(provider)) {
      return res.status(400).json({ success: false, message: `Invalid provider. Use: ${validProviders.join(', ')}` });
    }

    const encryptedKey = encrypt(apiKey);

    // Deactivate any existing configs
    await AIConfig.update({ isActive: false }, { where: { isActive: true } });

    // Create new active config
    const config = await AIConfig.create({
      provider,
      apiKey: encryptedKey,
      model: model || '',
      baseUrl: baseUrl || '',
      isActive: true,
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
 * Test connection to the configured (or provided) AI provider.
 */
async function testConfig(req, res) {
  try {
    const { provider, apiKey, model, baseUrl } = req.body;

    // If credentials provided, test those directly
    if (provider && apiKey) {
      const result = await aiService.testConnection(provider, apiKey, model, baseUrl);
      if (result.success) {
        // Update lastTestedAt on active config if it matches
        const active = await AIConfig.findOne({ where: { isActive: true } });
        if (active && active.provider === provider) {
          await active.update({ lastTestedAt: new Date() });
        }
      }
      return res.json({ success: result.success, message: result.message, data: { responseTime: result.responseTime } });
    }

    // Otherwise test the saved config
    const config = await aiService.getActiveConfig();
    if (!config) {
      return res.status(400).json({ success: false, message: 'No AI configuration found. Save a config first.' });
    }

    const result = await aiService.testConnection(config.provider, config.apiKey, config.model, config.baseUrl);

    if (result.success) {
      await AIConfig.update({ lastTestedAt: new Date() }, { where: { id: config.id } });
    }

    res.json({ success: result.success, message: result.message, data: { responseTime: result.responseTime } });
  } catch (error) {
    console.error('[AIController] testConfig error:', error);
    res.status(500).json({ success: false, message: 'Failed to test AI connection.' });
  }
}

/**
 * DELETE /api/ai/config
 * Remove all AI configurations.
 */
async function deleteConfig(req, res) {
  try {
    await AIConfig.destroy({ where: {} });

    logActivity({
      action: 'ai_config_deleted',
      description: 'AI configuration deleted',
      entityType: 'ai_config',
      userId: req.user.id,
    });

    res.json({ success: true, message: 'AI configuration removed.' });
  } catch (error) {
    console.error('[AIController] deleteConfig error:', error);
    res.status(500).json({ success: false, message: 'Failed to remove AI configuration.' });
  }
}

/**
 * POST /api/ai/chat
 * Send messages to the AI assistant.
 * Accepts: { messages: [{role, content}], context: string }
 */
async function chatWithAI(req, res) {
  try {
    const { messages, context } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ success: false, message: 'Messages array is required.' });
    }

    // Build system prompt with context
    const systemPrompt = buildSystemPrompt(req.user, context);

    const reply = await aiService.chat(messages, systemPrompt);

    res.json({
      success: true,
      data: { message: reply },
    });
  } catch (error) {
    console.error('[AIController] chat error:', error);

    // Provide helpful error messages
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

module.exports = { getConfig, saveConfig, testConfig, deleteConfig, chatWithAI, checkGrammar };
