import { createPortal } from 'react-dom';
import React, { useRef, useEffect, useState } from 'react';

/**
 * Renders children in a portal positioned relative to an anchor element.
 * Prevents clipping by overflow:hidden parents.
 */
export default function PortalDropdown({ anchorRef, open, onClose, children, align = 'center', width = 'auto' }) {
  const menuRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open || !anchorRef?.current) return;
    function updatePos() {
      const rect = anchorRef.current.getBoundingClientRect();
      let left;
      if (align === 'left') left = rect.left;
      else if (align === 'right') left = rect.right;
      else left = rect.left + rect.width / 2;

      // Ensure dropdown doesn't go off-screen right
      const menuW = typeof width === 'number' ? width : 200;
      if (left + menuW > window.innerWidth - 16) {
        left = window.innerWidth - menuW - 16;
      }
      if (left < 8) left = 8;

      // Check if dropdown would go below viewport — flip upward if needed
      let top = rect.bottom + 4;
      const menuH = menuRef.current?.offsetHeight || 400;
      if (top + menuH > window.innerHeight - 16) {
        // Not enough space below — position above the anchor
        top = Math.max(8, rect.top - menuH - 4);
      }

      setPos({ top, left });
    }
    updatePos();
    window.addEventListener('scroll', updatePos, true);
    window.addEventListener('resize', updatePos);
    return () => {
      window.removeEventListener('scroll', updatePos, true);
      window.removeEventListener('resize', updatePos);
    };
  }, [open, anchorRef, align, width]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target) && !anchorRef?.current?.contains(e.target)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  return createPortal(
    <div ref={menuRef} style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 9999, width: typeof width === 'number' ? width : undefined }}
      className="dropdown-enter">
      {children}
    </div>,
    document.body
  );
}
