const https = require('https');
const { URL } = require('url');
const { TranscriptionProvider } = require('../models');
const { decrypt } = require('../utils/encryption');

const DEEPGRAM_API_HOST = 'api.deepgram.com';
const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen';
const DEEPGRAM_VERIFY_PATH = '/v1/projects';

/**
 * Resolve the active-default transcription provider and return its decrypted
 * credentials. Returns null if none configured.
 */
async function getActiveDefaultProvider() {
  const provider = await TranscriptionProvider.findOne({
    where: { isActive: true, isDefault: true },
  });
  if (!provider) return null;

  let apiKey;
  try { apiKey = decrypt(provider.apiKey); }
  catch (err) {
    console.error('[TranscriptionService] Failed to decrypt provider key:', err.message);
    return null;
  }

  return {
    id: provider.id,
    name: provider.name,
    providerType: provider.providerType,
    apiKey,
    model: provider.model || 'nova-3',
    language: provider.language || 'en-US',
    baseUrl: provider.baseUrl || '',
    diarizationEnabled: !!provider.diarizationEnabled,
  };
}

/**
 * Build the Deepgram streaming WebSocket URL with the required query params.
 */
function buildDeepgramStreamUrl(provider) {
  const base = provider.baseUrl || DEEPGRAM_WS_URL;
  const url = new URL(base);
  const params = {
    model: provider.model || 'nova-3',
    language: provider.language || 'en-US',
    diarize: provider.diarizationEnabled ? 'true' : 'false',
    interim_results: 'true',
    punctuate: 'true',
    smart_format: 'true',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/**
 * Test a provider by pinging its credential-verification endpoint.
 * For Deepgram: GET /v1/projects with `Authorization: Token <key>`.
 */
function testProviderConnection(providerType, apiKey, baseUrl) {
  if (providerType !== 'deepgram' && providerType !== 'custom') {
    return Promise.resolve({
      success: false,
      message: `Unknown transcription provider type: ${providerType}`,
      failureType: 'unknown_provider',
    });
  }

  let host = DEEPGRAM_API_HOST;
  let path = DEEPGRAM_VERIFY_PATH;
  if (providerType === 'custom' && baseUrl) {
    try {
      const u = new URL(baseUrl);
      host = u.host;
      path = u.pathname.replace(/\/$/, '') + (u.pathname.endsWith('/projects') ? '' : '/v1/projects');
    } catch {
      return Promise.resolve({
        success: false,
        message: 'Invalid base URL for custom provider.',
        failureType: 'invalid_url',
      });
    }
  }

  return new Promise((resolve) => {
    const req = https.request({
      method: 'GET',
      host,
      path,
      headers: {
        Authorization: `Token ${apiKey}`,
        'User-Agent': 'Aniston-Task-Manager/1.0',
      },
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          return resolve({
            success: true,
            message: 'Connection successful. API key verified.',
            httpStatus: res.statusCode,
          });
        }
        resolve({
          success: false,
          message: res.statusCode === 401
            ? 'Invalid API key — Deepgram returned 401 Unauthorized.'
            : `Deepgram responded with HTTP ${res.statusCode}.`,
          httpStatus: res.statusCode,
          failureType: res.statusCode === 401 ? 'unauthorized' : 'http_error',
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        success: false,
        message: 'Request timed out. Check your network or the provider URL.',
        failureType: 'timeout',
      });
    });
    req.on('error', (err) => {
      resolve({
        success: false,
        message: `Network error: ${err.message}`,
        failureType: 'network_error',
      });
    });
    req.end();
  });
}

module.exports = {
  getActiveDefaultProvider,
  buildDeepgramStreamUrl,
  testProviderConnection,
  DEEPGRAM_WS_URL,
};
