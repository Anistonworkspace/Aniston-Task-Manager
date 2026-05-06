import React, { useEffect, useState } from 'react';
import { motion, useMotionValue, useTransform, animate, useReducedMotion } from 'framer-motion';
import { staggerItem } from '../../utils/animations';

/**
 * Number that counts up from 0 to its target over ~600ms. Honors prefers-
 * reduced-motion by jumping straight to the final value.
 */
export function CountUp({ value, suffix = '' }) {
  const prefersReducedMotion = useReducedMotion();
  const target = typeof value === 'number' ? value : parseFloat(value) || 0;
  const mv = useMotionValue(prefersReducedMotion ? target : 0);
  const display = useTransform(mv, v => Math.round(v));
  const [current, setCurrent] = useState(prefersReducedMotion ? target : 0);

  useEffect(() => {
    if (prefersReducedMotion) {
      setCurrent(target);
      return;
    }
    const ctrl = animate(mv, target, { duration: 0.6, ease: [0.16, 1, 0.3, 1] });
    const unsub = display.on('change', v => setCurrent(v));
    return () => { ctrl.stop(); unsub(); };
  }, [target, mv, display, prefersReducedMotion]);

  return (
    <>
      {current}
      {suffix}
    </>
  );
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

  const base =
    'relative rounded-2xl border bg-white dark:bg-[var(--bg-elevated)] p-4 transition-shadow';
  const heroBg = hero
    ? 'bg-gradient-to-br from-primary-50/60 via-white to-white dark:from-primary-900/20 dark:via-[var(--bg-elevated)] dark:to-[var(--bg-elevated)] border-primary-100/70 dark:border-primary-900/30'
    : 'border-[rgba(15,15,25,0.06)] dark:border-[rgba(255,255,255,0.06)]';
  const dangerAccent = danger
    ? 'before:content-[""] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-full before:bg-danger'
    : '';

  return (
    <motion.div
      variants={staggerItem}
      whileHover={{
        y: -2,
        boxShadow: '0 4px 16px rgba(15,15,25,0.06), 0 1px 4px rgba(15,15,25,0.04)',
      }}
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
