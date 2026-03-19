import React, { useState, useEffect, useMemo } from 'react';
import { addDays, subDays, format, differenceInDays, parseISO, startOfWeek, endOfWeek, eachDayOfInterval, isWeekend, isToday, isSameDay } from 'date-fns';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
import api from '../services/api';
import { STATUS_CONFIG } from '../utils/constants';

export default function TimelinePage() {
  const [tasks, setTasks] = useState([]);
  const [boards, setBoards] = useState([]);
  const [selectedBoard, setSelectedBoard] = useState('');
  const [loading, setLoading] = useState(true);
  const [startDate, setStartDate] = useState(startOfWeek(new Date()));
  const [daysToShow, setDaysToShow] = useState(14);

  useEffect(() => {
    Promise.all([
      api.get('/boards').then(r => setBoards(r.data.boards || r.data || [])),
      api.get('/tasks').then(r => setTasks(r.data.tasks || r.data || [])),
    ]).catch(console.error).finally(() => setLoading(false));
  }, []);

  const filteredTasks = selectedBoard
    ? tasks.filter(t => t.boardId === selectedBoard)
    : tasks;

  const timelineTasks = filteredTasks.filter(t => t.startDate || t.dueDate);
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
    return { left: Math.max(left, 0), width: Math.min(width, daysToShow * dayWidth - Math.max(left, 0)), color: cfg.bgColor };
  }

  if (loading) {
    return <div className="flex items-center justify-center h-full"><div className="animate-spin rounded-full h-8 w-8 border-2 border-primary/20 border-t-primary" /></div>;
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 pt-5 pb-3">
        <h1 className="text-xl font-bold text-text-primary mb-3">Timeline</h1>
        <div className="flex items-center gap-3">
          <select value={selectedBoard} onChange={(e) => setSelectedBoard(e.target.value)} className="text-sm border border-border rounded-md px-3 py-1.5 bg-white">
            <option value="">All Boards</option>
            {boards.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <div className="flex items-center gap-1 ml-auto">
            <button onClick={() => setStartDate(subDays(startDate, 7))} className="p-1.5 rounded hover:bg-surface text-text-secondary"><ChevronLeft size={16} /></button>
            <button onClick={() => setStartDate(startOfWeek(new Date()))} className="px-3 py-1 text-sm border border-border rounded-md hover:bg-surface">Today</button>
            <button onClick={() => setStartDate(addDays(startDate, 7))} className="p-1.5 rounded hover:bg-surface text-text-secondary"><ChevronRight size={16} /></button>
            <div className="border-l border-border h-5 mx-2" />
            <button onClick={() => setDaysToShow(Math.min(daysToShow + 7, 28))} className="p-1.5 rounded hover:bg-surface text-text-secondary" title="Zoom out"><ZoomOut size={16} /></button>
            <button onClick={() => setDaysToShow(Math.max(daysToShow - 7, 7))} className="p-1.5 rounded hover:bg-surface text-text-secondary" title="Zoom in"><ZoomIn size={16} /></button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="min-w-fit">
          {/* Day Headers */}
          <div className="flex sticky top-0 z-10 bg-white border-b border-border">
            <div className="w-[220px] flex-shrink-0 px-4 py-2 text-xs font-medium text-text-secondary border-r border-border bg-white sticky left-0 z-20">
              {format(startDate, 'MMM d')} - {format(endDate, 'MMM d')}
            </div>
            <div className="flex">
              {days.map((day, i) => (
                <div key={i} className={`text-center border-r border-border py-2 ${isWeekend(day) ? 'bg-surface/50' : 'bg-white'}`} style={{ width: dayWidth }}>
                  <div className="text-[10px] text-text-tertiary">{format(day, 'EEE')}</div>
                  <div className={`text-xs font-medium ${isToday(day) ? 'text-primary' : 'text-text-primary'}`}>{format(day, 'd')}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Task Rows */}
          {timelineTasks.length === 0 ? (
            <div className="text-center py-16 text-sm text-text-secondary">No tasks with dates to show on timeline</div>
          ) : (
            timelineTasks.map(task => {
              const bar = getBarStyle(task);
              return (
                <div key={task.id} className="flex border-b border-border hover:bg-surface/30 transition-colors">
                  <div className="w-[220px] flex-shrink-0 px-4 py-3 border-r border-border bg-white sticky left-0 z-10">
                    <p className="text-sm font-medium text-text-primary truncate">{task.title}</p>
                    <p className="text-[11px] text-text-tertiary mt-0.5">
                      {task.startDate ? format(parseISO(task.startDate), 'MMM d') : ''}
                      {task.startDate && task.dueDate ? ' - ' : ''}
                      {task.dueDate ? format(parseISO(task.dueDate), 'MMM d') : ''}
                    </p>
                  </div>
                  <div className="flex-1 relative" style={{ minWidth: daysToShow * dayWidth }}>
                    {/* Grid lines */}
                    <div className="absolute inset-0 flex">
                      {days.map((day, i) => (
                        <div key={i} className={`border-r border-border h-full ${isWeekend(day) ? 'bg-surface/30' : ''} ${isToday(day) ? 'bg-primary/5' : ''}`} style={{ width: dayWidth }} />
                      ))}
                    </div>
                    {/* Bar */}
                    {bar && (
                      <div className="absolute top-2.5 h-7 rounded-md flex items-center px-2 text-white text-[11px] font-medium truncate shadow-sm"
                        style={{ left: bar.left, width: Math.max(bar.width, 30), backgroundColor: bar.color }}>
                        {bar.width > 60 && task.title}
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
