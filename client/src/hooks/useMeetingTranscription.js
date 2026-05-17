import { useState, useRef, useCallback, useEffect } from 'react';
import api from '../services/api';

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
 *   WebSocket → /api/meeting-stream/ws?token=<ticket>
 *   The server proxies PCM frames to Deepgram Streaming API and fans the
 *   JSON transcripts back to us.
 *
 * Auth (post-D-1 Phase 2):
 *   The access JWT lives in an httpOnly cookie that JS cannot read, and in
 *   dev the WS connects to a different origin than the one the cookie is
 *   bound to. So we first ask the backend (over an authenticated HTTP
 *   call that carries the cookie) for a short-lived "meeting-ws" ticket
 *   and pass it in the query string. Legacy storage-token clients keep
 *   working via the 404 fallback below.
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

// Legacy fallback only — used when the backend ticket endpoint is missing
// (e.g. transitional deploy where the frontend ships before the backend).
// New sessions never have a token here because login writes only to the
// httpOnly cookie; we keep the read so users mid-migration aren't broken.
function readLegacyStorageToken() {
  try {
    return (
      sessionStorage.getItem('token')
      || localStorage.getItem('token')
      || ''
    );
  } catch { return ''; }
}

/**
 * Fetch a short-lived WebSocket ticket from the backend. The HTTP call
 * carries the auth cookie automatically (api client has withCredentials).
 *
 * On success: returns the ticket string.
 * On 404 (endpoint not yet deployed): returns the legacy storage token
 *   if present, otherwise empty.
 * On 401: throws an auth-tagged Error so the caller surfaces the right
 *   "session expired" copy.
 * On network / 5xx: throws a network-tagged Error.
 */
async function fetchMeetingWsTicket() {
  try {
    // Pass {} (not null) — axios serializes a null body to the literal string
    // "null", which express.json() strict mode rejects with 400.
    const res = await api.post('/meeting-stream/ticket', {}, { _silent: true });
    const ticket = res?.data?.data?.ticket || res?.data?.ticket;
    if (ticket) return ticket;
    // Shape mismatch — treat as fallback path.
    const legacy = readLegacyStorageToken();
    if (legacy) return legacy;
    const err = new Error('Your session expired. Please sign in again.');
    err._authFailure = true;
    throw err;
  } catch (err) {
    if (err && err._authFailure) throw err;
    const status = err?.response?.status;
    if (status === 404) {
      // Backend hasn't been deployed with the ticket endpoint yet — fall
      // back to whatever token still lives in storage (pre-Phase-2 clients).
      const legacy = readLegacyStorageToken();
      if (legacy) return legacy;
      const fail = new Error('Your session expired. Please sign in again.');
      fail._authFailure = true;
      throw fail;
    }
    if (status === 401 || status === 403) {
      const fail = new Error('Your session expired. Please sign in again.');
      fail._authFailure = true;
      throw fail;
    }
    const netErr = new Error('Could not reach the meeting stream service.');
    netErr._networkFailure = true;
    throw netErr;
  }
}

export default function useMeetingTranscription() {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interim, setInterim] = useState('');
  const [error, setError] = useState(null);

  // Phase D — observable diagnostics. Exposed so the UI can render a
  // small "WS: open · rx: 12 · interim: 47ch" strip during recording.
  // Lets us tell-at-a-glance whether the breakdown is in (a) the WS
  // connection, (b) message receipt, (c) message filtering, or
  // (d) React rendering — without forcing the user into DevTools.
  const [diagnostics, setDiagnostics] = useState({
    wsState: 'idle', // idle | connecting | open | closed | error
    totalMsgs: 0,
    transcriptMsgs: 0,
    nonEmptyTranscripts: 0,
    bytesSent: 0,
    lastMsgAt: null,
    // micLevel = peak RMS of the most recent PCM frame, normalized 0-100.
    // Tells us whether the OS is actually delivering audio (vs. silent
    // frames). When this stays at 0 while bytesSent climbs, the mic is
    // muted at OS / hardware level.
    micLevel: 0,
    micPeakLevel: 0, // running peak over the session
    deviceLabel: '',
  });
  const diagRef = useRef({
    wsState: 'idle',
    totalMsgs: 0,
    transcriptMsgs: 0,
    nonEmptyTranscripts: 0,
    bytesSent: 0,
    lastMsgAt: null,
    micLevel: 0,
    micPeakLevel: 0,
    deviceLabel: '',
  });
  const diagFlushTimerRef = useRef(null);
  function flushDiag() {
    if (diagFlushTimerRef.current) return;
    diagFlushTimerRef.current = setTimeout(() => {
      diagFlushTimerRef.current = null;
      setDiagnostics({ ...diagRef.current });
    }, 250);
  }
  function bumpDiag(patch) {
    diagRef.current = { ...diagRef.current, ...patch };
    flushDiag();
  }

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
    bumpDiag({ wsState: 'closed' });

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
    // The ticket fetch is async; wrap the chain so the Promise constructor
    // still surfaces the eventual rejection / resolution.
    (async () => {
      let ticket;
      try {
        ticket = await fetchMeetingWsTicket();
      } catch (err) {
        reject(err);
        return;
      }
      const url = `${resolveWebSocketUrl()}?token=${encodeURIComponent(ticket)}`;
      let ws;
      try { ws = new WebSocket(url); }
      catch (err) { reject(err); return; }
      wsRef.current = ws;
      bumpDiag({ wsState: 'connecting' });

      const cleanup = () => {
        ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null;
      };

      ws.onopen = () => {
        reconnectAttemptRef.current = 0;
        bumpDiag({ wsState: 'open' });
        cleanup();
        wireSocket(ws);
        resolve(ws);
      };
      ws.onerror = () => {
        cleanup();
        const netErr = new Error('Could not reach the meeting stream service.');
        netErr._networkFailure = true;
        reject(netErr);
      };
      ws.onclose = (ev) => {
        cleanup();
        if (ev.code === 4401 || ev.code === 1008) {
          const authErr = new Error('Your session expired. Please sign in again.');
          authErr._authFailure = true;
          reject(authErr);
        } else if (ev.code === 4001 || ev.code === 503) {
          const provErr = new Error('No active transcription provider configured.');
          provErr._providerFailure = true;
          reject(provErr);
        } else {
          reject(new Error(ev.reason || `Meeting stream closed (code ${ev.code}).`));
        }
      };
    })();
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
      // Count EVERY message before any filtering so the diagnostic strip
      // can tell us whether messages are arriving at all.
      diagRef.current.totalMsgs += 1;
      diagRef.current.lastMsgAt = Date.now();
      let msg;
      try { msg = JSON.parse(ev.data); }
      catch { flushDiag(); return; }
      if (msg.type === 'ready') { flushDiag(); return; }
      if (msg.type === 'error') {
        setError(msg.message || 'Transcription error.');
        flushDiag();
        return;
      }
      if (msg.type === 'closed') { flushDiag(); return; }
      if (msg.type !== 'transcript') { flushDiag(); return; }

      diagRef.current.transcriptMsgs += 1;
      const segments = Array.isArray(msg.segments) ? msg.segments : [];
      if (segments.length === 0) { flushDiag(); return; }
      diagRef.current.nonEmptyTranscripts += 1;
      flushDiag();

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
      if (ev.code === 4401 || ev.code === 1008) {
        setError('Your session expired. Please sign in again.');
        stopAll();
        return;
      }
      if (ev.code === 4001 || ev.code === 503) {
        setError('No active transcription provider configured.');
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
    // Surface the device the browser actually picked so the user can
    // confirm it's the right mic (and not e.g. a disconnected Bluetooth
    // headset that's first in the device list).
    try {
      const track = stream.getAudioTracks()[0];
      if (track) {
        diagRef.current.deviceLabel = track.label || '(unnamed)';
        flushDiag();
      }
    } catch { /* getAudioTracks rarely throws */ }

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
      try {
        ws.send(event.data);
        diagRef.current.bytesSent += event.data?.byteLength || 0;
        // Mic-level meter. event.data is an ArrayBuffer holding Int16 PCM
        // samples. RMS in Int16 range (max 32767) → normalized 0-100. If
        // this is 0 while bytesSent climbs, the OS is delivering silent
        // frames (mic muted, wrong device picked, or Voice Isolation
        // blocking input). That's the smoking gun the user needs.
        if (event.data && event.data.byteLength) {
          const view = new Int16Array(event.data);
          let sumSquares = 0;
          // Sample every 8th value — full pass on a 1600-sample frame is
          // overkill 30x/sec; 200 samples is enough for a UI meter.
          for (let i = 0; i < view.length; i += 8) {
            const v = view[i];
            sumSquares += v * v;
          }
          const rms = Math.sqrt(sumSquares / (view.length / 8));
          const level = Math.min(100, Math.round((rms / 8000) * 100));
          diagRef.current.micLevel = level;
          if (level > diagRef.current.micPeakLevel) {
            diagRef.current.micPeakLevel = level;
          }
        }
        flushDiag();
      } catch { /* socket gone */ }
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
    // Reset diagnostics so the live strip starts at zero for the new
    // recording — otherwise a previous session's tx count would survive.
    diagRef.current = {
      wsState: 'idle', totalMsgs: 0, transcriptMsgs: 0,
      nonEmptyTranscripts: 0, bytesSent: 0, lastMsgAt: null,
      micLevel: 0, micPeakLevel: 0, deviceLabel: '',
    };
    setDiagnostics({ ...diagRef.current });

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

  return {
    isListening, transcript, interim, error,
    startListening, stopListening, resetTranscript,
    // Phase D — read-only diagnostics for the live UI strip.
    diagnostics,
  };
}
