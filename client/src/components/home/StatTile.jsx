import React from 'react';
import { motion } from 'framer-motion';
import { staggerItem } from '../../utils/animations';

/**
 * Static numeric display — no count-up animation. Kept as a named export so
 * existing call sites stay unchanged; previously animated, now renders the
 * value directly. (Per UX feedback: number tickers were distracting on a
 * dashboard glanced at all day.)
 */
export function CountUp({ value, suffix = '' }) {
  const target = typeof value === 'number' ? value : parseFloat(value) || 0;
  return <>{target}{suffix}</>;
}

/**
 * Bento tile shell.
 * Variants:
 *   - "default": white card, soft hairline border, hover lift.
 *   - "hero":    subtle gradient background, primary-tinted border.
 *   - "slim":    horizontal-row layout with smaller padding (use `slim` prop).
 *   - "danger":  faint red left border for alert states.
 */
export default function StatTile({
  children,
  hero = false,
  danger = false,
  className = '',
  onClick,
  ariaLabel,
  ...rest
}) {
  const isInteractive = Boolean(onClick);

  // Padding intentionally omitted from base so call sites can dictate it
  // (`p-3 sm:p-4` for compact tiles, custom for hero, etc.). Tailwind
  // utility ordering means a hard-coded base `p-4` would beat any
  // smaller value passed via className.
  const base =
    'relative rounded-2xl border bg-white dark:bg-[var(--bg-elevated)] transition-shadow';
  const heroBg = hero
    ? 'bg-gradient-to-br from-primary-50/60 via-white to-white dark:from-primary-900/20 dark:via-[var(--bg-elevated)] dark:to-[var(--bg-elevated)] border-primary-100/70 dark:border-primary-900/30'
    : 'border-[rgba(15,15,25,0.06)] dark:border-[rgba(255,255,255,0.06)]';
  const dangerAccent = danger
    ? 'before:content-[""] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full before:bg-danger'
    : '';

  // Only lift on hover when the tile is actually clickable. Static
  // summary tiles (e.g. Completion Rate hero) shouldn't move under the
  // cursor — that motion implies interactivity that doesn't exist.
  const hoverProps = isInteractive
    ? {
        whileHover: {
          y: -2,
          boxShadow: '0 4px 16px rgba(15,15,25,0.06), 0 1px 4px rgba(15,15,25,0.04)',
        },
      }
    : {};

  return (
    <motion.div
      variants={staggerItem}
      {...hoverProps}
      onClick={onClick}
      onKeyDown={
        isInteractive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick?.(e);
              }
            }
          : undefined
      }
      role={isInteractive ? 'button' : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      aria-label={ariaLabel}
      className={`${base} ${heroBg} ${dangerAccent} shadow-[0_1px_2px_rgba(15,15,25,0.04),0_4px_12px_rgba(15,15,25,0.04)] ${
        isInteractive
          ? 'cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500'
          : ''
      } ${className}`}
      {...rest}
    >
      {children}
    </motion.div>
  );
}
