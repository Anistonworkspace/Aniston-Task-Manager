import React from 'react';

const GRADIENTS = [
  ['#4f46e5', '#818cf8'],
  ['#10b981', '#34d399'],
  ['#f59e0b', '#fbbf24'],
  ['#ef4444', '#f87171'],
  ['#8b5cf6', '#a78bfa'],
  ['#3b82f6', '#60a5fa'],
  ['#ec4899', '#f472b6'],
  ['#14b8a6', '#2dd4bf'],
  ['#f97316', '#fb923c'],
  ['#06b6d4', '#22d3ee'],
];

function hashGradient(name) {
  if (!name) return GRADIENTS[0];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return GRADIENTS[Math.abs(h) % GRADIENTS.length];
}

function initials(name) {
  if (!name) return '?';
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const p = trimmed.split(/\s+/);
  return p.length === 1 ? p[0][0].toUpperCase() : (p[0][0] + p[p.length - 1][0]).toUpperCase();
}

const SIZES = {
  xs: 'w-6 h-6 text-[9px]',
  sm: 'w-7 h-7 text-[10px]',
  md: 'w-8 h-8 text-[11px]',
  lg: 'w-10 h-10 text-xs',
  xl: 'w-12 h-12 text-sm',
};

export default function Avatar({ name, image, size = 'md', className = '' }) {
  const [from, to] = hashGradient(name);
  return (
    <div
      className={`rounded-lg flex items-center justify-center font-semibold text-white flex-shrink-0 shadow-sm ${SIZES[size] || SIZES.md} ${className}`}
      style={{ background: image ? 'transparent' : `linear-gradient(135deg, ${from}, ${to})` }}
      title={name}
    >
      {image ? <img src={image} alt={name} className="w-full h-full rounded-lg object-cover" /> : initials(name)}
    </div>
  );
}
