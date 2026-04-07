import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Calendar as CalIcon, Table, Search, ChevronLeft, ChevronRight, Plus, Settings,
  Send, Lock, Zap, AlertTriangle, Clock, CheckCircle2, CircleDot,
} from 'lucide-react';
import { SkeletonTable } from '../components/common/Skeleton';
import {
  format, startOfMonth, endOfMonth, eachDayOfInterval, addMonths, subMonths,
  isSameDay, parseISO, isToday, isPast, startOfWeek, endOfWeek, addDays,
} from 'date-fns';
import { useAuth } from '../context/AuthContext';
import { STATUS_CONFIG, PRIORITY_CONFIG } from '../utils/constants';
import api from '../services/api';
import Avatar from '../components/common/Avatar';
import DelegateTaskModal from '../components/task/DelegateTaskModal';
import useSocket from '../hooks/useSocket';
import { useToast } from '../components/common/Toast';

export default function MyWorkPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { error: toastError } = useToast();
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [viewTab, setViewTab] = useState('table');
  const [searchQuery, setSearchQuery] = useState('');
  const [calMonth, setCalMonth] = useState(new Date());
  const [delegateTask, setDelegateTask] = useState(null);

  useEffect(() => { loadTasks(); }, []);

  // Live updates
  useSocket('task:created', () => loadTasks());
  useSocket('task:updated', () => loadTasks());
  useSocket('task:delegated', () => loadTasks());
  useSocket('task:unblocked', () => loadTasks());

  async function loadTasks() {
    try {
      const res = await api.get('/tasks?assignedTo=me&limit=100');
      setTasks(res.data.tasks || res.data || []);
    } catch (err) {
      console.error('Failed to load tasks:', err);
      toastError('Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }

  const filtered = searchQuery ? tasks.filter(t => t.title.toLowerCase().includes(searchQuery.toLowerCase())) : tasks;

  // Enhanced grouping
  const grouped = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekEnd = addDays(today, 7);

    const overdue = [], todayTasks = [], thisWeek = [], later = [], done = [];
    filtered.forEach(t => {
      if (t.status === 'done') { done.push(t); return; }
      if (t.dueDate && isPast(parseISO(t.dueDate)) && !isSameDay(parseISO(t.dueDate), today)) { overdue.push(t); return; }
      if (t.dueDate && isSameDay(parseISO(t.dueDate), today)) { todayTasks.push(t); return; }
      if (t.dueDate && parseISO(t.dueDate) <= weekEnd) { thisWeek.push(t); return; }
      later.push(t);
    });

    return [
      { label: 'Overdue', tasks: overdue, color: '#e2445c', icon: AlertTriangle },
      { label: 'Today', tasks: todayTasks, color: '#0073ea', icon: Clock },
      { label: 'This Week', tasks: thisWeek, color: '#fdab3d', icon: CalIcon },
      { label: 'Upcoming', tasks: later, color: '#c4c4c4', icon: CircleDot },
      { label: 'Completed', tasks: done, color: '#00c875', icon: CheckCircle2 },
    ].filter(g => g.tasks.length > 0);
  }, [filtered]);

  // Calendar
  const calDays = useMemo(() => {
    const start = startOfWeek(startOfMonth(calMonth));
    const end = endOfWeek(endOfMonth(calMonth));
    return eachDayOfInterval({ start, end });
  }, [calMonth]);

  // Stats
  const stats = {
    total: tasks.filter(t => t.status !== 'done').length,
    overdue: tasks.filter(t => t.dueDate && isPast(parseISO(t.dueDate)) && !isSameDay(parseISO(t.dueDate), new Date()) && t.status !== 'done').length,
    done: tasks.filter(t => t.status === 'done').length,
    autoAssigned: tasks.filter(t => t.autoAssigned && t.status !== 'done').length,
  };

  if (loading) {
    return (
      <div className="h-full flex flex-col">
        <div className="px-6 pt-5 pb-4">
          <div className="h-7 w-32 bg-gray-100 rounded animate-pulse mb-2" />
          <div className="h-4 w-48 bg-gray-50 rounded animate-pulse" />
        </div>
        <div className="flex gap-3 px-6 mb-4">
          {[1,2,3,4].map(i => <div key={i} className="h-16 flex-1 bg-gray-50 rounded-xl animate-pulse" />)}
        </div>
        <div className="px-6 flex-1">
          <SkeletonTable rows={8} cols={5} />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 pt-5 pb-2">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-xl font-bold text-text-primary">My Work</h1>
            <p className="text-xs text-text-secondary mt-0.5">
              {stats.total} active task{stats.total !== 1 ? 's' : ''}
              {stats.overdue > 0 && <span className="text-danger font-medium"> · {stats.overdue} overdue</span>}
              {stats.autoAssigned > 0 && <span className="text-purple font-medium"> · {stats.autoAssigned} auto-assigned</span>}
            </p>
          </div>
        </div>

        {/* Stats cards */}
        <div className="grid grid-cols-4 gap-2 mb-3">
          {[
            { label: 'Active', value: stats.total, color: '#0073ea' },
            { label: 'Overdue', value: stats.overdue, color: '#e2445c' },
            { label: 'Completed', value: stats.done, color: '#00c875' },
            { label: 'Auto-assigned', value: stats.autoAssigned, color: '#a25ddc' },
          ].map(s => (
            <div key={s.label} className="bg-white rounded-lg border border-border px-3 py-2">
              <p className="text-[10px] text-text-tertiary font-medium">{s.label}</p>
              <p className="text-lg font-bold" style={{ color: s.color }}>{s.value}</p>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-4 border-b border-border mb-3">
          {[
            { id: 'table', label: 'Table', icon: Table },
            { id: 'calendar', label: 'Calendar', icon: CalIcon },
          ].map(tab => (
            <button key={tab.id} onClick={() => setViewTab(tab.id)}
              className={`flex items-center gap-1.5 px-1 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${viewTab === tab.id ? 'border-primary text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
              <tab.icon size={15} /> {tab.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 py-2">
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-sm text-text-secondary hover:bg-surface rounded-md">
            <Search size={14} />
            <input type="text" placeholder="Search tasks..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="bg-transparent border-none outline-none text-sm w-[120px] focus:w-[200px] transition-all" />
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 pb-6">
        {viewTab === 'table' ? (
          <div>
            {grouped.length === 0 ? (
              <div className="text-center py-16">
                <CheckCircle2 size={40} className="mx-auto text-text-tertiary mb-3 opacity-40" />
                <p className="text-sm text-text-secondary font-medium">No tasks assigned to you</p>
                <p className="text-xs text-text-tertiary mt-1">Tasks assigned to you will appear here</p>
              </div>
            ) : (
              grouped.map(group => {
                const GroupIcon = group.icon;
                return (
                  <div key={group.label} className="mb-5">
                    <div className="flex items-center gap-2 mb-1.5">
                      <GroupIcon size={15} style={{ color: group.color }} />
                      <span className="text-sm font-semibold" style={{ color: group.color }}>{group.label}</span>
                      <span className="text-xs text-text-tertiary bg-surface px-1.5 py-0.5 rounded-full">{group.tasks.length}</span>
                    </div>
                    <div className="bg-white rounded-lg border border-border overflow-hidden">
                      {/* Header */}
                      <div className="grid grid-cols-[1fr_100px_110px_90px_90px_70px] gap-0 text-[10px] font-semibold text-text-secondary uppercase tracking-wider border-b border-border bg-surface/30">
                        <div className="px-3 py-2">Task</div>
                        <div className="px-2 py-2 text-center">Status</div>
                        <div className="px-2 py-2 text-center">Board</div>
                        <div className="px-2 py-2 text-center">Priority</div>
                        <div className="px-2 py-2 text-center">Due</div>
                        <div className="px-2 py-2 text-center">Action</div>
                      </div>
                      {group.tasks.map(task => {
                        const statusCfg = STATUS_CONFIG[task.status] || STATUS_CONFIG.not_started;
                        const priorityCfg = PRIORITY_CONFIG[task.priority] || {};
                        const isOverdue = task.dueDate && isPast(parseISO(task.dueDate)) && task.status !== 'done';
                        return (
                          <div key={task.id}
                            className={`grid grid-cols-[1fr_100px_110px_90px_90px_70px] gap-0 border-b border-border last:border-b-0 hover:bg-surface/30 cursor-pointer transition-colors ${task.status === 'done' ? 'opacity-50' : ''}`}>
                            {/* Task */}
                            <div className="px-3 py-2.5 flex items-center gap-2 min-w-0" onClick={() => task.boardId && navigate(`/boards/${task.boardId}`)}>
                              <span className="text-sm font-medium text-text-primary truncate">{task.title}</span>
                              {task.autoAssigned && (
                                <span className="inline-flex items-center text-[9px] font-medium px-1 py-0.5 rounded bg-purple/10 text-purple flex-shrink-0" title="Auto-assigned">
                                  <Zap size={8} />
                                </span>
                              )}
                            </div>
                            {/* Status */}
                            <div className="px-1 py-1.5 flex items-center justify-center">
                              <span className="status-pill text-[10px] px-2 py-0.5 min-w-0" style={{ backgroundColor: statusCfg.bgColor }}>{statusCfg.label}</span>
                            </div>
                            {/* Board */}
                            <div className="px-2 py-2.5 flex items-center justify-center" onClick={() => task.boardId && navigate(`/boards/${task.boardId}`)}>
                              {task.Board || task.board ? (
                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-surface border border-border text-text-secondary truncate max-w-[100px]">
                                  {(task.Board || task.board)?.name}
                                </span>
                              ) : <span className="text-text-tertiary text-xs">—</span>}
                            </div>
                            {/* Priority */}
                            <div className="px-1 py-1.5 flex items-center justify-center">
                              <span className="text-[10px] px-2 py-0.5 rounded font-medium" style={{ backgroundColor: `${priorityCfg.color || '#c4c4c4'}20`, color: priorityCfg.color || '#666' }}>
                                {priorityCfg.label || task.priority}
                              </span>
                            </div>
                            {/* Due */}
                            <div className="px-2 py-2.5 flex items-center justify-center">
                              {task.dueDate ? (
                                <span className={`text-xs ${isOverdue ? 'text-danger font-semibold' : 'text-text-secondary'}`}>
                                  {format(parseISO(task.dueDate), 'MMM d')}
                                </span>
                              ) : <span className="text-text-tertiary text-xs">—</span>}
                            </div>
                            {/* Action */}
                            <div className="px-2 py-2 flex items-center justify-center">
                              {task.status !== 'done' && (
                                <button onClick={(e) => { e.stopPropagation(); setDelegateTask(task); }}
                                  className="p-1 rounded hover:bg-primary/5 text-text-tertiary hover:text-primary transition-colors" title="Delegate">
                                  <Send size={13} />
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        ) : (
          /* CALENDAR VIEW */
          <div className="bg-white rounded-lg border border-border p-4">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <button onClick={() => setCalMonth(new Date())} className="px-3 py-1 text-sm border border-border rounded-md hover:bg-surface">Today</button>
                <button onClick={() => setCalMonth(subMonths(calMonth, 1))} className="p-1 rounded hover:bg-surface"><ChevronLeft size={16} /></button>
                <button onClick={() => setCalMonth(addMonths(calMonth, 1))} className="p-1 rounded hover:bg-surface"><ChevronRight size={16} /></button>
              </div>
              <h3 className="text-base font-semibold">{format(calMonth, 'MMMM yyyy')}</h3>
              <div className="text-sm text-text-secondary">Month</div>
            </div>
            <div className="grid grid-cols-7 gap-px bg-border rounded-lg overflow-hidden">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => (
                <div key={d} className="bg-surface px-2 py-2 text-xs font-medium text-text-secondary text-center">{d}</div>
              ))}
              {calDays.map((day, i) => {
                const dayTasks = tasks.filter(t => t.dueDate && isSameDay(parseISO(t.dueDate), day));
                const isCurrentMonth = day.getMonth() === calMonth.getMonth();
                return (
                  <div key={i} className={`bg-white min-h-[80px] p-1 ${!isCurrentMonth ? 'opacity-40' : ''}`}>
                    <div className={`text-xs font-medium mb-1 w-6 h-6 flex items-center justify-center rounded-full ${isToday(day) ? 'bg-primary text-white' : 'text-text-primary'}`}>
                      {format(day, 'd')}
                    </div>
                    {dayTasks.slice(0, 2).map(t => {
                      const cfg = STATUS_CONFIG[t.status];
                      return (
                        <div key={t.id} className="text-[10px] font-medium px-1 py-0.5 rounded mb-0.5 truncate text-white" style={{ backgroundColor: cfg?.bgColor || '#c4c4c4' }}>
                          {t.title}
                        </div>
                      );
                    })}
                    {dayTasks.length > 2 && <div className="text-[10px] text-text-tertiary px-1">+{dayTasks.length - 2} more</div>}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Delegate Modal */}
      {delegateTask && (
        <DelegateTaskModal
          task={delegateTask}
          onClose={() => setDelegateTask(null)}
          onDelegated={() => { setDelegateTask(null); loadTasks(); }}
        />
      )}
    </div>
  );
}
