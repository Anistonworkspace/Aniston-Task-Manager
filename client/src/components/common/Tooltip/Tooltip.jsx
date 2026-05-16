import React, { useRef, useState, useEffect, useId, cloneElement, isValidElement } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { usePopoverPosition } from '../Popover/usePopoverPosition';
import { resolvePaletteColor, contrastingTextColor } from '../../../utils/labelPalette';

/**
 * Tooltip — small label on hover/focus.
 *
 *   <Tooltip content="Full text" placement="top">
 *     <button>Hover me</button>
 *   </Tooltip>
 *
 * Behavior:
 *   - Opens after `delay` ms (default 200) on hover OR focus.
 *   - Never opens on touch devices (would block tap target).
 *   - Wires aria-describedby on the trigger.
 *
 * Color-matching variant (skill §2.5):
 *   colorMatch="red" or colorMatch="#df2f4a" — tooltip background matches
 *   the trigger's pill color. White text auto-selected when bg is dark.
 */
export default function Tooltip({
  content,
  children,
  placement = 'top',
  delay = 200,
  closeDelay = 0,
  disabled = false,
  colorMatch,
  maxWidth = 240,
  className = '',
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const contentRef = useRef(null);
  const openTimerRef = useRef(null);
  const closeTimerRef = useRef(null);
  const tooltipId = useId();
  const reducedMotion = useReducedMotion();

  const position = usePopoverPosition({
    anchorRef: triggerRef,
    contentRef,
    open,
    placement,
    offset: 8,
  });

  // Detect touch — `(hover: none)` is set on devices without a precise pointer.
  const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches;

  function scheduleOpen() {
    if (disabled || isTouch || !content) return;
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (open) return;
    openTimerRef.current = setTimeout(() => setOpen(true), delay);
  }

  function scheduleClose() {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeDelay > 0) {
      closeTimerRef.current = setTimeout(() => setOpen(false), closeDelay);
    } else {
      setOpen(false);
    }
  }

  useEffect(() => () => {
    if (openTimerRef.current) clearTimeout(openTimerRef.current);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);

  // Hide tooltip on Escape (a11y nicety for keyboard users).
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  let bg = 'rgba(31, 31, 31, 0.95)';
  let text = '#ffffff';
  if (colorMatch) {
    const palette = resolvePaletteColor(colorMatch);
    bg = palette.bg;
    text = palette.text || contrastingTextColor(palette.bg);
  }

  const triggerProps = {
    onMouseEnter: (e) => { children?.props?.onMouseEnter?.(e); scheduleOpen(); },
    onMouseLeave: (e) => { children?.props?.onMouseLeave?.(e); scheduleClose(); },
    onFocus: (e) => { children?.props?.onFocus?.(e); scheduleOpen(); },
    onBlur: (e) => { children?.props?.onBlur?.(e); scheduleClose(); },
    'aria-describedby': open ? tooltipId : children?.props?.['aria-describedby'],
  };

  const trigger = isValidElement(children)
    ? cloneElement(children, {
        ref: (node) => {
          triggerRef.current = node;
          const childRef = children.ref;
          if (typeof childRef === 'function') childRef(node);
          else if (childRef && typeof childRef === 'object') childRef.current = node;
        },
        ...triggerProps,
      })
    : (
      <span ref={triggerRef} {...triggerProps}>{children}</span>
    );

  return (
    <>
      {trigger}
      <AnimatePresence>
        {open && content && createPortal(
          <motion.div
            ref={contentRef}
            role="tooltip"
            id={tooltipId}
            className={`pointer-events-none ${className}`}
            style={{
              position: 'fixed',
              top: position.top,
              left: position.left,
              maxWidth,
              backgroundColor: bg,
              color: text,
              padding: '6px 10px',
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 500,
              lineHeight: '16px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
              visibility: position.ready ? 'visible' : 'hidden',
              zIndex: 'var(--tooltip-z-index, 10001)',
            }}
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
            animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12, ease: 'easeOut' }}
          >
            {content}
          </motion.div>,
          document.body
        )}
      </AnimatePresence>
    </>
  );
}
