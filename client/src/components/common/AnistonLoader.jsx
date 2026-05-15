import React from 'react';

// Public asset path — file lives at client/public/icons/aniston_logo_loader.gif
// and is served at /icons/aniston_logo_loader.gif in both dev and production builds.
const LOADER_SRC = '/icons/aniston_logo_loader.gif';

const SIZE_PX = {
  xs: 20,
  sm: 28,
  md: 56,
  lg: 80,
  xl: 112,
};

function LoaderImage({ pixels, className = '' }) {
  return (
    <img
      src={LOADER_SRC}
      alt=""
      width={pixels}
      height={pixels}
      draggable={false}
      decoding="async"
      style={{ width: pixels, height: pixels }}
      className={`select-none pointer-events-none ${className}`}
    />
  );
}

export default function AnistonLoader({
  variant = 'inline',
  size = 'md',
  label = 'Loading',
  showLabel = false,
  className = '',
}) {
  const pixels = SIZE_PX[size] || SIZE_PX.md;

  if (variant === 'fullScreen') {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label={label}
        className={`h-screen w-screen flex items-center justify-center bg-surface ${className}`}
      >
        <LoaderImage pixels={SIZE_PX.lg} />
        <span className="sr-only">{label}…</span>
      </div>
    );
  }

  if (variant === 'fullPage' || variant === 'page') {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label={label}
        className={`h-full w-full flex flex-col items-center justify-center gap-3 py-12 ${className}`}
      >
        <LoaderImage pixels={SIZE_PX.lg} />
        {showLabel && <span className="text-sm text-text-secondary">{label}…</span>}
        {!showLabel && <span className="sr-only">{label}…</span>}
      </div>
    );
  }

  if (variant === 'section') {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label={label}
        className={`flex items-center justify-center py-10 ${className}`}
      >
        <LoaderImage pixels={pixels} />
        <span className="sr-only">{label}…</span>
      </div>
    );
  }

  // inline (default) — renders just the image, sized via `size` prop
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={label}
      className={`inline-flex items-center justify-center ${className}`}
    >
      <LoaderImage pixels={pixels} />
      <span className="sr-only">{label}…</span>
    </span>
  );
}

// Convenience wrapper for full-page Suspense / route fallback usage.
export function AnistonPageLoader({ label = 'Loading', showLabel = false, className = '' }) {
  return (
    <AnistonLoader
      variant="page"
      size="lg"
      label={label}
      showLabel={showLabel}
      className={className}
    />
  );
}

// Convenience wrapper for app-shell-level auth/bootstrap loading.
export function AnistonFullScreenLoader({ label = 'Loading', className = '' }) {
  return <AnistonLoader variant="fullScreen" label={label} className={className} />;
}
