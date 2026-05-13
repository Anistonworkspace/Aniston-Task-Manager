import React, { useMemo, useState, useCallback } from 'react';
import { ChevronLeft, ChevronRight, User } from 'lucide-react';
import {
  format, startOfMonth, endOfMonth, eachDayOfInterval, startOfWeek, endOfWeek,
  isToday, addMonths, subMonths, isSameMonth,
} from 'date-fns';
import Modal from '../common/Modal';
import { STATUS_CONFIG, PRIORITY_CONFIG } from '../../utils/constants';
import Avatar from '../common/Avatar';

// Workload-heatmap calendar.
//
// Each day cell shades blue based on how many tasks are due that day.
// Density buckets:
//   0 tasks   → empty / dashed
//   1 task    → light tint
//   2 tasks   → medium tint
//   3+ tasks  → strong tint
//
// Click behavior:
//   Cell click opens a date-task list dialog. Selecting a row in the dialog
//   is what opens the actual TaskModal. Empty cells are non-interactive.
//   Single-task days route through the dialog too for uniform interaction.

function densityClass(level, isCurrentMonth) {
  const opacity = isCurrentMonth ? '' : 'opacity-50';
  if (level === 0) {
    return `bg-white dark:bg-zinc-900 border-dashed ${opacity}`;
  }
  if (level === 1) return `bg-blue-50 dark:bg-blue-950/30 ${opacity}`;
  if (level === 2) return `bg-blue-100 dark:bg-blue-900/40 ${opacity}`;
  return `bg-blue-200 dark:bg-blue-800/60 ${opacity}`;
}

function densityLevel(count) {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count === 2) return 2;
  return 3;
}

// Single row inside the date-task list dialog. Renders title, status pill,
// priority pill, owner avatar — all data the user already sees on the board
// row — so picking the right task in a 3+ task list doesn't require opening
// each one to disambiguate.
function DateTaskRow({ task, members, onSelect }) {
  const status = STATUS_CONFIG[task.status] || STATUS_CONFIG.not_started;
  const priority = task.priority ? PRIORITY_CONFIG[task.priority] : null;
  const assignee = task.assignedTo ? members.find(m => m.id === task.assignedTo) : null;

  return (
    <button
      type="button"
      onClick={() => onSelect(task)}
      data-testid="date-task-row"
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:border-primary/50 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">{task.title}</p>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          <span
            className="text-[10px] font-semibold px-1.5 py-0.5 rounded text-white"
            style={{ backgroundColor: status.bgColor }}
          >
            {status.label}
          </span>
          {priority && (
            <span
              className="text-[10px] font-semibold px-1.5 py-0.5 rounded text-white"
              style={{ backgroundColor: priority.bgColor }}
            >
              {priority.label}
            </span>
          )}
        </div>
      </div>
      <div className="flex-shrink-0">
        {assignee ? (
          <Avatar name={assignee.name} image={assignee.avatar} size="xs" />
        ) : (
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-400">
            <User size={12} />
          </span>
        )}
      </div>
    </button>
  );
}

export default function CalendarView({ tasks = [], members = [], onTaskClick }) {
  const [month, setMonth] = useState(new Date());
  // Date-task list dialog state. Stored as { day: Date, tasks: Task[] } so
  // the dialog renders the snapshot at click time even if the underlying
  // tasksByDay map mutates (socket push, etc.) while the dialog is open.
  const [activeDate, setActiveDate] = useState(null);

  const calDays = useMemo(() => {
    const start = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
    const end = endOfWeek(endOfMonth(month), { weekStartsOn: 1 });
    return eachDayOfInterval({ start, end });
  }, [month]);

  // Bucket tasks by ISO date string. Using the UTC date slice keeps the
  // dialog tasks list and cell render perfectly in sync: both look up the
  // same key.
  const tasksByDay = useMemo(() => {
    const map = new Map();
    for (const t of tasks) {
      if (!t.dueDate) continue;
      const key = t.dueDate.slice(0, 10);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(t);
    }
    return map;
  }, [tasks]);

  const handleCellClick = useCallback((day, dayTasks) => {
    if (!dayTasks || dayTasks.length === 0) return;
    setActiveDate({ day, tasks: dayTasks });
  }, []);

  const handleSelectTask = useCallback((task) => {
    setActiveDate(null);
    onTaskClick?.(task);
  }, [onTaskClick]);

  const closeDialog = useCallback(() => setActiveDate(null), []);

  return (
    <>
      <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-800 shadow-sm overflow-hidden">
        {/* Header: month nav only — Today button and Filter chips removed
            per request. Prev/next/month-title behavior preserved. */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-1.5">
            <button onClick={() => setMonth(subMonths(month, 1))} className="p-1 rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors" aria-label="Previous month">
              <ChevronLeft size={16} />
            </button>
            <button onClick={() => setMonth(addMonths(month, 1))} className="p-1 rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors" aria-label="Next month">
              <ChevronRight size={16} />
            </button>
          </div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{format(month, 'MMMM yyyy')}</h3>
          {/* Spacer matched to the left-side button cluster so the month
              title stays visually centered. */}
          <div className="w-[52px]" aria-hidden />
        </div>

        {/* Weekday header (Mon-first) */}
        <div className="grid grid-cols-7 px-3 pt-3">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => (
            <div key={d} className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 px-2 pb-2">{d}</div>
          ))}
        </div>

        {/* Day grid */}
        <div className="grid grid-cols-7 gap-2 px-3 pb-3">
          {calDays.map((day, i) => {
            const key = format(day, 'yyyy-MM-dd');
            const dayTasks = tasksByDay.get(key) || [];
            const count = dayTasks.length;
            const level = densityLevel(count);
            const isCurrentMonth = isSameMonth(day, month);
            const today = isToday(day);
            const firstTask = dayTasks[0];
            const extra = count - 1;
            const hasTasks = count > 0;

            const cellClasses = [
              'group relative rounded-xl border min-h-[88px] p-2 flex flex-col text-left transition-all',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
              today
                ? 'border-violet-400 dark:border-violet-500 ring-1 ring-violet-300 dark:ring-violet-600 bg-violet-50 dark:bg-violet-950/40'
                : `border-zinc-200 dark:border-zinc-800 ${densityClass(level, isCurrentMonth)}`,
              hasTasks ? 'cursor-pointer hover:border-zinc-300 dark:hover:border-zinc-600' : 'cursor-default',
            ].join(' ');

            const ariaLabel = `${format(day, 'EEEE, MMMM d')}${count > 0 ? `, ${count} task${count === 1 ? '' : 's'}` : ', no tasks'}${today ? ', today' : ''}`;

            return (
              <button
                key={i}
                type="button"
                aria-label={ariaLabel}
                data-testid={`cal-cell-${key}`}
                disabled={!hasTasks}
                aria-disabled={!hasTasks}
                className={cellClasses}
                onClick={() => handleCellClick(day, dayTasks)}
              >
                <div className="flex items-start justify-between w-full">
                  <span
                    className={`text-sm font-semibold leading-none ${
                      today
                        ? 'inline-flex items-center justify-center w-6 h-6 rounded-full bg-violet-500 text-white'
                        : isCurrentMonth
                          ? 'text-zinc-900 dark:text-zinc-100'
                          : 'text-zinc-400 dark:text-zinc-600'
                    }`}
                  >
                    {format(day, 'd')}
                  </span>
                  {count > 0 && (
                    <span
                      aria-hidden="true"
                      className="inline-flex items-center justify-center min-w-[20px] h-[20px] px-1.5 rounded-full bg-white/80 dark:bg-zinc-900/70 text-[10px] font-semibold text-zinc-700 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700"
                    >
                      {count}
                    </span>
                  )}
                </div>

                {firstTask && (
                  <div className="mt-auto pt-2 w-full">
                    <p className="text-[11px] font-medium text-zinc-700 dark:text-zinc-200 truncate">
                      {firstTask.title}
                      {extra > 0 && (
                        <span className="text-zinc-500 dark:text-zinc-400 font-normal"> +{extra}</span>
                      )}
                    </p>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Date-task list dialog */}
      <Modal
        isOpen={!!activeDate}
        onClose={closeDialog}
        title={activeDate ? `Tasks on ${format(activeDate.day, 'MMMM d, yyyy')}` : ''}
        size="md"
      >
        {activeDate && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">
              {activeDate.tasks.length} task{activeDate.tasks.length === 1 ? '' : 's'} due
            </p>
            {activeDate.tasks.map(task => (
              <DateTaskRow
                key={task.id}
                task={task}
                members={members}
                onSelect={handleSelectTask}
              />
            ))}
          </div>
        )}
      </Modal>
    </>
  );
}
