import React, { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

const WAVE_KEY = 'home-wave-played-v1';

/**
 * Inline waving-hand emoji. Plays a 3-wag wave on mount once per browser session
 * (using sessionStorage), then sits static. Respects prefers-reduced-motion.
 */
export default function WaveHand() {
  const prefersReducedMotion = useReducedMotion();
  const [shouldAnimate, setShouldAnimate] = useState(false);

  useEffect(() => {
    if (prefersReducedMotion) return;
    try {
      if (!sessionStorage.getItem(WAVE_KEY)) {
        setShouldAnimate(true);
        sessionStorage.setItem(WAVE_KEY, '1');
      }
    } catch {
      setShouldAnimate(true);
    }
  }, [prefersReducedMotion]);

  return (
    <motion.span
      role="img"
      aria-label="waving hand"
      style={{ display: 'inline-block', transformOrigin: '70% 70%' }}
      animate={
        shouldAnimate
          ? { rotate: [0, 14, -8, 14, -4, 10, 0] }
          : { rotate: 0 }
      }
      transition={shouldAnimate ? { duration: 1.2, ease: 'easeInOut' } : { duration: 0 }}
    >
      👋
    </motion.span>
  );
}
