import React from 'react';
import LoadingSpinner from './LoadingSpinner';

export default function Button({
  children,
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  loading = false,
  disabled = false,
  icon: Icon,
  iconOnly = false,
  className = '',
  type = 'button',
  onClick,
  ...props
}) {
  const classes = [
    'btn',
    `btn--${variant}`,
    size !== 'md' && `btn--${size}`,
    fullWidth && 'btn--full',
    iconOnly && 'btn--icon',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || loading}
      onClick={onClick}
      {...props}
    >
      {loading ? (
        <LoadingSpinner size="sm" />
      ) : (
        <>
          {Icon && <Icon size={size === 'sm' ? 14 : 16} />}
          {!iconOnly && children}
        </>
      )}
    </button>
  );
}
