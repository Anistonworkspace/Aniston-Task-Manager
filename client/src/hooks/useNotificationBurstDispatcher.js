import { useEffect, useRef } from 'react';

/**
 * Leading-edge + trailing-summary dispatcher for notification:new events.
 *
 * Why
 * ----
 * The May 2026 6:30 PM storm fix originally buffered EVERY notification:new
 * event for 1500ms and only dispatched on flush. That gave correct storm
 * protection (1 grouped card per burst) but regressed the common path —
 * a single task-assignment notification was delayed by 1500ms before any
 * UI surface (toast or OS notification) appeared, which made users
 * perceive "browser notifications stopped working".
 *
 * This hook implements the natural pattern instead:
 *
 *   - First event of a burst window  → dispatch IMMEDIATELY via `onIndividual`.
 *   - Subsequent events within window → accumulate silently.
 *   - After `windowMs` of quiet:
 *       - if accumulated count ≥ (threshold - 1)
 *           → one `onGrouped(count)` summary fires.
 *           Total OS entries for an N-event burst (N ≥ threshold):
 *             1 leading individual + 1 trailing summary = 2 (not N).
 *       - else (1 or 2 late events): dispatch each via `onIndividual` so
 *           a small "user clicked twice quickly" flurry still surfaces both
 *           cards individually (no "you have 1 more notifications" oddity).
 *
 * Result:
 *   - 1 event   → instant individual (matches pre-storm UX).
 *   - 2 events  → 2 individuals (one instant, one ~delay later).
 *   - 3+ events → 1 instant individual + 1 summary after the burst settles.
 *
 * Failure isolation: caller's onIndividual / onGrouped may throw; the hook
 * catches so one bad event can't poison the next.
 *
 * Cleanup: the trailing timer is cleared on unmount so a logout-mid-burst
 * doesn't fire a summary toast against a stale component.
 *
 * @param {object}   opts
 * @param {(payload:any)=>void} opts.onIndividual  Called for each event that
 *                                                 should display normally.
 * @param {(count:number)=>void} opts.onGrouped    Called once per burst that
 *                                                 crosses the threshold,
 *                                                 with the LATE event count.
 * @param {number}   [opts.threshold=3]            Total events in the window
 *                                                 (leading + late) that
 *                                                 triggers the grouped path.
 * @param {number}   [opts.windowMs=1500]          Burst window length.
 * @returns {(payload:any)=>void}  The dispatcher to call from a realtime
 *                                 listener.
 */
export default function useNotificationBurstDispatcher({
  onIndividual,
  onGrouped,
  threshold = 3,
  windowMs = 1500,
} = {}) {
  // Burst buffer: `events` is the LATE events (the leading one was already
  // dispatched), `timer` is the trailing-summary timeout id. We use a ref so
  // mutating across event arrivals doesn't trigger re-renders and so the
  // value survives the next render naturally.
  const bufferRef = useRef({ events: [], timer: null });

  // Latest callbacks. Callers re-create these inline each render; pinning
  // them in a ref means the trailing-summary timer (which captures the ref
  // by closure) always reads the LATEST callback identities. Otherwise a
  // re-render between event arrival and flush would call stale callbacks
  // that close over stale state.
  const cbRef = useRef({ onIndividual, onGrouped });
  cbRef.current = { onIndividual, onGrouped };

  useEffect(() => {
    // Snapshot the ref at effect-setup time so the cleanup closure reads
    // the SAME ref object on unmount — even if a future code change ever
    // replaces bufferRef.current with a fresh object the cleanup will
    // still clear whatever timer is live.
    const buf = bufferRef;
    return () => {
      if (buf.current.timer) {
        clearTimeout(buf.current.timer);
        buf.current.timer = null;
      }
    };
  }, []);

  return function dispatch(payload) {
    if (payload === undefined || payload === null) return;
    const buf = bufferRef.current;

    if (!buf.timer) {
      // Leading edge — outside any active burst window. Dispatch
      // immediately. This is the path that restores the pre-storm UX for
      // single notifications: a task-assignment now fires its toast + OS
      // notification right away.
      try { cbRef.current.onIndividual(payload); }
      catch (err) {
        // eslint-disable-next-line no-console
        console.error('[NotificationBurst] onIndividual threw', err);
      }
      // Open the trailing-summary window. Anything that arrives in the
      // next `windowMs` is buffered into `events`.
      buf.events = [];
      buf.timer = setTimeout(() => {
        const accumulated = bufferRef.current.events;
        bufferRef.current = { events: [], timer: null };
        // The leading event already displayed, so the THRESHOLD count we
        // care about for grouping is (threshold - 1) LATE events.
        if (accumulated.length >= (threshold - 1)) {
          try { cbRef.current.onGrouped(accumulated.length); }
          catch (err) {
            // eslint-disable-next-line no-console
            console.error('[NotificationBurst] onGrouped threw', err);
          }
        } else {
          // Below threshold (1 or 2 late events): show each individually
          // so the user sees real notification cards, not a "+1" summary.
          for (const p of accumulated) {
            try { cbRef.current.onIndividual(p); }
            catch (err) {
              // eslint-disable-next-line no-console
              console.error('[NotificationBurst] onIndividual threw (trailing)', err);
            }
          }
        }
      }, windowMs);
    } else {
      // Inside an active burst window — accumulate. The first event of
      // this window has already been shown; subsequent ones are silent
      // until the summary fires (or are flushed individually if below
      // the grouping threshold).
      buf.events.push(payload);
    }
  };
}
