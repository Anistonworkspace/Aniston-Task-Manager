import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import api from '../../services/api';
import safeLog from '../../utils/safeLog';

/* ──────────────────────────────────────────────────────────────
 * Phase G — real-time collaborative editing for docs.
 *
 * useDocCollab opens a Y.js + Hocuspocus session for the given docId,
 * piggy-backing on the same WebSocket transport pattern as the meeting
 * stream (see useMeetingTranscription.js):
 *
 *   1. POST /api/docs-collab/ticket  →  short-lived JWT bound to the user
 *      + this docId. The JWT is carried in the auth cookie that JS can't
 *      read, so we explicitly trade it for a ticket the WS handshake can
 *      use. Lets the hook work in dev where Vite's :3000 and the API's
 *      :5000 are different origins.
 *   2. new HocuspocusProvider({ url, name: docId, token, document })
 *      Hocuspocus owns the WS lifecycle; we just listen for status /
 *      awareness events.
 *
 * Public surface — stable across renders so React.StrictMode's mount /
 * unmount / remount cycle doesn't leak provider instances:
 *
 *   {
 *     ydoc,        // Y.Doc instance (null until enabled+connected)
 *     provider,    // HocuspocusProvider instance (null until enabled)
 *     status,      // 'idle' | 'disabled' | 'connecting' | 'connected' | 'error'
 *     peerCount,   // number of OTHER awareness states (excludes self)
 *     error,       // Error or null. Flagged with `_collabMigrationMissing`
 *                  // when the server refuses with "Doc not migrated for
 *                  // collab" so DocPage can render the banner + fall back
 *                  // to HTTP autosave.
 *   }
 *
 * The hook does NOT swallow the connection error — DocPage's gating
 * logic decides whether to render the editor in collab mode or single-
 * user HTTP autosave mode based on `status === 'connected' && !error`.
 * ────────────────────────────────────────────────────────────── */

function resolveWebSocketUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const apiOrigin = import.meta.env.VITE_API_WS_ORIGIN
    || (window.location.port === '3000'
      ? `${proto}//${window.location.hostname}:5000`
      : `${proto}//${window.location.host}`);
  return `${apiOrigin.replace(/\/$/, '')}/api/docs-collab/ws`;
}

/**
 * Fetch a short-lived collab ticket scoped to this docId. Mirrors
 * fetchMeetingWsTicket in useMeetingTranscription. The cookie carries
 * the user's identity; the server hands back a JWT that includes the
 * docId so the WS handshake can be authenticated AND authorized in one
 * step without a follow-up DB lookup.
 *
 * Surfaces three flavors of failure via tagged Error.message:
 *   - 401/403           → "Your session expired…"
 *   - 404 doc not found → "This doc no longer exists."
 *   - 409/410/412 +     → "Doc not migrated for collab" (collab _migrationMissing flag)
 *   - network / 5xx     → "Could not reach the collab service."
 */
async function fetchDocCollabTicket(docId) {
  try {
    const res = await api.post(`/docs-collab/ticket`, { docId }, { _silent: true });
    const ticket = res?.data?.data?.ticket || res?.data?.ticket;
    if (ticket) return ticket;
    const err = new Error('Collab ticket missing from server response.');
    err._collabFailure = true;
    throw err;
  } catch (err) {
    if (err && err._collabFailure) throw err;
    const status = err?.response?.status;
    const serverMessage =
      err?.response?.data?.message ||
      err?.response?.data?.error ||
      '';
    // Server's polite way of saying "this doc still lives in contentJson;
    // no Y.Doc snapshot exists yet". Surface as a special flag so DocPage
    // can show the banner + fall back to HTTP autosave instead of
    // bricking the editor.
    if (
      status === 409 || status === 410 || status === 412 ||
      /not migrated/i.test(serverMessage)
    ) {
      const e = new Error(serverMessage || 'Doc not migrated for collab.');
      e._collabMigrationMissing = true;
      throw e;
    }
    if (status === 401 || status === 403) {
      const e = new Error('Your session expired. Please sign in again.');
      e._authFailure = true;
      throw e;
    }
    if (status === 404) {
      const e = new Error('This doc no longer exists.');
      e._notFound = true;
      throw e;
    }
    const netErr = new Error('Could not reach the collab service.');
    netErr._networkFailure = true;
    throw netErr;
  }
}

/**
 * Stable hash → deterministic color. Mirrors the pickColor used in
 * DocPage so CollaborationCursor caret colors stay consistent with any
 * presence chips the rest of the UI renders for the same user.
 */
const COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];
export function pickColor(userId) {
  let hash = 0;
  for (const c of String(userId || '')) hash = (hash * 31 + c.charCodeAt(0)) & 0x7fffffff;
  return COLORS[hash % COLORS.length];
}

export default function useDocCollab({ docId, enabled, currentUser } = {}) {
  const [ydoc, setYdoc] = useState(null);
  const [provider, setProvider] = useState(null);
  const [status, setStatus] = useState(enabled ? 'idle' : 'disabled');
  const [peerCount, setPeerCount] = useState(0);
  const [error, setError] = useState(null);

  // Refs so the cleanup closure always sees the latest instances even if
  // the docId changes mid-flight and a new effect already fired.
  const providerRef = useRef(null);
  const ydocRef = useRef(null);
  // Single-flight guard: prevents React.StrictMode's double-invocation
  // from spinning up two providers for the same docId. The first effect
  // fires, sets sessionKeyRef.current = `${docId}`, opens the provider,
  // then the second effect sees the same key and short-circuits.
  const sessionKeyRef = useRef(null);

  useEffect(() => {
    // Disable path — explicit so DocPage can flip a feature flag without
    // remounting the page.
    if (!enabled || !docId) {
      setStatus(enabled ? 'idle' : 'disabled');
      setPeerCount(0);
      setError(null);
      return undefined;
    }

    let cancelled = false;
    const sessionKey = `${docId}`;
    sessionKeyRef.current = sessionKey;

    const cleanupLocal = () => {
      cancelled = true;
      const p = providerRef.current;
      const y = ydocRef.current;
      providerRef.current = null;
      ydocRef.current = null;
      if (p) {
        try { p.destroy(); } catch (e) { safeLog.warn('[useDocCollab] provider.destroy failed', e); }
      }
      if (y) {
        try { y.destroy(); } catch (e) { safeLog.warn('[useDocCollab] ydoc.destroy failed', e); }
      }
      if (sessionKeyRef.current === sessionKey) sessionKeyRef.current = null;
    };

    (async () => {
      setStatus('connecting');
      setError(null);
      setPeerCount(0);

      let ticket;
      try {
        ticket = await fetchDocCollabTicket(docId);
      } catch (err) {
        if (cancelled) return;
        safeLog.warn('[useDocCollab] ticket fetch failed', err);
        setError(err);
        setStatus('error');
        return;
      }
      if (cancelled) return;

      // Create the Y.Doc + provider together so they share an identity.
      // If we created the ydoc earlier and then aborted before the
      // provider attached, we'd leak the doc.
      let nextDoc;
      let nextProvider;
      try {
        nextDoc = new Y.Doc();
        const wsUrl = resolveWebSocketUrl();
        nextProvider = new HocuspocusProvider({
          url: wsUrl,
          name: docId,
          token: ticket,
          document: nextDoc,
          // We attach event listeners after construction; don't auto-
          // start a fresh connection on token refresh (the provider does
          // this anyway, but explicit beats implicit).
          connect: true,
          // forceSyncInterval is intentionally left at the default; the
          // server sends updates immediately on every transact.
        });
      } catch (err) {
        if (cancelled) return;
        safeLog.error('[useDocCollab] provider construction failed', err);
        try { nextDoc?.destroy(); } catch (e) { /* no-op */ }
        try { nextProvider?.destroy(); } catch (e) { /* no-op */ }
        setError(err);
        setStatus('error');
        return;
      }

      providerRef.current = nextProvider;
      ydocRef.current = nextDoc;
      setYdoc(nextDoc);
      setProvider(nextProvider);

      // Hocuspocus events:
      //   onStatus({ status: 'connecting' | 'connected' | 'disconnected' })
      //   onSynced({ state })   first round-trip complete; doc state primed
      //   onAuthenticationFailed(reason) → ticket was rejected
      //   onClose(event)        ws closed
      //   awarenessChange       presence updates
      const onStatus = ({ status: s }) => {
        if (cancelled || sessionKeyRef.current !== sessionKey) return;
        // Re-fetched in case the user lost connectivity and the provider
        // is reconnecting. We map directly because Hocuspocus's status
        // strings align with our own state machine.
        if (s === 'connected') setStatus('connected');
        else if (s === 'connecting') setStatus('connecting');
        else if (s === 'disconnected') {
          // Provider will auto-retry; stay in 'connecting' so DocPage's
          // "🟡 Reconnecting…" pill stays correct.
          setStatus('connecting');
        }
      };

      const onSynced = () => {
        if (cancelled || sessionKeyRef.current !== sessionKey) return;
        // onSynced fires once the initial state is in. Keep status at
        // 'connected' (it should already be) — the meaningful thing
        // here is that the editor is now safe to render with collab
        // content.
        setStatus('connected');
      };

      const onAuthFail = (data) => {
        if (cancelled || sessionKeyRef.current !== sessionKey) return;
        const reasonText = (data?.reason || data?.message || '').toString();
        // Surface a "needs migration" failure the same way the ticket
        // path does so DocPage can render the same fallback banner.
        if (/not migrated/i.test(reasonText)) {
          const e = new Error(reasonText || 'Doc not migrated for collab.');
          e._collabMigrationMissing = true;
          setError(e);
        } else {
          const e = new Error(reasonText || 'Collab authentication failed.');
          e._authFailure = true;
          setError(e);
        }
        setStatus('error');
      };

      const onAwarenessChange = () => {
        if (cancelled || sessionKeyRef.current !== sessionKey) return;
        try {
          const awareness = nextProvider.awareness;
          if (!awareness) return;
          // Subtract one for ourselves so the chip reads "N OTHER editing".
          // Hocuspocus injects the local awareness state even before we
          // call setLocalStateField, so getStates().size starts at >=1
          // the moment we connect.
          const totalSize = awareness.getStates ? awareness.getStates().size : 0;
          setPeerCount(Math.max(0, totalSize - 1));
        } catch (e) {
          safeLog.warn('[useDocCollab] awareness read failed', e);
        }
      };

      nextProvider.on('status', onStatus);
      nextProvider.on('synced', onSynced);
      nextProvider.on('authenticationFailed', onAuthFail);
      if (nextProvider.awareness && typeof nextProvider.awareness.on === 'function') {
        nextProvider.awareness.on('change', onAwarenessChange);
      }

      // Publish our identity into awareness so peers can render the right
      // name/color next to our caret via CollaborationCursor. Guarded
      // because nothing forces the caller to pass currentUser.
      if (currentUser && nextProvider.awareness && typeof nextProvider.setAwarenessField === 'function') {
        try {
          nextProvider.setAwarenessField('user', {
            name: currentUser.name || 'Anonymous',
            color: currentUser.color || pickColor(currentUser.id),
          });
        } catch (e) {
          safeLog.warn('[useDocCollab] setAwarenessField failed', e);
        }
      } else if (currentUser && nextProvider.awareness && typeof nextProvider.awareness.setLocalStateField === 'function') {
        try {
          nextProvider.awareness.setLocalStateField('user', {
            name: currentUser.name || 'Anonymous',
            color: currentUser.color || pickColor(currentUser.id),
          });
        } catch (e) {
          safeLog.warn('[useDocCollab] setLocalStateField failed', e);
        }
      }
    })();

    return cleanupLocal;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, enabled, currentUser?.id, currentUser?.name, currentUser?.color]);

  // When the hook unmounts entirely (page nav), nuke the React state so a
  // stale `provider` reference doesn't briefly render after the WS is
  // closed.
  useEffect(() => {
    return () => {
      setYdoc(null);
      setProvider(null);
      setStatus('idle');
      setPeerCount(0);
      setError(null);
    };
  }, []);

  return { ydoc, provider, status, peerCount, error };
}
