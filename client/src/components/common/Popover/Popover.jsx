import React, {
  createContext,
  useContext,
  useState,
  useRef,
  useEffect,
  useCallback,
  useId,
  cloneElement,
  isValidElement,
} from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { usePopoverPosition } from './usePopoverPosition';

/**
 * Popover — universal anchored overlay primitive.
 *
 * Compound API:
 *   <Popover open={...} onOpenChange={...} placement="bottom-start">
 *     <Popover.Trigger>{trigger}</Popover.Trigger>
 *     <Popover.Content>{content}</Popover.Content>
 *   </Popover>
 *
 * Behavior:
 *   - Portal-rendered (escapes overflow:hidden / z-index stacks).
 *   - Outside-click + Escape close (configurable).
 *   - Optional focus trap with `modal` prop.
 *   - Viewport collision flip + shift.
 *
 * Designed to swap to @floating-ui/react later without changing the public API.
 */

const PopoverContext = createContext(null);

function usePopoverContext() {
  const ctx = useContext(PopoverContext);
  if (!ctx) throw new Error('Popover.Trigger / Popover.Content must be inside <Popover>');
  return ctx;
}

export default function Popover({
  children,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  placement = 'bottom-start',
  offset = 8,
  closeOnOutsideClick = true,
  closeOnEscape = true,
  modal = false,
  matchTriggerWidth = false,
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  const setOpen = useCallback((next) => {
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }, [isControlled, onOpenChange]);

  const triggerRef = useRef(null);
  const contentRef = useRef(null);
  const triggerId = useId();
  const contentId = useId();

  const value = {
    open,
    setOpen,
    triggerRef,
    contentRef,
    triggerId,
    contentId,
    placement,
    offset,
    closeOnOutsideClick,
    closeOnEscape,
    modal,
    matchTriggerWidth,
  };

  return <PopoverContext.Provider value={value}>{children}</PopoverContext.Provider>;
}

function PopoverTrigger({ children, asChild = true }) {
  const { open, setOpen, triggerRef, triggerId, contentId } = usePopoverContext();

  const onClick = useCallback((e) => {
    children.props?.onClick?.(e);
    if (e.defaultPrevented) return;
    setOpen(!open);
  }, [children.props, open, setOpen]);

  const ariaProps = {
    'aria-expanded': open,
    'aria-controls': open ? contentId : undefined,
    'aria-haspopup': 'dialog',
    id: triggerId,
  };

  if (asChild && isValidElement(children)) {
    return cloneElement(children, {
      ref: (node) => {
        triggerRef.current = node;
        const childRef = children.ref;
        if (typeof childRef === 'function') childRef(node);
        else if (childRef && typeof childRef === 'object') childRef.current = node;
      },
      onClick,
      ...ariaProps,
    });
  }

  return (
    <button ref={triggerRef} onClick={onClick} type="button" {...ariaProps}>
      {children}
    </button>
  );
}

function PopoverContent({
  children,
  width = 'auto',
  maxHeight,
  className = '',
  style: styleOverride = {},
  showArrow = false,
  ariaLabel,
}) {
  const {
    open,
    setOpen,
    triggerRef,
    contentRef,
    triggerId,
    contentId,
    placement,
    offset,
    closeOnOutsideClick,
    closeOnEscape,
    modal,
    matchTriggerWidth,
  } = usePopoverContext();

  const reducedMotion = useReducedMotion();
  const previousFocusRef = useRef(null);

  const { top, left, ready, width: posWidth, finalPlacement } = usePopoverPosition({
    anchorRef: triggerRef,
    contentRef,
    open,
    placement,
    offset,
    matchTriggerWidth,
  });

  // Outside click handling.
  useEffect(() => {
    if (!open || !closeOnOutsideClick) return undefined;
    function onPointer(e) {
      const t = e.target;
      if (!contentRef.current || !triggerRef.current) return;
      if (contentRef.current.contains(t) || triggerRef.current.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('touchstart', onPointer);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('touchstart', onPointer);
    };
  }, [open, closeOnOutsideClick, setOpen, contentRef, triggerRef]);

  // Escape handling.
  useEffect(() => {
    if (!open || !closeOnEscape) return undefined;
    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, closeOnEscape, setOpen]);

  // Focus management — move into content on open, restore on close.
  useEffect(() => {
    if (!open) return undefined;
    previousFocusRef.current = document.activeElement;
    const t = setTimeout(() => {
      if (!contentRef.current) return;
      if (modal) {
        const focusable = contentRef.current.querySelector(
          'input, textarea, button, [href], [tabindex]:not([tabindex="-1"])'
        );
        focusable?.focus();
      }
    }, 50);
    return () => {
      clearTimeout(t);
      const prev = previousFocusRef.current;
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
        prev.focus();
      }
    };
  }, [open, modal, contentRef]);

  // Focus trap when modal=true.
  useEffect(() => {
    if (!open || !modal) return undefined;
    function onKey(e) {
      if (e.key !== 'Tab' || !contentRef.current) return;
      const focusable = contentRef.current.querySelectorAll(
        'input, textarea, button:not([disabled]), [href], select, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, modal, contentRef]);

  const resolvedWidth = matchTriggerWidth ? posWidth : (width === 'trigger' ? posWidth : (width === 'auto' ? undefined : width));

  const transformOrigin = transformOriginFor(finalPlacement);

  return (
    <AnimatePresence>
      {open && createPortal(
        <motion.div
          ref={contentRef}
          id={contentId}
          role="dialog"
          aria-labelledby={triggerId}
          aria-label={ariaLabel}
          className={`popover-content ${className}`}
          style={{
            position: 'fixed',
            top,
            left,
            width: resolvedWidth,
            maxHeight,
            visibility: ready ? 'visible' : 'hidden',
            zIndex: 'var(--popover-z-index, 9999)',
            transformOrigin,
            ...styleOverride,
          }}
          initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
          animate={reducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
          exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
          transition={{ duration: reducedMotion ? 0.1 : 0.15, ease: [0.16, 1, 0.3, 1] }}
        >
          {children}
        </motion.div>,
        document.body
      )}
    </AnimatePresence>
  );
}

function transformOriginFor(placement) {
  const [side] = (placement || '').split('-');
  switch (side) {
    case 'top': return 'bottom center';
    case 'bottom': return 'top center';
    case 'left': return 'right center';
    case 'right': return 'left center';
    default: return 'top center';
  }
}

Popover.Trigger = PopoverTrigger;
Popover.Content = PopoverContent;
