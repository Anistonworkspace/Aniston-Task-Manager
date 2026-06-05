import React from 'react';
import { format, isToday } from 'date-fns';
import { unionMinutesForDay, formatDuration } from './plannerTheme';

// Soft pastel tints cycled across the week (reference look). Tints are light
// enough to sit under dark text; the selected/today states add a ring.
const TINTS = [
  'bg-[#eef2ff]', // indigo
  'bg-[#ecfdf5]', // green
  'bg-[#fef3f2]', // rose
  'bg-[#fffbeb]', // amber
  'bg-[#eff6ff]', // blue
  'bg-[#faf5ff]', // purple
  'bg-[#f0fdfa]', // teal
];

/**
 * Horizontal strip of rounded date cards. Click a card to select that day
 * (drives the Day view / highlights the Week column). Shows each day's
 * planned load so the week reads at a glance. Scrolls horizontally on small
 * screens.
 */
export default function DayStrip({ days, selectedDate, onSelect, blocks }) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {days.map((day, i) => {
        const dateStr = format(day, 'yyyy-MM-dd');
        const today = isToday(day);
        const selected = selectedDate === dateStr;
        const dayBlocks = blocks.filter((b) => b.date === dateStr);
        const mins = unionMinutesForDay(dayBlocks);

        return (
          <button
            key={dateStr}
            type="button"
            onClick={() => onSelect(dateStr)}
            aria-pressed={selected}
            className={`relative flex min-w-[84px] flex-1 flex-col items-center rounded-2xl px-3 py-2.5 transition-all duration-150
                        hover:-translate-y-px hover:shadow-card focus:outline-none focus:ring-2 focus:ring-primary
                        ${TINTS[i % TINTS.length]}
                        ${selected ? 'ring-2 ring-primary shadow-card' : today ? 'ring-1 ring-primary/40' : 'ring-1 ring-black/5'}`}
          >
            <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">{format(day, 'EEE')}</span>
            <span className={`font-title text-2xl font-bold leading-tight ${today ? 'text-primary' : 'text-text-primary'}`}>{format(day, 'd')}</span>
            <span className="mt-0.5 text-[9px] font-medium text-text-tertiary">
              {dayBlocks.length ? formatDuration(mins) : '—'}
            </span>
            {today && <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-primary" aria-label="Today" />}
          </button>
        );
      })}
    </div>
  );
}
