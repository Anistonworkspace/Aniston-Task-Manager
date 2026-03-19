import React, { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, startOfWeek, endOfWeek, isSameDay, isToday, addMonths, subMonths, parseISO, isSameMonth } from 'date-fns';
import { STATUS_CONFIG, PRIORITY_CONFIG } from '../../utils/constants';
import Avatar from '../common/Avatar';

export default function CalendarView({ tasks = [], members = [], onTaskClick }) {
  const [month, setMonth] = useState(new Date());

  const calDays = useMemo(() => {
    const start = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
    const end = endOfWeek(endOfMonth(month), { weekStartsOn: 1 });
    return eachDayOfInterval({ start, end });
  }, [month]);

  return (
    <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <button onClick={() => setMonth(new Date())} className="px-3 py-1 text-xs border border-border rounded-md hover:bg-surface font-medium">Today</button>
          <button onClick={() => setMonth(subMonths(month, 1))} className="p-1 rounded hover:bg-surface"><ChevronLeft size={16} /></button>
          <button onClick={() => setMonth(addMonths(month, 1))} className="p-1 rounded hover:bg-surface"><ChevronRight size={16} /></button>
        </div>
        <h3 className="text-sm font-bold text-text-primary">{format(month, 'MMMM yyyy')}</h3>
        <div />
      </div>

      {/* Calendar Grid */}
      <div className="grid grid-cols-7 gap-px bg-border">
        {/* Day Headers */}
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => (
          <div key={d} className="bg-surface px-2 py-2 text-[10px] font-semibold text-text-tertiary text-center uppercase tracking-wider">{d}</div>
        ))}

        {/* Day Cells */}
        {calDays.map((day, i) => {
          const dayTasks = tasks.filter(t => t.dueDate && isSameDay(parseISO(t.dueDate), day));
          const isCurrentMonth = isSameMonth(day, month);
          const today = isToday(day);

          return (
            <div key={i} className={`bg-white min-h-[100px] p-1.5 ${!isCurrentMonth ? 'opacity-30' : ''} ${today ? 'ring-1 ring-inset ring-primary/30' : ''}`}>
              <div className={`text-xs font-medium mb-1 w-6 h-6 flex items-center justify-center rounded-full ${today ? 'bg-primary text-white' : 'text-text-primary'}`}>
                {format(day, 'd')}
              </div>
              <div className="space-y-0.5">
                {dayTasks.slice(0, 3).map(task => {
                  const sCfg = STATUS_CONFIG[task.status] || {};
                  const assignee = task.assignee || (task.assignedTo ? members.find(m => m.id === task.assignedTo) : null);
                  return (
                    <div key={task.id} onClick={() => onTaskClick(task)}
                      className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium cursor-pointer hover:opacity-80 truncate text-white"
                      style={{ backgroundColor: sCfg.bgColor || '#c4c4c4' }}>
                      {assignee?.name && <span className="w-3 h-3 rounded-full bg-white/30 text-[7px] flex items-center justify-center flex-shrink-0">{assignee.name[0]}</span>}
                      <span className="truncate">{task.title}</span>
                    </div>
                  );
                })}
                {dayTasks.length > 3 && (
                  <p className="text-[9px] text-text-tertiary px-1">+{dayTasks.length - 3} more</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
