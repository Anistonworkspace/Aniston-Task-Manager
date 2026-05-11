import { useEffect, useRef, useState } from 'react';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import useRealtimeQuery from '../realtime/useRealtimeQuery';

// Shared hooks for the two global navigation badges:
//
//   - useApprovalsBadgeCount     → Sidebar "Approvals & Requests" row
//   - useDependenciesBadgeCount  → Header Dependencies (Waypoints) icon
//
// Both hit lightweight `count`-only endpoints (not full lists) and re-fetch
// on the relevant socket events via the existing eventRouter mappings:
//
//   approvals.pendingCounts          ← task:approval-updated, notification:new,
//                                      extension:*, help:*
//   dependencies.assignedActiveCount ← dependency:*, notification:new
//
// Both endpoints are user-scoped and tier-aware on the server; we never count
// items the caller can't act on. A failed fetch silently keeps the previous
// value so the badge doesn't flap on a transient network blip.

function useAuthGated(loadFn) {
  const { authReady, user } = useAuth();
  const loadRef = useRef(loadFn);
  loadRef.current = loadFn;

  useEffect(() => {
    if (!authReady || !user) return;
    loadRef.current();
  }, [authReady, user]);
}

export function useApprovalsBadgeCount() {
  const { authReady, user } = useAuth();
  const [count, setCount] = useState(0);

  async function load() {
    if (!authReady || !user) { setCount(0); return; }
    try {
      const res = await api.get('/task-extras/pending-counts', { _silent: true });
      const data = res.data?.data || res.data || {};
      const total = Number(data.total);
      setCount(Number.isFinite(total) && total >= 0 ? total : 0);
    } catch {
      // Silent — interceptor handles 401, any other error keeps the prior
      // count so the badge doesn't flicker to 0 on a transient failure.
    }
  }

  useAuthGated(load);
  useRealtimeQuery({ queryKey: 'approvals.pendingCounts', refetch: load });

  return count;
}

export function useDependenciesBadgeCount() {
  const { authReady, user } = useAuth();
  const [count, setCount] = useState(0);

  async function load() {
    if (!authReady || !user) { setCount(0); return; }
    try {
      const res = await api.get('/dependencies/assigned-active-count', { _silent: true });
      const data = res.data?.data || res.data || {};
      const next = Number(data.count);
      setCount(Number.isFinite(next) && next >= 0 ? next : 0);
    } catch {
      // Silent — same rationale as above.
    }
  }

  useAuthGated(load);
  useRealtimeQuery({ queryKey: 'dependencies.assignedActiveCount', refetch: load });

  return count;
}

// Display helper — renders 99+ for over-cap counts. Single source of truth
// so the sidebar and header agree on the cap.
export function formatBadgeCount(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 99 ? '99+' : String(n);
}
