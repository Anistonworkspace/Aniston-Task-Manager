import { useEffect, useRef, useCallback } from 'react';

/**
 * Trailing-edge debounce for a callback.
 *
 * Returns a stable function whose invocations are coalesced — only the last
 * call within `delay` ms actually runs. The wrapped callback always sees the
 * most-recent arguments.
 *
 * Why this exists
 * ---------------
 * Realtime events can arrive in bursts (a `notification:new` storm during a
 * cron tick, a flurry of `task:updated` events while a board is being
 * re-ordered). Without debouncing, every event triggers an unconditional
 * `loadUnreadCount()` / `loadApprovalsBadge()` / etc. GET — 30 bursting
 * events = 30 round-trips, often returning the same answer.
 *
 * Trailing-edge semantics: the FIRST event is delayed by `delay` ms; if no
 * more events arrive in that window, the callback fires. If more arrive,
 * the timer resets. So the worst-case latency on a quiet badge update is
 * `delay`; the worst-case during a storm is "one fire shortly after the
 * storm ends".
 *
 * Default delay (500ms) chosen to be larger than the natural inter-event
 * gap when many notifications arrive from a single cron tick (typically
 * ~50–100ms per event in our setup) but small enough that a single update
 * still feels real-time.
 *
 * Cleanup: the timer is cleared on unmount so a debounced fetch never
 * lands on a stale component. Caller still owns auth/abort guards.
 */
export default function useDebouncedCallback(callback, delay = 500) {
  const callbackRef = useRef(callback);
  const timerRef = useRef(null);

  // Always invoke the LATEST callback identity. Pages frequently re-create
  // their `load` function on each render — pinning to the first one would
  // capture stale state.
  callbackRef.current = callback;

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return useCallback((...args) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      try {
        callbackRef.current(...args);
      } catch (err) {
        // A throwing refetch must not break future debounced calls.
        // eslint-disable-next-line no-console
        console.error('[useDebouncedCallback] callback threw', err);
      }
    }, delay);
  }, [delay]);
}
