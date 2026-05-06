import React, { useId } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

/**
 * Animated ring/donut chart.
 * - `value` is the percentage (0–100). Animates stroke-dasharray from 0 over ~800ms.
 * - When value is 0, only the faint track ring shows.
 */
export default function RingChart({
  value = 0,
  size = 132,
  strokeWidth = 12,
  trackColor = 'rgba(15, 23, 42, 0.06)',
  gradientFrom = '#4f46e5',
  gradientTo = '#3b82f6',
  delay = 0.15,
}) {
  const prefersReducedMotion = useReducedMotion();
  const gradId = useId();

  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, value));
  const targetOffset = circumference - (clamped / 100) * circumference;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={gradientFrom} />
          <stop offset="100%" stopColor={gradientTo} />
        </linearGradient>
      </defs>

      {/* Track */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={trackColor}
        strokeWidth={strokeWidth}
      />

      {/* Progress */}
      {clamped > 0 && (
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          initial={prefersReducedMotion ? false : { strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: targetOffset }}
          transition={{ duration: 0.9, delay, ease: [0.16, 1, 0.3, 1] }}
        />
      )}
    </svg>
  );
}
