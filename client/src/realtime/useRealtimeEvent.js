import { useEffect, useRef } from 'react';
import { useRealtime } from './RealtimeProvider';

/**
 * Subscribe directly to a raw realtime event payload.
 *
 * The escape hatch for cases where useRealtimeQuery's "refetch on
 * invalidate" model isn't enough — e.g. patching a single field in place
 * (BoardPage's `task:updated` patcher) or showing a one-off toast.
 *
 * Prefer useRealtimeQuery whenever the natural reaction is "refetch the
 * list" — that's the path that keeps cache consistency centralised.
 *
 * Drop-in equivalent of useSocket(event, callback) but routed through the
 * RealtimeProvider's single connection-aware dispatch instead of attaching
 * a new socket.io listener per component.
 */
export default function useRealtimeEvent(event, callback, { enabled = true } = {}) {
  const realtime = useRealtime();
  const cbRef = useRef(callback);

  useEffect(() => { cbRef.current = callback; }, [callback]);

  useEffect(() => {
    if (!enabled || !event) return undefined;
    const handler = (payload) => {
      if (cbRef.current) cbRef.current(payload);
    };
    return realtime.on(event, handler);
  }, [realtime, event, enabled]);
}
