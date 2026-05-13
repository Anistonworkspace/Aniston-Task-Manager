import React, { useState, useMemo, useCallback } from 'react';
import { addDays, subDays, format, differenceInDays, parseISO, startOfWeek, eachDayOfInterval, isWeekend, isToday, isSameDay } from 'date-fns';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
import { STATUS_CONFIG } from '../../utils/constants';
import { useT } from '../../context/LanguageContext';

// startOfWeek defaults are environment-dependent — pin to Sunday so the header
// matches the day grid (also matches how the screenshots render).
const WEEK_OPTS = { weekStartsOn: 0 };

export default function TimelineView({ tasks = [], members = [], onTaskClick }) {
  const t = useT();
  const [startDate, setStartDate] = useState(() => startOfWeek(new Date(), WEEK_OPTS));
  const [daysToShow, setDaysToShow] = useState(14);

  // Only show tasks that have at least a due date (or start date). A task
  // with neither has no place on a timeline.
  const timelineTasks = useMemo(() => tasks.filter(tk => tk.startDate || tk.dueDate), [tasks]);
  const endDate = addDays(startDate, daysToShow - 1);
  const days = useMemo(() => eachDayOfInterval({ start: startDate, end: endDate }), [startDate, endDate]);
  const dayWidth = 60;

  // Bar geometry.
  //
  // Rules (matching the user's spec):
  //   • due date only, no start date  →  single-day bar on the due date.
  //   • start date only, no due date  →  single-day bar on the start date.
  //   • both                          →  span from start → due (inclusive).
  //   • start > due (data drift)      →  treat as single-day on due.
  //
  // The old implementation synthesized an artificial 3-day window
  // (`subDays(dueDate, 2)`) when no start date existed, which is why a task
  // with only a due date of May 15 was rendering as a May 13 → May 15 bar.
  const getBarStyle = useCallback((task) => {
    const hasStart = !!task.startDate;
    const hasDue = !!task.dueDate;
    if (!hasStart && !hasDue) return null;

    const startISO = hasStart ? parseISO(task.startDate) : null;
    const dueISO = hasDue ? parseISO(task.dueDate) : null;

    let taskStart;
    let taskEnd;
    if (hasStart && hasDue) {
      // If the data is inverted (start after due), collapse to a single-day
      // bar on the due date rather than rendering a negative-width slab.
      if (startISO.getTime() > dueISO.getTime()) {
        taskStart = dueISO;
        taskEnd = dueISO;
      } else {
        taskStart = startISO;
        taskEnd = dueISO;
      }
    } else if (hasDue) {
      taskStart = dueISO;
      taskEnd = dueISO;
    } else {
      taskStart = startISO;
      taskEnd = startISO;
    }

    const offsetDays = differenceInDays(taskStart, startDate);
    const duration = Math.max(differenceInDays(taskEnd, taskStart) + 1, 1);
    const left = offsetDays * dayWidth;
    const width = duration * dayWidth;
    // Clip bars that fall entirely outside the visible window.
    if (left + width <= 0 || left >= daysToShow * dayWidth) return null;

    const cfg = STATUS_CONFIG[task.status] || STATUS_CONFIG.not_started;
    const visibleLeft = Math.max(left, 0);
    const visibleWidth = Math.min(left + width, daysToShow * dayWidth) - visibleLeft;
    return {
      left: visibleLeft,
      width: Math.max(visibleWidth, dayWidth - 8),
      color: cfg.bgColor || cfg.color,
      singleDay: duration === 1,
    };
  }, [startDate, daysToShow]);

  // Navigation handlers — derived from current startDate so prev/next reliably
  // shift the visible window. Today resets to the current week's start. We
  // pass an updater function so the most recent state is used even if the
  // user presses the button repeatedly in quick succession.
  const goPrev = useCallback(() => setStartDate(prev => subDays(prev, 7)), []);
  const goNext = useCallback(() => setStartDate(prev => addDays(prev, 7)), []);
  const goToday = useCallback(() => setStartDate(startOfWeek(new Date(), WEEK_OPTS)), []);

  // The visible window is "showing today" only when one of the rendered day
  // columns is the real calendar today — used to style the Today button so
  // the user can tell when they're on the current period vs. having
  // navigated away.
  const viewingToday = days.some(d => isSameDay(d, new Date()));

  return (
    <div className="h-full flex flex-col">
      {/* Controls */}
      <div className="flex items-center gap-3 mb-3">
        <span className="text-xs text-text-secondary font-medium">
          {format(startDate, 'MMM d')} – {format(endDate, 'MMM d, yyyy')}
        </span>
        <div className="flex items-center gap-1 ml-auto">
          <button onClick={goPrev} className="btn-ghost p-1.5" aria-label="Previous period"><ChevronLeft size={15} /></button>
          <button
            onClick={goToday}
            className={`btn-ghost text-xs px-3 py-1 ${viewingToday ? 'bg-primary-50 text-primary-600 font-semibold' : ''}`}
            aria-pressed={viewingToday}
          >
            {t('task.today')}
          </button>
          <button onClick={goNext} className="btn-ghost p-1.5" aria-label="Next period"><ChevronRight size={15} /></button>
          <div className="h-4 w-px bg-border mx-1" />
          <button onClick={() => setDaysToShow(d => Math.min(d + 7, 28))} className="btn-ghost p-1.5" title="Zoom out"><ZoomOut size={15} /></button>
          <button onClick={() => setDaysToShow(d => Math.max(d - 7, 7))} className="btn-ghost p-1.5" title="Zoom in"><ZoomIn size={15} /></button>
        </div>
      </div>

      {/* Timeline Grid */}
      <div className="flex-1 overflow-auto rounded-xl border border-border bg-white">
        <div className="min-w-fit">
          {/* Day Headers */}
          <div className="flex sticky top-0 z-10 bg-white border-b border-border">
            <div className="w-[200px] flex-shrink-0 px-4 py-2.5 text-[11px] font-medium text-text-tertiary uppercase tracking-wider border-r border-border bg-white sticky left-0 z-20">
              {t('board.columns.task')}
            </div>
            <div className="flex">
              {days.map((day, i) => (
                <div key={i} className={`text-center border-r border-border/50 py-2 ${isWeekend(day) ? 'bg-surface-50' : 'bg-white'}`} style={{ width: dayWidth }}>
                  <div className="text-[9px] text-text-muted uppercase">{format(day, 'EEE')}</div>
                  <div className={`text-xs font-medium mt-0.5 ${isToday(day) ? 'bg-primary-500 text-white w-5 h-5 rounded-full flex items-center justify-center mx-auto' : 'text-text-primary'}`}>
                    {format(day, 'd')}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Task Rows */}
          {timelineTasks.length === 0 ? (
            <div className="text-center py-16 text-sm text-text-tertiary">
              No tasks with dates to display on timeline.
              <br />
              <span className="text-xs text-text-muted">Add start dates and due dates to your tasks to see them here.</span>
            </div>
          ) : (
            timelineTasks.map(task => {
              const bar = getBarStyle(task);
              const assignee = task.assignedTo ? members.find(m => m.id === task.assignedTo) : null;
              return (
                <div key={task.id} onClick={() => onTaskClick?.(task)}
                  className="flex border-b border-border/50 hover:bg-surface-50 transition-colors cursor-pointer group">
                  <div className="w-[200px] flex-shrink-0 px-4 py-3 border-r border-border bg-white sticky left-0 z-10">
                    <p className="text-sm font-medium text-text-primary truncate group-hover:text-primary-600 transition-colors">{task.title}</p>
                    <p className="text-[10px] text-text-muted mt-0.5">
                      {task.startDate ? format(parseISO(task.startDate), 'MMM d') : ''}
                      {task.startDate && task.dueDate && task.startDate !== task.dueDate ? ' → ' : ''}
                      {task.dueDate && task.dueDate !== task.startDate ? format(parseISO(task.dueDate), 'MMM d') : ''}
                      {!task.startDate && task.dueDate ? format(parseISO(task.dueDate), 'MMM d') : ''}
                      {assignee && ` · ${assignee.name}`}
                    </p>
                  </div>
                  <div className="flex-1 relative" style={{ minWidth: daysToShow * dayWidth }}>
                    {/* Grid lines */}
                    <div className="absolute inset-0 flex">
                      {days.map((day, i) => (
                        <div key={i} className={`border-r border-border/30 h-full ${isWeekend(day) ? 'bg-surface-50/50' : ''} ${isToday(day) ? 'bg-primary-50/30' : ''}`} style={{ width: dayWidth }} />
                      ))}
                    </div>
                    {/* Bar — always render the title; `truncate` handles narrow
                        widths (single-day bars are exactly one column wide,
                        which the previous `bar.width > 60` guard treated as
                        "too narrow" and rendered as a blank pill). */}
                    {bar && (
                      <div
                        className="absolute top-2.5 h-7 rounded-md flex items-center px-2 text-white text-[11px] font-medium shadow-sm hover:shadow-md transition-shadow overflow-hidden"
                        style={{ left: bar.left, width: bar.width, backgroundColor: bar.color }}
                        title={task.title}
                      >
                        <span className="truncate">{task.title}</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
