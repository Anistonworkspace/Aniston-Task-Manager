import React, { useEffect, useRef, useState } from 'react';
import Tooltip from '../Tooltip';
import { resolvePaletteColor, contrastingTextColor } from '../../../utils/labelPalette';

/**
 * StatusPill — categorical color label.
 *
 *   <StatusPill color="red" label="Stuck" />
 *   <StatusPill color="green" label="Done" variant="outlined" />
 *   <StatusPill color="#df2f4a" label="Custom" />
 *
 * Behavior:
 *   - color: palette token (red/orange/yellow/green/teal/blue/purple/pink/gray)
 *     OR a hex string. Hex outside the palette gets contrast-adjusted text.
 *   - When `truncate` (default) is on and the label is clipped, a Tooltip
 *     appears on hover with a colorMatch background (skill §2.5).
 *   - `onClick` makes it interactive (cursor-pointer + focus ring).
 *   - `size="default" | "compact"` for board-cell vs. dense legends.
 */
export default function StatusPill({
  color = 'gray',
  label,
  variant = 'filled',
  size = 'default',
  onClick,
  truncate = true,
  iconPrefix,
  className = '',
  style: styleOverride,
  ariaLabel,
  fullWidth = false,
}) {
  const ref = useRef(null);
  const [isTruncated, setIsTruncated] = useState(false);

  useEffect(() => {
    if (!truncate || !ref.current) return;
    const el = ref.current;
    setIsTruncated(el.scrollWidth > el.clientWidth + 1);
  }, [label, truncate]);

  const palette = resolvePaletteColor(color);
  const isFilled = variant === 'filled';
  const text = isFilled
    ? (palette.text || contrastingTextColor(palette.bg))
    : palette.softText || palette.bg;
  const bg = isFilled ? palette.bg : palette.soft || 'transparent';
  const border = isFilled ? 'transparent' : palette.border || palette.bg;

  const padding = size === 'compact' ? '2px 8px' : '4px 10px';
  const fontSize = size === 'compact' ? 11 : 12;

  const pill = (
    <span
      ref={ref}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={ariaLabel || label}
      onClick={onClick}
      onKeyDown={(e) => {
        if (onClick && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick(e);
        }
      }}
      className={`inline-flex items-center gap-1.5 font-semibold rounded-sm whitespace-nowrap ${
        truncate ? 'overflow-hidden text-ellipsis' : ''
      } ${onClick ? 'cursor-pointer focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-primary-400' : ''} ${
        fullWidth ? 'w-full' : ''
      } ${className}`}
      style={{
        backgroundColor: bg,
        color: text,
        padding,
        fontSize,
        lineHeight: 1.2,
        border: variant === 'outlined' ? `1px solid ${border}` : '1px solid transparent',
        maxWidth: fullWidth ? '100%' : undefined,
        ...styleOverride,
      }}
    >
      {iconPrefix && <span className="flex-shrink-0">{iconPrefix}</span>}
      <span className={truncate ? 'truncate' : ''}>{label}</span>
    </span>
  );

  if (truncate && isTruncated && label) {
    return (
      <Tooltip content={label} colorMatch={isFilled ? color : undefined} placement="top">
        {pill}
      </Tooltip>
    );
  }
  return pill;
}
