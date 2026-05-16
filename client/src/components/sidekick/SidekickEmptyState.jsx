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
