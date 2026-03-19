import React, { useState, useMemo } from 'react';
import { addDays, subDays, format, differenceInDays, parseISO, startOfWeek, eachDayOfInterval, isWeekend, isToday } from 'date-fns';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
import { STATUS_CONFIG } from '../../utils/constants';

export default function TimelineView({ tasks = [], members = [], onTaskClick }) {
  const [startDate, setStartDate] = useState(startOfWeek(new Date()));
  const [daysToShow, setDaysToShow] = useState(14);

  const timelineTasks = useMemo(() => tasks.filter(t => t.startDate || t.dueDate), [tasks]);
  const endDate = addDays(startDate, daysToShow - 1);
  const days = eachDayOfInterval({ start: startDate, end: endDate });
  const dayWidth = 60;

  function getBarStyle(task) {
    const taskStart = task.startDate ? parseISO(task.startDate) : task.dueDate ? subDays(parseISO(task.dueDate), 2) : startDate;
    const taskEnd = task.dueDate ? parseISO(task.dueDate) : addDays(taskStart, 2);
    const offsetDays = differenceInDays(taskStart, startDate);
    const duration = Math.max(differenceInDays(taskEnd, taskStart) + 1, 1);
    const left = offsetDays * dayWidth;
    const width = duration * dayWidth;
    if (left + width < 0 || left > daysToShow * dayWidth) return null;
    const cfg = STATUS_CONFIG[task.status] || STATUS_CONFIG.not_started;
    return { left: Math.max(left, 0), width: Math.min(width, daysToShow * dayWidth - Math.max(left, 0)), color: cfg.bgColor || cfg.color };
  }

  return (
    <div className="h-full flex flex-col">
      {/* Controls */}
      <div className="flex items-center gap-3 mb-3">
        <span className="text-xs text-text-secondary font-medium">
          {format(startDate, 'MMM d')} – {format(endDate, 'MMM d, yyyy')}
        </span>
        <div className="flex items-center gap-1 ml-auto">
          <button onClick={() => setStartDate(subDays(startDate, 7))} className="btn-ghost p-1.5"><ChevronLeft size={15} /></button>
          <button onClick={() => setStartDate(startOfWeek(new Date()))} className="btn-ghost text-xs px-3 py-1">Today</button>
          <button onClick={() => setStartDate(addDays(startDate, 7))} className="btn-ghost p-1.5"><ChevronRight size={15} /></button>
          <div className="h-4 w-px bg-border mx-1" />
          <button onClick={() => setDaysToShow(Math.min(daysToShow + 7, 28))} className="btn-ghost p-1.5" title="Zoom out"><ZoomOut size={15} /></button>
          <button onClick={() => setDaysToShow(Math.max(daysToShow - 7, 7))} className="btn-ghost p-1.5" title="Zoom in"><ZoomIn size={15} /></button>
        </div>
      </div>

      {/* Timeline Grid */}
      <div className="flex-1 overflow-auto rounded-xl border border-border bg-white">
        <div className="min-w-fit">
          {/* Day Headers */}
          <div className="flex sticky top-0 z-10 bg-white border-b border-border">
            <div className="w-[200px] flex-shrink-0 px-4 py-2.5 text-[11px] font-medium text-text-tertiary uppercase tracking-wider border-r border-border bg-white sticky left-0 z-20">
              Task
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
                      {task.startDate && task.dueDate ? ' → ' : ''}
                      {task.dueDate ? format(parseISO(task.dueDate), 'MMM d') : ''}
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
                    {/* Bar */}
                    {bar && (
                      <div className="absolute top-2.5 h-7 rounded-md flex items-center px-2 text-white text-[11px] font-medium truncate shadow-sm hover:shadow-md transition-shadow"
                        style={{ left: bar.left, width: Math.max(bar.width, 30), backgroundColor: bar.color }}>
                        {bar.width > 80 && task.title}
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
