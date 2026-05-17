import React, { useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { modalOverlay, modalContent } from '../../utils/animations';

export default function Modal({ isOpen, onClose, title, children, footer, size = 'md', className = '' }) {
  const modalRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const hasAutoFocused = useRef(false);

  // Keep onClose ref current without causing re-renders
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  const handleKey = useCallback((e) => {
    if (e.key === 'Escape') onCloseRef.current();
    // Focus trap: Tab cycles within modal
    if (e.key === 'Tab' && modalRef.current) {
      const focusable = modalRef.current.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKey);
      document.body.style.overflow = 'hidden';
      // Auto-focus first input (prefer input/textarea over buttons) — only on initial open
      if (!hasAutoFocused.current) {
        hasAutoFocused.current = true;
        setTimeout(() => {
          if (modalRef.current) {
            const input = modalRef.current.querySelector('input, textarea, select');
            const fallback = modalRef.current.querySelector('button, [href], [tabindex]:not([tabindex="-1"])');
            (input || fallback)?.focus();
          }
        }, 100);
      }
    } else {
      hasAutoFocused.current = false;
    }
    return () => { document.removeEventListener('keydown', handleKey); document.body.style.overflow = ''; };
  }, [isOpen, handleKey]);

  // Sizes per skill §7.1 — base widths grow at ≥1280 and ≥1440.
  // `panel` is a non-spec right-rail variant kept for back-compat.
  //
  // Mobile (`max-md`): every centered size is allowed to grow to 92vh so
  // long-form modals (TaskModal, CreateBoardModal) don't crop their
  // footers behind the bottom edge on small screens. The base ≥md cap
  // (50/80/80/90vh) is preserved on desktop.
  const sizes = {
    sm:    'max-w-[460px] xl:max-w-[480px] 2xl:max-w-[520px] max-md:max-h-[92vh] max-h-[50vh]',
    md:    'max-w-[540px] xl:max-w-[580px] 2xl:max-w-[620px] max-md:max-h-[92vh] max-h-[80vh]',
    lg:    'max-w-[800px] xl:max-w-[840px] 2xl:max-w-[900px] max-md:max-h-[92vh] max-h-[80vh]',
    xl:    'max-w-[960px] max-md:max-h-[92vh] max-h-[90vh]',
    fullView: 'w-full mx-6 mt-10 max-h-[calc(100vh-40px)]',
    panel: 'max-w-[600px] ml-auto h-full rounded-none',
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          // Mobile: 12px horizontal padding so the modal panel doesn't hug
          // the viewport edge on phones. Desktop: no padding — the modal's
          // own max-width keeps it centered with breathing room.
          className="fixed inset-0 flex items-center justify-center max-md:px-3"
          style={{ zIndex: 'var(--modal-z-index, 10000)' }}
          onClick={(e) => e.target === e.currentTarget && onClose()}
          {...modalOverlay}
        >
          {/* Backdrop — spec §1.3 --backdrop-color (rgba(41,47,76,0.7)) */}
          <motion.div
            className="absolute inset-0"
            style={{ backgroundColor: 'var(--backdrop-color)' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.1 }}
          />

          {/* Content — radius --border-radius-big (16px), shadow --box-shadow-large */}
          <motion.div
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-label={title || 'Modal'}
            className={`relative w-full ${sizes[size] || sizes.md} flex flex-col overflow-hidden ${className}`}
            style={{
              backgroundColor: 'var(--modal-background-color)',
              borderRadius: 'var(--border-radius-big)',
              boxShadow: 'var(--box-shadow-large)',
            }}
            {...modalContent}
          >
            {title && (
              <div
                className="flex items-center justify-between"
                style={{
                  padding: 'var(--space-24) var(--space-32)',
                  borderBottom: '1px solid var(--layout-border-color)',
                }}
              >
                <h2
                  className="leading-tight"
                  style={{ font: 'var(--font-text1-medium)', color: 'var(--primary-text-color)' }}
                >
                  {title}
                </h2>
                <motion.button
                  onClick={onClose}
                  className="rounded-sm transition-colors"
                  style={{
                    padding: 'var(--space-4)',
                    color: 'var(--icon-color)',
                  }}
                  whileHover={{ rotate: 90, backgroundColor: 'var(--primary-background-hover-color)' }}
                  whileTap={{ scale: 0.9 }}
                  transition={{ duration: 0.15 }}
                  aria-label="Close"
                >
                  <X size={16} />
                </motion.button>
              </div>
            )}
            <div
              className="flex-1 overflow-auto"
              style={{ padding: 'var(--space-24) var(--space-32)' }}
            >
              {children}
            </div>
            {footer && (
              <div
                className="flex items-center justify-end flex-shrink-0"
                style={{
                  gap: 'var(--space-8)',
                  padding: 'var(--space-20) var(--space-24)',
                  borderTop: '1px solid var(--layout-border-color)',
                  backgroundColor: 'var(--primary-background-color)',
                }}
              >
                {footer}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
