import React, { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, Download, FileText, FileSpreadsheet, CheckCircle2, Clock, AlertTriangle, ListChecks } from 'lucide-react';
import { format, addDays, subDays, parseISO, startOfWeek, endOfWeek } from 'date-fns';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import Avatar from '../components/common/Avatar';

const STATUS_LABELS = {
  not_started: { label: 'Not Started', color: '#c4c4c4' },
  working_on_it: { label: 'Working', color: '#fdab3d' },
  stuck: { label: 'Stuck', color: '#e2445c' },
  done: { label: 'Done', color: '#00c875' },
  review: { label: 'Review', color: '#a25ddc' },
};

const PRIORITY_LABELS = {
  low: { label: 'Low', color: '#579bfc' },
  medium: { label: 'Medium', color: '#fdab3d' },
  high: { label: 'High', color: '#e2445c' },
  critical: { label: 'Urgent', color: '#333333' },
};

export default function ReviewPage() {
  const { user, canManage } = useAuth();
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().slice(0, 10));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [members, setMembers] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [downloading, setDownloading] = useState('');

  useEffect(() => {
    if (canManage) loadMembers();
  }, [canManage]);

  useEffect(() => {
    loadReview();
  }, [selectedDate, selectedUserId]);

  async function loadMembers() {
    try {
      const res = await api.get('/users');
      setMembers(res.data.data || res.data.users || []);
    } catch {}
  }

  async function loadReview() {
    try {
      setLoading(true);
      const params = new URLSearchParams({ date: selectedDate });
      if (selectedUserId) params.append('userId', selectedUserId);
      const res = await api.get(`/reviews/weekly?${params}`);
      setData(res.data.data || res.data);
    } catch (err) {
      console.error('Failed to load review:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleDownload(type) {
    setDownloading(type);
    try {
      const params = new URLSearchParams({ date: selectedDate });
      if (selectedUserId) params.append('userId', selectedUserId);
      const res = await api.get(`/reviews/weekly/${type}?${params}`, { responseType: 'blob' });
      const mimeType = type === 'pdf' ? 'application/pdf' : 'text/csv;charset=utf-8';
      const url = window.URL.createObjectURL(new Blob([res.data], { type: mimeType }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `review-${selectedDate}.${type === 'pdf' ? 'pdf' : 'csv'}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error(`Failed to download ${type}:`, err);
    } finally {
      setDownloading('');
    }
  }

  function handlePrevWeek() {
    setSelectedDate(subDays(parseISO(selectedDate), 7).toISOString().slice(0, 10));
  }
  function handleNextWeek() {
    setSelectedDate(addDays(parseISO(selectedDate), 7).toISOString().slice(0, 10));
  }
  function handleThisWeek() {
    setSelectedDate(new Date().toISOString().slice(0, 10));
  }

  const dateObj = parseISO(selectedDate);
  const weekStart = startOfWeek(dateObj, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(dateObj, { weekStartsOn: 1 });
  const weekLabel = `${format(weekStart, 'MMM d')} – ${format(weekEnd, 'MMM d, yyyy')}`;
  const isCurrentWeek = format(startOfWeek(new Date(), { weekStartsOn: 1 }), 'yyyy-MM-dd') === format(weekStart, 'yyyy-MM-dd');

  return (
    <div className="p-6 max-w-[1100px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold text-text-primary flex items-center gap-2">
            <FileText size={20} className="text-primary" /> Weekly Review
          </h1>
          <p className="text-sm text-text-secondary mt-0.5">Review completed tasks and download reports</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => handleDownload('pdf')} disabled={!!downloading || loading || !data}
            className="flex items-center gap-1.5 px-3.5 py-1.5 bg-danger/10 text-danger text-sm font-medium rounded-lg hover:bg-danger/20 transition-colors disabled:opacity-40">
            <FileText size={14} /> {downloading === 'pdf' ? 'Generating...' : 'PDF'}
          </button>
          <button onClick={() => handleDownload('csv')} disabled={!!downloading || loading || !data}
            className="flex items-center gap-1.5 px-3.5 py-1.5 bg-success/10 text-success text-sm font-medium rounded-lg hover:bg-success/20 transition-colors disabled:opacity-40">
            <FileSpreadsheet size={14} /> {downloading === 'csv' ? 'Generating...' : 'CSV'}
          </button>
        </div>
      </div>

      {/* Week Navigation + Member Selector */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2">
          <button onClick={handlePrevWeek} className="p-1.5 rounded-md hover:bg-surface text-text-secondary transition-colors">
            <ChevronLeft size={18} />
          </button>
          <div className="text-center min-w-[220px]">
            <span className="text-lg font-bold text-text-primary">{weekLabel}</span>
          </div>
          <button onClick={handleNextWeek} className="p-1.5 rounded-md hover:bg-surface text-text-secondary transition-colors">
            <ChevronRight size={18} />
          </button>
          {!isCurrentWeek && (
            <button onClick={handleThisWeek} className="ml-2 px-2.5 py-1 text-xs font-medium text-primary bg-primary/10 rounded-md hover:bg-primary/20 transition-colors">
              This week
            </button>
          )}
        </div>

        {canManage && members.length > 0 && (
          <select value={selectedUserId} onChange={e => setSelectedUserId(e.target.value)}
            className="text-sm border border-border rounded-lg px-3 py-1.5 focus:outline-none focus:border-primary bg-white min-w-[180px]">
            <option value="">My Review</option>
            {members.filter(m => m.isActive !== false).map(m => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        )}
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary/20 border-t-primary" />
        </div>
      ) : !data ? (
        <div className="widget-card text-center py-16">
          <FileText size={40} className="mx-auto text-text-tertiary mb-3" />
          <p className="text-sm text-text-secondary">Failed to load review data</p>
        </div>
      ) : (
        <>
          {/* User Info + Summary */}
          <div className="widget-card mb-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <Avatar name={data.user.name} size="lg" />
                <div>
                  <h2 className="text-base font-bold text-text-primary">{data.user.name}</h2>
                  <p className="text-xs text-text-tertiary">
                    {[data.user.designation, data.user.department].filter(Boolean).join(' · ') || data.user.role}
                  </p>
                </div>
              </div>
              <div className="text-right">
                <span className="text-2xl font-bold text-primary">
                  {data.summary.total > 0 ? Math.round((data.summary.done / data.summary.total) * 100) : 0}%
                </span>
                <p className="text-[10px] text-text-tertiary uppercase tracking-wider">completion</p>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {[
                { label: 'Total', value: data.summary.total, color: '#0073ea', icon: ListChecks },
                { label: 'Completed', value: data.summary.done, color: '#00c875', icon: CheckCircle2 },
                { label: 'Working', value: data.summary.working, color: '#fdab3d', icon: Clock },
                { label: 'Stuck', value: data.summary.stuck, color: '#e2445c', icon: AlertTriangle },
                { label: 'Not Started', value: data.summary.notStarted, color: '#c4c4c4', icon: ListChecks },
              ].map(s => {
                const Icon = s.icon;
                return (
                  <div key={s.label} className="text-center p-3 rounded-lg bg-surface/50 border border-border/50">
                    <Icon size={16} className="mx-auto mb-1" style={{ color: s.color }} />
                    <p className="text-xl font-bold" style={{ color: s.color }}>{s.value}</p>
                    <p className="text-[10px] text-text-tertiary uppercase tracking-wider">{s.label}</p>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Tasks Table */}
          <div className="widget-card mb-5">
            <h3 className="text-sm font-semibold text-text-primary mb-3">Tasks Updated This Week</h3>
            {data.tasks.length === 0 ? (
              <p className="text-sm text-text-secondary text-center py-8">No tasks were updated this week</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-2 px-3 text-text-secondary font-medium">Task</th>
                      <th className="text-left py-2 px-2 text-text-secondary font-medium">Board</th>
                      <th className="text-center py-2 px-2 text-text-secondary font-medium">Status</th>
                      <th className="text-center py-2 px-2 text-text-secondary font-medium">Priority</th>
                      <th className="text-center py-2 px-2 text-text-secondary font-medium">Due Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.tasks.map(task => {
                      const statusCfg = STATUS_LABELS[task.status] || { label: task.status, color: '#c4c4c4' };
                      const priorityCfg = PRIORITY_LABELS[task.priority] || { label: task.priority, color: '#c4c4c4' };
                      const isOverdue = task.dueDate && task.dueDate.toString().slice(0, 10) < new Date().toISOString().slice(0, 10) && task.status !== 'done';
                      return (
                        <tr key={task.id} className="border-b border-border/50 hover:bg-surface/30">
                          <td className="py-2.5 px-3">
                            <span className="font-medium text-text-primary">{task.title}</span>
                          </td>
                          <td className="py-2 px-2">
                            <span className="text-xs text-text-tertiary bg-surface px-1.5 py-0.5 rounded">{task.board?.name || '—'}</span>
                          </td>
                          <td className="py-2 px-2 text-center">
                            <span className="inline-block text-[10px] font-semibold text-white px-2 py-0.5 rounded-sm" style={{ backgroundColor: statusCfg.color }}>
                              {statusCfg.label}
                            </span>
                          </td>
                          <td className="py-2 px-2 text-center">
                            <span className="inline-block text-[10px] font-semibold text-white px-2 py-0.5 rounded-sm" style={{ backgroundColor: priorityCfg.color }}>
                              {priorityCfg.label}
                            </span>
                          </td>
                          <td className="py-2 px-2 text-center">
                            <span className={`text-xs ${isOverdue ? 'text-danger font-semibold' : 'text-text-secondary'}`}>
                              {task.dueDate ? task.dueDate.toString().slice(0, 10) : '—'}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Work Logs */}
          <div className="widget-card">
            <h3 className="text-sm font-semibold text-text-primary mb-3">Daily Updates This Week</h3>
            {data.worklogs.length === 0 ? (
              <p className="text-sm text-text-secondary text-center py-8">No daily updates this week</p>
            ) : (
              <div className="space-y-2.5">
                {data.worklogs.map(log => (
                  <div key={log.id} className="flex gap-3 p-3 rounded-lg bg-surface/30 border border-border/50">
                    <div className="w-[70px] flex-shrink-0">
                      <p className="text-xs font-semibold text-text-primary">{format(parseISO(log.date), 'EEE')}</p>
                      <p className="text-[10px] text-text-tertiary">{format(parseISO(log.date), 'MMM d')}</p>
                    </div>
                    <div className="flex-1 min-w-0">
                      {log.task && (
                        <p className="text-[10px] text-primary font-medium mb-0.5 truncate">{log.task.title}</p>
                      )}
                      <p className="text-sm text-text-secondary">{log.content}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
