const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { URL } = require('url');
const { User } = require('../models');
const {
  getActiveDefaultProvider,
  buildDeepgramStreamUrl,
} = require('./transcriptionService');

const WS_PATH = '/api/meeting-stream/ws';

// Close codes reserved for application-level errors.
const CLOSE_NO_PROVIDER = 4001;
const CLOSE_BAD_AUTH = 4401;
const CLOSE_UPSTREAM_ERROR = 4500;

/**
 * Verify the JWT that the client sent in the `Authorization` header or the
 * `token` query parameter. Returns the user object or null.
 */
async function authenticateUpgrade(req) {
  try {
    let token = null;
    const auth = req.headers['authorization'];
    if (auth && auth.startsWith('Bearer ')) token = auth.slice('Bearer '.length);
    if (!token) {
      const u = new URL(req.url, 'http://localhost');
      token = u.searchParams.get('token');
    }
    if (!token) return null;
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findByPk(decoded.id);
    if (!user || !user.isActive) return null;
    return user;
  } catch {
    return null;
  }
}

/**
 * Per-connection bridge state. Buffers audio frames that arrive before the
 * upstream Deepgram socket is OPEN, then flushes them in order.
 */
function createBridge(clientWs, upstreamUrl, apiKey, user, logInfo) {
  let upstream = null;
  let upstreamOpen = false;
  let pending = [];
  let closed = false;
  const connectedAt = Date.now();
  let bytesFromClient = 0;
  let transcriptsEmitted = 0;

  function safeClientSend(obj) {
    if (closed || clientWs.readyState !== WebSocket.OPEN) return;
    try { clientWs.send(JSON.stringify(obj)); } catch { /* client gone */ }
  }

  function closeAll(code, reason) {
    if (closed) return;
    closed = true;
    try { upstream && upstream.readyState <= WebSocket.OPEN && upstream.close(code, reason); } catch {}
    try { clientWs.readyState <= WebSocket.OPEN && clientWs.close(code, reason); } catch {}
    const durationSec = Math.round((Date.now() - connectedAt) / 1000);
    console.log(`[MeetingStream] closed user=${user.id} ${durationSec}s rxBytes=${bytesFromClient} txMsgs=${transcriptsEmitted} reason=${reason || code}`);
  }

  upstream = new WebSocket(upstreamUrl, {
    headers: { Authorization: `Token ${apiKey}` },
    perMessageDeflate: false,
  });

  upstream.on('open', () => {
    upstreamOpen = true;
    safeClientSend({ type: 'ready', provider: logInfo });
    // Flush any pending audio chunks collected before upstream opened.
    for (const frame of pending) {
      try { upstream.send(frame); } catch {}
    }
    pending = [];
  });

  upstream.on('message', (raw) => {
    let parsed;
    try { parsed = JSON.parse(raw.toString()); }
    catch { return; }

    // Deepgram live-transcription payload shape.
    const channel = parsed && parsed.channel;
    const alt = channel && channel.alternatives && channel.alternatives[0];
    if (!alt || typeof alt.transcript !== 'string') {
      // Forward metadata (SpeechStarted, UtteranceEnd, etc.) as-is.
      if (parsed && parsed.type) safeClientSend({ type: 'meta', payload: parsed });
      return;
    }

    // Prefer word-level speaker info when diarization is active.
    const words = Array.isArray(alt.words) ? alt.words : [];
    const groups = [];
    if (words.length) {
      let current = null;
      for (const w of words) {
        const spk = `Speaker ${w.speaker ?? 0}`;
        if (!current || current.speaker !== spk) {
          if (current) groups.push(current);
          current = {
            speaker: spk,
            text: w.punctuated_word || w.word,
            startMs: Math.round((w.start || 0) * 1000),
            endMs: Math.round((w.end || 0) * 1000),
          };
        } else {
          current.text += ' ' + (w.punctuated_word || w.word);
          current.endMs = Math.round((w.end || 0) * 1000);
        }
      }
      if (current) groups.push(current);
    } else if (alt.transcript.trim()) {
      groups.push({
        speaker: 'Speaker 0',
        text: alt.transcript,
        startMs: Math.round((parsed.start || 0) * 1000),
        endMs: Math.round(((parsed.start || 0) + (parsed.duration || 0)) * 1000),
      });
    }

    transcriptsEmitted += 1;
    safeClientSend({
      type: 'transcript',
      isFinal: !!parsed.is_final,
      speechFinal: !!parsed.speech_final,
      segments: groups,
    });
  });

  upstream.on('error', (err) => {
    console.warn('[MeetingStream] upstream error:', err.message);
    safeClientSend({ type: 'error', code: 'upstream_error', message: err.message });
    closeAll(CLOSE_UPSTREAM_ERROR, 'Upstream error');
  });

  upstream.on('close', (code, reason) => {
    if (closed) return;
    safeClientSend({ type: 'closed', code, reason: reason && reason.toString() });
    closeAll(code || 1000, 'Upstream closed');
  });

  clientWs.on('message', (data, isBinary) => {
    // Text messages are control frames (e.g., stop). Binary messages are PCM.
    if (!isBinary) {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg && msg.type === 'stop') {
        if (upstreamOpen) {
          try { upstream.send(JSON.stringify({ type: 'CloseStream' })); } catch {}
        }
        closeAll(1000, 'Client requested stop');
      }
      return;
    }
    bytesFromClient += data.length;
    if (upstreamOpen) {
      try { upstream.send(data); } catch {}
    } else {
      pending.push(data);
    }
  });

  clientWs.on('close', () => closeAll(1000, 'Client disconnected'));
  clientWs.on('error', () => closeAll(1011, 'Client socket error'));

  return { closeAll };
}

/**
 * Attach a WebSocket server to the provided HTTP server at WS_PATH.
 * Handles JWT auth, resolves the active Deepgram provider, and proxies audio.
 */
function attachMeetingStream(server) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    // Only claim upgrades on our path; let Socket.io handle its own.
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch { return; }
    if (pathname !== WS_PATH) return;

    const user = await authenticateUpgrade(req);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const provider = await getActiveDefaultProvider();
    if (!provider) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\nNo active transcription provider configured.');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const upstreamUrl = buildDeepgramStreamUrl(provider);
      console.log(`[MeetingStream] open user=${user.id} provider=${provider.providerType} model=${provider.model}`);
      createBridge(ws, upstreamUrl, provider.apiKey, user, {
        providerType: provider.providerType,
        model: provider.model,
        language: provider.language,
        diarize: provider.diarizationEnabled,
      });
    });
  });

  console.log(`[MeetingStream] WebSocket endpoint ready at ${WS_PATH}`);
  return wss;
}

module.exports = {
  attachMeetingStream,
  WS_PATH,
  CLOSE_NO_PROVIDER,
  CLOSE_BAD_AUTH,
  CLOSE_UPSTREAM_ERROR,
};
