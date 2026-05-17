import React from 'react';
import {
  LayoutGrid, FileText, Search, BarChart3, Lightbulb, MoreHorizontal,
} from 'lucide-react';
import SidekickComposer from './SidekickComposer';

/**
 * SidekickEmptyState — first-load greeting + quick actions + starter chips
 * (skill §4).
 *
 *   <SidekickEmptyState
 *     userName="Sarah"
 *     suggestedStarters={[ ... ]}
 *     onSend={(text) => ...}
 *     onQuickAction={(id) => ...}
 *   />
 */

const QUICK_ACTIONS = [
  { id: 'board',       label: 'Create a board',     icon: LayoutGrid, color: '#9d50dd' },
  { id: 'doc',         label: 'Write a doc',        icon: FileText,   color: '#00c875' },
  { id: 'research',    label: 'Research online',    icon: Search,     color: '#ffcb00' },
  { id: 'analyze',     label: 'Analyze data',       icon: BarChart3,  color: '#ff158a' },
  { id: 'brainstorm',  label: 'Brainstorm ideas',   icon: Lightbulb,  color: '#579bfc' },
  { id: 'more',        label: 'More',               icon: MoreHorizontal, color: '#94a3b8' },
];

export default function SidekickEmptyState({
  userName,
  suggestedStarters = [],
  onSend,
  onQuickAction,
}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-4 py-6 text-center overflow-auto">
      <SidekickMascot />
      <h2 className="text-2xl font-semibold text-text-primary">
        Hi {userName || 'there'},
      </h2>
      <p className="mt-1 text-sm text-text-secondary">
        What would you like to work on today?
      </p>

      <div className="mt-6 w-full max-w-md">
        <SidekickComposer
          placeholder="Ask AI Sidekick anything…"
          onSend={onSend}
          autoFocus
        />
      </div>

      <div className="mt-6 grid grid-cols-3 gap-2 w-full max-w-md">
        {QUICK_ACTIONS.map((qa) => {
          const Icon = qa.icon;
          return (
            <button
              key={qa.id}
              type="button"
              onClick={() => onQuickAction?.(qa.id)}
              className="flex flex-col items-center gap-1.5 px-3 py-3 rounded-md text-xs font-medium text-text-primary hover:bg-surface-100 transition-colors"
            >
              <span
                className="w-9 h-9 rounded-md inline-flex items-center justify-center"
                style={{ backgroundColor: qa.color + '20', color: qa.color }}
              >
                <Icon size={16} />
              </span>
              <span className="text-text-secondary">{qa.label}</span>
            </button>
          );
        })}
      </div>

      {suggestedStarters.length > 0 && (
        <div className="mt-6 w-full max-w-md">
          <div className="text-[10px] uppercase tracking-wide font-semibold text-text-tertiary mb-2 text-left">
            Suggested starters tailored for your work
          </div>
          <div className="flex flex-wrap gap-1.5">
            {suggestedStarters.map((s, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onSend?.(s)}
                className="px-3 py-1.5 rounded-full text-xs text-text-secondary border border-border bg-surface hover:border-primary-300 hover:text-primary transition-colors text-left"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// 3D-ish rainbow Sidekick mascot — inline SVG so it ships zero-dep and animates
// via CSS. The orb body uses a radial gradient for the spherical highlight, a
// conic-style rainbow ring orbits it, and two little eyes sit on the front.
// Respects `prefers-reduced-motion`: the float/spin animations auto-disable.
function SidekickMascot() {
  return (
    <div
      className="relative w-20 h-20 mb-3 motion-safe:animate-[sidekick-float_3.6s_ease-in-out_infinite]"
      aria-hidden="true"
    >
      <style>{`
        @keyframes sidekick-float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
        @keyframes sidekick-spin  { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
      <svg viewBox="0 0 80 80" className="absolute inset-0 w-full h-full motion-safe:animate-[sidekick-spin_8s_linear_infinite]">
        <defs>
          <linearGradient id="sk-ring" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%"   stopColor="#ff158a" />
            <stop offset="25%"  stopColor="#fdab3d" />
            <stop offset="50%"  stopColor="#00c875" />
            <stop offset="75%"  stopColor="#579bfc" />
            <stop offset="100%" stopColor="#9d50dd" />
          </linearGradient>
        </defs>
        <circle cx="40" cy="40" r="32" fill="none" stroke="url(#sk-ring)" strokeWidth="6" strokeLinecap="round" strokeDasharray="160 50" />
      </svg>
      <svg viewBox="0 0 80 80" className="absolute inset-0 w-full h-full">
        <defs>
          <radialGradient id="sk-body" cx="35%" cy="32%" r="65%">
            <stop offset="0%"  stopColor="#ffffff" />
            <stop offset="55%" stopColor="#e6ecff" />
            <stop offset="100%" stopColor="#9bb2ff" />
          </radialGradient>
        </defs>
        <circle cx="40" cy="42" r="20" fill="url(#sk-body)" />
        {/* eyes */}
        <ellipse cx="34" cy="40" rx="2.2" ry="3" fill="#1f2937" />
        <ellipse cx="46" cy="40" rx="2.2" ry="3" fill="#1f2937" />
        {/* eye sparkle */}
        <circle cx="34.7" cy="39" r="0.7" fill="#ffffff" />
        <circle cx="46.7" cy="39" r="0.7" fill="#ffffff" />
        {/* tiny smile */}
        <path d="M34 48 Q40 52 46 48" stroke="#1f2937" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      </svg>
    </div>
  );
}
