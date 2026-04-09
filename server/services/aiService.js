const axios = require('axios');
const { decrypt } = require('../utils/encryption');

/**
 * Get a specific AI provider by ID from the new AIProvider table.
 * Decrypts the API key before returning.
 */
async function getProviderById(providerId) {
  const { AIProvider } = require('../models');
  const provider = await AIProvider.findByPk(providerId);
  if (!provider || !provider.isActive) return null;
  try {
    return { ...provider.toJSON(), apiKey: decrypt(provider.apiKey) };
  } catch (err) {
    console.error('[AIService] Failed to decrypt API key for provider:', providerId, err.message);
    return null;
  }
}

/**
 * Get the default AI provider (isDefault=true) from the AIProvider table.
 * Falls back to any active provider, then legacy AIConfig.
 * Decrypts the API key before returning.
 */
async function getActiveConfig() {
  const { AIProvider, AIConfig } = require('../models');

  // 1. Try new AIProvider table — default first
  let provider = await AIProvider.findOne({ where: { isActive: true, isDefault: true } });
  if (!provider) {
    // Fallback to any active provider
    provider = await AIProvider.findOne({ where: { isActive: true }, order: [['createdAt', 'ASC']] });
  }

  if (provider) {
    try {
      return { ...provider.toJSON(), apiKey: decrypt(provider.apiKey) };
    } catch (err) {
      console.error('[AIService] Failed to decrypt AIProvider key:', err.message);
    }
  }

  // 2. Fallback to legacy AIConfig table
  const config = await AIConfig.findOne({ where: { isActive: true } });
  if (!config) return null;
  try {
    return { ...config.toJSON(), apiKey: decrypt(config.apiKey) };
  } catch (err) {
    console.error('[AIService] Failed to decrypt legacy AIConfig key:', err.message);
    return null;
  }
}

/**
 * Get all active providers from the AIProvider table.
 */
async function getAllProviders() {
  const { AIProvider } = require('../models');
  return AIProvider.findAll({ where: { isActive: true }, order: [['createdAt', 'ASC']] });
}

/**
 * Provider configurations with defaults.
 */
function getProviderConfig(config) {
  const providers = {
    deepseek: {
      url: config.baseUrl || 'https://api.deepseek.com/v1/chat/completions',
      model: config.model || 'deepseek-chat',
      type: 'openai',
    },
    openai: {
      url: config.baseUrl || 'https://api.openai.com/v1/chat/completions',
      model: config.model || 'gpt-3.5-turbo',
      type: 'openai',
    },
    anthropic: {
      url: config.baseUrl || 'https://api.anthropic.com/v1/messages',
      model: config.model || 'claude-3-haiku-20240307',
      type: 'anthropic',
    },
    claude: {
      url: config.baseUrl || 'https://api.anthropic.com/v1/messages',
      model: config.model || 'claude-3-haiku-20240307',
      type: 'anthropic',
    },
    gemini: {
      url: config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
      model: config.model || 'gemini-pro',
      type: 'gemini',
    },
    custom: {
      url: config.baseUrl || '',
      model: config.model || '',
      type: 'openai',
    },
  };
  return providers[config.provider] || providers.deepseek;
}

/**
 * Send a chat request to the configured AI provider.
 * @param {Array} messages - Array of { role, content }
 * @param {string} systemPrompt - System-level instructions
 * @param {string} [providerId] - Optional specific provider ID to use
 * @returns {string} The assistant's reply text
 */
async function chat(messages, systemPrompt, providerId) {
  let config;
  if (providerId) {
    config = await getProviderById(providerId);
    if (!config) throw new Error('The selected AI provider is not available or inactive.');
  } else {
    config = await getActiveConfig();
  }
  if (!config) throw new Error('AI is not configured. Ask an admin to set up AI in Integrations.');

  return callProvider(config, messages, systemPrompt);
}

/**
 * Core provider-routing logic. Accepts a config object (can be temp or from DB).
 */
async function callProvider(config, messages, systemPrompt) {
  const providerConfig = getProviderConfig(config);

  // OpenAI-compatible APIs (DeepSeek, OpenAI, any custom)
  if (providerConfig.type === 'openai') {
    const allMessages = [];
    if (systemPrompt) allMessages.push({ role: 'system', content: systemPrompt });
    allMessages.push(...messages);

    const response = await axios.post(providerConfig.url, {
      model: providerConfig.model,
      messages: allMessages,
      max_tokens: 1500,
      temperature: 0.7,
    }, {
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    return response.data.choices[0].message.content;
  }

  // Anthropic Claude
  if (providerConfig.type === 'anthropic') {
    const response = await axios.post(providerConfig.url, {
      model: providerConfig.model,
      system: systemPrompt || '',
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      max_tokens: 1500,
    }, {
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    return response.data.content[0].text;
  }

  // Google Gemini
  if (providerConfig.type === 'gemini') {
    const url = providerConfig.url.replace('{model}', providerConfig.model);
    const contents = [];

    // Add system prompt as first user/model pair
    if (systemPrompt) {
      contents.push({ role: 'user', parts: [{ text: systemPrompt }] });
      contents.push({ role: 'model', parts: [{ text: 'Understood. I will follow these instructions.' }] });
    }

    for (const m of messages) {
      contents.push({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      });
    }

    const response = await axios.post(url, { contents }, {
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.apiKey,
      },
      timeout: 30000,
    });

    return response.data.candidates[0].content.parts[0].text;
  }

  throw new Error(`Unsupported AI provider: ${config.provider}`);
}

/**
 * Test a connection using provided (temporary) credentials.
 * Returns { success, message, responseTime }.
 */
async function testConnection(provider, apiKey, model, baseUrl) {
  const testMessages = [{ role: 'user', content: 'Say "Connection successful" in exactly two words.' }];
  const tempConfig = { provider, apiKey, model, baseUrl };

  const start = Date.now();
  try {
    const reply = await callProvider(tempConfig, testMessages, 'You are a helpful assistant.');
    const elapsed = Date.now() - start;
    return {
      success: true,
      message: `Connected successfully (${elapsed}ms). Response: "${reply.slice(0, 80)}"`,
      responseTime: elapsed,
    };
  } catch (err) {
    const elapsed = Date.now() - start;
    const detail = err.response?.data?.error?.message || err.response?.data?.message || err.message;
    return {
      success: false,
      message: `Connection failed (${elapsed}ms): ${detail}`,
      responseTime: elapsed,
    };
  }
}

/**
 * Migrate legacy AIConfig records to AIProvider table.
 * Called once at startup or on first access.
 */
async function migrateFromLegacy() {
  const { AIConfig, AIProvider } = require('../models');
  try {
    const providerCount = await AIProvider.count();
    if (providerCount > 0) return; // Already migrated or has data

    const legacyConfigs = await AIConfig.findAll();
    if (legacyConfigs.length === 0) return;

    for (const cfg of legacyConfigs) {
      await AIProvider.create({
        provider: cfg.provider,
        displayName: cfg.provider.charAt(0).toUpperCase() + cfg.provider.slice(1),
        apiKey: cfg.apiKey, // Already encrypted
        model: cfg.model || '',
        baseUrl: cfg.baseUrl || '',
        isActive: cfg.isActive,
        isDefault: cfg.isActive, // The active legacy config becomes the default
        lastTestedAt: cfg.lastTestedAt,
        configuredBy: cfg.configuredBy,
      });
    }
    console.log(`[AIService] Migrated ${legacyConfigs.length} legacy AIConfig(s) to AIProvider table.`);
  } catch (err) {
    console.error('[AIService] Legacy migration failed (non-fatal):', err.message);
  }
}

module.exports = { chat, getActiveConfig, getProviderById, getAllProviders, testConnection, migrateFromLegacy };
