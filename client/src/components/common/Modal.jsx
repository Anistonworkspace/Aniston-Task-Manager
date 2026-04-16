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

  const sizes = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl', panel: 'max-w-2xl ml-auto h-full rounded-none' };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center"
          onClick={(e) => e.target === e.currentTarget && onClose()}
          {...modalOverlay}
        >
          {/* Backdrop */}
          <motion.div
            className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          />

          {/* Content */}
          <motion.div
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-label={title || 'Modal'}
            className={`relative bg-white dark:bg-[#1E1F23] rounded-xl shadow-2xl w-full ${sizes[size] || sizes.md} max-h-[90vh] flex flex-col border border-border ${className}`}
            {...modalContent}
          >
            {title && (
              <div className="flex items-center justify-between px-6 py-4 border-b border-border">
                <h2 className="text-[15px] font-semibold text-text-primary">{title}</h2>
                <motion.button
                  onClick={onClose}
                  className="p-1.5 rounded-lg hover:bg-surface-100 transition-colors text-text-tertiary hover:text-text-secondary"
                  whileHover={{ rotate: 90 }}
                  whileTap={{ scale: 0.9 }}
                  transition={{ duration: 0.2 }}
                >
                  <X size={16} />
                </motion.button>
              </div>
            )}
            <div className="flex-1 overflow-auto px-6 py-4">{children}</div>
            {footer && <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-border">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
