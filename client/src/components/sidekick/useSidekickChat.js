import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import api from '../../services/api';
import safeLog from '../../utils/safeLog';
import { getErrorMessage } from '../../utils/errorMap';

/**
 * useSidekickChat — chat-thread state machine for the Sidekick.
 *
 *   const {
 *     messages, status, error, configured, send, stop, reset,
 *   } = useSidekickChat({ pageContext, pageState, scope, scopeId, history });
 *
 * Behavior:
 *   - Wraps the existing /api/ai/chat endpoint (single-shot reply for now).
 *   - Tracks a `status` of 'idle' | 'thinking' | 'streaming' | 'error' so the
 *     UI can show the right indicator + stop button.
 *   - `stop()` aborts an in-flight request (Axios CancelToken / AbortController).
 *
 * When the backend gains real streaming, this hook is the single swap point —
 * the rest of the UI (response card, composer, FAB) stays unchanged.
 */

const initialState = {
  messages: [],
  status: 'idle', // 'idle' | 'thinking' | 'streaming' | 'error'
  error: '',
};

function reducer(state, action) {
  switch (action.type) {
    case 'reset':
      return { messages: [], status: 'idle', error: '' };
    case 'hydrate':
      return { ...state, messages: action.messages || [] };
    case 'send':
      return {
        ...state,
        messages: [...state.messages, action.message],
        status: 'thinking',
        error: '',
      };
    case 'reply':
      return {
        ...state,
        messages: [...state.messages, action.message],
        status: 'idle',
      };
    case 'streaming':
      return { ...state, status: 'streaming' };
    case 'error':
      return {
        ...state,
        messages: [...state.messages, { role: 'error', content: action.message }],
        status: 'error',
        error: action.message,
      };
    case 'aborted':
      return { ...state, status: 'idle', error: '' };
    default:
      return state;
  }
}

export default function useSidekickChat({
  pageContext = '',
  pageState = {},
  scope,
  scopeId,
  history = null,
  historyKey = null,
} = {}) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const controllerRef = useRef(null);
  const configuredRef = useRef(null);

  // Hydrate from `history` prop (consumer-owned) OR localStorage by historyKey.
  // We keep this dumb on purpose — the chats-list rail owns the persistence,
  // and just hands us a starting messages[] when restoring an old chat.
  useEffect(() => {
    if (Array.isArray(history)) {
      dispatch({ type: 'hydrate', messages: history });
      return;
    }
    if (historyKey) {
      try {
        const raw = localStorage.getItem(historyKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) dispatch({ type: 'hydrate', messages: parsed });
        }
      } catch {
        /* ignore — fresh start is fine */
      }
    }
  }, [history, historyKey]);

  // Persist to localStorage on every message change, when historyKey is set.
  useEffect(() => {
    if (!historyKey) return;
    try { localStorage.setItem(historyKey, JSON.stringify(state.messages)); }
    catch { /* quota — drop silently */ }
  }, [state.messages, historyKey]);

  const configured = useMemo(() => configuredRef.current, [configuredRef.current]);

  // Probe AI configuration once. Subsequent sends rely on the same probe
  // result so we don't double-check on every send.
  useEffect(() => {
    let cancelled = false;
    api.get('/ai/config').then((res) => {
      if (cancelled) return;
      const data = res.data?.data || res.data || {};
      configuredRef.current = !!data.hasKey;
    }).catch(() => {
      if (!cancelled) configuredRef.current = false;
    });
    return () => { cancelled = true; };
  }, []);

  const send = useCallback(async (text) => {
    const trimmed = (text || '').trim();
    if (!trimmed || state.status === 'thinking' || state.status === 'streaming') return;

    const userMessage = { role: 'user', content: trimmed, ts: Date.now() };
    dispatch({ type: 'send', message: userMessage });

    // Build chat history slice — last 20 user+assistant turns, skipping errors.
    const convo = [...state.messages, userMessage]
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-20);

    const controller = new AbortController();
    controllerRef.current = controller;

    try {
      // Skill §6.4: scoped chat carries a `scope` + `scopeId` so the backend
      // can rehydrate the right context (meeting transcript, doc body, etc.).
      const body = {
        messages: convo,
        context: pageContext,
        pageState,
        ...(scope ? { scope, scopeId } : {}),
      };
      const res = await api.post('/ai/chat', body, { signal: controller.signal });
      const reply = res.data?.data?.message || res.data?.message || 'No response received.';
      dispatch({
        type: 'reply',
        message: { role: 'assistant', content: reply, ts: Date.now() },
      });
    } catch (err) {
      if (err?.name === 'CanceledError' || err?.name === 'AbortError' || axiosWasCancelled(err)) {
        dispatch({ type: 'aborted' });
        return;
      }
      safeLog.error('[useSidekickChat] send error', err);
      dispatch({ type: 'error', message: getErrorMessage(err) });
    } finally {
      controllerRef.current = null;
    }
  }, [pageContext, pageState, scope, scopeId, state.messages, state.status]);

  const stop = useCallback(() => {
    if (controllerRef.current) {
      controllerRef.current.abort();
      controllerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    if (controllerRef.current) controllerRef.current.abort();
    controllerRef.current = null;
    dispatch({ type: 'reset' });
    if (historyKey) {
      try { localStorage.removeItem(historyKey); } catch {}
    }
  }, [historyKey]);

  return {
    messages: state.messages,
    status: state.status,
    error: state.error,
    configured,
    send,
    stop,
    reset,
  };
}

function axiosWasCancelled(err) {
  // Axios v1 throws CanceledError; older shims set err.__CANCEL__.
  return !!(err && (err.__CANCEL__ || err.message === 'canceled'));
}
