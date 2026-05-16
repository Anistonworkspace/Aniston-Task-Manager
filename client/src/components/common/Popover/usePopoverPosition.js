import { useEffect, useRef, useState } from 'react';

/**
 * Positioning hook for portal-rendered Popovers/Tooltips/Menus.
 *
 * Computes top/left/transformOrigin given an anchor rect, content size, and
 * desired placement. Handles viewport collision via flip + shift.
 *
 * Designed to be swap-compatible with @floating-ui/react later — the public
 * shape (placement, offset, flip, shift) mirrors Floating UI's options.
 */
export function usePopoverPosition({
  anchorRef,
  contentRef,
  open,
  placement = 'bottom-start',
  offset = 8,
  flip = true,
  shift = true,
  matchTriggerWidth = false,
} = {}) {
  const [position, setPosition] = useState({ top: 0, left: 0, ready: false, finalPlacement: placement });
  const rafRef = useRef(null);

  useEffect(() => {
    if (!open || !anchorRef?.current) return undefined;

    function update() {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        if (!anchorRef.current) return;
        const aRect = anchorRef.current.getBoundingClientRect();
        const cRect = contentRef?.current?.getBoundingClientRect();
        const cW = cRect?.width || 240;
        const cH = cRect?.height || 200;
        const vpW = window.innerWidth;
        const vpH = window.innerHeight;
        const margin = 8;

        const [side, align = 'center'] = placement.split('-');

        // Compute base position for each side.
        const positions = {
          top: { top: aRect.top - cH - offset, left: alignAxis(aRect, cW, align, 'horizontal') },
          bottom: { top: aRect.bottom + offset, left: alignAxis(aRect, cW, align, 'horizontal') },
          left: { top: alignAxis(aRect, cH, align, 'vertical'), left: aRect.left - cW - offset },
          right: { top: alignAxis(aRect, cH, align, 'vertical'), left: aRect.right + offset },
        };

        let chosenSide = side;
        let candidate = positions[chosenSide];

        // Flip to opposite side if primary side overflows.
        if (flip) {
          const overflowTop = candidate.top < margin;
          const overflowBottom = candidate.top + cH > vpH - margin;
          const overflowLeft = candidate.left < margin;
          const overflowRight = candidate.left + cW > vpW - margin;

          const flipMap = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
          const horizontal = chosenSide === 'left' || chosenSide === 'right';
          const overflowsPrimary = horizontal
            ? (chosenSide === 'left' ? overflowLeft : overflowRight)
            : (chosenSide === 'top' ? overflowTop : overflowBottom);

          if (overflowsPrimary) {
            chosenSide = flipMap[chosenSide];
            candidate = positions[chosenSide];
          }
        }

        // Shift along the cross axis so the content stays in the viewport.
        if (shift) {
          if (chosenSide === 'top' || chosenSide === 'bottom') {
            if (candidate.left < margin) candidate.left = margin;
            if (candidate.left + cW > vpW - margin) candidate.left = vpW - cW - margin;
          } else {
            if (candidate.top < margin) candidate.top = margin;
            if (candidate.top + cH > vpH - margin) candidate.top = vpH - cH - margin;
          }
        }

        const width = matchTriggerWidth ? aRect.width : undefined;

        setPosition({
          top: candidate.top,
          left: candidate.left,
          width,
          ready: true,
          finalPlacement: chosenSide + (align !== 'center' ? `-${align}` : ''),
        });
      });
    }

    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);

    let ro;
    if (contentRef?.current && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(update);
      ro.observe(contentRef.current);
    }

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      if (ro) ro.disconnect();
    };
  }, [open, anchorRef, contentRef, placement, offset, flip, shift, matchTriggerWidth]);

  return position;
}

function alignAxis(rect, contentSize, align, axis) {
  if (axis === 'horizontal') {
    if (align === 'start') return rect.left;
    if (align === 'end') return rect.right - contentSize;
    return rect.left + rect.width / 2 - contentSize / 2;
  }
  if (align === 'start') return rect.top;
  if (align === 'end') return rect.bottom - contentSize;
  return rect.top + rect.height / 2 - contentSize / 2;
}
