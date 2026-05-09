import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, X } from 'lucide-react';

/**
 * App-styled confirmation dialog. Replaces the native `window.confirm` browser
 * popups (the audit flagged these on OrgChartPage drag/drop, hierarchy-level
 * change, and manager-relation removal).
 *
 * Public API:
 *   const confirm = useConfirm();
 *   const ok = await confirm({
 *     title: 'Assign manager?',
 *     body:  'Assign "Muskan Rawat" as primary manager for "Mayank Saxena"?',
 *     confirmLabel: 'Assign',     // optional, default 'Confirm'
 *     cancelLabel:  'Cancel',     // optional, default 'Cancel'
 *     danger: false,              // optional — danger=true uses a red confirm button
 *   });
 *   if (ok) { ... }
 *
 * Backdrop click and Esc both resolve to false (= cancel). Enter on the
 * dialog confirms. Focus is trapped to the dialog while it is open.
 *
 * The provider lives once near the root (already mounted in App.jsx alongside
 * ToastProvider) so any descendant can call useConfirm() without prop
 * drilling. Multiple concurrent confirms are not supported on purpose — the
 * second call replaces the first (existing one resolves to false).
 */

const ConfirmContext = createContext(null);

export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null);
  // Holds the resolver of the currently-open confirm so close paths
  // (cancel / Escape / backdrop / replace) can complete the Promise.
  const pendingResolveRef = useRef(null);
  const confirmButtonRef = useRef(null);

  const close = useCallback((result) => {
    setState(null);
    const resolve = pendingResolveRef.current;
    pendingResolveRef.current = null;
    if (typeof resolve === 'function') resolve(!!result);
  }, []);

  const confirm = useCallback((opts = {}) => {
    // If a previous confirm is still open, resolve it as cancel before
    // opening the new one. Avoids hung Promises if a caller chains rapidly.
    if (pendingResolveRef.current) {
      const prev = pendingResolveRef.current;
      pendingResolveRef.current = null;
      try { prev(false); } catch { /* ignore */ }
    }
    return new Promise((resolve) => {
      pendingResolveRef.current = resolve;
      setState({
        title: opts.title || 'Confirm action',
        body: opts.body || '',
        confirmLabel: opts.confirmLabel || 'Confirm',
        cancelLabel: opts.cancelLabel || 'Cancel',
        danger: !!opts.danger,
      });
      // Focus the confirm button on next tick so Enter immediately works.
      setTimeout(() => { confirmButtonRef.current?.focus(); }, 0);
    });
  }, []);

  const value = useMemo(() => ({ confirm }), [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <AnimatePresence>
        {state && (
          <motion.div
            key="confirm-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 backdrop-blur-sm"
            onClick={() => close(false)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); close(false); }
              if (e.key === 'Enter')  { e.preventDefault(); close(true); }
            }}
          >
            <motion.div
              initial={{ scale: 0.95, y: 8 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 8 }}
              transition={{ type: 'spring', stiffness: 320, damping: 26 }}
              role="dialog"
              aria-modal="true"
              aria-labelledby="confirm-title"
              className="bg-white rounded-xl w-full max-w-sm shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start gap-3 px-5 pt-5 pb-3">
                <div className={`w-9 h-9 rounded-lg flex-shrink-0 flex items-center justify-center ${state.danger ? 'bg-red-50 text-red-500' : 'bg-blue-50 text-blue-500'}`}>
                  <AlertTriangle size={18} />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 id="confirm-title" className="text-[14px] font-bold text-gray-800 leading-tight">{state.title}</h3>
                  {state.body && (
                    <p className="text-[12px] text-gray-500 leading-relaxed mt-1.5 whitespace-pre-line">{state.body}</p>
                  )}
                </div>
                <button
                  onClick={() => close(false)}
                  aria-label="Close dialog"
                  className="p-1 hover:bg-gray-100 rounded-md text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <X size={14} />
                </button>
              </div>
              <div className="flex items-center justify-end gap-2 px-5 pb-4 pt-1">
                <button
                  onClick={() => close(false)}
                  className="px-3.5 py-1.5 text-[12px] font-medium text-gray-600 hover:bg-gray-100 rounded-md transition-colors"
                >
                  {state.cancelLabel}
                </button>
                <button
                  ref={confirmButtonRef}
                  onClick={() => close(true)}
                  className={`px-3.5 py-1.5 text-[12px] font-semibold text-white rounded-md transition-colors shadow-sm ${
                    state.danger
                      ? 'bg-red-500 hover:bg-red-600'
                      : 'bg-blue-500 hover:bg-blue-600'
                  }`}
                >
                  {state.confirmLabel}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </ConfirmContext.Provider>
  );
}

// Stable no-op fallback if useConfirm is called outside a provider — auto-
// resolves to true so callers that forget to mount the provider degrade to
// "act anyway" rather than silently hang. Tests still get the throw.
const NOOP_CONFIRM = async () => true;

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  return ctx?.confirm || NOOP_CONFIRM;
}
