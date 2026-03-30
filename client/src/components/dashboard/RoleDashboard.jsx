import React, { useState, useEffect, useCallback } from 'react';
import {
  LayoutDashboard, Search, X, ChevronDown, AlertTriangle, Clock, User,
  Calendar, AlertCircle, Tag, Users, Filter,
} from 'lucide-react';
import { format, isBefore, startOfDay } from 'date-fns';
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { STATUS_CONFIG, PRIORITY_CONFIG } from '../../utils/constants';
import Avatar from '../common/Avatar';

const SMART_VIEWS_ALL = [
  { id: 'overdue', label: 'Overdue', icon: AlertTriangle, color: '#e2445c' },
  { id: 'due_today', label: 'Due Today', icon: Clock, color: '#fdab3d' },
  { id: 'my_tasks', label: 'My Tasks', icon: User, color: '#0073ea' },
  { id: 'this_week', label: 'This Week', icon: Calendar, color: '#00c875' },
  { id: 'stuck', label: 'Stuck Tasks', icon: AlertCircle, color: '#e2445c' },
  { id: 'high_priority', label: 'High Priority', icon: Tag, color: '#e2445c' },
  { id: 'unassigned', label: 'Unassigned', icon: Users, color: '#c4c4c4' },
];

/**
 * Shared dashboard component for all role-based dashboards.
 * @param {string} scope - 'member' | 'manager' | 'admin'
 * @param {string} title - Dashboard title
 * @param {string} subtitle - Role subtitle
 * @param {boolean} showPersonFilter - Whether to show the person dropdown
 * @param {boolean} showUnassigned - Whether to show the Unassigned smart view
 */
export default function RoleDashboard({ scope, title = 'My Dashboard', subtitle = '', showPersonFilter = true, showUnassigned = true }) {
  const { user: currentUser } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [personList, setPersonList] = useState([]);
  const [filters, setFilters] = useState({ status: [], priority: [], person: '', search: '', dateFilter: '', smartView: '' });
  const [smartViewOpen, setSmartViewOpen] = useState(false);
  const [personOpen, setPersonOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [showFilters, setShowFilters] = useState(false);

  const smartViews = showUnassigned ? SMART_VIEWS_ALL : SMART_VIEWS_ALL.filter(v => v.id !== 'unassigned');

  // Load person list for admin/manager scopes
  useEffect(() => {
    if (showPersonFilter) {
      api.get('/auth/users').then(res => {
        setPersonList(res.data.users || res.data.data?.users || res.data || []);
      }).catch(() => {});
    }
  }, [showPersonFilter]);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      params.set('scope', scope);
      if (filters.status.length) params.set('status', filters.status.join(','));
      if (filters.priority.length) params.set('priority', filters.priority.join(','));
      if (filters.person) params.set('assignedTo', filters.person);
      if (filters.search) params.set('search', filters.search);
      if (filters.dateFilter) params.set('dateFilter', filters.dateFilter);
      params.set('page', page);
      params.set('limit', 50);

      const res = await api.get(`/dashboard/role?${params.toString()}`);
      const d = res.data.data || res.data;
      setData(d);
      // Manager: use teamMembers from response for person dropdown
      if (scope === 'manager' && d.teamMembers?.length && !showPersonFilter) {
        setPersonList(d.teamMembers);
      }
    } catch (err) {
      console.error('Dashboard fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [filters, page, scope, showPersonFilter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  function applySmartView(viewId) {
    const reset = { status: [], priority: [], person: '', search: '', dateFilter: '', smartView: viewId };
    switch (viewId) {
      case 'overdue': reset.dateFilter = 'overdue'; break;
      case 'due_today': reset.dateFilter = 'today'; break;
      case 'my_tasks': reset.person = currentUser?.id || ''; break;
      case 'this_week': reset.dateFilter = 'this_week'; break;
      case 'stuck': reset.status = ['stuck']; break;
      case 'high_priority': reset.priority = ['high', 'critical']; break;
      case 'unassigned': reset.person = 'unassigned'; break;
      default: break;
    }
    setFilters(reset);
    setPage(1);
    setSmartViewOpen(false);
  }

  function toggleStatus(s) {
    setFilters(f => ({ ...f, status: f.status.includes(s) ? f.status.filter(x => x !== s) : [...f.status, s], smartView: '' }));
    setPage(1);
  }
  function togglePriority(p) {
    setFilters(f => ({ ...f, priority: f.priority.includes(p) ? f.priority.filter(x => x !== p) : [...f.priority, p], smartView: '' }));
    setPage(1);
  }
  function clearFilters() {
    setFilters({ status: [], priority: [], person: '', search: '', dateFilter: '', smartView: '' });
    setPage(1);
  }

  const hasFilters = filters.status.length || filters.priority.length || filters.person || filters.search || filters.dateFilter || filters.smartView;
  const summary = data?.summary || {};
  const tasks = data?.tasks || [];
  const pagination = data?.pagination || {};
  const memberStats = data?.memberStats || [];

  const statusChartData = Object.entries(data?.statusCounts || {}).map(([key, value]) => ({
    name: STATUS_CONFIG[key]?.label || key, value, color: STATUS_CONFIG[key]?.color || '#c4c4c4',
  }));
  const priorityChartData = Object.entries(data?.priorityCounts || {}).map(([key, value]) => ({
    name: PRIORITY_CONFIG[key]?.label || key, value, color: PRIORITY_CONFIG[key]?.color || '#94a3b8',
  }));

  const activeFilterCount = (filters.status.length || 0) + (filters.priority.length || 0) + (filters.person ? 1 : 0) + (filters.dateFilter ? 1 : 0) + (filters.smartView ? 1 : 0);

  return (
    <div className="min-h-screen bg-background p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary flex items-center gap-2">
            <LayoutDashboard size={24} className="text-primary" /> {title}
          </h1>
          {subtitle && <p className="text-sm text-text-tertiary mt-0.5">{subtitle}</p>}
        </div>
      </div>

      {/* ═══ STAT CARDS ═══ */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          { label: 'Total Tasks', value: summary.totalTasks || 0, color: '#0073ea' },
          { label: 'Done', value: summary.done || 0, color: '#00c875' },
          { label: 'Working', value: summary.working || 0, color: '#fdab3d' },
          { label: 'Stuck', value: summary.stuck || 0, color: '#e2445c' },
          { label: 'Overdue', value: summary.overdue || 0, color: '#e2445c' },
          { label: 'In Review', value: summary.review || 0, color: '#a25ddc' },
        ].map(stat => (
          <div key={stat.label} className="bg-white rounded-xl border border-border p-4 hover:shadow-sm transition-shadow">
            <p className="text-xs text-text-tertiary font-medium">{stat.label}</p>
            <p className="text-2xl font-bold mt-1" style={{ color: stat.color }}>{stat.value}</p>
          </div>
        ))}
      </div>

      {/* ═══ CHARTS ═══ */}
      {!loading && statusChartData.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-white rounded-xl border border-border p-5">
            <h3 className="text-sm font-semibold text-text-primary mb-4">Status Distribution</h3>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={statusChartData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="value" paddingAngle={2}>
                  {statusChartData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                </Pie>
                <Tooltip formatter={(value, name) => [value, name]} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: '11px' }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="bg-white rounded-xl border border-border p-5">
            <h3 className="text-sm font-semibold text-text-primary mb-4">Priority Distribution</h3>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={priorityChartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                  {priorityChartData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* ═══ TEAM OVERVIEW (manager/admin only) ═══ */}
      {memberStats.length > 1 && (
        <div className="bg-white rounded-xl border border-border overflow-hidden">
          <div className="px-5 py-3 border-b border-border">
            <h3 className="text-sm font-semibold text-text-primary">Team Overview</h3>
          </div>
          <table className="w-full">
            <thead className="bg-surface/50">
              <tr>
                <th className="text-left py-2 px-4 text-[10px] font-semibold text-text-tertiary uppercase">Member</th>
                <th className="text-center py-2 px-4 text-[10px] font-semibold text-text-tertiary uppercase">Total</th>
                <th className="text-center py-2 px-4 text-[10px] font-semibold text-text-tertiary uppercase">Done</th>
                <th className="text-center py-2 px-4 text-[10px] font-semibold text-text-tertiary uppercase">Working</th>
                <th className="text-center py-2 px-4 text-[10px] font-semibold text-text-tertiary uppercase">Stuck</th>
                <th className="text-center py-2 px-4 text-[10px] font-semibold text-text-tertiary uppercase">Overdue</th>
              </tr>
            </thead>
            <tbody>
              {memberStats.map(m => (
                <tr key={m.id} className="border-t border-border hover:bg-surface/30 cursor-pointer"
                  onClick={() => { setFilters(f => ({ ...f, person: m.id, smartView: '' })); setPage(1); }}>
                  <td className="py-2 px-4"><div className="flex items-center gap-2"><Avatar name={m.name} size="xs" /><span className="text-sm">{m.name}</span></div></td>
                  <td className="py-2 px-4 text-center text-sm font-semibold">{m.total}</td>
                  <td className="py-2 px-4 text-center text-sm text-success font-semibold">{m.done}</td>
                  <td className="py-2 px-4 text-center text-sm text-warning font-semibold">{m.working}</td>
                  <td className="py-2 px-4 text-center text-sm text-danger font-semibold">{m.stuck}</td>
                  <td className="py-2 px-4 text-center text-sm text-danger font-semibold">{m.overdue}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ═══ TASK TABLE WITH INLINE FILTERS ═══ */}
      <div className="bg-white rounded-xl border border-border overflow-hidden">
        {/* Task table header with search, filter toggle, and person filter */}
        <div className="px-5 py-3 border-b border-border">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              Tasks {pagination.total != null && <span className="text-text-tertiary font-normal">({pagination.total})</span>}
            </h3>

            <div className="flex items-center gap-2 flex-1 justify-end">
              {/* Person filter (for admin/superadmin/assistant_manager) */}
              {showPersonFilter && (
                <div className="relative">
                  <button onClick={() => setPersonOpen(!personOpen)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-border hover:border-primary/40 bg-white transition-colors">
                    <Users size={12} />
                    {filters.person && filters.person !== 'unassigned'
                      ? (personList.find(u => u.id === filters.person)?.name || 'Selected')
                      : filters.person === 'unassigned' ? 'Unassigned' : 'All Members'}
                    <ChevronDown size={12} />
                  </button>
                  {personOpen && (
                    <div className="absolute top-full right-0 mt-1 bg-white border border-border rounded-lg shadow-xl z-20 w-56 max-h-60 overflow-y-auto py-1">
                      <button onClick={() => { setFilters(f => ({ ...f, person: '' })); setPersonOpen(false); setPage(1); }}
                        className={`w-full text-left px-3 py-2 text-xs hover:bg-surface ${!filters.person ? 'bg-primary/5 font-semibold' : ''}`}>
                        All Members
                      </button>
                      {personList.filter(u => u.isActive !== false).map(u => (
                        <button key={u.id} onClick={() => { setFilters(f => ({ ...f, person: u.id, smartView: '' })); setPersonOpen(false); setPage(1); }}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-surface ${filters.person === u.id ? 'bg-primary/5 font-semibold' : ''}`}>
                          <Avatar name={u.name} size="xs" /> {u.name}
                          {u.role && <span className="text-[9px] text-text-tertiary ml-auto">{u.role}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Smart Views */}
              <div className="relative">
                <button onClick={() => setSmartViewOpen(!smartViewOpen)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${filters.smartView ? 'bg-primary text-white border-primary' : 'bg-surface border-border text-text-primary hover:border-primary/40'}`}>
                  <Filter size={13} />
                  {filters.smartView ? smartViews.find(v => v.id === filters.smartView)?.label : 'Smart Views'}
                  <ChevronDown size={12} />
                </button>
                {smartViewOpen && (
                  <div className="absolute top-full right-0 mt-1 bg-white border border-border rounded-lg shadow-xl z-20 w-48 py-1">
                    {smartViews.map(v => {
                      const Icon = v.icon;
                      return (
                        <button key={v.id} onClick={() => applySmartView(v.id)}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-surface transition-colors ${filters.smartView === v.id ? 'bg-primary/5 font-semibold' : ''}`}>
                          <Icon size={13} style={{ color: v.color }} /> {v.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Filter toggle */}
              <button onClick={() => setShowFilters(!showFilters)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${showFilters || activeFilterCount > 0 ? 'bg-primary/10 border-primary/30 text-primary' : 'border-border hover:border-primary/40 text-text-secondary'}`}>
                <Filter size={12} />
                Filters
                {activeFilterCount > 0 && (
                  <span className="w-4 h-4 rounded-full bg-primary text-white text-[9px] font-bold flex items-center justify-center">{activeFilterCount}</span>
                )}
              </button>

              {/* Search */}
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
                <input type="text" placeholder="Search tasks..." value={filters.search}
                  onChange={e => { setFilters(f => ({ ...f, search: e.target.value })); setPage(1); }}
                  className="pl-8 pr-3 py-1.5 text-xs border border-border rounded-lg w-48 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary" />
              </div>

              {hasFilters && (
                <button onClick={clearFilters} className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-medium text-danger hover:bg-danger/5 transition-colors">
                  <X size={12} /> Clear
                </button>
              )}
            </div>
          </div>

          {/* Expandable filter bar */}
          {showFilters && (
            <div className="mt-3 pt-3 border-t border-border space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] font-bold text-text-tertiary uppercase tracking-wider">Status</span>
                {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
                  <button key={key} onClick={() => toggleStatus(key)}
                    className="px-2 py-0.5 rounded text-[10px] font-semibold transition-all border"
                    style={{
                      backgroundColor: filters.status.includes(key) ? cfg.color : 'transparent',
                      color: filters.status.includes(key) ? '#fff' : cfg.color,
                      borderColor: filters.status.includes(key) ? cfg.color : '#e5e7eb',
                    }}>
                    {cfg.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] font-bold text-text-tertiary uppercase tracking-wider">Priority</span>
                {Object.entries(PRIORITY_CONFIG).map(([key, cfg]) => (
                  <button key={key} onClick={() => togglePriority(key)}
                    className="px-2 py-0.5 rounded text-[10px] font-semibold transition-all border"
                    style={{
                      backgroundColor: filters.priority.includes(key) ? cfg.color : 'transparent',
                      color: filters.priority.includes(key) ? '#fff' : cfg.color,
                      borderColor: filters.priority.includes(key) ? cfg.color : '#e5e7eb',
                    }}>
                    {cfg.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {loading ? (
          <div className="p-12 text-center text-text-tertiary text-sm">Loading tasks...</div>
        ) : tasks.length === 0 ? (
          <div className="p-12 text-center">
            <LayoutDashboard size={32} className="mx-auto text-text-tertiary mb-2" />
            <p className="text-sm text-text-secondary">No tasks found</p>
            <p className="text-xs text-text-tertiary mt-1">Try adjusting your filters</p>
          </div>
        ) : (
          <>
            <table className="w-full">
              <thead className="bg-surface/50">
                <tr>
                  <th className="text-left py-2.5 px-4 text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">Task</th>
                  <th className="text-left py-2.5 px-4 text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">Board</th>
                  <th className="text-left py-2.5 px-4 text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">Owner</th>
                  <th className="text-center py-2.5 px-4 text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">Status</th>
                  <th className="text-center py-2.5 px-4 text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">Priority</th>
                  <th className="text-left py-2.5 px-4 text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">Due Date</th>
                  <th className="text-center py-2.5 px-4 text-[10px] font-semibold text-text-tertiary uppercase tracking-wider">Progress</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map(task => {
                  const statusCfg = STATUS_CONFIG[task.status] || {};
                  const priorityCfg = PRIORITY_CONFIG[task.priority] || {};
                  const isOverdue = task.dueDate && isBefore(new Date(task.dueDate), startOfDay(new Date())) && task.status !== 'done';
                  return (
                    <tr key={task.id} className="border-t border-border hover:bg-surface/30 transition-colors">
                      <td className="py-2.5 px-4"><p className="text-sm font-medium text-text-primary truncate max-w-[280px]">{task.title}</p></td>
                      <td className="py-2.5 px-4">
                        {task.board && (
                          <span className="inline-flex items-center gap-1.5 text-xs text-text-secondary">
                            <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: task.board.color || '#0073ea' }} />
                            {task.board.name}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-4">
                        {task.assignee ? (
                          <div className="flex items-center gap-1.5"><Avatar name={task.assignee.name} size="xs" /><span className="text-xs text-text-secondary">{task.assignee.name}</span></div>
                        ) : (<span className="text-xs text-text-tertiary">Unassigned</span>)}
                      </td>
                      <td className="py-2.5 px-4 text-center">
                        <span className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold" style={{ backgroundColor: statusCfg.bgColor || '#c4c4c4', color: statusCfg.textColor || '#fff' }}>
                          {statusCfg.label || task.status}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-center">
                        <span className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold" style={{ backgroundColor: priorityCfg.bgColor || '#94a3b8', color: priorityCfg.textColor || '#fff' }}>
                          {priorityCfg.label || task.priority}
                        </span>
                      </td>
                      <td className="py-2.5 px-4">
                        {task.dueDate ? (
                          <span className={`text-xs ${isOverdue ? 'text-danger font-semibold' : 'text-text-secondary'}`}>
                            {format(new Date(task.dueDate), 'MMM d, yyyy')}{isOverdue && ' !'}
                          </span>
                        ) : (<span className="text-xs text-text-tertiary">—</span>)}
                      </td>
                      <td className="py-2.5 px-4 text-center">
                        <div className="flex items-center gap-1.5 justify-center">
                          <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                            <div className="h-full rounded-full transition-all" style={{
                              width: `${task.progress || 0}%`,
                              backgroundColor: (task.progress || 0) >= 100 ? '#00c875' : (task.progress || 0) >= 50 ? '#fdab3d' : '#e2445c',
                            }} />
                          </div>
                          <span className="text-[10px] text-text-tertiary w-7">{task.progress || 0}%</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {pagination.total > pagination.limit && (
              <div className="flex items-center justify-between px-5 py-3 border-t border-border">
                <span className="text-xs text-text-tertiary">
                  Showing {(pagination.page - 1) * pagination.limit + 1}–{Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total}
                </span>
                <div className="flex items-center gap-1">
                  <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}
                    className="px-3 py-1 text-xs rounded border border-border hover:bg-surface disabled:opacity-40 transition-colors">Prev</button>
                  <button disabled={page * pagination.limit >= pagination.total} onClick={() => setPage(p => p + 1)}
                    className="px-3 py-1 text-xs rounded border border-border hover:bg-surface disabled:opacity-40 transition-colors">Next</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
