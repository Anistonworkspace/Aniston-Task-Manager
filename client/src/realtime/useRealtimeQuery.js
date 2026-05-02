import { useEffect, useRef } from 'react';
import { useRealtime } from './RealtimeProvider';

/**
 * Register a refetcher for a queryKey. When ANY socket event whose router
 * mapping includes that queryKey arrives, the refetcher fires.
 *
 * Replaces the old pattern:
 *
 *   useSocket('task:created', () => loadTasks());
 *   useSocket('task:updated', () => loadTasks());
 *   useSocket('task:deleted', () => loadTasks());
 *   useSocket('tasks:reordered', () => loadTasks());
 *
 * with:
 *
 *   useRealtimeQuery({
 *     queryKey: `tasks.board.${boardId}`,
 *     refetch: loadTasks,
 *   });
 *
 * The component owns its own state + initial fetch (we deliberately do NOT
 * manage fetched data here; this isn't React Query, just a thin invalidation
 * layer). Phase-3 migration only replaces the socket listener wiring.
 *
 * Stable callback identity isn't required: the latest `refetch` is held in
 * a ref so passing an inline arrow function won't churn the registration.
 *
 * `enabled: false` skips registration entirely — convenient for queryKeys
 * that depend on a still-loading id (e.g. TaskModal opens before the
 * boardId is resolved).
 */
export default function useRealtimeQuery({ queryKey, refetch, enabled = true }) {
  const realtime = useRealtime();
  const refetchRef = useRef(refetch);

  useEffect(() => { refetchRef.current = refetch; }, [refetch]);

  useEffect(() => {
    if (!enabled || !queryKey) return undefined;
    const stableRefetch = () => {
      if (refetchRef.current) refetchRef.current();
    };
    return realtime.register(queryKey, stableRefetch);
  }, [realtime, queryKey, enabled]);
}
