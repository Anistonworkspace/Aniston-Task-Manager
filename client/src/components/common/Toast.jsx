import React, { useState, useEffect, createContext, useContext, useCallback, useMemo, useRef } from 'react';
import { CheckCircle2, AlertCircle, Info, X, AlertTriangle, Bell } from 'lucide-react';

/**
 * Toast (Microsoft Teams-style) — bigger, readable, hover-pauses, click-through.
 *
 * Public API (backwards compatible):
 *   - toast(message, type, duration)            // legacy positional
 *   - toast({ title, body, type, duration, onClick, icon })  // structured
 *   - success(msg) / error(msg) / warning(msg) / info(msg)
 *   - notify({ title, body, ... })              // alias for the structured form
 *   - remove(id)
 *
 * Behavioural changes from the previous version:
 *   1. Default duration is 5000ms (was 4000) — matches the user-facing
 *      "stay for 5 seconds" requirement.
 *   2. Hovering or focusing a toast PAUSES its dismiss timer; leaving
 *      RESUMES it. Implemented per-toast so multiple toasts pause
 *      independently.
 *   3. Toasts can carry a structured payload (title + body) and an
 *      `onClick` handler so clicks on the body navigate (used by the
 *      Header to open the linked task when a `notification:new` arrives).
 *   4. Each toast is a focusable region with role="status" — screen
 *      readers announce new toasts; Esc closes the focused one.
 */

const TOAST_DEDUP_WINDOW_MS = 1500;
const DEFAULT_DURATION_MS = 5000;
const MAX_TOASTS = 5;

const ToastContext = createContext(null);

const ICONS = {
  success: { icon: CheckCircle2, color: 'text-success', bg: 'bg-success/10 border-success/30' },
  error:   { icon: AlertCircle,   color: 'text-danger',  bg: 'bg-danger/10 border-danger/30'  },
  warning: { icon: AlertTriangle, color: 'text-warning', bg: 'bg-warning/10 border-warning/30' },
  info:    { icon: Info,          color: 'text-primary', bg: 'bg-primary/10 border-primary/30' },
  // 'notification' style differs from 'info' visually — used by the bell-driven
  // toasts to feel more like a Teams card and less like a status banner.
  notification: { icon: Bell, color: 'text-primary', bg: 'bg-[var(--primary-background-color)] border-border' },
};

/**
 * Single toast item. Owns its own dismiss timer so hover-to-pause is
 * isolated per-toast — pausing one doesn't pause the others.
 *
 * Timer model: on mount, schedule a setTimeout for `remaining` ms. On
 * hover/focus we clear the timer and snapshot how much time is left. On
 * leave/blur we re-schedule with the remaining time. This gives the user
 * a guarantee that whatever fraction of the 5s they hadn't yet "consumed"
 * before hovering is what they get when they leave.
 */
function ToastItem({ toast, onClose }) {
  const { id, type = 'info', duration = DEFAULT_DURATION_MS, title, body, message, onClick, icon: customIcon } = toast;
  const cfg = ICONS[type] || ICONS.info;
  const Icon = customIcon || cfg.icon;

  // Timer state lives in refs so we don't trigger re-renders on every tick.
  const timerRef = useRef(null);
  const remainingRef = useRef(duration);
  const startedAtRef = useRef(Date.now());
  const pausedRef = useRef(false);
  const containerRef = useRef(null);

  const start = useCallback(() => {
    if (duration <= 0) return; // 0 = sticky, never auto-dismiss
    if (timerRef.current) clearTimeout(timerRef.current);
    startedAtRef.current = Date.now();
    pausedRef.current = false;
    timerRef.current = setTimeout(() => onClose(id), remainingRef.current);
  }, [duration, id, onClose]);

  const pause = useCallback(() => {
    if (pausedRef.current || duration <= 0) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    const elapsed = Date.now() - startedAtRef.current;
    remainingRef.current = Math.max(0, remainingRef.current - elapsed);
    pausedRef.current = true;
  }, [duration]);

  // Initial schedule + cleanup on unmount.
  useEffect(() => {
    start();
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [start]);

  // Esc on the focused toast dismisses it. We only handle keys when the
  // toast itself (or one of its children) is focused so we don't compete
  // with global Esc handlers on modals.
  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose(id);
    }
  }, [id, onClose]);

  const handleBodyClick = useCallback((e) => {
    if (typeof onClick !== 'function') return;
    // Don't trigger the body action if the click hit the close button.
    if (e.target.closest('[data-toast-close]')) return;
    onClick(toast);
    onClose(id);
  }, [onClick, toast, id, onClose]);

  const isNotification = type === 'notification';
  const computedTitle = title || (isNotification ? 'New notification' : null);
  const computedBody = body || message || '';
  const clickable = typeof onClick === 'function';

  return (
    <div
      ref={containerRef}
      role={type === 'error' || type === 'warning' ? 'alert' : 'status'}
      aria-live={type === 'error' || type === 'warning' ? 'assertive' : 'polite'}
      aria-atomic="true"
      tabIndex={0}
      onMouseEnter={pause}
      onMouseLeave={start}
      onFocus={pause}
      onBlur={start}
      onKeyDown={handleKeyDown}
      className={`pointer-events-auto flex items-start gap-3.5 px-5 py-4 rounded-xl border shadow-xl backdrop-blur-sm w-full ${cfg.bg} dark:shadow-2xl text-text-primary outline-none focus:ring-2 focus:ring-primary/50 transition-shadow`}
      style={{ animation: 'toastIn 0.25s cubic-bezier(0.21, 1.02, 0.73, 1)' }}
    >
      <div className={`flex-shrink-0 mt-0.5 ${cfg.color}`}>
        <Icon size={22} aria-hidden="true" />
      </div>
      <div
        className={`flex-1 min-w-0 ${clickable ? 'cursor-pointer' : ''}`}
        onClick={handleBodyClick}
        onKeyDown={(e) => { if (clickable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); handleBodyClick(e); } }}
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : -1}
      >
        {computedTitle && (
          <p className="text-[15px] font-semibold leading-tight mb-1 break-words">{computedTitle}</p>
        )}
        <p className="text-sm text-text-primary leading-snug break-words whitespace-pre-line">{computedBody}</p>
      </div>
      <button
        data-toast-close
        onClick={() => onClose(id)}
        aria-label="Dismiss notification"
        className="flex-shrink-0 mt-0.5 p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-surface/50 transition-colors"
      >
        <X size={18} aria-hidden="true" />
      </button>
    </div>
  );
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  // Tracks recent (type+message) -> timestamp so we can swallow duplicates fired
  // by two code paths reacting to the same event. Lives in a ref so dedup
  // decisions are stable across renders.
  const recentToastsRef = useRef(new Map());

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  /**
   * Add a toast.
   *
   * Two call shapes supported:
   *   addToast('hello', 'success')                 // legacy positional
   *   addToast({ title: '…', body: '…', type: 'notification', onClick: fn })
   *
   * Returns the toast id (or null if deduplicated).
   */
  const addToast = useCallback((firstArg, type = 'info', duration = DEFAULT_DURATION_MS) => {
    let payload;
    if (firstArg && typeof firstArg === 'object' && !React.isValidElement(firstArg)) {
      payload = {
        title: firstArg.title || null,
        body: firstArg.body || firstArg.message || '',
        type: firstArg.type || 'info',
        duration: typeof firstArg.duration === 'number' ? firstArg.duration : DEFAULT_DURATION_MS,
        onClick: typeof firstArg.onClick === 'function' ? firstArg.onClick : null,
        icon: firstArg.icon || null,
      };
    } else {
      payload = {
        title: null,
        body: typeof firstArg === 'string' ? firstArg : JSON.stringify(firstArg),
        type,
        duration,
        onClick: null,
        icon: null,
      };
    }

    // Dedup window keyed on (type + body + title) so two paths reacting to
    // the same event don't both fire (e.g. local handler + api-error
    // interceptor). 1500ms is short enough that intentional repeats still
    // surface.
    const dedupKey = `${payload.type}::${payload.title || ''}::${payload.body}`;
    const now = Date.now();
    const last = recentToastsRef.current.get(dedupKey);
    if (last && now - last < TOAST_DEDUP_WINDOW_MS) {
      return null;
    }
    recentToastsRef.current.set(dedupKey, now);
    if (recentToastsRef.current.size > 50) {
      for (const [k, t] of recentToastsRef.current.entries()) {
        if (now - t > TOAST_DEDUP_WINDOW_MS * 4) recentToastsRef.current.delete(k);
      }
    }

    const id = now + Math.random();
    setToasts(prev => {
      const updated = [...prev, { id, ...payload }];
      // Keep at most MAX_TOASTS visible — drop the OLDEST when over.
      return updated.length > MAX_TOASTS ? updated.slice(-MAX_TOASTS) : updated;
    });
    return id;
  }, []);

  // Listen for global API error events
  useEffect(() => {
    function handleApiError(e) {
      const { message } = e.detail || {};
      if (message) addToast({ body: message, type: 'error', duration: 5000 });
    }
    window.addEventListener('api-error', handleApiError);
    return () => window.removeEventListener('api-error', handleApiError);
  }, [addToast]);

  // Memoise the context value so consumers' useCallback/useEffect deps don't
  // see a fresh reference every render. (Same reason as the previous
  // implementation — without this, BoardPage's per-IP request storm came back.)
  const value = useMemo(() => ({ addToast, removeToast }), [addToast, removeToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/*
        Toast container — TOP-RIGHT positioning so notifications appear in
        the natural reading-flow corner, below the header (top-[64px] offset
        clears the 52px header + ~12px gap so the toast doesn't kiss the
        bell button). max-w-[460px] on desktop, viewport-minus-margin on
        mobile.
        `pointer-events-none` on the container so the layout doesn't block
        clicks on the page beneath when toasts aren't covering the area;
        individual toasts re-enable pointer events.
      */}
      <div
        className="fixed top-[64px] right-4 z-[100] flex flex-col gap-2.5 max-w-[460px] w-[calc(100vw-2rem)] sm:w-[460px] pointer-events-none"
        aria-live="polite"
        aria-relevant="additions"
      >
        {toasts.map(toast => (
          <ToastItem key={toast.id} toast={toast} onClose={removeToast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// Stable no-op fallback used when the hook is called outside the provider.
// Module-level so its identity never changes — safe to put in a useEffect/
// useCallback dep array.
const NOOP_TOAST = Object.freeze({
  toast: () => {},
  notify: () => {},
  success: () => {},
  error: () => {},
  warning: () => {},
  info: () => {},
  remove: () => {},
});

export function useToast() {
  const ctx = useContext(ToastContext);
  // The returned object MUST be stable across renders (see history note in
  // earlier version). useMemo on the ctx identity gives that stability.
  return useMemo(() => {
    if (!ctx) return NOOP_TOAST;
    return {
      toast: ctx.addToast,
      // notify(...) is the structured shape — used by the bell handler so
      // notification:new events render as Teams-style cards with title+body
      // and an onClick that opens the linked task.
      notify: (payload) => ctx.addToast({ type: 'notification', ...payload }),
      success: (msg) => ctx.addToast(msg, 'success'),
      error: (msg) => ctx.addToast(msg, 'error'),
      warning: (msg) => ctx.addToast(msg, 'warning'),
      info: (msg) => ctx.addToast(msg, 'info'),
      remove: ctx.removeToast,
    };
  }, [ctx]);
}
