import React, { createContext, useContext, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';

/**
 * SidePanel — edge-anchored slide-in panel.
 *
 *   <SidePanel open onClose side="right" width={420} mode="overlay">
 *     <SidePanel.Header>...</SidePanel.Header>
 *     <SidePanel.Body>...</SidePanel.Body>
 *     <SidePanel.Footer>...</SidePanel.Footer>
 *   </SidePanel>
 *
 *  - mode="overlay": floats above content with a subtle backdrop tint,
 *    traps focus by default, closes on Escape.
 *  - mode="push":    pushes the main content (no backdrop, no focus trap).
 *    The consumer is responsible for reserving the width on the page.
 *  - persistent: when true, content stays mounted on close (translates off).
 */

const SidePanelContext = createContext(null);

function useSidePanelContext() {
  const ctx = useContext(SidePanelContext);
  if (!ctx) throw new Error('SidePanel.Header/Body/Footer must be inside <SidePanel>');
  return ctx;
}

export default function SidePanel({
  open,
  onClose,
  side = 'right',
  width = 420,
  mode = 'overlay',
  closeOnEscape = true,
  closeOnOutsideClick = false,
  persistent = false,
  trapFocus = mode === 'overlay',
  ariaLabel,
  children,
}) {
  const panelRef = useRef(null);
  const previousFocusRef = useRef(null);
  const reducedMotion = useReducedMotion();

  // Restore focus to opener on close.
  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement;
      const t = setTimeout(() => {
        if (!panelRef.current) return;
        const focusable = panelRef.current.querySelector(
          'input, textarea, button:not([disabled]), [href], select, [tabindex]:not([tabindex="-1"])'
        );
        focusable?.focus();
      }, 60);
      return () => clearTimeout(t);
    }
    const prev = previousFocusRef.current;
    if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
      prev.focus();
    }
    return undefined;
  }, [open]);

  // Escape close.
  useEffect(() => {
    if (!open || !closeOnEscape) return undefined;
    function onKey(e) { if (e.key === 'Escape') onClose?.(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, closeOnEscape, onClose]);

  // Focus trap (overlay only).
  useEffect(() => {
    if (!open || !trapFocus) return undefined;
    function onKey(e) {
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll(
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
  }, [open, trapFocus]);

  const widthCss = typeof width === 'number' ? `${width}px` : width;
  const xClosed = side === 'right' ? '100%' : '-100%';

  const panel = (
    <motion.div
      ref={panelRef}
      role="dialog"
      aria-modal={mode === 'overlay' ? 'true' : undefined}
      aria-label={ariaLabel || 'Side panel'}
      className="flex flex-col"
      style={{
        position: 'fixed',
        top: 0,
        bottom: 0,
        [side]: 0,
        width: widthCss,
        maxWidth: '100vw',
        backgroundColor: 'var(--primary-background-color, #ffffff)',
        boxShadow: side === 'right'
          ? '-12px 0 32px rgba(0,0,0,0.12)'
          : '12px 0 32px rgba(0,0,0,0.12)',
        zIndex: 'var(--side-panel-z-index, 9998)',
        borderLeft: side === 'right' ? '1px solid var(--layout-border-color, #e2e2e2)' : undefined,
        borderRight: side === 'left' ? '1px solid var(--layout-border-color, #e2e2e2)' : undefined,
      }}
      initial={reducedMotion ? { opacity: 0 } : { x: xClosed, opacity: 0 }}
      animate={reducedMotion ? { opacity: 1 } : { x: 0, opacity: 1 }}
      exit={reducedMotion ? { opacity: 0 } : { x: xClosed, opacity: 0 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
    >
      <SidePanelContext.Provider value={{ onClose }}>
        {children}
      </SidePanelContext.Provider>
    </motion.div>
  );

  const backdrop = mode === 'overlay' ? (
    <motion.div
      onClick={closeOnOutsideClick ? onClose : undefined}
      className="fixed inset-0"
      style={{
        backgroundColor: 'rgba(15, 23, 42, 0.32)',
        zIndex: 'var(--side-panel-backdrop-z-index, 9997)',
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
    />
  ) : null;

  // Persistent mode: render even when closed (translate offscreen).
  if (persistent) {
    return createPortal(
      <>
        {open && backdrop}
        {panel}
      </>,
      document.body
    );
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          {backdrop}
          {panel}
        </>
      )}
    </AnimatePresence>,
    document.body
  );
}

function SidePanelHeader({ title, children, onClose: onCloseOverride, className = '' }) {
  const { onClose } = useSidePanelContext();
  const handleClose = onCloseOverride || onClose;
  return (
    <div
      className={`flex items-center justify-between flex-shrink-0 ${className}`}
      style={{
        padding: '16px 20px',
        borderBottom: '1px solid var(--layout-border-color, #e2e2e2)',
      }}
    >
      {title ? (
        <h2 className="font-semibold text-base text-text-primary truncate">{title}</h2>
      ) : children}
      {handleClose && (
        <button
          type="button"
          onClick={handleClose}
          aria-label="Close panel"
          className="ml-3 p-1.5 rounded-md transition-colors hover:bg-surface-100 text-text-secondary"
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}

function SidePanelBody({ children, className = '', padded = true }) {
  return (
    <div
      className={`flex-1 overflow-auto ${className}`}
      style={padded ? { padding: '20px' } : undefined}
    >
      {children}
    </div>
  );
}

function SidePanelFooter({ children, className = '' }) {
  return (
    <div
      className={`flex items-center justify-end gap-2 flex-shrink-0 ${className}`}
      style={{
        padding: '12px 20px',
        borderTop: '1px solid var(--layout-border-color, #e2e2e2)',
        backgroundColor: 'var(--surface-50, #f8f9fb)',
      }}
    >
      {children}
    </div>
  );
}

SidePanel.Header = SidePanelHeader;
SidePanel.Body = SidePanelBody;
SidePanel.Footer = SidePanelFooter;
