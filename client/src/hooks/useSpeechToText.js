import { useState, useRef, useCallback, useEffect } from 'react';

/* ──────────────────────────────────────────────────────────────
 *  GLOBAL SINGLETON GUARD
 *  Chrome only allows one SpeechRecognition session per page.
 *  This module-level variable ensures:
 *   • Starting a new session stops any existing one first
 *   • The stopped hook gets its state cleaned up properly
 * ────────────────────────────────────────────────────────────── */
let _activeInstance = null;  // { id, stop() }

const MAX_NETWORK_RETRIES = 3;
const RETRY_DELAY_MS = 500;

function dbg(...args) {
  if (typeof window !== 'undefined' && window.__SPEECH_DEBUG__) {
    console.log('%c[SpeechToText]', 'color:#10b981;font-weight:bold', ...args);
  }
}

let _hookIdCounter = 0;

/**
 * Browser-native Speech-to-Text hook using the Web Speech API.
 *
 * Debug: run `window.__SPEECH_DEBUG__ = true` in DevTools.
 *
 * IMPORTANT: Only one hook instance can be actively listening at a time.
 * Starting a second instance will cleanly stop the first.
 */
export default function useSpeechToText({
  lang = 'en-US',
  continuous = true,
  interimResults = true,
} = {}) {
  // Stable identity for this hook instance (useRef initialiser runs once)
  const hookIdRef = useRef(null);
  if (hookIdRef.current === null) hookIdRef.current = `stt-${++_hookIdCounter}`;
  const id = hookIdRef.current;

  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interim, setInterim] = useState('');
  const [error, setError] = useState(null);

  // ── Refs (always current, never stale) ──────────────────────
  const recogRef = useRef(null);
  const listeningRef = useRef(false);
  const onFinalCbRef = useRef(null);
  const networkRetriesRef = useRef(0);
  const stoppingRef = useRef(false);
  const committedIndexRef = useRef(-1);
  const lastFinalTextRef = useRef('');

  // Config refs — kept in sync every render
  const langRef = useRef(lang);
  const contRef = useRef(continuous);
  const interimOptRef = useRef(interimResults);
  useEffect(() => { langRef.current = lang; }, [lang]);
  useEffect(() => { contRef.current = continuous; }, [continuous]);
  useEffect(() => { interimOptRef.current = interimResults; }, [interimResults]);

  // ── Cleanup on unmount ──────────────────────────────────────
  useEffect(() => {
    return () => {
      dbg(id, 'unmounting — cleanup');
      killInstance();
      if (_activeInstance?.id === id) _activeInstance = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Internal helpers ────────────────────────────────────────

  function killInstance() {
    const r = recogRef.current;
    if (!r) return;
    r.onstart = null;
    r.onaudiostart = null;
    r.onspeechstart = null;
    r.onspeechend = null;
    r.onresult = null;
    r.onerror = null;
    r.onend = null;
    try { r.stop(); } catch (_) {
      try { r.abort(); } catch (_2) { /* dead */ }
    }
    recogRef.current = null;
  }

  function fullStop() {
    dbg(id, 'fullStop');
    stoppingRef.current = true;
    listeningRef.current = false;
    setIsListening(false);
    setInterim('');
    killInstance();
    networkRetriesRef.current = 0;
    if (_activeInstance?.id === id) _activeInstance = null;
    setTimeout(() => { stoppingRef.current = false; }, 100);
  }

  // ── boot stored in a ref so startListening & auto-restart
  //    always call the LATEST version (no stale closure) ───────
  const bootRef = useRef(null);

  bootRef.current = function boot() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setError('Speech recognition is not supported in this browser. Use Chrome or Edge.');
      return;
    }

    killInstance();

    const r = new SR();
    r.continuous = contRef.current;
    r.interimResults = interimOptRef.current;
    r.lang = langRef.current;
    r.maxAlternatives = 1;

    // ── onstart ──────────────────────────────────────────────
    r.onstart = () => {
      dbg(id, 'onstart ✓ connected, lang=' + r.lang);
      networkRetriesRef.current = 0;
      setError(null);
    };

    r.onaudiostart = () => dbg(id, 'onaudiostart ✓ audio flowing');
    r.onspeechstart = () => dbg(id, 'onspeechstart ✓ speech detected');
    r.onspeechend = () => dbg(id, 'onspeechend – speech stopped');

    // ── onresult ─────────────────────────────────────────────
    r.onresult = (e) => {
      let finalChunk = '';
      let interimChunk = '';

      for (let i = e.resultIndex; i < e.results.length; i++) {
        const seg = e.results[i];
        if (seg.isFinal) {
          if (i <= committedIndexRef.current) {
            dbg(id, 'skipping already-committed index', i);
            continue;
          }
          finalChunk += seg[0].transcript;
          committedIndexRef.current = i;
        } else {
          interimChunk += seg[0].transcript;
        }
      }

      dbg(id, 'onresult', {
        idx: e.resultIndex,
        total: e.results.length,
        committedUpTo: committedIndexRef.current,
        final: finalChunk || '(none)',
        interim: interimChunk || '(none)',
      });

      // ── ALWAYS update interim + transcript state directly ──
      // This guarantees the component re-renders with live text.
      setInterim(interimChunk);

      if (finalChunk) {
        const trimmed = finalChunk.trim();
        // Deduplicate consecutive identical finals
        if (trimmed && trimmed === lastFinalTextRef.current) {
          dbg(id, 'skipping duplicate final:', JSON.stringify(trimmed));
        } else {
          lastFinalTextRef.current = trimmed;

          // Append to the hook-level transcript (visible during recording)
          setTranscript(prev => {
            const sep = prev && !prev.endsWith(' ') && !prev.endsWith('\n') ? ' ' : '';
            return prev + sep + finalChunk;
          });

          // Also call the consumer callback for additional processing
          if (onFinalCbRef.current) {
            dbg(id, '>> delivering final to callback:', JSON.stringify(finalChunk));
            try {
              onFinalCbRef.current(finalChunk);
            } catch (cbErr) {
              console.error('[SpeechToText] callback threw:', cbErr);
            }
          }
        }
      }
    };

    // ── onerror ──────────────────────────────────────────────
    r.onerror = (e) => {
      dbg(id, 'onerror:', e.error);

      switch (e.error) {
        case 'no-speech':
          return;
        case 'aborted':
          return;

        case 'network': {
          const attempt = networkRetriesRef.current + 1;
          networkRetriesRef.current = attempt;
          if (attempt <= MAX_NETWORK_RETRIES && listeningRef.current) {
            dbg(id, `network retry ${attempt}/${MAX_NETWORK_RETRIES}`);
            killInstance();
            setTimeout(() => {
              if (listeningRef.current && !stoppingRef.current) bootRef.current();
            }, RETRY_DELAY_MS * attempt);
            return;
          }
          setError(
            'Could not connect to the speech service.\n' +
            '• Check your internet connection\n' +
            '• A firewall may be blocking Google\'s speech servers\n' +
            '• Refresh the page and try again'
          );
          fullStop();
          return;
        }

        case 'not-allowed':
        case 'service-not-allowed':
          setError('Microphone access denied. Allow mic in browser settings (lock icon → Microphone → Allow).');
          fullStop();
          return;

        case 'audio-capture':
          setError('No microphone found, or another app is using it.');
          fullStop();
          return;

        default:
          setError(`Speech error: ${e.error}`);
          fullStop();
          return;
      }
    };

    // ── onend ────────────────────────────────────────────────
    r.onend = () => {
      dbg(id, 'onend', { stopping: stoppingRef.current, listening: listeningRef.current });
      if (stoppingRef.current) return;

      if (listeningRef.current) {
        dbg(id, 'auto-restarting...');
        committedIndexRef.current = -1;
        lastFinalTextRef.current = '';
        setTimeout(() => {
          if (listeningRef.current && !stoppingRef.current) bootRef.current();
        }, 150);
      } else {
        setInterim('');
      }
    };

    recogRef.current = r;

    try {
      r.start();
      dbg(id, 'start() called');
    } catch (err) {
      dbg(id, 'start() threw:', err);
      if (/already started/i.test(err?.message)) return;
      setError('Failed to start speech recognition. Refresh and try again.');
      fullStop();
    }
  };

  // ── Public API ──────────────────────────────────────────────

  const startListening = useCallback((onFinal) => {
    dbg(id, 'startListening requested');

    // GLOBAL GUARD: stop any other active hook instance first
    if (_activeInstance && _activeInstance.id !== id) {
      dbg(id, 'stopping other active instance:', _activeInstance.id);
      _activeInstance.stop();
    }

    setError(null);
    setTranscript('');
    setInterim('');
    stoppingRef.current = false;
    networkRetriesRef.current = 0;
    committedIndexRef.current = -1;
    lastFinalTextRef.current = '';
    onFinalCbRef.current = onFinal;
    listeningRef.current = true;
    setIsListening(true);

    _activeInstance = { id, stop: () => fullStop() };

    // Call boot via ref — always the latest version
    bootRef.current();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopListening = useCallback(() => {
    dbg(id, 'stopListening requested');
    fullStop();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { isListening, transcript, interim, error, startListening, stopListening };
}
