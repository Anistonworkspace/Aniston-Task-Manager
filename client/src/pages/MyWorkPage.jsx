import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Calendar as CalIcon, Table, Search, ChevronLeft, ChevronRight, Plus, Settings,
  Lock, Zap, AlertTriangle, Clock, CheckCircle2, CircleDot, X, Sparkles, ListOrdered,
} from 'lucide-react';
// Plan A Slice 1: planning-scoped Sidekick on "My Work". The hook reads
// scope='planning' so the backend loads the caller's open tasks bucketed
// by overdue/today/this-week/later — perfect for "Plan my week" prompts.
import SidekickPanel from '../components/sidekick/SidekickPanel';
// Plan A Slice 3: dedicated "Plan my week" modal — calls
// POST /ai/plan-week (Slice 2) and renders the Mon-Fri schedule.
import PlanWeekModal from '../components/sidekick/PlanWeekModal';
import { SkeletonTable } from '../components/common/Skeleton';
import {
  format, startOfMonth, endOfMonth, eachDayOfInterval, addMonths, subMonths,
  isSameDay, parseISO, isToday, isPast, startOfWeek, endOfWeek, addDays,
} from 'date-fns';
import { useAuth } from '../context/AuthContext';
import { useT } from '../context/LanguageContext';
import { translatePriority, translateStatus } from '../utils/i18nLabels';
import { STATUS_CONFIG, PRIORITY_CONFIG } from '../utils/constants';
import api from '../services/api';
import Avatar from '../components/common/Avatar';
import useRealtimeQuery from '../realtime/useRealtimeQuery';
import { useToast } from '../components/common/Toast';
import { sortTasksByPendingPriority } from '../utils/taskPrioritization';

// Filter chip metadata. The keys here are the values accepted by the
// `?filter=` URL param, so deep-links from the Home page stat tiles land
// on a pre-narrowed view. RBAC stays intact because the underlying data
// source (/tasks?assignedTo=me) is already personal-scoped server-side —
// the filter only narrows what the user already sees, never widens it.
//
// Colors are drawn from skill §1.6 content swatches:
//   stuck-red = #df2f4a · primary = #0073ea · bright-blue = #579bfc
//   working_orange = #fdab3d · done-green = #00c875
const FILTER_META = {
  overdue:     { label: 'Overdue',     color: '#df2f4a' },
  today:       { label: 'Due today',   color: '#0073ea' },
  in_progress: { label: 'In progress', color: '#579bfc' },
  stuck:       { label: 'Stuck / blocked', color: '#df2f4a' },
  done:        { label: 'Completed',   color: '#00c875' },
};

export default function MyWorkPage() {
  const { user } = useAuth();
  // `tr` (not `t`) — the page already uses `t` as a task variable in
  // nested callbacks, so we alias the translator to avoid shadowing.
  const tr = useT();
  const navigate = useNavigate();
  const { error: toastError } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const filterKey = searchParams.get('filter');
  const activeFilter = FILTER_META[filterKey] ? filterKey : null;

  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [viewTab, setViewTab] = useState('table');
  const [searchQuery, setSearchQuery] = useState('');
  const [calMonth, setCalMonth] = useState(new Date());
  // Plan A Slice 1: planning-scoped Sidekick. The panel renders the
  // planning action chips on its empty state (Plan my week / Order today /
  // What to focus on first / etc.), so a single "Ask AI" header button is
  // enough — users pick the prompt that matches what they want.
  const [planSidekickOpen, setPlanSidekickOpen] = useState(false);
  // Plan A Slice 3: dedicated "Plan my week" modal — separate from the
  // Ask AI chat because it renders a STRUCTURED Mon-Fri schedule, not text.
  const [planWeekOpen, setPlanWeekOpen] = useState(false);

  useEffect(() => { loadTasks(); }, []);

  // Live updates — every task event for the current user (assignment,
  // status change, archive, unblock, delegation) lands on this queryKey
  // via the eventRouter. One declaration replaces the old chain of
  // per-event listeners.
  useRealtimeQuery({
    queryKey: 'tasks.assignedTo.me',
    refetch: loadTasks,
  });

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

  // Apply the URL-param bucket filter first, then the search-box text
  // filter. Order matters: the URL filter is the user's deep-link intent
  // ("show me overdue") and search refines within it.
  const bucketFiltered = useMemo(() => {
    if (!activeFilter) return tasks;
    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    switch (activeFilter) {
      case 'overdue':
        return tasks.filter(t => t.dueDate && isPast(parseISO(t.dueDate))
          && !isSameDay(parseISO(t.dueDate), todayStart) && t.status !== 'done');
      case 'today':
        return tasks.filter(t => t.dueDate && isSameDay(parseISO(t.dueDate), todayStart));
      case 'in_progress':
        return tasks.filter(t => t.status === 'working_on_it' || t.status === 'in_progress');
      case 'stuck':
        return tasks.filter(t => t.status === 'stuck');
      case 'done':
        return tasks.filter(t => t.status === 'done');
      default:
        return tasks;
    }
  }, [tasks, activeFilter]);

  const filtered = searchQuery
    ? bucketFiltered.filter(t => t.title.toLowerCase().includes(searchQuery.toLowerCase()))
    : bucketFiltered;

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
      { label: 'Overdue', tasks: sortTasksByPendingPriority(overdue), color: '#df2f4a', icon: AlertTriangle },
      { label: 'Today', tasks: sortTasksByPendingPriority(todayTasks), color: '#0073ea', icon: Clock },
      { label: 'This Week', tasks: sortTasksByPendingPriority(thisWeek), color: '#fdab3d', icon: CalIcon },
      { label: 'Upcoming', tasks: sortTasksByPendingPriority(later), color: '#c4c4c4', icon: CircleDot },
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
          <div className="flex items-center gap-2 min-w-0">
            <div>
              <h1 className="text-xl font-bold text-text-primary">My Work</h1>
              <p className="text-xs text-text-secondary mt-0.5">
                {stats.total} active task{stats.total !== 1 ? 's' : ''}
                {stats.overdue > 0 && <span className="text-danger font-medium"> · {stats.overdue} overdue</span>}
                {stats.autoAssigned > 0 && <span className="text-purple font-medium"> · {stats.autoAssigned} auto-assigned</span>}
              </p>
            </div>
            {activeFilter && (
              <span
                className="ml-3 inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-semibold"
                style={{
                  backgroundColor: `${FILTER_META[activeFilter].color}1A`,
                  color: FILTER_META[activeFilter].color,
                }}
              >
                Filtered: {FILTER_META[activeFilter].label}
                <button
                  type="button"
                  onClick={() => {
                    const next = new URLSearchParams(searchParams);
                    next.delete('filter');
                    setSearchParams(next, { replace: true });
                  }}
                  className="rounded-full hover:bg-black/5 p-0.5"
                  aria-label="Clear filter"
                >
                  <X size={12} />
                </button>
              </span>
            )}
          </div>
          {tasks.length > 0 && (
            <div className="flex items-center gap-1.5">
              {/* Plan A Slice 3 — "Plan my week" calls POST /ai/plan-week
                  and renders the Mon-Fri structured schedule in a modal.
                  Separate from the Sidekick chat because the result is
                  structured (day columns), not free-form. */}
              <button
                type="button"
                onClick={() => setPlanWeekOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-semibold text-emerald-600 border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-900/20 dark:border-emerald-800 transition-colors"
                title="AI plans your Mon-Fri schedule"
              >
                <Sparkles size={13} /> Plan my week
              </button>
              {/* Plan A Slice 1 — "Ask AI" opens the planning-scoped
                  Sidekick chat for free-form prompts (What to focus on /
                  Am I overloaded / Roughly how long). Use this when you
                  want a conversation, not a structured plan. */}
              <button
                type="button"
                onClick={() => setPlanSidekickOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-semibold text-violet-600 border border-violet-200 bg-violet-50 hover:bg-violet-100 dark:bg-violet-900/20 dark:border-violet-800 transition-colors"
                title="Ask AI to plan or prioritize your tasks"
              >
                <Sparkles size={13} /> Ask AI
              </button>
            </div>
          )}
        </div>

        {/* Stats cards */}
        <div className="grid grid-cols-4 gap-2 mb-3">
          {[
            { label: 'Active', value: stats.total, color: '#0073ea' },
            { label: 'Overdue', value: stats.overdue, color: '#df2f4a' },
            { label: 'Completed', value: stats.done, color: '#00c875' },
            { label: 'Auto-assigned', value: stats.autoAssigned, color: '#9d50dd' },
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
                      <div className="grid grid-cols-[1fr_100px_110px_90px_90px] gap-0 text-[10px] font-semibold text-text-secondary uppercase tracking-wider border-b border-border bg-surface/30">
                        <div className="px-3 py-2">Task</div>
                        <div className="px-2 py-2 text-center">Status</div>
                        <div className="px-2 py-2 text-center">Board</div>
                        <div className="px-2 py-2 text-center">Priority</div>
                        <div className="px-2 py-2 text-center">Due</div>
                      </div>
                      {group.tasks.map(task => {
                        const statusCfg = STATUS_CONFIG[task.status] || STATUS_CONFIG.not_started;
                        const priorityCfg = PRIORITY_CONFIG[task.priority] || {};
                        const isOverdue = task.dueDate && isPast(parseISO(task.dueDate)) && task.status !== 'done';
                        return (
                          <div key={task.id}
                            className={`grid grid-cols-[1fr_100px_110px_90px_90px] gap-0 border-b border-border last:border-b-0 hover:bg-surface/30 cursor-pointer transition-colors ${task.status === 'done' ? 'opacity-50' : ''}`}>
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
                              <span className="status-pill text-[10px] px-2 py-0.5 min-w-0" style={{ backgroundColor: statusCfg.bgColor }}>{translateStatus(task.status, statusCfg.label, tr)}</span>
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
                              <span className="text-[10px] px-2 py-0.5 rounded font-medium" style={{ backgroundColor: `${priorityCfg.color || '#c4c4c4'}20`, color: priorityCfg.color || 'var(--secondary-text-color)' }}>
                                {translatePriority(task.priority, tr, priorityCfg.label || task.priority)}
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

      {/* Plan A Slice 1 — planning-scoped Sidekick mount. The panel's empty
          state renders the planning action chips defined in
          actionSuggestionCatalog.js so users can pick the prompt instead of
          typing. The backend reads scope='planning' and loads the caller's
          open tasks bucketed by overdue / today / this week / later. */}
      <SidekickPanel
        isOpen={planSidekickOpen}
        onClose={() => setPlanSidekickOpen(false)}
        scope="planning"
        scopeLabel="your workload"
        pageContext="My Work — caller's personal task list grouped by due date."
        pageState={{ route: '/my-work' }}
      />

      {/* Plan A Slice 3 — Plan my week modal. Renders the structured AI
          schedule when the user clicks the green header button. */}
      <PlanWeekModal
        isOpen={planWeekOpen}
        onClose={() => setPlanWeekOpen(false)}
        tasks={tasks}
      />

    </div>
  );
}
