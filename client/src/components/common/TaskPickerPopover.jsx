import React, {
  forwardRef, useImperativeHandle, useLayoutEffect, useState,
} from 'react';
import {
  Hash, CheckCircle2, Circle, AlertTriangle, Clock, Plus,
} from 'lucide-react';

/**
 * TaskPickerPopover — picker UI for the task-chip Tiptap node (Phase D Slice 2).
 *
 * Rendered imperatively via ReactRenderer when the user types the chip's
 * trigger char inside a doc. Each row shows: task title (truncated), board
 * pill (name + color dot), and a small status pill.
 *
 * Props:
 *   items        — current list of tasks
 *                  ([{ id, title, status, priority, boardId, boardName, boardColor, dueDate }])
 *   loading      — true while the latest search is in flight
 *   command(it)  — called when the user picks an entry; the parent's
 *                  Suggestion plugin then inserts the taskChip node.
 *   rect         — client-rect of the trigger glyph (for fixed positioning)
 *
 * Imperative `onKeyDown({event})` returns true when handled, matching the
 * @tiptap/suggestion render contract — same shape as MentionPopover.
 */
const TaskPickerPopover = forwardRef(function TaskPickerPopover(
  { items, loading, command, rect, query, onCreateNew },
  ref,
) {
  const [selected, setSelected] = useState(0);

  // Slice 2b — virtual "Create '<query>' as new task" row appears at the
  // end of the list when (a) the caller wired onCreateNew and (b) the
  // user has typed something to make a sensible title. Always keeping
  // it disabled-but-visible would be too noisy.
  const showCreate = !!onCreateNew && !!(query && query.trim());
  const totalRows = items.length + (showCreate ? 1 : 0);

  useLayoutEffect(() => { setSelected(0); }, [items, showCreate]);

  function pickRow(idx) {
    if (idx < items.length) {
      const it = items[idx];
      if (it) command(it);
      return;
    }
    if (showCreate) onCreateNew(query.trim());
  }

  useImperativeHandle(ref, () => ({
    onKeyDown({ event }) {
      if (totalRows === 0) return false;
      if (event.key === 'ArrowDown') {
        setSelected((s) => (s + 1) % totalRows);
        return true;
      }
      if (event.key === 'ArrowUp') {
        setSelected((s) => (s - 1 + totalRows) % totalRows);
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        pickRow(selected);
        return true;
      }
      return false;
    },
  }), [totalRows, selected, command, showCreate, query, onCreateNew, items]);

  if (loading && (!items || items.length === 0) && !showCreate) {
    return (
      <div
        className="task-picker-menu fixed z-[9999] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg px-3 py-2 text-xs text-zinc-500"
        style={positionStyle(rect)}
      >
        Searching tasks…
      </div>
    );
  }

  // Zero items AND no create row → empty state.
  if ((!items || items.length === 0) && !showCreate) {
    return (
      <div
        className="task-picker-menu fixed z-[9999] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg px-3 py-2 text-xs text-zinc-500"
        style={positionStyle(rect)}
      >
        No tasks match
      </div>
    );
  }

  return (
    <div
      className="task-picker-menu fixed z-[9999] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 w-[340px] max-h-[320px] overflow-y-auto"
      style={positionStyle(rect)}
    >
      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide font-semibold text-zinc-400 flex items-center gap-1">
        <Hash size={10} /> Link task
      </div>
      {items.map((t, idx) => {
        const isActive = idx === selected;
        return (
          <button
            key={t.id}
            type="button"
            onMouseDown={(e) => { e.preventDefault(); command(t); }}
            onMouseEnter={() => setSelected(idx)}
            className={`w-full text-left flex items-start gap-2.5 px-3 py-1.5 text-sm transition-colors ${
              isActive
                ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
                : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800'
            }`}
          >
            <StatusIcon status={t.status} />
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{t.title || 'Untitled task'}</div>
              <div className="flex items-center gap-1.5 mt-0.5">
                {t.boardName && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-zinc-400 truncate max-w-[200px]">
                    <span
                      className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: t.boardColor || '#9ca3af' }}
                    />
                    {t.boardName}
                  </span>
                )}
                {t.priority && (
                  <span className="text-[10px] text-zinc-400">· {t.priority}</span>
                )}
              </div>
            </div>
          </button>
        );
      })}
      {showCreate && (() => {
        const idx = items.length;
        const isActive = idx === selected;
        return (
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); onCreateNew(query.trim()); }}
            onMouseEnter={() => setSelected(idx)}
            className={`w-full text-left flex items-center gap-2.5 px-3 py-1.5 text-sm border-t border-zinc-100 dark:border-zinc-800 transition-colors ${
              isActive
                ? 'bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300'
                : 'text-primary hover:bg-primary-50/50 dark:hover:bg-primary-900/20'
            }`}
            title={`Create "${query.trim()}" as a new task and insert the chip`}
          >
            <Plus size={14} className="flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">
                Create &quot;{query.trim()}&quot; as a new task
              </div>
              <div className="text-[10px] text-zinc-400 mt-0.5">
                Pick the board on the next step, then the chip gets inserted here.
              </div>
            </div>
          </button>
        );
      })()}
    </div>
  );
});

function StatusIcon({ status }) {
  const s = String(status || '').toLowerCase();
  if (s === 'done')          return <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0 text-emerald-500" />;
  if (s === 'stuck')         return <AlertTriangle size={14} className="mt-0.5 flex-shrink-0 text-red-500" />;
  if (s === 'working_on_it') return <Clock size={14} className="mt-0.5 flex-shrink-0 text-amber-500" />;
  return <Circle size={14} className="mt-0.5 flex-shrink-0 text-zinc-400" />;
}

function positionStyle(rect) {
  if (!rect) return { display: 'none' };
  const top = rect.bottom + 6;
  const left = rect.left;
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800;
  const wouldOverflow = top + 320 > viewportH;
  return wouldOverflow
    ? { left, top: 'auto', bottom: viewportH - rect.top + 6 }
    : { left, top };
}

export default TaskPickerPopover;
