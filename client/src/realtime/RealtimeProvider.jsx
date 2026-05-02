import React, { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { getSocket, subscribe, onConnect } from '../services/socket';
import { routeEvent } from './eventRouter';

/**
 * RealtimeProvider — single owner of the frontend's realtime invalidation
 * registry. Mounts once at the app root (under AuthProvider).
 *
 * Pages don't talk to the socket directly any more. They declare:
 *
 *   useRealtimeQuery({
 *     queryKey: `tasks.board.${boardId}`,
 *     refetch: loadTasks,
 *   });
 *
 * The provider listens to every realtime event from the server, asks the
 * pure eventRouter which queryKeys are affected, and calls the refetch
 * functions of every component currently registered for those keys.
 *
 * One place to add a new event. One place to add a new page. No more
 * scattered useSocket('event:name', loadX) chains across 30 files.
 *
 * Backwards compatible: useSocket(...) still works — components that haven't
 * migrated keep their existing listeners. The provider doesn't intercept
 * events; it just adds a parallel dispatch path.
 */

const REALTIME_EVENTS = [
  // Tasks
  'task:created', 'task:updated', 'task:deleted', 'task:moved',
  'task:delegated', 'task:approval-updated', 'task:receipt',
  'task:unblocked',
  'tasks:bulkUpdated', 'tasks:reordered',
  // Subtasks
  'subtask:created', 'subtask:updated', 'subtask:deleted',
  // Watchers (Phase 2)
  'watcher:added', 'watcher:removed',
  // Dependencies
  'dependency:added', 'dependency:removed', 'dependency:auto_unblocked',
  'dependency:delegated',
  // Notifications
  'notification:new', 'notification:read',
  // Boards
  'board:created', 'board:updated', 'board:deleted',
  'board:memberAdded', 'board:memberRemoved',
  // Comments / files
  'comment:created', 'comment:deleted',
  'file:uploaded', 'file:deleted',
  // Meetings
  'meeting:created', 'meeting:updated', 'meeting:deleted',
  'meeting:accepted', 'meeting:declined',
  // Permissions
  'permissions:updated',
];

const RealtimeContext = createContext(null);

export function RealtimeProvider({ children }) {
  // Map<queryKey: string, Set<refetch: () => void>>
  // We keep this in a ref so registering/unregistering doesn't trigger a
  // re-render of the whole tree. The provider's contract is a stable object
  // — useMemo at the bottom keeps the context value referentially stable.
  const registryRef = useRef(new Map());

  // Direct event subscribers (escape hatch — used when a component genuinely
  // needs to inspect the raw payload, e.g. TaskModal patching approvalFlows
  // in place rather than refetching).
  // Map<event: string, Set<handler: (payload) => void>>
  const eventSubscribersRef = useRef(new Map());

  // Ref so the dispatcher always reads the latest invalidator without
  // re-creating the socket listener on every state change.
  const invalidateRef = useRef(null);

  invalidateRef.current = function invalidate(queryKey) {
    if (!queryKey) return;
    const set = registryRef.current.get(queryKey);
    if (!set || set.size === 0) return;
    // Snapshot the set before iterating: refetch implementations may
    // synchronously unmount their owner (rare, but possible during
    // navigation), which would mutate the Set under us.
    for (const refetch of Array.from(set)) {
      try {
        refetch();
      } catch (err) {
        console.error('[Realtime] refetch threw for queryKey', queryKey, err);
      }
    }
  };

  // ── Wire socket events into the registry ─────────────────────
  useEffect(() => {
    const offFns = [];

    function attach() {
      // Re-attach ALL event listeners. socket.io-client doesn't double-add
      // if we hand it the same handler reference, but we recreate handlers
      // here so each subscribe() returns a clean off() — simpler than
      // tracking handler identity ourselves.
      while (offFns.length) {
        const off = offFns.pop();
        try { off && off(); } catch { /* ignore */ }
      }

      for (const event of REALTIME_EVENTS) {
        const handler = (payload) => {
          // 1. Forward to direct subscribers (escape hatch).
          const direct = eventSubscribersRef.current.get(event);
          if (direct && direct.size > 0) {
            for (const cb of Array.from(direct)) {
              try { cb(payload); } catch (e) { console.error('[Realtime] direct subscriber threw:', e); }
            }
          }
          // 2. Route to queryKeys via the pure router and invalidate each.
          const keys = routeEvent(event, payload || {});
          for (const key of keys) {
            invalidateRef.current(key);
          }
        };
        offFns.push(subscribe(event, handler));
      }
    }

    // True on the very first connect, false after a reconnect. Lets us
    // refetch every registered queryKey on a reconnect (events that fired
    // during the gap are gone forever otherwise) without re-firing the
    // same fetches the components just made on initial mount.
    let isFirstConnect = true;

    // Attach immediately (in case the socket is already connected) AND on
    // every (re)connect — subscribe() returns a working off() in both
    // cases, even if the underlying socket changes after a reconnect.
    if (getSocket()) attach();
    const offConnect = onConnect(() => {
      attach();
      // Reconnect-resync: every queryKey the user is currently looking at
      // gets refetched. Bounded by what's actually mounted — registryRef
      // only holds keys whose owning components are alive — so this is a
      // proportional resync, not a global cache bust.
      if (!isFirstConnect) {
        for (const queryKey of registryRef.current.keys()) {
          invalidateRef.current(queryKey);
        }
        if (typeof console !== 'undefined') {
          console.log(
            '[Realtime] reconnect-resync invalidated',
            registryRef.current.size,
            'queryKeys'
          );
        }
      }
      isFirstConnect = false;
    });

    return () => {
      while (offFns.length) {
        const off = offFns.pop();
        try { off && off(); } catch { /* ignore */ }
      }
      if (offConnect) offConnect();
    };
  }, []);

  // ── Public API ───────────────────────────────────────────────
  const api = useMemo(() => ({
    /** Register a refetcher for a queryKey. Returns an unregister fn. */
    register(queryKey, refetch) {
      if (!queryKey || typeof refetch !== 'function') return () => {};
      let set = registryRef.current.get(queryKey);
      if (!set) {
        set = new Set();
        registryRef.current.set(queryKey, set);
      }
      set.add(refetch);
      return () => {
        const s = registryRef.current.get(queryKey);
        if (!s) return;
        s.delete(refetch);
        if (s.size === 0) registryRef.current.delete(queryKey);
      };
    },

    /** Manually invalidate a queryKey (e.g. after a mutation by this client). */
    invalidate(queryKey) {
      invalidateRef.current(queryKey);
    },

    /**
     * Subscribe to a raw event (escape hatch). Use this when you genuinely
     * need the payload — e.g. patching a single field in place rather than
     * triggering a full refetch. Most components should prefer useRealtimeQuery.
     * Returns an unsubscribe fn.
     */
    on(event, handler) {
      if (!event || typeof handler !== 'function') return () => {};
      let set = eventSubscribersRef.current.get(event);
      if (!set) {
        set = new Set();
        eventSubscribersRef.current.set(event, set);
      }
      set.add(handler);
      return () => {
        const s = eventSubscribersRef.current.get(event);
        if (!s) return;
        s.delete(handler);
        if (s.size === 0) eventSubscribersRef.current.delete(event);
      };
    },
  }), []);

  return (
    <RealtimeContext.Provider value={api}>
      {children}
    </RealtimeContext.Provider>
  );
}

export function useRealtime() {
  const ctx = useContext(RealtimeContext);
  if (!ctx) {
    throw new Error('useRealtime must be used within a RealtimeProvider');
  }
  return ctx;
}
