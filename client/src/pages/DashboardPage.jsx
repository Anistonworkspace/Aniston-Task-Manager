import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion, useMotionValue, useTransform, animate as fmAnimate } from 'framer-motion';
import { ArrowLeft, Users, AlertTriangle, CheckCircle2, Clock, ListChecks, FileText, Activity, ChevronRight } from 'lucide-react';
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line, AreaChart, Area } from 'recharts';
import { formatDistanceToNow, parseISO, format } from 'date-fns';
import api from '../services/api';
import { STATUS_CONFIG, PRIORITY_CONFIG } from '../utils/constants';
import Avatar from '../components/common/Avatar';
import MemberDrillDown from '../components/dashboard/MemberDrillDown';
import useSocket from '../hooks/useSocket';
import { SkeletonDashboard } from '../components/common/Skeleton';

export default function DashboardPage() {
  const { id: boardId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedMember, setSelectedMember] = useState(null);

  useEffect(() => {
    loadDashboard();
  }, [boardId]);

  // Live refresh when tasks change
  useSocket('task:created', () => loadDashboard());
  useSocket('task:updated', () => loadDashboard());
  useSocket('task:deleted', () => loadDashboard());
  useSocket('task:delegated', () => loadDashboard());

  async function loadDashboard() {
    try {
      setLoading(true);
      const params = boardId ? `?boardId=${boardId}` : '';
      const [statsRes, boardRes] = await Promise.all([
        api.get(`/dashboard/stats${params}`),
        boardId ? api.get(`/boards/${boardId}`) : Promise.resolve(null),
      ]);
      setData(statsRes.data.data || statsRes.data);
      if (boardRes) setBoard(boardRes.data.board || boardRes.data.data?.board || boardRes.data);
    } catch (err) {
      console.error('Failed to load dashboard:', err);
    } finally {
      setLoading(false);
    }
  }

  if (loading || !data) {
    return <SkeletonDashboard />;
  }

  const { summary, statusCounts, priorityCounts, memberStats, recentActivity, recentWorklogs, boards, overdueTasks = [], trendData = [], workloadData = [] } = data;

  // Chart data
  const byStatus = Object.entries(STATUS_CONFIG).map(([key, cfg]) => ({
    name: cfg.label, value: statusCounts[key] || 0, color: cfg.bgColor,
  })).filter(s => s.value > 0);

  const byPriority = Object.entries(PRIORITY_CONFIG).map(([key, cfg]) => ({
    name: cfg.label, value: priorityCounts[key] || 0, color: cfg.bgColor,
  })).filter(p => p.value > 0);

  const completionRate = summary.totalTasks > 0 ? Math.round((summary.done / summary.totalTasks) * 100) : 0;

  const statCards = [
    { label: 'Total Tasks', value: summary.totalTasks, color: '#0073ea', icon: ListChecks },
    { label: 'Completed', value: summary.done, color: '#00c875', icon: CheckCircle2 },
    { label: 'In Progress', value: summary.working, color: '#fdab3d', icon: Clock },
    { label: 'Stuck', value: summary.stuck, color: '#e2445c', icon: AlertTriangle },
    { label: 'Overdue', value: summary.overdue, color: '#e2445c', icon: AlertTriangle },
  ];

  return (
    <motion.div className="p-6 max-w-[1400px] mx-auto" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
      {/* Header */}
      <motion.div className="flex items-center gap-3 mb-6" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}>
        {boardId && (
          <button onClick={() => navigate(`/boards/${boardId}`)} className="p-1.5 rounded-md hover:bg-surface text-text-secondary"><ArrowLeft size={18} /></button>
        )}
        <div className="flex-1">
          <h1 className="text-xl font-bold text-text-primary">Dashboard & Reports</h1>
          {board ? (
            <p className="text-sm text-text-secondary">{board.name}</p>
          ) : (
            <p className="text-sm text-text-secondary">All boards overview</p>
          )}
        </div>
        <div className="flex items-center gap-2 bg-primary/10 px-3 py-1.5 rounded-lg">
          <span className="text-2xl font-bold text-primary">{completionRate}%</span>
          <span className="text-xs text-text-secondary">completed</span>
        </div>
      </motion.div>

      {/* Stat Cards */}
      <motion.div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6"
        initial="initial" animate="animate" variants={{ animate: { transition: { staggerChildren: 0.05 } } }}>
        {statCards.map(card => {
          const Icon = card.icon;
          return (
            <motion.div key={card.label} className="widget-card"
              variants={{ initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0, transition: { duration: 0.25, ease: [0.16, 1, 0.3, 1] } } }}
              whileHover={{ y: -1, transition: { duration: 0.15 } }}>
              <div className="flex items-center gap-2 mb-2">
                <Icon size={14} style={{ color: card.color }} />
                <span className="text-xs text-text-secondary font-medium">{card.label}</span>
              </div>
              <p className="text-2xl font-bold" style={{ color: card.color }}>{card.value}</p>
            </motion.div>
          );
        })}
      </motion.div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        {/* Status Pie */}
        <div className="widget-card">
          <h3 className="text-sm font-semibold mb-4">Tasks by Status</h3>
          {byStatus.length > 0 ? (
            <div className="flex items-center gap-6">
              <ResponsiveContainer width="50%" height={180}>
                <PieChart>
                  <Pie data={byStatus} cx="50%" cy="50%" outerRadius={70} innerRadius={40} dataKey="value" stroke="none">
                    {byStatus.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="flex flex-col gap-2">
                {byStatus.map(s => (
                  <div key={s.name} className="flex items-center gap-2 text-sm">
                    <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: s.color }} />
                    <span className="text-text-secondary">{s.name}</span>
                    <span className="font-semibold ml-auto">{s.value}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-text-secondary text-center py-8">No data</p>
          )}
        </div>

        {/* Priority Bar */}
        <div className="widget-card">
          <h3 className="text-sm font-semibold mb-4">Tasks by Priority</h3>
          {byPriority.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={byPriority}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e6e9ef" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                  {byPriority.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-text-secondary text-center py-8">No data</p>
          )}
        </div>
      </div>

      {/* Team Overview */}
      {memberStats.length > 0 && (
        <div className="widget-card mb-6">
          <h3 className="text-sm font-semibold mb-1 flex items-center gap-2">
            <Users size={15} /> Team Overview
          </h3>
          <p className="text-xs text-text-tertiary mb-3">Click a member to view their tasks, add tasks, or leave comments</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 px-3 text-text-secondary font-medium">Member</th>
                  <th className="text-center py-2 px-2 text-text-secondary font-medium">Total</th>
                  <th className="text-center py-2 px-2 text-text-secondary font-medium">Done</th>
                  <th className="text-center py-2 px-2 text-text-secondary font-medium">Working</th>
                  <th className="text-center py-2 px-2 text-text-secondary font-medium">Stuck</th>
                  <th className="text-center py-2 px-2 text-text-secondary font-medium">Overdue</th>
                  <th className="text-left py-2 px-3 text-text-secondary font-medium">Progress</th>
                </tr>
              </thead>
              <tbody>
                {memberStats.filter(m => m.id !== 'unassigned').map(member => {
                  const pct = member.total > 0 ? Math.round((member.done / member.total) * 100) : 0;
                  return (
                    <tr key={member.id} onClick={() => setSelectedMember(member.id)} className="border-b border-border/50 hover:bg-primary/5 cursor-pointer transition-colors group">
                      <td className="py-2.5 px-3">
                        <div className="flex items-center gap-2">
                          <Avatar name={member.name} size="sm" />
                          <span className="font-medium text-text-primary group-hover:text-primary">{member.name}</span>
                          <ChevronRight size={14} className="text-text-tertiary opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      </td>
                      <td className="text-center py-2 px-2 font-semibold">{member.total}</td>
                      <td className="text-center py-2 px-2"><span className="text-success font-semibold">{member.done}</span></td>
                      <td className="text-center py-2 px-2"><span className="text-warning font-semibold">{member.working}</span></td>
                      <td className="text-center py-2 px-2"><span className={member.stuck > 0 ? 'text-danger font-semibold' : 'text-text-tertiary'}>{member.stuck}</span></td>
                      <td className="text-center py-2 px-2"><span className={member.overdue > 0 ? 'text-danger font-semibold' : 'text-text-tertiary'}>{member.overdue}</span></td>
                      <td className="py-2 px-3 w-[140px]">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                            <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: pct === 100 ? '#00c875' : '#0073ea' }} />
                          </div>
                          <span className="text-xs text-text-tertiary w-8 text-right">{pct}%</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Board Summary (global view only) */}
      {boards && boards.length > 0 && (
        <div className="widget-card mb-6">
          <h3 className="text-sm font-semibold mb-4">Boards Overview</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {boards.map(b => {
              const pct = b.totalTasks > 0 ? Math.round((b.doneTasks / b.totalTasks) * 100) : 0;
              return (
                <div key={b.id} onClick={() => navigate(`/boards/${b.id}/dashboard`)} className="flex items-center gap-3 p-3 rounded-lg border border-border hover:border-primary/30 cursor-pointer transition-colors">
                  <div className="w-3 h-10 rounded-sm flex-shrink-0" style={{ backgroundColor: b.color || '#0073ea' }} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text-primary truncate">{b.name}</p>
                    <p className="text-xs text-text-tertiary">{b.doneTasks}/{b.totalTasks} tasks done</p>
                  </div>
                  <div className="text-right">
                    <span className="text-lg font-bold" style={{ color: pct === 100 ? '#00c875' : '#0073ea' }}>{pct}%</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Bottom row: Activity + Work Logs */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recent Activity */}
        <div className="widget-card">
          <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
            <Activity size={15} /> Recent Activity
          </h3>
          {recentActivity.length > 0 ? (
            <div className="space-y-3 max-h-[400px] overflow-y-auto">
              {recentActivity.map(act => {
                const actorName = act.actor?.name || 'Someone';
                return (
                  <div key={act.id} className="flex items-start gap-2.5">
                    <Avatar name={actorName} size="sm" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-text-primary">{act.description}</p>
                      <span className="text-xs text-text-tertiary">
                        {act.createdAt ? formatDistanceToNow(parseISO(act.createdAt), { addSuffix: true }) : ''}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-text-secondary text-center py-8">No activity yet</p>
          )}
        </div>

        {/* Recent Work Logs */}
        <div className="widget-card">
          <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
            <FileText size={15} /> Recent Daily Updates
          </h3>
          {recentWorklogs.length > 0 ? (
            <div className="space-y-3 max-h-[400px] overflow-y-auto">
              {recentWorklogs.map(log => {
                const authorName = log.author?.name || 'Someone';
                return (
                  <div key={log.id} className="flex gap-2.5 p-2.5 rounded-lg bg-surface/30 border border-border/50">
                    <Avatar name={authorName} size="sm" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-sm font-medium text-text-primary">{authorName}</span>
                        <span className="text-xs text-text-tertiary">
                          {log.date ? (() => {
                            const today = new Date().toISOString().slice(0, 10);
                            const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
                            if (log.date === today) return 'Today';
                            if (log.date === yesterday) return 'Yesterday';
                            try { return format(parseISO(log.date), 'MMM d'); } catch { return log.date; }
                          })() : ''}
                        </span>
                      </div>
                      {log.task && (
                        <p className="text-xs text-primary mb-0.5 truncate">on: {log.task.title}</p>
                      )}
                      <p className="text-sm text-text-secondary line-clamp-2">{log.content}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-text-secondary text-center py-8">No updates yet</p>
          )}
        </div>
      </div>

      {/* Completion Trend + Workload */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Weekly Completion Trend */}
        {trendData.length > 0 && (
          <div className="widget-card">
            <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
              <CheckCircle2 size={15} className="text-success" /> Completion Trend (14 days)
            </h3>
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={trendData}>
                <defs>
                  <linearGradient id="completionGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#00c875" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#00c875" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e6e9ef" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={v => { try { return format(parseISO(v), 'MMM d'); } catch { return v; } }} />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} labelFormatter={v => { try { return format(parseISO(v), 'EEE, MMM d'); } catch { return v; } }} />
                <Area type="monotone" dataKey="count" stroke="#00c875" fill="url(#completionGrad)" strokeWidth={2} name="Tasks Completed" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Team Workload */}
        {workloadData.length > 0 && (
          <div className="widget-card">
            <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
              <Users size={15} className="text-primary" /> Team Workload
            </h3>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={workloadData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#e6e9ef" />
                <XAxis type="number" tick={{ fontSize: 10 }} allowDecimals={false} />
                <YAxis dataKey="name" type="category" tick={{ fontSize: 10 }} width={80} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                <Bar dataKey="active" fill="#0073ea" name="Active" stackId="stack" radius={[0, 0, 0, 0]} />
                <Bar dataKey="done" fill="#00c875" name="Done" stackId="stack" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Overdue Tasks Widget */}
      {overdueTasks.length > 0 && (
        <div className="widget-card">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <AlertTriangle size={15} className="text-danger" /> Overdue Tasks
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-danger text-white">{overdueTasks.length}</span>
          </h3>
          <div className="space-y-1.5">
            {overdueTasks.map(task => (
              <div key={task.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-danger/5 border border-danger/10 hover:bg-danger/10 transition-colors cursor-pointer"
                onClick={() => task.boardId && navigate(`/boards/${task.boardId}`)}>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary truncate">{task.title}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    {task.board && <span className="text-[10px] text-text-tertiary">{task.board.name}</span>}
                    <span className="text-[10px] text-danger font-semibold">{task.daysOverdue} day{task.daysOverdue !== 1 ? 's' : ''} overdue</span>
                  </div>
                </div>
                {task.assignee && (
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <Avatar name={task.assignee.name} size="xs" />
                    <span className="text-[10px] text-text-secondary">{task.assignee.name.split(' ')[0]}</span>
                  </div>
                )}
                <span className="text-[10px] text-danger font-medium">Due {task.dueDate}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Member Drill-Down Panel */}
      {selectedMember && (
        <MemberDrillDown
          userId={selectedMember}
          boardId={boardId}
          onClose={() => setSelectedMember(null)}
        />
      )}
    </motion.div>
  );
}
