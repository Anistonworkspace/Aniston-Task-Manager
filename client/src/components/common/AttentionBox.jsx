import React from 'react';
import {
  CheckCircle2, Info, AlertTriangle, AlertCircle, X,
} from 'lucide-react';

// AttentionBox — a single inline-alert primitive that replaces the ad-hoc
// banner divs scattered across the app. Mirrors Monday's Vibe AttentionBox
// API (title / text / type) and adds a few practical extras the codebase
// already wants in many places:
//
//   - `children` for richer body content (e.g. a "Try Again" button below
//     two lines of explanation — see NotesPage's mic-error block).
//   - `action` for a right-aligned primary action (Try Again / Refresh /
//     Open Settings).
//   - `onClose` for a dismiss-x button.
//   - `compact` for tighter padding inside modals/panels.
//
// What this is NOT: a toast, a modal, or a confirmation dialog. Use this
// for *inline page-level notices* — something the user should see while
// scanning the page, not blocking their workflow.

const VARIANTS = {
  success: {
    icon: CheckCircle2,
    wrap: 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800',
    iconColor: 'text-emerald-500',
    title: 'text-emerald-700 dark:text-emerald-400',
    body: 'text-emerald-600 dark:text-emerald-500',
  },
  primary: {
    icon: Info,
    wrap: 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800',
    iconColor: 'text-blue-500',
    title: 'text-blue-700 dark:text-blue-400',
    body: 'text-blue-600 dark:text-blue-500',
  },
  // Alias — "info" is the natural English word; "primary" is the Vibe spec.
  // Both map to the same blue variant so callers can use either.
  info: {
    icon: Info,
    wrap: 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800',
    iconColor: 'text-blue-500',
    title: 'text-blue-700 dark:text-blue-400',
    body: 'text-blue-600 dark:text-blue-500',
  },
  warning: {
    icon: AlertTriangle,
    wrap: 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800',
    iconColor: 'text-amber-500',
    title: 'text-amber-700 dark:text-amber-400',
    body: 'text-amber-600 dark:text-amber-500',
  },
  danger: {
    icon: AlertCircle,
    wrap: 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800',
    iconColor: 'text-red-500',
    title: 'text-red-700 dark:text-red-400',
    body: 'text-red-600 dark:text-red-500',
  },
};

export default function AttentionBox({
  type = 'primary',
  title,
  text,
  children,
  action,
  onClose,
  compact = false,
  icon: CustomIcon,
  className = '',
}) {
  const variant = VARIANTS[type] || VARIANTS.primary;
  const Icon = CustomIcon || variant.icon;

  const padding = compact ? 'px-3 py-2' : 'px-4 py-3';
  const iconSize = compact ? 14 : 16;
  const titleSize = compact ? 'text-xs' : 'text-sm';
  const bodySize = compact ? 'text-[11px]' : 'text-xs';

  return (
    <div
      role="alert"
      className={`flex items-start gap-3 ${padding} border rounded-xl ${variant.wrap} ${className}`}
    >
      <Icon size={iconSize} className={`${variant.iconColor} flex-shrink-0 mt-0.5`} />
      <div className="flex-1 min-w-0">
        {title && (
          <p className={`${titleSize} font-medium ${variant.title} ${text || children ? (compact ? 'mb-0.5' : 'mb-1') : ''}`}>
            {title}
          </p>
        )}
        {text && (
          <p className={`${bodySize} ${variant.body} whitespace-pre-line leading-relaxed`}>{text}</p>
        )}
        {children && (
          <div className={`${bodySize} ${variant.body} leading-relaxed`}>{children}</div>
        )}
        {action && (
          <div className={compact ? 'mt-1.5' : 'mt-2'}>{action}</div>
        )}
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          className={`flex-shrink-0 p-1 rounded-md hover:bg-black/5 dark:hover:bg-white/5 ${variant.iconColor} transition-colors`}
        >
          <X size={compact ? 12 : 14} />
        </button>
      )}
    </div>
  );
}
