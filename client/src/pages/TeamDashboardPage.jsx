import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Users, BarChart3, AlertTriangle, Clock, CheckCircle2, TrendingUp,
  Shield, Bell, Megaphone, Eye, Target, Zap, ChevronRight, RefreshCw,
  ArrowUpRight, ArrowDownRight, Flame, Calendar, PieChart as PieIcon,
  LayoutGrid, ListChecks, UserCheck, AlertCircle, Star
} from 'lucide-react';
import {
  PieChart, Pie, Cell, ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  Tooltip, CartesianGrid, AreaChart, Area, Legend
} from 'recharts';

const COLORS = ['#0073ea', '#00c875', '#fdab3d', '#e2445c', '#a25ddc', '#579bfc'];
const STATUS_COLORS = { not_started: '#c4c4c4', working_on_it: '#fdab3d', stuck: '#e2445c', done: '#00c875' };
const PRIORITY_COLORS = { low: '#579bfc', medium: '#fdab3d', high: '#e2445c', critical: '#333' };

const fadeIn = { initial: { opacity: 0, y: 20 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.4 } };

function Widget({ title, icon: Icon, children, className = '', action }) {
  return (
    <motion.div {...fadeIn} className={`bg-white dark:bg-zinc-800 rounded-xl border border-gray-200 dark:border-zinc-700 shadow-sm overflow-hidden ${className}`}>
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 dark:border-zinc-700">
        <div className="flex items-center gap-2">
          {Icon && <Icon size={16} className="text-primary" />}
          <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">{title}</h3>
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </motion.div>
  );
}

function StatCard({ label, value, icon: Icon, color, trend, trendUp }) {
  return (
    <motion.div {...fadeIn} className="bg-white dark:bg-zinc-800 rounded-xl border border-gray-200 dark:border-zinc-700 p-4 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">{label}</p>
          <p className="text-2xl font-bold text-gray-800 dark:text-gray-100">{value}</p>
          {trend !== undefined && (
            <div className={`flex items-center gap-1 mt-1 text-xs ${trendUp ? 'text-green-600' : 'text-red-500'}`}>
              {trendUp ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
              <span>{trend}%</span>
            </div>
          )}
        </div>
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center`} style={{ backgroundColor: `${color}15` }}>
          <Icon size={20} style={{ color }} />
        </div>
      </div>
    </motion.div>
  );
}

export default function TeamDashboardPage() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('team'); // team | my
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = async () => {
    try {
      const res = await api.get('/dashboard/enterprise');
      setData(res.data);
    } catch (err) {
      console.error('Enterprise dashboard error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const handleRefresh = () => { setRefreshing(true); fetchData(); };

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        {[1,2,3].map(i => (
          <div key={i} className="animate-pulse bg-gray-100 dark:bg-zinc-800 rounded-xl h-32" />
        ))}
      </div>
    );
  }

  if (!data) return <div className="p-6 text-center text-gray-500">Failed to load dashboard.</div>;

  const { summary, statusCounts, priorityCounts, memberGrid, heatmapData, slaStats, escalatedTasks, riskTasks, workspaces, announcements } = data;

  const statusData = Object.entries(statusCounts || {}).map(([name, value]) => ({ name: name.replace(/_/g, ' '), value }));
  const priorityData = Object.entries(priorityCounts || {}).map(([name, value]) => ({ name, value }));

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      {/* Header */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2">
            <LayoutGrid size={24} className="text-primary" />
            Enterprise Dashboard
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Team performance, approvals & workspace overview</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex bg-gray-100 dark:bg-zinc-700 rounded-lg p-0.5">
            <button onClick={() => setActiveTab('team')} className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${activeTab === 'team' ? 'bg-white dark:bg-zinc-600 text-primary shadow-sm' : 'text-gray-500'}`}>
              <Users size={12} className="inline mr-1" /> Team Tasks
            </button>
            <button onClick={() => setActiveTab('my')} className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${activeTab === 'my' ? 'bg-white dark:bg-zinc-600 text-primary shadow-sm' : 'text-gray-500'}`}>
              <UserCheck size={12} className="inline mr-1" /> My Tasks
            </button>
          </div>
          <button onClick={handleRefresh} className={`p-2 rounded-lg border border-gray-200 dark:border-zinc-600 hover:bg-gray-50 dark:hover:bg-zinc-700 transition-colors ${refreshing ? 'animate-spin' : ''}`}>
            <RefreshCw size={16} className="text-gray-500" />
          </button>
        </div>
      </motion.div>

      {/* Stat Cards Row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
        <StatCard label="Total Tasks" value={summary.totalTasks} icon={ListChecks} color="#0073ea" />
        <StatCard label="Completed" value={summary.done} icon={CheckCircle2} color="#00c875" trend={summary.completionRate} trendUp={summary.completionRate > 50} />
        <StatCard label="In Progress" value={summary.working} icon={TrendingUp} color="#fdab3d" />
        <StatCard label="Stuck" value={summary.stuck} icon={AlertTriangle} color="#e2445c" />
        <StatCard label="Overdue" value={summary.overdue} icon={Clock} color="#e2445c" />
        <StatCard label="Pending Approval" value={summary.pendingApprovals} icon={Shield} color="#a25ddc" />
      </div>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        {/* Priority Distribution */}
        <Widget title="Priority Distribution" icon={PieIcon}>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={priorityData} cx="50%" cy="50%" innerRadius={40} outerRadius={70} dataKey="value" paddingAngle={3}>
                  {priorityData.map((_, i) => <Cell key={i} fill={Object.values(PRIORITY_COLORS)[i] || COLORS[i]} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="flex flex-wrap gap-3 mt-2 justify-center">
            {priorityData.map((d, i) => (
              <div key={d.name} className="flex items-center gap-1.5 text-xs">
                <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: Object.values(PRIORITY_COLORS)[i] || COLORS[i] }} />
                <span className="text-gray-600 dark:text-gray-400 capitalize">{d.name}</span>
                <span className="font-semibold text-gray-800 dark:text-gray-200">{d.value}</span>
              </div>
            ))}
          </div>
        </Widget>

        {/* Status Breakdown */}
        <Widget title="Status Breakdown" icon={BarChart3}>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={statusData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={80} />
                <Tooltip />
                <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                  {statusData.map((entry, i) => (
                    <Cell key={i} fill={STATUS_COLORS[entry.name.replace(/ /g, '_')] || COLORS[i]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Widget>

        {/* Productivity Summary */}
        <Widget title="Productivity Summary" icon={Target}>
          <div className="space-y-4">
            <div className="text-center">
              <div className="relative inline-flex items-center justify-center">
                <svg className="w-24 h-24 -rotate-90">
                  <circle cx="48" cy="48" r="38" fill="none" stroke="#e5e7eb" strokeWidth="8" />
                  <circle cx="48" cy="48" r="38" fill="none" stroke="#00c875" strokeWidth="8"
                    strokeDasharray={`${summary.completionRate * 2.39} 239`} strokeLinecap="round" />
                </svg>
                <span className="absolute text-xl font-bold text-gray-800 dark:text-gray-100">{summary.completionRate}%</span>
              </div>
              <p className="text-xs text-gray-500 mt-1">Completion Rate</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-gray-50 dark:bg-zinc-700 rounded-lg p-3 text-center">
                <p className="text-lg font-bold text-gray-800 dark:text-gray-100">{summary.avgCompletionDays}</p>
                <p className="text-[10px] text-gray-500">Avg Days to Complete</p>
              </div>
              <div className="bg-gray-50 dark:bg-zinc-700 rounded-lg p-3 text-center">
                <p className="text-lg font-bold text-gray-800 dark:text-gray-100">{summary.pendingAccessRequests}</p>
                <p className="text-[10px] text-gray-500">Access Requests</p>
              </div>
            </div>
          </div>
        </Widget>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* SLA / Deadline Breach Indicator */}
        <Widget title="SLA & Deadline Monitor" icon={AlertCircle}>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-3 text-center">
              <p className="text-xl font-bold text-red-600">{slaStats.totalOverdue}</p>
              <p className="text-[10px] text-red-500">Overdue</p>
            </div>
            <div className="bg-yellow-50 dark:bg-yellow-900/20 rounded-lg p-3 text-center">
              <p className="text-xl font-bold text-yellow-600">{slaStats.dueSoon}</p>
              <p className="text-[10px] text-yellow-600">Due Soon (3 days)</p>
            </div>
            <div className="bg-gray-50 dark:bg-zinc-700 rounded-lg p-3 text-center">
              <p className="text-xl font-bold text-gray-800 dark:text-gray-100">{slaStats.breachRate}%</p>
              <p className="text-[10px] text-gray-500">Breach Rate</p>
            </div>
          </div>
          {slaStats.overdueTasks?.length > 0 && (
            <div className="space-y-2 max-h-40 overflow-y-auto">
              {slaStats.overdueTasks.map(t => (
                <div key={t.id} className="flex items-center justify-between bg-red-50/50 dark:bg-red-900/10 rounded-lg px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">{t.title}</p>
                    <p className="text-[10px] text-gray-500">{t.board?.name} · {t.assignee?.name || 'Unassigned'}</p>
                  </div>
                  <span className="text-xs font-bold text-red-600 ml-2 whitespace-nowrap">{t.daysOverdue}d late</span>
                </div>
              ))}
            </div>
          )}
        </Widget>

        {/* Workload Heatmap */}
        <Widget title="Team Workload Heatmap" icon={Flame}>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className="text-left py-1.5 px-2 text-gray-500 font-medium">Member</th>
                  {['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map(d => (
                    <th key={d} className="text-center py-1.5 px-2 text-gray-500 font-medium">{d}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(heatmapData || []).slice(0, 8).map(row => (
                  <tr key={row.userId} className="border-t border-gray-50 dark:border-zinc-700">
                    <td className="py-1.5 px-2 text-gray-700 dark:text-gray-300 font-medium truncate max-w-[120px]">{row.name}</td>
                    {['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map(d => {
                      const val = row.days?.[d] || 0;
                      const intensity = Math.min(val / 5, 1);
                      const bg = val === 0 ? '#f3f4f6' : `rgba(0, 115, 234, ${0.15 + intensity * 0.6})`;
                      return (
                        <td key={d} className="text-center py-1.5 px-2">
                          <div className="w-8 h-8 rounded-md flex items-center justify-center mx-auto text-xs font-medium"
                            style={{ backgroundColor: bg, color: val > 2 ? '#fff' : '#333' }}>
                            {val}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Widget>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        {/* Team Members Grid */}
        <Widget title="Team Members" icon={Users} className="lg:col-span-2">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 max-h-72 overflow-y-auto">
            {(memberGrid || []).filter(m => activeTab === 'my' ? m.id === user?.id : true).map(m => (
              <motion.div key={m.id} whileHover={{ scale: 1.02 }} className="bg-gray-50 dark:bg-zinc-700 rounded-lg p-3 text-center">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-2 text-sm font-bold text-primary">
                  {m.avatar ? <img src={m.avatar} alt="" className="w-10 h-10 rounded-full object-cover" /> : m.name?.charAt(0)}
                </div>
                <p className="text-xs font-semibold text-gray-800 dark:text-gray-200 truncate">{m.name}</p>
                <p className="text-[10px] text-gray-500 capitalize">{m.role}</p>
                <div className="flex justify-center gap-2 mt-2 text-[10px]">
                  <span className="text-green-600 font-medium">{m.doneTasks}✓</span>
                  <span className="text-yellow-600 font-medium">{m.workingTasks}⟳</span>
                  <span className="text-red-500 font-medium">{m.overdueTasks}!</span>
                </div>
                <div className="w-full bg-gray-200 dark:bg-zinc-600 rounded-full h-1.5 mt-2">
                  <div className="bg-green-500 h-1.5 rounded-full transition-all" style={{ width: `${m.totalTasks > 0 ? (m.doneTasks / m.totalTasks) * 100 : 0}%` }} />
                </div>
              </motion.div>
            ))}
          </div>
        </Widget>

        {/* Announcements Panel */}
        <Widget title="Team Announcements" icon={Megaphone}
          action={
            <button className="text-[10px] text-primary hover:underline">View All</button>
          }>
          {announcements?.length > 0 ? (
            <div className="space-y-3 max-h-60 overflow-y-auto">
              {announcements.map(a => (
                <div key={a.id} className={`rounded-lg p-3 border-l-3 ${
                  a.type === 'urgent' ? 'bg-red-50 dark:bg-red-900/10 border-red-500' :
                  a.type === 'warning' ? 'bg-yellow-50 dark:bg-yellow-900/10 border-yellow-500' :
                  a.type === 'success' ? 'bg-green-50 dark:bg-green-900/10 border-green-500' :
                  'bg-blue-50 dark:bg-blue-900/10 border-blue-500'
                }`}>
                  <div className="flex items-center gap-1.5 mb-1">
                    {a.isPinned && <Star size={10} className="text-yellow-500 fill-yellow-500" />}
                    <p className="text-xs font-semibold text-gray-800 dark:text-gray-200">{a.title}</p>
                  </div>
                  <p className="text-[11px] text-gray-600 dark:text-gray-400 line-clamp-2">{a.content}</p>
                  <p className="text-[9px] text-gray-400 mt-1">{a.author?.name} · {new Date(a.createdAt).toLocaleDateString()}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-gray-400 text-xs">
              <Megaphone size={24} className="mx-auto mb-2 opacity-40" />
              No announcements yet
            </div>
          )}
        </Widget>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Pending Approvals */}
        <Widget title="Pending Approvals" icon={Shield}>
          {summary.pendingApprovals > 0 ? (
            <div className="space-y-2">
              <div className="bg-purple-50 dark:bg-purple-900/10 rounded-lg p-4 text-center">
                <p className="text-3xl font-bold text-purple-600">{summary.pendingApprovals}</p>
                <p className="text-xs text-purple-500 mt-1">Tasks awaiting approval</p>
              </div>
              <a href="/reviews" className="flex items-center justify-center gap-1 text-xs text-primary hover:underline mt-2">
                Review Approvals <ChevronRight size={12} />
              </a>
            </div>
          ) : (
            <div className="text-center py-6 text-gray-400 text-xs">
              <CheckCircle2 size={24} className="mx-auto mb-2 opacity-40" />
              All caught up! No pending approvals.
            </div>
          )}
        </Widget>

        {/* Risk / Escalated Tasks */}
        <Widget title="Risk & Escalated Tasks" icon={Zap}>
          {(riskTasks || []).length > 0 || (escalatedTasks || []).length > 0 ? (
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {(riskTasks || []).map(t => (
                <div key={t.id} className={`flex items-center gap-3 rounded-lg px-3 py-2 ${
                  t.risk === 'critical' ? 'bg-red-50 dark:bg-red-900/10' : 'bg-yellow-50 dark:bg-yellow-900/10'
                }`}>
                  <Flame size={14} className={t.risk === 'critical' ? 'text-red-500' : 'text-yellow-500'} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">{t.title}</p>
                    <p className="text-[10px] text-gray-500">{t.assignee?.name || 'Unassigned'} · Due {t.dueDate}</p>
                  </div>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                    t.risk === 'critical' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'
                  }`}>{t.risk}</span>
                </div>
              ))}
              {(escalatedTasks || []).map(t => (
                <div key={t.id} className="flex items-center gap-3 rounded-lg px-3 py-2 bg-orange-50 dark:bg-orange-900/10">
                  <AlertTriangle size={14} className="text-orange-500" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">{t.title}</p>
                    <p className="text-[10px] text-gray-500">{t.assignee?.name || 'Unassigned'}</p>
                  </div>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">escalated</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-6 text-gray-400 text-xs">
              <CheckCircle2 size={24} className="mx-auto mb-2 opacity-40" />
              No risk or escalated tasks
            </div>
          )}
        </Widget>
      </div>

      {/* Workspace Summary */}
      {workspaces?.length > 0 && (
        <Widget title="Workspaces Overview" icon={LayoutGrid} className="mb-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {workspaces.map(w => (
              <motion.div key={w.id} whileHover={{ scale: 1.03 }}
                className="rounded-lg p-4 border border-gray-100 dark:border-zinc-700 cursor-pointer hover:shadow-md transition-shadow">
                <div className="w-8 h-8 rounded-lg mb-2 flex items-center justify-center" style={{ backgroundColor: `${w.color}20` }}>
                  <LayoutGrid size={16} style={{ color: w.color }} />
                </div>
                <p className="text-sm font-semibold text-gray-800 dark:text-gray-200">{w.name}</p>
                <div className="flex gap-3 mt-1.5 text-[10px] text-gray-500">
                  <span>{w.boardCount} boards</span>
                  <span>{w.memberCount} members</span>
                </div>
              </motion.div>
            ))}
          </div>
        </Widget>
      )}
    </div>
  );
}
