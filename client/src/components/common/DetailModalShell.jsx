import React, { useEffect, useRef, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';

const SIZE_CLASS = {
  default: 'sm:max-w-[860px]',
  wide: 'sm:max-w-[1024px]',
  narrow: 'sm:max-w-[640px]',
  workspace: 'sm:w-[82vw] sm:max-w-[1240px]',
  // monday.com-style slide-up sheet: exactly 70vw, no max cap.
  sheet: 'sm:w-[70vw] sm:max-w-[70vw]',
};

// Outer flex container alignment per placement.
const PLACEMENT_CONTAINER = {
  center: 'items-center justify-center p-3 sm:p-6',
  bottom: 'items-end justify-center p-3 sm:px-6 sm:pb-6 sm:pt-12',
  // bottom-sheet has no padding so the panel touches the viewport bottom edge.
  'bottom-sheet': 'items-end justify-center',
};

// Panel-side styles per placement (height ceiling, animation hook, corner rounding).
const PLACEMENT_PANEL = {
  center: 'max-h-[90vh] sm:max-h-[88vh] rounded-xl detail-modal-panel-center',
  bottom: 'max-h-[calc(100vh-24px)] sm:max-h-[calc(100vh-72px)] rounded-xl detail-modal-panel-bottom',
  // Tall sheet attached to bottom edge: rounded only on top, flat at bottom.
  'bottom-sheet': 'h-[calc(100vh-32px)] sm:h-[calc(100vh-48px)] rounded-t-xl rounded-b-none border-b-0 detail-modal-panel-bottom-sheet',
};

const EXIT_ANIMATION_MS = 240;

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Centered modal shell for detail views (Task, Member drill-down, etc.).
 * Replaces the legacy right-side sheet with a monday.com-style centered dialog.
 *
 * Behaviour:
 *  - Renders in a portal under <body> with z-[100].
 *  - Locks body scroll while open, restores on unmount.
 *  - Closes on Escape (always) and on backdrop click (configurable).
 *  - Traps focus within the dialog and restores focus to the trigger on close.
 *  - Animation respects prefers-reduced-motion via a global media query.
 */
export default function DetailModalShell({
  onClose,
  onBeforeClose,
  ariaLabel,
  ariaLabelledBy,
  size = 'default',
  placement = 'center',
  closeOnBackdrop = true,
  className = '',
  closeRef,
  children,
}) {
  const dialogRef = useRef(null);
  const previousFocusRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const onBeforeCloseRef = useRef(onBeforeClose);
  const [isClosing, setIsClosing] = useState(false);
  const isClosingRef = useRef(false);
  const exitTimerRef = useRef(null);

  // Bottom-sheet is the only placement that ships with an exit animation.
  // For the others a synchronous close still feels right, so they bypass it.
  const supportsExitAnimation = placement === 'bottom-sheet';

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { onBeforeCloseRef.current = onBeforeClose; }, [onBeforeClose]);

  // requestClose may be called synchronously (Escape, X button) or via the
  // exposed closeRef. When an onBeforeClose guard is registered, we consult
  // it FIRST — before the slide-down animation starts — so an aborted close
  // leaves the panel untouched. The guard may return a boolean or a
  // Promise<boolean>; only an explicit `false` aborts.
  const requestClose = useCallback(async () => {
    if (isClosingRef.current) return;
    const guard = onBeforeCloseRef.current;
    if (typeof guard === 'function') {
      try {
        const decision = await guard();
        if (decision === false) return;
      } catch {
        // Treat guard errors as "abort" so an unexpected throw never
        // silently dismisses an unsaved edit.
        return;
      }
      if (isClosingRef.current) return;
    }
    if (!supportsExitAnimation) {
      onCloseRef.current?.();
      return;
    }
    isClosingRef.current = true;
    setIsClosing(true);
    exitTimerRef.current = setTimeout(() => {
      onCloseRef.current?.();
    }, EXIT_ANIMATION_MS);
  }, [supportsExitAnimation]);

  // Expose requestClose to consumers so close buttons inside the panel can
  // trigger the slide-down before the parent unmounts the shell.
  useEffect(() => {
    if (!closeRef) return undefined;
    closeRef.current = requestClose;
    return () => { if (closeRef) closeRef.current = null; };
  }, [closeRef, requestClose]);

  useEffect(() => {
    return () => { if (exitTimerRef.current) clearTimeout(exitTimerRef.current); };
  }, []);

  useEffect(() => {
    previousFocusRef.current = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        requestClose();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll(FOCUSABLE);
        if (focusable.length === 0) {
          e.preventDefault();
          dialogRef.current.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        const inside = dialogRef.current.contains(active);
        if (e.shiftKey) {
          if (!inside || active === first) { e.preventDefault(); last.focus(); }
        } else {
          if (!inside || active === last) { e.preventDefault(); first.focus(); }
        }
      }
    };
    document.addEventListener('keydown', onKey);

    const focusTimer = setTimeout(() => {
      if (!dialogRef.current) return;
      if (dialogRef.current.contains(document.activeElement)) return;
      const first = dialogRef.current.querySelector(FOCUSABLE);
      (first || dialogRef.current).focus({ preventScroll: true });
    }, 60);

    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      const target = previousFocusRef.current;
      if (target && typeof target.focus === 'function') {
        try { target.focus({ preventScroll: true }); } catch { /* element gone */ }
      }
    };
  }, []);

  const handleBackdropMouseDown = useCallback((e) => {
    if (!closeOnBackdrop) return;
    if (e.target === e.currentTarget) requestClose();
  }, [closeOnBackdrop, requestClose]);

  const sizeClass = SIZE_CLASS[size] || SIZE_CLASS.default;
  const containerClass = PLACEMENT_CONTAINER[placement] || PLACEMENT_CONTAINER.center;
  const panelPlacementClass = PLACEMENT_PANEL[placement] || PLACEMENT_PANEL.center;
  const closingClass = isClosing ? 'is-closing' : '';

  return createPortal(
    <div
      className={`detail-modal-backdrop fixed inset-0 z-[100] flex ${containerClass} ${closingClass}`}
      onMouseDown={handleBackdropMouseDown}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabelledBy ? undefined : ariaLabel}
        aria-labelledby={ariaLabelledBy}
        tabIndex={-1}
        className={`detail-modal-panel relative bg-[var(--primary-background-color)] shadow-2xl border border-border w-full ${sizeClass} ${panelPlacementClass} ${closingClass} flex flex-col overflow-hidden focus:outline-none ${className}`}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}
