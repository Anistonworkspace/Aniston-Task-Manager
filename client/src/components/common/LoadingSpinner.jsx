import React from 'react';

export default function LoadingSpinner({ size = 'md' }) {
  const sizes = { sm: 'h-4 w-4', md: 'h-6 w-6', lg: 'h-8 w-8' };
  return <div className={`animate-spin rounded-full border-2 border-primary/20 border-t-primary ${sizes[size] || sizes.md}`} />;
}

export function LoadingPage({ label = 'Loading...' }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3">
      <LoadingSpinner size="lg" />
      <span className="text-sm text-text-secondary">{label}</span>
    </div>
  );
}
