import { useState, useRef, useCallback, useEffect } from 'react';

/* ──────────────────────────────────────────────────────────────
 * Deepgram-backed meeting transcription hook.
 *
 * Public surface intentionally mirrors useSpeechToText so consumers can
 * swap engines via a single boolean toggle:
 *
 *   { isListening, transcript, interim, error, startListening, stopListening }
 *
 * startListening(onFinal) receives speaker-labeled objects:
 *   { speaker, text, startMs, endMs }
 *
 * Transport:
 *   WebSocket → /api/meeting-stream/ws?token=<jwt>
 *   The server proxies PCM frames to Deepgram Streaming API and fans the
 *   JSON transcripts back to us.
 * ────────────────────────────────────────────────────────────── */

const WORKLET_URL = '/audio/pcmWorklet.js';
const RECONNECT_BACKOFF_MS = [500, 1500, 3500];

function resolveWebSocketUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Dev: Vite on :3000 proxies /api to :5000 via standard rules — but WS
  // upgrades don't always proxy cleanly. So we point directly at the API
  // origin in dev; in prod, same-origin.
  const apiOrigin = import.meta.env.VITE_API_WS_ORIGIN
    || (window.location.port === '3000'
      ? `${proto}//${window.location.hostname}:5000`
      : `${proto}//${window.location.host}`);
  return `${apiOrigin.replace(/\/$/, '')}/api/meeting-stream/ws`;
}

// Match the precedence used by services/api.js and AuthContext — the primary
// store is sessionStorage; localStorage is the "remember me" fallback. Using
// only one side here caused the WebSocket upgrade to fire before the token
// was visible, which the UI reported as "Not authenticated".
function readToken() {
  try {
    return (
      sessionStorage.getItem('token')
      || localStorage.getItem('token')
      || ''
    );
  } catch { return ''; }
}

export default function useMeetingTranscription() {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interim, setInterim] = useState('');
  const [error, setError] = useState(null);

  const onFinalCbRef = useRef(null);
  const listeningRef = useRef(false);
  const stoppingRef = useRef(false);

  // Audio graph refs
  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const sourceRef = useRef(null);
  const workletRef = useRef(null);

  // WebSocket refs
  const wsRef = useRef(null);
  const reconnectAttemptRef = useRef(0);

  const stopAll = useCallback(() => {
    stoppingRef.current = true;
    listeningRef.current = false;
    setIsListening(false);
    setInterim('');

    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'stop' })); } catch { /* no-op */ }
    }
    if (ws) {
      try { ws.close(1000, 'client stop'); } catch { /* no-op */ }
    }

    if (workletRef.current) {
      try { workletRef.current.disconnect(); } catch { /* no-op */ }
      workletRef.current = null;
    }
    if (sourceRef.current) {
      try { sourceRef.current.disconnect(); } catch { /* no-op */ }
      sourceRef.current = null;
    }
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch { /* no-op */ }
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      try { streamRef.current.getTracks().forEach(t => t.stop()); } catch { /* no-op */ }
      streamRef.current = null;
    }
    setTimeout(() => { stoppingRef.current = false; }, 100);
  }, []);

  useEffect(() => () => stopAll(), [stopAll]);

  const openSocket = useCallback(() => new Promise((resolve, reject) => {
    const token = readToken();
    if (!token) { reject(new Error('Not authenticated. Please sign in again.')); return; }
    const url = `${resolveWebSocketUrl()}?token=${encodeURIComponent(token)}`;
    let ws;
    try { ws = new WebSocket(url); }
    catch (err) { reject(err); return; }
    wsRef.current = ws;

    const cleanup = () => {
      ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null;
    };

    ws.onopen = () => {
      reconnectAttemptRef.current = 0;
      cleanup();
      wireSocket(ws);
      resolve(ws);
    };
    ws.onerror = () => { cleanup(); reject(new Error('Could not reach the meeting stream service.')); };
    ws.onclose = (ev) => {
      cleanup();
      if (ev.code === 4401 || ev.code === 1008) reject(new Error('Authentication failed for meeting stream.'));
      else reject(new Error(ev.reason || `Meeting stream closed (code ${ev.code}).`));
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  const scheduleReconnect = useCallback(() => {
    if (!listeningRef.current || stoppingRef.current) return;
    const attempt = reconnectAttemptRef.current;
    if (attempt >= RECONNECT_BACKOFF_MS.length) {
      setError('Meeting stream disconnected and could not reconnect. Stop and try again.');
      stopAll();
      return;
    }
    const delay = RECONNECT_BACKOFF_MS[attempt];
    reconnectAttemptRef.current = attempt + 1;
    setTimeout(async () => {
      if (!listeningRef.current || stoppingRef.current) return;
      try {
        await openSocket();
        setError(null);
      } catch (err) {
        scheduleReconnect();
      }
    }, delay);
  }, [openSocket, stopAll]);

  function wireSocket(ws) {
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); }
      catch { return; }
      if (msg.type === 'ready') return;
      if (msg.type === 'error') {
        setError(msg.message || 'Transcription error.');
        return;
      }
      if (msg.type === 'closed') return;
      if (msg.type !== 'transcript') return;

      const segments = Array.isArray(msg.segments) ? msg.segments : [];
      if (segments.length === 0) return;

      // Interim preview: concatenate all speaker texts from the latest non-
      // final result so the user sees live captions.
      if (!msg.isFinal) {
        setInterim(segments.map(s => `${s.speaker}: ${s.text}`).join('  '));
        return;
      }

      setInterim('');
      // Deliver each speaker-labeled final as its own callback so consumers
      // can render one bubble per speaker turn instead of joining strings.
      for (const seg of segments) {
        const text = (seg.text || '').trim();
        if (!text) continue;
        setTranscript(prev => {
          const chunk = `${seg.speaker}: ${text}`;
          return prev ? `${prev}\n${chunk}` : chunk;
        });
        if (onFinalCbRef.current) {
          try { onFinalCbRef.current(seg); }
          catch (cbErr) { console.error('[MeetingTranscription] callback threw:', cbErr); }
        }
      }
    };
    ws.onerror = () => {
      if (!stoppingRef.current) setError('Meeting stream error. Attempting to reconnect…');
    };
    ws.onclose = (ev) => {
      if (stoppingRef.current) return;
      if (ev.code === 4401) {
        setError('Authentication failed for meeting stream.');
        stopAll();
        return;
      }
      if (ev.code === 4001 || ev.code === 503) {
        setError('No active transcription provider configured. Ask an admin to set one up.');
        stopAll();
        return;
      }
      if (listeningRef.current) scheduleReconnect();
    };
  }

  async function startAudioPipeline() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Microphone access is not supported in this browser.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    streamRef.current = stream;

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) throw new Error('Web Audio API is not supported.');
    const ctx = new AudioContextCtor();
    if (ctx.state === 'suspended') await ctx.resume();
    audioCtxRef.current = ctx;

    if (!ctx.audioWorklet || !ctx.audioWorklet.addModule) {
      throw new Error('AudioWorklet is not supported. Use a recent Chrome/Edge.');
    }
    await ctx.audioWorklet.addModule(WORKLET_URL);

    const source = ctx.createMediaStreamSource(stream);
    sourceRef.current = source;

    const worklet = new AudioWorkletNode(ctx, 'pcm-downsampler');
    workletRef.current = worklet;

    worklet.port.onmessage = (event) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try { ws.send(event.data); } catch { /* socket gone */ }
    };

    source.connect(worklet);
    // No connection to destination — we do not want to play the mic back.
  }

  const startListening = useCallback(async (onFinal) => {
    if (listeningRef.current) return;
    onFinalCbRef.current = onFinal;
    setError(null);
    setTranscript('');
    setInterim('');
    stoppingRef.current = false;
    listeningRef.current = true;
    setIsListening(true);
    reconnectAttemptRef.current = 0;

    try {
      await startAudioPipeline();
      await openSocket();
    } catch (err) {
      setError(err.message || 'Failed to start meeting mode.');
      stopAll();
    }
  }, [openSocket, stopAll]);

  const stopListening = useCallback(() => { stopAll(); }, [stopAll]);

  // Mirror useSpeechToText: let the consumer wipe the accumulated transcript
  // after a discard or a successful save so the UI returns to a clean state
  // without re-opening the WebSocket.
  const resetTranscript = useCallback(() => {
    setTranscript('');
    setInterim('');
    setError(null);
  }, []);

  return { isListening, transcript, interim, error, startListening, stopListening, resetTranscript };
}
