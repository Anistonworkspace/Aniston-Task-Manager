import React, { useId } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

/**
 * Tiny SVG sparkline.
 *
 * - When `empty` is true (no data yet from backend), renders a flat
 *   skeleton baseline at low opacity with no animation. The flat line
 *   reads clearly as "no data yet" instead of "the value is zero".
 * - Otherwise draws left-to-right via stroke-dashoffset over ~800ms.
 */
export default function Sparkline({
  data = [],
  empty = false,
  width = 220,
  height = 32,
  color = '#0073ea',
  strokeWidth = 1.6,
  fill = true,
  delay = 0.2,
}) {
  const prefersReducedMotion = useReducedMotion();
  const gradientId = useId();

  const isEmpty = empty || data.length === 0;

  if (isEmpty) {
    const midY = height / 2;
    return (
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        role="presentation"
      >
        <line
          x1="0"
          y1={midY}
          x2={width}
          y2={midY}
          stroke={color}
          strokeOpacity="0.15"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
      </svg>
    );
  }

  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = max - min || 1;
  const stepX = width / Math.max(data.length - 1, 1);

  const points = data.map((v, i) => {
    const x = i * stepX;
    const y = height - 2 - ((v - min) / span) * (height - 4);
    return [x, y];
  });

  const path = points
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`)
    .join(' ');

  const areaPath =
    `${path} L ${(points[points.length - 1][0]).toFixed(2)} ${height} L 0 ${height} Z`;

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{ overflow: 'visible' }}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.18" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && (
        <motion.path
          d={areaPath}
          fill={`url(#${gradientId})`}
          initial={prefersReducedMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, delay: delay + 0.2 }}
        />
      )}
      <motion.path
        d={path}
        fill="none"
        stroke={color}
        strokeOpacity="0.95"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={prefersReducedMotion ? false : { pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 0.8, delay, ease: [0.16, 1, 0.3, 1] }}
      />
    </svg>
  );
}
