import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';

/**
 * Mini vertical bar chart for tile footers.
 *
 * - When `empty` is true (no data yet), renders 7 equal-height ghost bars
 *   at low opacity with no animation. Reads as a skeleton placeholder, not
 *   as a real "all-zero" reading.
 */
export default function MiniBars({
  data = [],
  empty = false,
  height = 28,
  gap = 3,
  color = '#10b981',
  delay = 0.25,
}) {
  const prefersReducedMotion = useReducedMotion();
  const isEmpty = empty || data.length === 0;

  if (isEmpty) {
    const ghostHeight = Math.max(4, height * 0.55);
    return (
      <div
        className="flex items-end w-full"
        style={{ height, gap }}
        aria-hidden="true"
        role="presentation"
      >
        {Array.from({ length: 7 }).map((_, i) => (
          <span
            key={i}
            className="flex-1 rounded-[2px]"
            style={{
              height: ghostHeight,
              backgroundColor: color,
              opacity: 0.12,
            }}
          />
        ))}
      </div>
    );
  }

  const max = Math.max(...data, 1);

  return (
    <div className="flex items-end w-full" style={{ height, gap }} aria-hidden="true">
      {data.map((v, i) => {
        const h = Math.max(2, (v / max) * height);
        return (
          <motion.span
            key={i}
            className="flex-1 rounded-[2px]"
            style={{ backgroundColor: color, opacity: 0.85 }}
            initial={prefersReducedMotion ? false : { height: 2, opacity: 0 }}
            animate={{ height: h, opacity: 0.85 }}
            transition={{
              duration: 0.4,
              delay: delay + i * 0.04,
              ease: [0.16, 1, 0.3, 1],
            }}
          />
        );
      })}
    </div>
  );
}
