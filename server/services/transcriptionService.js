const https = require('https');
const { URL } = require('url');
const { TranscriptionProvider } = require('../models');
const { decrypt } = require('../utils/encryption');
const safeLogger = require('../utils/safeLogger');

const DEEPGRAM_API_HOST = 'api.deepgram.com';
const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen';
const DEEPGRAM_VERIFY_PATH = '/v1/projects';

// Sarvam AI is a batch (HTTP multipart) speech-to-text API — it does NOT speak
// the Deepgram live-streaming WebSocket protocol. The meeting-stream bridge
// adapts to it by buffering PCM into short windows and POSTing each window to
// this endpoint (see meetingStreamService.createSarvamBridge).
const SARVAM_STT_URL = 'https://api.sarvam.ai/speech-to-text';

// BCP-47 codes Sarvam supports, plus the auto-detect sentinel.
const SARVAM_LANGS = new Set([
  'hi-IN', 'bn-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'od-IN', 'pa-IN',
  'ta-IN', 'te-IN', 'en-IN', 'gu-IN', 'unknown',
]);

/**
 * Classify a provider into one of the two transport kinds we support:
 *   - 'sarvam'   → batch HTTP multipart (buffered windows)
 *   - 'deepgram' → live WebSocket streaming (also used for 'custom' endpoints
 *                  that implement the Deepgram Live protocol)
 */
function providerKind(provider) {
  return provider && provider.providerType === 'sarvam' ? 'sarvam' : 'deepgram';
}

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
    safeLogger.error('[TranscriptionService] Failed to decrypt provider key', { err });
    return null;
  }

  const defaultModel = provider.providerType === 'sarvam' ? 'saarika:v2.5' : 'nova-3';
  return {
    id: provider.id,
    name: provider.name,
    providerType: provider.providerType,
    apiKey,
    model: provider.model || defaultModel,
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

// ── Sarvam helpers ──────────────────────────────────────────────────────────

/** Resolve the Sarvam STT endpoint, honouring a user-supplied baseUrl. */
function sarvamSttUrl(baseUrl) {
  const b = (baseUrl || '').trim();
  if (b && /^https?:\/\//i.test(b)) return b.replace(/\/$/, '');
  return SARVAM_STT_URL;
}

/** Map our generic language values onto a code Sarvam accepts (or auto-detect). */
function normalizeSarvamLanguage(lang) {
  if (!lang) return 'unknown';
  if (SARVAM_LANGS.has(lang)) return lang;
  const map = {
    'en-US': 'en-IN', 'en-GB': 'en-IN', en: 'en-IN',
    hi: 'hi-IN', multi: 'unknown', auto: 'unknown',
  };
  return map[lang] || 'unknown';
}

/**
 * Wrap raw 16-bit little-endian mono PCM in a minimal WAV container so the
 * Sarvam REST endpoint can decode it. The browser worklet emits exactly this
 * format (linear16 / 16 kHz / mono), matching the Deepgram streaming path.
 */
function pcmToWav(pcm, sampleRate = 16000, channels = 1) {
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);          // fmt chunk size (PCM)
  header.writeUInt16LE(1, 20);           // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Normalize a Sarvam STT JSON response into our canonical segment shape:
 *   { speaker, text, startMs, endMs }
 * Uses diarized entries when present (batch API only); otherwise a single
 * Speaker 0 segment carrying the whole transcript.
 */
function parseSarvamResponse(json) {
  if (!json) return { transcript: '', segments: [] };
  const transcript = typeof json.transcript === 'string' ? json.transcript.trim() : '';

  const dia = json.diarized_transcript;
  if (dia && Array.isArray(dia.entries) && dia.entries.length) {
    const segments = dia.entries
      .filter((e) => e && typeof e.transcript === 'string' && e.transcript.trim())
      .map((e) => ({
        speaker: `Speaker ${e.speaker_id ?? 0}`,
        text: e.transcript.trim(),
        startMs: Math.round((e.start_time_seconds || 0) * 1000),
        endMs: Math.round((e.end_time_seconds || 0) * 1000),
      }));
    if (segments.length) return { transcript, segments };
  }

  if (!transcript) return { transcript: '', segments: [] };
  return { transcript, segments: [{ speaker: 'Speaker 0', text: transcript, startMs: 0, endMs: 0 }] };
}

/**
 * Transcribe a single window of raw PCM via the Sarvam REST endpoint.
 * Returns { ok, status, transcript, segments, error }.
 */
async function transcribeSarvamPcm(pcmBuffer, provider) {
  const model = provider.model || 'saarika:v2.5';
  const wav = pcmToWav(pcmBuffer, 16000, 1);

  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', model);
  const lang = normalizeSarvamLanguage(provider.language);
  if (lang) form.append('language_code', lang);
  // `mode` is only valid for the saaras family; default to plain transcription.
  if (model.startsWith('saaras')) form.append('mode', 'transcribe');

  let res;
  try {
    res = await fetch(sarvamSttUrl(provider.baseUrl), {
      method: 'POST',
      headers: { 'api-subscription-key': provider.apiKey },
      body: form,
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    return { ok: false, status: 0, error: err.message, transcript: '', segments: [] };
  }

  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }

  if (!res.ok) {
    const detail = json && (json.error?.message || json.error || json.message);
    return {
      ok: false,
      status: res.status,
      error: detail || `HTTP ${res.status}`,
      transcript: '',
      segments: [],
    };
  }

  return { ok: true, status: res.status, ...parseSarvamResponse(json) };
}

// ── Connection tests ─────────────────────────────────────────────────────────

/**
 * Verify a Sarvam key by transcribing a brief silent WAV. A valid key returns
 * 200 (empty transcript); a bad key returns 401/403.
 */
async function testSarvamConnection(apiKey, baseUrl) {
  // 0.3 s of digital silence — enough for the endpoint to accept and decode.
  const silence = Buffer.alloc(Math.floor(16000 * 2 * 0.3));
  const wav = pcmToWav(silence, 16000, 1);

  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'probe.wav');
  form.append('model', 'saarika:v2.5');
  form.append('language_code', 'unknown');

  try {
    const res = await fetch(sarvamSttUrl(baseUrl), {
      method: 'POST',
      headers: { 'api-subscription-key': apiKey },
      body: form,
      signal: AbortSignal.timeout(15000),
    });

    if (res.ok) {
      return { success: true, message: 'Connection successful. Sarvam API key verified.', httpStatus: res.status };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        success: false,
        message: 'Invalid API key — Sarvam rejected the subscription key.',
        httpStatus: res.status,
        failureType: 'unauthorized',
      };
    }
    let detail = '';
    try {
      const j = await res.json();
      const m = j && (j.error?.message || j.error || j.message);
      if (m) detail = ` (${typeof m === 'string' ? m : JSON.stringify(m)})`;
    } catch { /* ignore */ }
    return {
      success: false,
      message: `Sarvam responded with HTTP ${res.status}.${detail}`,
      httpStatus: res.status,
      failureType: 'http_error',
    };
  } catch (err) {
    if (err.name === 'TimeoutError') {
      return { success: false, message: 'Request timed out reaching Sarvam.', failureType: 'timeout' };
    }
    return { success: false, message: `Network error: ${err.message}`, failureType: 'network_error' };
  }
}

/**
 * Verify a Deepgram (or Deepgram-compatible custom) key.
 * GET /v1/projects with `Authorization: Token <key>`.
 */
function testDeepgramConnection(providerType, apiKey, baseUrl) {
  const label = providerType === 'deepgram' ? 'Deepgram' : 'Endpoint';

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
            ? `Invalid API key — ${label} returned 401 Unauthorized.`
            : `${label} responded with HTTP ${res.statusCode}.`,
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

/**
 * Test a provider by pinging its credential-verification endpoint, dispatching
 * on the provider type.
 */
function testProviderConnection(providerType, apiKey, baseUrl) {
  if (providerType === 'sarvam') return testSarvamConnection(apiKey, baseUrl);
  if (providerType === 'deepgram' || providerType === 'custom') {
    return testDeepgramConnection(providerType, apiKey, baseUrl);
  }
  return Promise.resolve({
    success: false,
    message: `Unknown transcription provider type: ${providerType}`,
    failureType: 'unknown_provider',
  });
}

module.exports = {
  getActiveDefaultProvider,
  buildDeepgramStreamUrl,
  testProviderConnection,
  providerKind,
  transcribeSarvamPcm,
  pcmToWav,
  normalizeSarvamLanguage,
  DEEPGRAM_WS_URL,
  SARVAM_STT_URL,
};
