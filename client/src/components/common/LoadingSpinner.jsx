import React from 'react';
import AnistonLoader from './AnistonLoader';

// Map legacy size prop (sm/md/lg) to the branded loader's size scale.
// `sm` stays compact for inline / button usage; `md` and `lg` scale up
// for centered page-level loading.
const SIZE_MAP = { sm: 'xs', md: 'sm', lg: 'md' };

export default function LoadingSpinner({ size = 'md', className = '' }) {
  return <AnistonLoader variant="inline" size={SIZE_MAP[size] || 'sm'} className={className} />;
}

export function LoadingPage({ label = 'Loading', showLabel = true }) {
  return <AnistonLoader variant="page" size="lg" label={label} showLabel={showLabel} />;
}
