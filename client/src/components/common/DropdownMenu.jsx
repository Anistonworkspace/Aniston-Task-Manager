import React, { useState, useRef, useEffect } from 'react';

export default function DropdownMenu({
  trigger,
  children,
  align = 'left',
  className = '',
}) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function handleToggle(e) {
    e.stopPropagation();
    setIsOpen((prev) => !prev);
  }

  function handleClose() {
    setIsOpen(false);
  }

  return (
    <div className={`dropdown ${className}`} ref={ref}>
      <div onClick={handleToggle}>{trigger}</div>
      {isOpen && (
        <div className={`dropdown__menu ${align === 'right' ? 'dropdown__menu--right' : ''}`}>
          {typeof children === 'function' ? children({ close: handleClose }) : children}
        </div>
      )}
    </div>
  );
}

export function DropdownItem({ children, icon: Icon, danger = false, onClick, close }) {
  function handleClick(e) {
    if (onClick) onClick(e);
    if (close) close();
  }

  return (
    <button
      className={`dropdown__item ${danger ? 'dropdown__item--danger' : ''}`}
      onClick={handleClick}
    >
      {Icon && (
        <span className="dropdown__item-icon">
          <Icon size={14} />
        </span>
      )}
      {children}
    </button>
  );
}

export function DropdownDivider() {
  return <div className="dropdown__divider" />;
}
