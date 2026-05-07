import React, { useState, useEffect, useRef } from 'react';
import { ShieldAlert, RefreshCw } from 'lucide-react';
import { subscribe } from '../../services/socket';
import { useAuth } from '../../context/AuthContext';

// Mounted once globally inside Layout so any authenticated page surfaces the
// popup. Triggered by the server's `user:role-updated` event, which is targeted
// to the affected user's personal socket room only — never broadcast.
//
// Why a hard reload? Tier/role drives sidebar items, route guards, RBAC checks,
// and cached `/auth/me`. A clean window.location.reload() guarantees every
// derived state is rebuilt from the new server-side truth without us having
// to whack-a-mole every cache and ref.
const COUNTDOWN_SECONDS = 5;

export default function RoleChangePopup() {
  const { user } = useAuth();
  const [event, setEvent] = useState(null);
  const [seconds, setSeconds] = useState(COUNTDOWN_SECONDS);
  // Latches once the first event arrives so a duplicate emit (e.g. one user
  // with two open tabs receiving a single targeted event, or a backend retry)
  // doesn't reset the countdown mid-flight or trigger a second reload.
  const triggeredRef = useRef(false);

  useEffect(() => {
    if (!user) return;
    const off = subscribe('user:role-updated', (payload) => {
      if (triggeredRef.current) return;
      triggeredRef.current = true;
      setSeconds(COUNTDOWN_SECONDS);
      setEvent(payload || {});
    });
    return () => { if (off) off(); };
  }, [user]);

  useEffect(() => {
    if (!event) return;
    if (seconds <= 0) {
      try { window.location.reload(); } catch { /* ignore */ }
      return;
    }
    const t = setTimeout(() => setSeconds(s => s - 1), 1000);
    return () => clearTimeout(t);
  }, [event, seconds]);

  if (!event) return null;

  const reloadNow = () => {
    try { window.location.reload(); } catch { /* ignore */ }
  };

  const progressPct = Math.max(0, Math.min(100, (seconds / COUNTDOWN_SECONDS) * 100));

  return (
    <div
      className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="role-change-title"
      aria-describedby="role-change-desc"
    >
      <div className="bg-white dark:bg-zinc-800 rounded-xl shadow-2xl max-w-md w-[90vw] p-6 border border-zinc-200 dark:border-zinc-700">
        <div className="flex items-start gap-3 mb-4">
          <div className="shrink-0 w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-500/20 text-amber-600 flex items-center justify-center">
            <ShieldAlert size={20} />
          </div>
          <div>
            <h2 id="role-change-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Your role has been updated
            </h2>
            <p id="role-change-desc" className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              The app will refresh in{' '}
              <span className="font-semibold text-gray-900 dark:text-gray-100">{seconds}</span>{' '}
              {seconds === 1 ? 'second' : 'seconds'} to apply the latest permissions.
            </p>
          </div>
        </div>
        <div
          className="w-full h-1.5 bg-gray-200 dark:bg-zinc-700 rounded-full overflow-hidden mb-4"
          aria-hidden="true"
        >
          <div
            className="h-full bg-amber-500 transition-all ease-linear"
            style={{ width: `${progressPct}%`, transitionDuration: '1000ms' }}
          />
        </div>
        <button
          type="button"
          onClick={reloadNow}
          className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          <RefreshCw size={14} /> Refresh now
        </button>
      </div>
    </div>
  );
}
