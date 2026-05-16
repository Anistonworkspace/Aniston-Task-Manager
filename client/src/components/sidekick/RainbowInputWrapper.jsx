import React, { useMemo } from 'react';
import { BRAND_GRADIENT } from '../../utils/labelPalette';

/**
 * RainbowInputWrapper — the signature 2px-gradient border applied to AI inputs.
 *
 *   <RainbowInputWrapper focused={isFocused} thickness={2}>
 *     <textarea ... />
 *   </RainbowInputWrapper>
 *
 * Implementation note (skill §12.2): the gradient is the wrapper background,
 * and the child sits on top with a solid background, leaving a `thickness`-px
 * border of the gradient visible around the edge.
 *
 * Reduced motion: the gradient does NOT animate when prefers-reduced-motion is
 * set; the static gradient is shown instead. We don't currently animate the
 * angle on web anyway (the cost of a perpetually-running animation is real),
 * but the hook is here so we can add an explicit opt-in later.
 */
export default function RainbowInputWrapper({
  children,
  focused = false,
  thickness = 2,
  radius = 12,
  className = '',
  contentClassName = '',
  style: styleOverride,
}) {
  const wrapperStyle = useMemo(() => ({
    backgroundImage: BRAND_GRADIENT,
    padding: thickness,
    borderRadius: radius,
    transition: 'filter 200ms ease-out, transform 200ms ease-out',
    filter: focused ? 'saturate(1.15)' : 'saturate(0.85)',
    transform: focused ? 'scale(1.005)' : 'scale(1)',
    ...styleOverride,
  }), [focused, thickness, radius, styleOverride]);

  const innerStyle = useMemo(() => ({
    backgroundColor: 'var(--primary-background-color, #ffffff)',
    borderRadius: radius - 1,
  }), [radius]);

  return (
    <div className={className} style={wrapperStyle}>
      <div className={contentClassName} style={innerStyle}>
        {children}
      </div>
    </div>
  );
}
