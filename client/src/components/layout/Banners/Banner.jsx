import React from 'react';
import { CheckCircle2, Info, AlertTriangle, AlertCircle, Sparkles, X } from 'lucide-react';

/**
 * Banner — single full-width inline notice rendered by BannerStack.
 *
 * Variants follow skill §2.2:
 *   info     — blue tint (default)
 *   warning  — amber tint
 *   danger   — red tint
 *   promo    — neutral tint
 *
 * This is layout-level (full width below the top bar), distinct from
 * AttentionBox which is page-level inline. The visual treatment is
 * intentionally similar so the design language stays consistent.
 */

const VARIANTS = {
  info: {
    icon: Info,
    wrap: 'bg-blue-50 dark:bg-blue-900/20 border-b border-blue-200 dark:border-blue-800',
    iconColor: 'text-blue-500',
    title: 'text-blue-700 dark:text-blue-300',
    body: 'text-blue-600 dark:text-blue-400',
  },
  warning: {
    icon: AlertTriangle,
    wrap: 'bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-800',
    iconColor: 'text-amber-500',
    title: 'text-amber-700 dark:text-amber-300',
    body: 'text-amber-600 dark:text-amber-400',
  },
  danger: {
    icon: AlertCircle,
    wrap: 'bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800',
    iconColor: 'text-red-500',
    title: 'text-red-700 dark:text-red-300',
    body: 'text-red-600 dark:text-red-400',
  },
  promo: {
    icon: Sparkles,
    wrap: 'bg-violet-50 dark:bg-violet-900/20 border-b border-violet-200 dark:border-violet-800',
    iconColor: 'text-violet-500',
    title: 'text-violet-700 dark:text-violet-300',
    body: 'text-violet-600 dark:text-violet-400',
  },
  success: {
    icon: CheckCircle2,
    wrap: 'bg-emerald-50 dark:bg-emerald-900/20 border-b border-emerald-200 dark:border-emerald-800',
    iconColor: 'text-emerald-500',
    title: 'text-emerald-700 dark:text-emerald-300',
    body: 'text-emerald-600 dark:text-emerald-400',
  },
};

export default function Banner({
  variant = 'info',
  title,
  message,
  action,
  dismissible = true,
  onDismiss,
  className = '',
}) {
  const v = VARIANTS[variant] || VARIANTS.info;
  const Icon = v.icon;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`${v.wrap} px-4 py-2 flex items-center gap-3 ${className}`}
    >
      <Icon size={16} className={`flex-shrink-0 ${v.iconColor}`} aria-hidden="true" />

      <div className="flex-1 min-w-0 flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {title && (
          <span className={`text-sm font-semibold ${v.title}`}>{title}</span>
        )}
        {message && (
          <span className={`text-sm ${v.body}`}>{message}</span>
        )}
      </div>

      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className={`text-sm font-medium underline-offset-2 hover:underline ${v.title}`}
        >
          {action.label}
        </button>
      )}

      {dismissible && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss banner"
          className={`flex-shrink-0 p-1 rounded-md hover:bg-black/5 dark:hover:bg-white/5 ${v.iconColor}`}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
