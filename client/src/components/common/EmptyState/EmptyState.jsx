import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';

/**
 * EmptyState — universal "no content yet" placeholder.
 *
 *   <EmptyState
 *     illustration={<MyIllustration />}
 *     title="No favorites yet"
 *     description="Add your boards, docs, or dashboards for quick access."
 *     primaryAction={{ label: '+ Add favorite', onClick: () => ... }}
 *     secondaryAction={{ label: 'Learn more', onClick: () => ... }}
 *   />
 *
 *   <EmptyState compact title="No results were found" description="Check your settings & filters" />
 *
 * The home-page-specific variant lives at components/home/EmptyState.jsx and
 * stays untouched. This is the general-purpose primitive used by Sidebar
 * Favorites, dashboard widgets, Files tab, Notetaker landing, etc.
 */
export default function EmptyState({
  illustration,
  icon,
  title,
  description,
  primaryAction,
  secondaryAction,
  compact = false,
  className = '',
}) {
  const reducedMotion = useReducedMotion();
  const padding = compact ? 'py-6' : 'py-12';
  const illustrationSize = compact ? 64 : 120;

  return (
    <div
      className={`flex flex-col items-center justify-center text-center ${padding} ${className}`}
      role="status"
    >
      {(illustration || icon) && (
        <motion.div
          className="mb-4 flex items-center justify-center"
          style={{ width: illustrationSize, height: illustrationSize }}
          initial={reducedMotion ? false : { scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        >
          {illustration || icon}
        </motion.div>
      )}
      {title && (
        <p className={`font-semibold text-text-primary ${compact ? 'text-sm' : 'text-base'} mb-1`}>
          {title}
        </p>
      )}
      {description && (
        <p className={`text-text-secondary ${compact ? 'text-xs' : 'text-sm'} max-w-md`}>
          {description}
        </p>
      )}
      {primaryAction && (
        <button
          type="button"
          onClick={primaryAction.onClick}
          className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-white text-sm font-medium hover:bg-primary-600 transition-colors"
        >
          {primaryAction.icon}
          {primaryAction.label}
        </button>
      )}
      {secondaryAction && (
        <button
          type="button"
          onClick={secondaryAction.onClick}
          className="mt-2 text-sm text-primary hover:underline"
        >
          {secondaryAction.label}
        </button>
      )}
    </div>
  );
}
