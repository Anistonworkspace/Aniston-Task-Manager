import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  cloneElement,
  isValidElement,
} from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChevronRight } from 'lucide-react';

/**
 * ContextMenu — right-click (or long-press) menu.
 *
 *   <ContextMenu>
 *     <ContextMenu.Trigger>
 *       <div>Right-click me</div>
 *     </ContextMenu.Trigger>
 *     <ContextMenu.Content>
 *       <ContextMenu.Item onSelect={...}>Rename</ContextMenu.Item>
 *       <ContextMenu.Separator />
 *       <ContextMenu.Submenu label="Move to...">
 *         <ContextMenu.Item onSelect={...}>Group A</ContextMenu.Item>
 *       </ContextMenu.Submenu>
 *       <ContextMenu.Item destructive onSelect={...}>Delete</ContextMenu.Item>
 *     </ContextMenu.Content>
 *   </ContextMenu>
 */

const ContextMenuContext = createContext(null);
function useCtx() {
  const ctx = useContext(ContextMenuContext);
  if (!ctx) throw new Error('ContextMenu.* must be inside <ContextMenu>');
  return ctx;
}

export default function ContextMenu({ children }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const value = { open, setOpen, pos, setPos };
  return <ContextMenuContext.Provider value={value}>{children}</ContextMenuContext.Provider>;
}

function CMTrigger({ children, disabled = false, asChild = true, longPressMs = 500 }) {
  const { setOpen, setPos } = useCtx();
  const longPressTimer = useRef(null);

  const handlers = {
    onContextMenu: (e) => {
      if (disabled) return;
      children?.props?.onContextMenu?.(e);
      e.preventDefault();
      setPos({ x: e.clientX, y: e.clientY });
      setOpen(true);
    },
    onTouchStart: (e) => {
      if (disabled) return;
      children?.props?.onTouchStart?.(e);
      const touch = e.touches?.[0];
      if (!touch) return;
      longPressTimer.current = setTimeout(() => {
        setPos({ x: touch.clientX, y: touch.clientY });
        setOpen(true);
      }, longPressMs);
    },
    onTouchEnd: (e) => {
      children?.props?.onTouchEnd?.(e);
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
    },
    onTouchMove: (e) => {
      children?.props?.onTouchMove?.(e);
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
    },
  };

  if (asChild && isValidElement(children)) {
    return cloneElement(children, handlers);
  }
  return <span {...handlers}>{children}</span>;
}

function CMContent({ children, minWidth = 200, maxWidth = 320, ariaLabel = 'Context menu' }) {
  const { open, setOpen, pos } = useCtx();
  const ref = useRef(null);
  const [adjustedPos, setAdjustedPos] = useState(pos);
  const reducedMotion = useReducedMotion();

  // Adjust position to stay inside viewport.
  useEffect(() => {
    if (!open) return;
    const t = requestAnimationFrame(() => {
      if (!ref.current) return;
      const rect = ref.current.getBoundingClientRect();
      let { x, y } = pos;
      const margin = 8;
      if (x + rect.width > window.innerWidth - margin) x = window.innerWidth - rect.width - margin;
      if (y + rect.height > window.innerHeight - margin) y = window.innerHeight - rect.height - margin;
      if (x < margin) x = margin;
      if (y < margin) y = margin;
      setAdjustedPos({ x, y });
    });
    return () => cancelAnimationFrame(t);
  }, [open, pos]);

  // Outside click + Escape.
  useEffect(() => {
    if (!open) return undefined;
    function onPointer(e) {
      if (!ref.current || !ref.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('touchstart', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('touchstart', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen]);

  // Focus first item on open for keyboard nav.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      const first = ref.current?.querySelector('[role="menuitem"]:not([aria-disabled="true"])');
      first?.focus();
    }, 30);
    return () => clearTimeout(t);
  }, [open]);

  return (
    <AnimatePresence>
      {open && createPortal(
        <motion.div
          ref={ref}
          role="menu"
          aria-label={ariaLabel}
          className="py-1 rounded-md shadow-md focus:outline-none"
          style={{
            position: 'fixed',
            top: adjustedPos.y,
            left: adjustedPos.x,
            minWidth,
            maxWidth,
            backgroundColor: 'var(--primary-background-color, #ffffff)',
            border: '1px solid var(--layout-border-color, #e2e2e2)',
            zIndex: 'var(--context-menu-z-index, 10000)',
          }}
          initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
          animate={reducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
          exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
          transition={{ duration: 0.12 }}
          onKeyDown={(e) => handleArrowKeys(e, ref.current)}
        >
          {children}
        </motion.div>,
        document.body
      )}
    </AnimatePresence>
  );
}

function handleArrowKeys(e, container) {
  if (!container) return;
  const items = Array.from(container.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])'));
  if (items.length === 0) return;
  const activeIndex = items.indexOf(document.activeElement);

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    items[(activeIndex + 1) % items.length].focus();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    items[(activeIndex - 1 + items.length) % items.length].focus();
  } else if (e.key === 'Home') {
    e.preventDefault();
    items[0].focus();
  } else if (e.key === 'End') {
    e.preventDefault();
    items[items.length - 1].focus();
  }
}

function CMItem({
  children,
  onSelect,
  disabled = false,
  destructive = false,
  icon,
  shortcut,
  className = '',
}) {
  const { setOpen } = useCtx();
  const handler = () => {
    if (disabled) return;
    onSelect?.();
    setOpen(false);
  };
  return (
    <button
      role="menuitem"
      type="button"
      aria-disabled={disabled || undefined}
      onClick={handler}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handler();
        }
      }}
      disabled={disabled}
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left outline-none disabled:opacity-40 ${
        destructive
          ? 'text-danger hover:bg-danger/10 focus:bg-danger/10'
          : 'text-text-primary hover:bg-surface-100 focus:bg-surface-100'
      } ${className}`}
    >
      {icon && <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center">{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
      {shortcut && <span className="text-xs text-text-tertiary ml-3">{shortcut}</span>}
    </button>
  );
}

function CMSeparator() {
  return <div className="my-1 border-t border-border-light" role="separator" />;
}

function CMSubmenu({ label, icon, children, disabled = false }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const subRef = useRef(null);
  const closeTimer = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  function openMenu() {
    if (disabled) return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (!triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    setPos({ top: r.top, left: r.right + 2 });
    setOpen(true);
  }
  function closeMenu() {
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  }

  return (
    <div
      className="relative"
      onMouseEnter={openMenu}
      onMouseLeave={closeMenu}
    >
      <button
        ref={triggerRef}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        type="button"
        disabled={disabled}
        onFocus={openMenu}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'Enter') {
            e.preventDefault();
            openMenu();
          }
        }}
        className="w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-text-primary hover:bg-surface-100 focus:bg-surface-100 outline-none disabled:opacity-40"
      >
        {icon && <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center">{icon}</span>}
        <span className="flex-1 text-left truncate">{label}</span>
        <ChevronRight size={14} className="text-text-tertiary" />
      </button>
      <AnimatePresence>
        {open && createPortal(
          <motion.div
            ref={subRef}
            role="menu"
            className="py-1 rounded-md shadow-md"
            onMouseEnter={openMenu}
            onMouseLeave={closeMenu}
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              minWidth: 180,
              backgroundColor: 'var(--primary-background-color, #ffffff)',
              border: '1px solid var(--layout-border-color, #e2e2e2)',
              zIndex: 'var(--context-menu-z-index, 10000)',
            }}
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -4 }}
            transition={{ duration: 0.12 }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') {
                setOpen(false);
                triggerRef.current?.focus();
              }
              handleArrowKeys(e, subRef.current);
            }}
          >
            {children}
          </motion.div>,
          document.body
        )}
      </AnimatePresence>
    </div>
  );
}

ContextMenu.Trigger = CMTrigger;
ContextMenu.Content = CMContent;
ContextMenu.Item = CMItem;
ContextMenu.Separator = CMSeparator;
ContextMenu.Submenu = CMSubmenu;
