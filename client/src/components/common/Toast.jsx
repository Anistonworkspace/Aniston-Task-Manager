import React, { useState, useEffect, createContext, useContext, useCallback } from 'react';
import { CheckCircle2, AlertCircle, Info, X, AlertTriangle } from 'lucide-react';

const ToastContext = createContext(null);

const ICONS = {
  success: { icon: CheckCircle2, color: 'text-success', bg: 'bg-success/10 border-success/20' },
  error: { icon: AlertCircle, color: 'text-danger', bg: 'bg-danger/10 border-danger/20' },
  warning: { icon: AlertTriangle, color: 'text-warning', bg: 'bg-warning/10 border-warning/20' },
  info: { icon: Info, color: 'text-primary', bg: 'bg-primary/10 border-primary/20' },
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((message, type = 'info', duration = 4000) => {
    const id = Date.now() + Math.random();
    setToasts(prev => {
      const updated = [...prev, { id, message, type, duration }];
      // Keep max 5 toasts visible — remove oldest if exceeded
      return updated.length > 5 ? updated.slice(-5) : updated;
    });
    if (duration > 0) {
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id));
      }, duration);
    }
    return id;
  }, []);

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast, removeToast }}>
      {children}
      {/* Toast Container */}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-[380px]">
        {toasts.map(toast => {
          const cfg = ICONS[toast.type] || ICONS.info;
          const Icon = cfg.icon;
          return (
            <div key={toast.id}
              className={`flex items-start gap-2.5 px-4 py-3 rounded-xl border shadow-lg backdrop-blur-sm ${cfg.bg} animate-slide-in`}
              style={{ animation: 'toastIn 0.3s ease-out' }}>
              <Icon size={16} className={`${cfg.color} mt-0.5 flex-shrink-0`} />
              <p className="text-sm text-text-primary flex-1">{toast.message}</p>
              <button onClick={() => removeToast(toast.id)} className="text-text-tertiary hover:text-text-secondary flex-shrink-0 mt-0.5">
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Return a no-op if used outside provider (graceful fallback)
    return { toast: () => {}, success: () => {}, error: () => {}, warning: () => {}, info: () => {} };
  }
  return {
    toast: ctx.addToast,
    success: (msg) => ctx.addToast(msg, 'success'),
    error: (msg) => ctx.addToast(msg, 'error'),
    warning: (msg) => ctx.addToast(msg, 'warning'),
    info: (msg) => ctx.addToast(msg, 'info'),
    remove: ctx.removeToast,
  };
}
