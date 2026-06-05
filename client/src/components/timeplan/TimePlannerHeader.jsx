import React from 'react';
import {
  Clock, ChevronLeft, ChevronRight, Calendar, Users, CalendarDays,
  Plus, ListTodo,
} from 'lucide-react';

const VIEWS = [
  { value: 'month', label: 'Month', enabled: true },
  { value: 'week', label: 'Week', enabled: true },
  { value: 'day', label: 'Day', enabled: true },
];

function Segmented({ options, value, onChange }) {
  return (
    <div className="flex items-center rounded-lg bg-surface p-0.5">
      {options.map((o) => {
        const active = value === o.value;
        const disabled = o.enabled === false;
        return (
          <button
            key={o.value}
            type="button"
            disabled={disabled}
            title={disabled ? 'Month view is coming soon — use Week or Day' : undefined}
            onClick={() => !disabled && onChange(o.value)}
            aria-pressed={active}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors
              ${active ? 'bg-white text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'}
              ${disabled ? 'cursor-not-allowed opacity-40 hover:text-text-secondary' : ''}`}
          >
            {o.icon}{o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Planner top bar: identity + navigation on the left, controls on the right.
 * Stacks vertically on small screens.
 */
export default function TimePlannerHeader({
  rangeLabel, onPrev, onNext, onToday,
  view, onViewChange,
  viewMode, onViewModeChange, canManage,
  plannedLabel, teamsLabel,
  onAddBlock, queueOpen, onToggleQueue,
}) {
  return (
    <div className="mb-5 space-y-4">
      {/* Row 1: identity + view mode */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 font-title text-2xl font-bold text-text-primary">
            <Clock size={22} className="text-primary" /> Time Planner
          </h1>
          <p className="mt-0.5 text-sm text-text-secondary">Plan your weekly work schedule</p>
        </div>
        {canManage && (
          <Segmented
            value={viewMode}
            onChange={onViewModeChange}
            options={[
              { value: 'my', label: 'My Plan', icon: <Calendar size={13} /> },
              { value: 'team', label: 'Team Plan', icon: <Users size={13} /> },
            ]}
          />
        )}
      </div>

      {/* Row 2: navigation + controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button type="button" onClick={onPrev} aria-label="Previous" className="rounded-lg p-1.5 text-text-secondary hover:bg-surface">
            <ChevronLeft size={18} />
          </button>
          <span className="min-w-[160px] text-center font-title text-base font-bold text-text-primary">{rangeLabel}</span>
          <button type="button" onClick={onNext} aria-label="Next" className="rounded-lg p-1.5 text-text-secondary hover:bg-surface">
            <ChevronRight size={18} />
          </button>
          <button
            type="button"
            onClick={onToday}
            className="ml-1 rounded-lg bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/20"
          >
            Today
          </button>
          <div className="ml-2 hidden sm:block">
            <Segmented options={VIEWS} value={view} onChange={onViewChange} />
          </div>
        </div>

        {viewMode === 'my' && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-lg bg-surface px-2.5 py-1 text-xs font-medium text-text-secondary">
              <Clock size={11} className="mr-1 inline" />{plannedLabel} planned
            </span>
            {teamsLabel && (
              <span className="rounded-lg bg-[#7b83eb]/10 px-2.5 py-1 text-xs font-medium text-[#7b83eb]">
                <CalendarDays size={11} className="mr-1 inline" />{teamsLabel} in Teams
              </span>
            )}

            {onToggleQueue && (
              <button
                type="button"
                onClick={onToggleQueue}
                aria-pressed={queueOpen}
                className={`flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors
                  ${queueOpen ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border text-text-secondary hover:bg-surface'}`}
              >
                <ListTodo size={13} /> Work Queue
              </button>
            )}
            <button type="button" onClick={() => onAddBlock()} className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-600">
              <Plus size={14} /> Add Block
            </button>
          </div>
        )}
      </div>

      {/* mobile view switcher */}
      <div className="sm:hidden">
        <Segmented options={VIEWS} value={view} onChange={onViewChange} />
      </div>
    </div>
  );
}
