import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { CheckCircle2 } from 'lucide-react';

/**
 * Encouraging empty state for the My Tasks tile. The check icon scales in and
 * the subtle ring around it fades up for a non-static feel.
 */
export default function EmptyState({
  title = "You're all caught up",
  subtitle = 'Tasks will appear here when assigned to you',
  action,
}) {
  const prefersReducedMotion = useReducedMotion();

  return (
    <div className="flex flex-col items-center justify-center text-center py-10">
      <motion.div
        className="relative w-16 h-16 mb-4 flex items-center justify-center"
        initial={prefersReducedMotion ? false : { scale: 0.85, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1], delay: 0.1 }}
      >
        <span className="absolute inset-0 rounded-full bg-success-light/60 dark:bg-success/15" />
        <span className="absolute inset-1.5 rounded-full bg-success-light dark:bg-success/25" />
        <CheckCircle2
          size={28}
          strokeWidth={1.8}
          className="relative text-success dark:text-success"
          aria-hidden="true"
        />
      </motion.div>
      <p className="text-sm font-semibold text-text-primary mb-1">{title}</p>
      <p className="text-xs text-text-secondary max-w-xs">{subtitle}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
