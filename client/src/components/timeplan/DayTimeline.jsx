import React from 'react';
import { Clock, Trash2, Edit3 } from 'lucide-react';
import { STATUS_CONFIG, PRIORITY_CONFIG } from '../../utils/constants';

const HOUR_HEIGHT = 60; // px per hour
const START_HOUR = 8;
const END_HOUR = 21; // 8 PM last slot
const TOTAL_HOURS = END_HOUR - START_HOUR;

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minutesToPx(mins) {
  return ((mins - START_HOUR * 60) / 60) * HOUR_HEIGHT;
}

// Color palette for blocks without tasks
const BLOCK_COLORS = [
  { bg: '#e8f0fe', border: '#4285f4', text: '#1a56db' },
  { bg: '#fef3e2', border: '#fdab3d', text: '#b45309' },
  { bg: '#e6f9ed', border: '#00c875', text: '#047857' },
  { bg: '#fce8ec', border: '#e2445c', text: '#be123c' },
  { bg: '#f3e8ff', border: '#a855f7', text: '#7c3aed' },
];

export default function DayTimeline({ blocks, onEdit, onDelete }) {
  const hours = Array.from({ length: TOTAL_HOURS }, (_, i) => START_HOUR + i);

  return (
    <div className="relative" style={{ height: TOTAL_HOURS * HOUR_HEIGHT + 20 }}>
      {/* Hour grid lines */}
      {hours.map(hour => {
        const top = (hour - START_HOUR) * HOUR_HEIGHT;
        const label = hour === 0 ? '12 AM' : hour < 12 ? `${hour} AM` : hour === 12 ? '12 PM' : `${hour - 12} PM`;
        return (
          <div key={hour} className="absolute left-0 right-0" style={{ top }}>
            <div className="flex items-start">
              <span className="text-[10px] text-text-tertiary w-[50px] -mt-1.5 text-right pr-2 select-none">{label}</span>
              <div className="flex-1 border-t border-border/40" />
            </div>
          </div>
        );
      })}

      {/* Half-hour lines */}
      {hours.map(hour => {
        const top = (hour - START_HOUR) * HOUR_HEIGHT + HOUR_HEIGHT / 2;
        return (
          <div key={`half-${hour}`} className="absolute right-0" style={{ top, left: 52 }}>
            <div className="border-t border-border/20 w-full" />
          </div>
        );
      })}

      {/* Time blocks */}
      {blocks.map((block, idx) => {
        const startMins = timeToMinutes(block.startTime);
        const endMins = timeToMinutes(block.endTime);
        const top = minutesToPx(startMins);
        const height = Math.max(((endMins - startMins) / 60) * HOUR_HEIGHT, 28);
        const colorSet = BLOCK_COLORS[idx % BLOCK_COLORS.length];
        const taskStatus = block.task ? STATUS_CONFIG[block.task.status] : null;

        return (
          <div
            key={block.id}
            className="absolute right-0 rounded-lg border-l-[3px] px-2.5 py-1.5 group cursor-pointer transition-shadow hover:shadow-md overflow-hidden"
            style={{
              top,
              left: 56,
              height,
              backgroundColor: colorSet.bg,
              borderLeftColor: colorSet.border,
              zIndex: 10,
            }}
          >
            <div className="flex items-start justify-between gap-1">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-semibold" style={{ color: colorSet.text }}>
                    {block.startTime} – {block.endTime}
                  </span>
                </div>
                {block.task ? (
                  <p className="text-xs font-medium text-text-primary truncate mt-0.5">{block.task.title}</p>
                ) : block.description ? (
                  <p className="text-xs font-medium text-text-primary truncate mt-0.5">{block.description}</p>
                ) : null}
                {block.task && taskStatus && height > 44 && (
                  <span className="inline-block mt-1 text-[9px] px-1.5 py-0.5 rounded-sm font-medium" style={{ backgroundColor: taskStatus.bgColor, color: taskStatus.textColor || '#fff' }}>
                    {taskStatus.label}
                  </span>
                )}
                {block.description && block.task && height > 60 && (
                  <p className="text-[10px] text-text-tertiary mt-0.5 truncate">{block.description}</p>
                )}
              </div>
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                <button onClick={(e) => { e.stopPropagation(); onEdit(block); }} className="p-0.5 rounded hover:bg-white/60 text-text-tertiary hover:text-primary">
                  <Edit3 size={12} />
                </button>
                <button onClick={(e) => { e.stopPropagation(); onDelete(block.id); }} className="p-0.5 rounded hover:bg-white/60 text-text-tertiary hover:text-danger">
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          </div>
        );
      })}

      {/* Current time indicator */}
      <CurrentTimeIndicator />
    </div>
  );
}

function CurrentTimeIndicator() {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  if (mins < START_HOUR * 60 || mins > END_HOUR * 60) return null;
  const top = minutesToPx(mins);

  return (
    <div className="absolute left-[50px] right-0 z-20 pointer-events-none" style={{ top }}>
      <div className="flex items-center">
        <div className="w-2.5 h-2.5 rounded-full bg-danger -ml-1" />
        <div className="flex-1 border-t-2 border-danger" />
      </div>
    </div>
  );
}
