const axios = require('axios');
const { decrypt } = require('../utils/encryption');

/**
 * Get the active AI configuration from the database.
 * Decrypts the API key before returning.
 */
async function getActiveConfig() {
  // Lazy-require to avoid circular dependency at startup
  const { AIConfig } = require('../models');
  const config = await AIConfig.findOne({ where: { isActive: true } });
  if (!config) return null;
  try {
    return { ...config.toJSON(), apiKey: decrypt(config.apiKey) };
  } catch (err) {
    console.error('[AIService] Failed to decrypt API key:', err.message);
    return null;
  }
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
 * @returns {string} The assistant's reply text
 */
async function chat(messages, systemPrompt) {
  const config = await getActiveConfig();
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

module.exports = { chat, getActiveConfig, testConnection };
