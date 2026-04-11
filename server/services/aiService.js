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
 * Known provider configurations with defaults.
 */
const PROVIDER_CONFIGS = {
  deepseek: { defaultUrl: 'https://api.deepseek.com/v1/chat/completions', defaultModel: 'deepseek-chat', type: 'openai' },
  openai:   { defaultUrl: 'https://api.openai.com/v1/chat/completions',   defaultModel: 'gpt-3.5-turbo', type: 'openai' },
  anthropic:{ defaultUrl: 'https://api.anthropic.com/v1/messages',         defaultModel: 'claude-3-haiku-20240307', type: 'anthropic' },
  claude:   { defaultUrl: 'https://api.anthropic.com/v1/messages',         defaultModel: 'claude-3-haiku-20240307', type: 'anthropic' },
  gemini:   { defaultUrl: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent', defaultModel: 'gemini-pro', type: 'gemini' },
  custom:   { defaultUrl: '',                                              defaultModel: '', type: 'openai' },
};

function getProviderConfig(config) {
  const known = PROVIDER_CONFIGS[config.provider];
  if (!known) {
    throw new Error(
      `Unknown AI provider type: "${config.provider}". ` +
      `Valid types: ${Object.keys(PROVIDER_CONFIGS).join(', ')}`
    );
  }
  return {
    url: config.baseUrl || known.defaultUrl,
    model: config.model || known.defaultModel,
    type: known.type,
  };
}

/**
 * Detect whether a URL points to OpenRouter.
 */
function isOpenRouterUrl(url) {
  return url && /openrouter\.ai/i.test(url);
}

/**
 * Send a chat request to the configured AI provider.
 * Retries automatically on 429 rate-limit errors.
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

  try {
    return await callProviderWithRetry(config, messages, systemPrompt);
  } catch (err) {
    // Attach provider metadata to the error so controllers can report which provider failed
    err._providerInfo = {
      id: config.id,
      provider: config.provider,
      model: config.model,
      displayName: config.displayName || config.provider,
      keySuffix: config.apiKey ? '...' + config.apiKey.slice(-4) : '(none)',
      isDefault: config.isDefault,
    };
    throw err;
  }
}

/**
 * Normalize the endpoint URL for OpenAI-compatible providers.
 * If the user supplied a base URL (e.g. "https://openrouter.ai/api") without
 * the /v1/chat/completions path, append it automatically.
 */
function normalizeOpenAIUrl(url) {
  if (!url) return url;
  // Strip trailing slashes for consistent comparison
  const trimmed = url.replace(/\/+$/, '');
  // Already includes the completions path — use as-is
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  // Ends with /v1 — just append /chat/completions
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/chat/completions`;
  // Bare base URL — append full path
  return `${trimmed}/v1/chat/completions`;
}

/**
 * Core provider-routing logic. Accepts a config object (can be temp or from DB).
 * @param {object} config - Provider config with apiKey, provider, model, baseUrl
 * @param {Array} messages - Messages array
 * @param {string} systemPrompt - System prompt
 * @param {object} [opts] - Optional overrides
 * @param {number} [opts.maxTokens] - Override default max_tokens (1500)
 */
async function callProvider(config, messages, systemPrompt, opts = {}) {
  const providerConfig = getProviderConfig(config);
  const maxTokens = opts.maxTokens || 1500;

  // OpenAI-compatible APIs (DeepSeek, OpenAI, OpenRouter, any custom)
  if (providerConfig.type === 'openai') {
    const allMessages = [];
    if (systemPrompt) allMessages.push({ role: 'system', content: systemPrompt });
    allMessages.push(...messages);

    const url = normalizeOpenAIUrl(providerConfig.url);

    // Build headers — add OpenRouter-specific headers when targeting openrouter.ai
    const headers = {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (isOpenRouterUrl(url)) {
      headers['HTTP-Referer'] = process.env.CLIENT_URL || 'http://localhost:3000';
      headers['X-Title'] = 'Aniston Project Hub';
    }

    const response = await axios.post(url, {
      model: providerConfig.model,
      messages: allMessages,
      max_tokens: maxTokens,
      temperature: 0.7,
    }, {
      headers,
      timeout: 30000,
    });

    const choices = response.data?.choices;
    if (!Array.isArray(choices) || !choices.length || !choices[0]) {
      const keys = Object.keys(response.data || {}).join(', ');
      const errorMsg = response.data?.error?.message || response.data?.error || '';
      throw new Error(
        errorMsg
          ? `AI provider error: ${errorMsg}`
          : `AI provider returned an unexpected response format (no choices). Response keys: [${keys}]`
      );
    }
    return choices[0]?.message?.content || '';
  }

  // Anthropic Claude
  if (providerConfig.type === 'anthropic') {
    const response = await axios.post(providerConfig.url, {
      model: providerConfig.model,
      system: systemPrompt || '',
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      max_tokens: maxTokens,
    }, {
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    const content = response.data?.content;
    if (!Array.isArray(content) || !content.length || !content[0]) {
      const keys = Object.keys(response.data || {}).join(', ');
      const errorMsg = response.data?.error?.message || '';
      throw new Error(
        errorMsg
          ? `Anthropic error: ${errorMsg}`
          : `Anthropic returned an unexpected response format (no content). Response keys: [${keys}]`
      );
    }
    return content[0]?.text || '';
  }

  // Google Gemini
  if (providerConfig.type === 'gemini') {
    const url = providerConfig.url.replace('{model}', providerConfig.model);
    const contents = [];

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

    const candidates = response.data?.candidates;
    if (!Array.isArray(candidates) || !candidates.length || !candidates[0]) {
      const keys = Object.keys(response.data || {}).join(', ');
      const errorMsg = response.data?.error?.message || '';
      throw new Error(
        errorMsg
          ? `Gemini error: ${errorMsg}`
          : `Gemini returned an unexpected response format (no candidates). Response keys: [${keys}]`
      );
    }
    return candidates[0]?.content?.parts?.[0]?.text || '';
  }

  // getProviderConfig already throws for unknown types, but guard anyway
  throw new Error(`Unsupported AI provider type: "${providerConfig.type}"`);
}

/**
 * Shared retry wrapper around callProvider.
 * Retries on 429 rate-limit errors with exponential backoff.
 * Used by both testConnection and chat/grammar flows.
 */
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 2000;

async function callProviderWithRetry(config, messages, systemPrompt, opts = {}) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callProvider(config, messages, systemPrompt, opts);
    } catch (err) {
      const isRateLimited = err.response?.status === 429;
      if (isRateLimited && attempt < MAX_RETRIES) {
        const retryAfter = err.response?.headers?.['retry-after'];
        const delaySec = retryAfter
          ? Math.min(parseInt(retryAfter, 10) || 2, 10)
          : (BASE_DELAY_MS * Math.pow(2, attempt)) / 1000;
        const delayMs = Math.round(delaySec * 1000);
        console.log(`[AIService] 429 rate-limited (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delayMs}ms...`);
        await sleep(delayMs);
        continue;
      }
      throw err; // Non-retryable or retries exhausted — propagate
    }
  }
}

/**
 * Small helper — wait for `ms` milliseconds.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Classify an error into a structured result object.
 * Separated from testConnection so retry logic stays clean.
 */
function classifyError(err, elapsed, tempConfig) {
  const status = err.response?.status;
  const apiError = err.response?.data?.error?.message || err.response?.data?.message;
  const errorCode = err.response?.data?.error?.code;
  const retryAfter = err.response?.headers?.['retry-after'];

  const diagnostics = {
    httpStatus: status || null,
    errorCode: errorCode || null,
    failureType: 'unknown',
    retryable: false,
  };

  // 401 — invalid or expired API key
  if (status === 401) {
    diagnostics.failureType = 'authentication';
    return {
      success: false,
      message: `Authentication failed (${elapsed}ms): The API key is invalid, expired, or revoked. Verify the key is correct and active in your provider's dashboard.`,
      responseTime: elapsed,
      diagnostics,
    };
  }

  // 402 — billing / credits issue
  if (status === 402) {
    diagnostics.failureType = 'billing';
    return {
      success: false,
      message: `Billing error (${elapsed}ms): The API key is valid but the linked account has no paid credits. `
        + `Note: "Unlimited" key limit means no per-key spending cap — it does NOT mean free usage. `
        + `The account/workspace still requires prepaid credits to make API calls. `
        + (apiError ? `Provider message: ${apiError}` : 'Add credits in your provider dashboard.'),
      responseTime: elapsed,
      diagnostics,
    };
  }

  // 403 — forbidden
  if (status === 403) {
    diagnostics.failureType = 'permission';
    return {
      success: false,
      message: `Access denied (${elapsed}ms): The API key does not have permission for this model or endpoint. `
        + (apiError || 'Check model access and key permissions in your provider dashboard.'),
      responseTime: elapsed,
      diagnostics,
    };
  }

  // 404 — model not found
  if (status === 404) {
    diagnostics.failureType = 'model_not_found';
    return {
      success: false,
      message: `Model not found (${elapsed}ms): The model "${tempConfig.model || '(empty)'}" was not found at this endpoint. `
        + `Verify the model name is correct and available at your provider.`,
      responseTime: elapsed,
      diagnostics,
    };
  }

  // 429 — rate limited (retryable)
  if (status === 429) {
    diagnostics.failureType = 'rate_limit';
    diagnostics.retryable = true;
    diagnostics.retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : null;
    const isFreeModel = (tempConfig.model || '').includes(':free');
    const freeNote = isFreeModel
      ? `The model "${tempConfig.model}" is a free-tier model with shared capacity and strict rate limits. `
        + `Free models are heavily throttled during peak usage. Try again after a short wait, or switch to a paid model for reliable access.`
      : `The provider is temporarily rate-limiting requests. ${apiError || 'Try again after a short wait.'}`;
    return {
      success: false,
      message: `Rate limited (${elapsed}ms): ${freeNote}`,
      responseTime: elapsed,
      diagnostics,
    };
  }

  // Other API errors (4xx/5xx)
  if (apiError) {
    diagnostics.failureType = 'api_error';
    return {
      success: false,
      message: `Connection failed (${elapsed}ms): ${apiError}`,
      responseTime: elapsed,
      diagnostics,
    };
  }

  // Timeout
  if (err.code === 'ECONNABORTED') {
    diagnostics.failureType = 'timeout';
    return {
      success: false,
      message: `Connection timed out (${elapsed}ms). Check the base URL and network.`,
      responseTime: elapsed,
      diagnostics,
    };
  }

  // Network / DNS errors
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
    diagnostics.failureType = 'network';
    return {
      success: false,
      message: `Connection failed (${elapsed}ms): Could not reach the AI provider. Check the base URL.`,
      responseTime: elapsed,
      diagnostics,
    };
  }

  // TypeError / unexpected runtime errors
  if (err instanceof TypeError) {
    diagnostics.failureType = 'unexpected_response';
    console.error('[AIService] Unexpected TypeError during test:', err.message, err.stack);
    return {
      success: false,
      message: `Connection failed (${elapsed}ms): Unexpected response format from the AI provider. Check the base URL, model name, and API key.`,
      responseTime: elapsed,
      diagnostics,
    };
  }

  // All other errors
  diagnostics.failureType = 'other';
  return {
    success: false,
    message: `Connection failed (${elapsed}ms): ${err.message}`,
    responseTime: elapsed,
    diagnostics,
  };
}

/**
 * Test a connection using provided (temporary) credentials.
 * Uses shared callProviderWithRetry for automatic 429 retry.
 * Uses max_tokens=10 to minimize token waste during test.
 * Returns { success, message, responseTime, diagnostics }.
 */
async function testConnection(provider, apiKey, model, baseUrl) {
  const testMessages = [{ role: 'user', content: 'Reply with OK' }];
  const tempConfig = { provider, apiKey, model, baseUrl };

  const start = Date.now();
  try {
    const reply = await callProviderWithRetry(tempConfig, testMessages, 'Respond concisely.', { maxTokens: 10 });
    const elapsed = Date.now() - start;
    const preview = typeof reply === 'string' ? reply.slice(0, 80) : '(no text)';
    return {
      success: true,
      message: `Connected successfully (${elapsed}ms). Response: "${preview}"`,
      responseTime: elapsed,
    };
  } catch (err) {
    const elapsed = Date.now() - start;
    return classifyError(err, elapsed, tempConfig);
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

module.exports = { chat, getActiveConfig, getProviderById, getAllProviders, testConnection, migrateFromLegacy, classifyError };
