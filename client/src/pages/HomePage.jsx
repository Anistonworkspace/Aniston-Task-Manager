import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, useMotionValue, useTransform, animate } from 'framer-motion';
import {
  Clock, ArrowRight, FolderKanban, BarChart3, Bell, Plus, ListTodo,
  CheckCircle2, AlertCircle, CircleDot, Zap, AlertTriangle, TrendingUp,
  Users, Target, Calendar, ArrowUpRight, ArrowDownRight, Flame, Eye
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { STATUS_CONFIG, PRIORITY_CONFIG } from '../utils/constants';
import api from '../services/api';
import useSocket from '../hooks/useSocket';
import { staggerContainer, staggerItem, fadeInUp, hoverLift, pressable } from '../utils/animations';
import { useToast } from '../components/common/Toast';
import { sortTasksByPendingPriority } from '../utils/taskPrioritization';

// Animated number that counts up from 0
function AnimatedNumber({ value }) {
  const mv = useMotionValue(0);
  const display = useTransform(mv, v => Math.round(v));
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    const num = typeof value === 'string' ? parseInt(value) || 0 : value || 0;
    const ctrl = animate(mv, num, { duration: 0.8, ease: [0.16, 1, 0.3, 1] });
    const unsub = display.on('change', v => setCurrent(v));
    return () => { ctrl.stop(); unsub(); };
  }, [value, mv, display]);

  if (typeof value === 'string' && value.includes('%')) return <>{current}%</>;
  return <>{current}</>;
}

function MetricCard({ label, value, icon: Icon, color, trend, trendUp, subtitle, delay = 0 }) {
  return (
    <motion.div
      className="metric-card group"
      variants={staggerItem}
      {...hoverLift}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-text-tertiary mb-1">{label}</p>
          <p className="text-2xl font-bold text-text-primary">
            <AnimatedNumber value={value} />
          </p>
          {subtitle && <p className="text-[11px] text-text-tertiary mt-0.5">{subtitle}</p>}
          {trend !== undefined && (
            <div className={`flex items-center gap-0.5 mt-1.5 text-[11px] font-medium ${trendUp ? 'text-emerald-600' : 'text-red-500'}`}>
              {trendUp ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
              {trend}% vs last week
            </div>
          )}
        </div>
        <div className="w-10 h-10 rounded-xl flex items-center justify-center transition-transform group-hover:scale-110"
          style={{ backgroundColor: `${color}12` }}>
          <Icon size={19} style={{ color }} strokeWidth={1.8} />
        </div>
      </div>
    </motion.div>
  );
}

export default function HomePage() {
  const { user, isMember, canManage, isAdmin } = useAuth();
  const navigate = useNavigate();
  const { error: toastError } = useToast();
  const [boards, setBoards] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [myTasks, setMyTasks] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([loadBoards(), loadNotifications(), loadMyTasks(), canManage && loadStats()]).finally(() => setLoading(false));
  }, []);

  useSocket('task:created', () => loadMyTasks());
  useSocket('task:updated', () => loadMyTasks());
  useSocket('task:delegated', () => loadMyTasks());
  useSocket('notification:new', () => loadNotifications());
  useSocket('board:created', () => loadBoards());
  useSocket('board:updated', () => loadBoards());

  async function loadBoards() {
    try { const res = await api.get('/boards'); setBoards((res.data.boards || res.data || []).slice(0, 6)); } catch (err) { toastError('Failed to load boards'); }
  }
  async function loadNotifications() {
    try { const res = await api.get('/notifications'); setNotifications((res.data.notifications || res.data || []).slice(0, 5)); } catch (err) { toastError('Failed to load notifications'); }
  }
  async function loadMyTasks() {
    try {
      const res = await api.get('/tasks?assignedTo=me&limit=20');
      let tasks = res.data.tasks || res.data || [];
      tasks = sortTasksByPendingPriority(tasks);
      setMyTasks(tasks.slice(0, 10));
    } catch (err) { toastError('Failed to load tasks'); }
  }
  async function loadStats() {
    try { const res = await api.get('/dashboard/stats'); setStats(res.data); } catch (err) { toastError('Failed to load dashboard stats'); }
  }

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  })();

  const overdueTasks = myTasks.filter(t => t.dueDate && new Date(t.dueDate) < new Date() && t.status !== 'done');
  const pendingTasks = myTasks.filter(t => t.status !== 'done');
  const todayTasks = myTasks.filter(t => {
    if (!t.dueDate) return false;
    const d = new Date(t.dueDate);
    const today = new Date();
    return d.toDateString() === today.toDateString();
  });

  if (loading) {
    return (
      <div className="p-8 max-w-[1280px] mx-auto space-y-6">
        <div className="skeleton h-12 w-64 mb-2" />
        <div className="skeleton h-5 w-96 mb-8" />
        <div className="grid grid-cols-4 gap-4">
          {[1,2,3,4].map(i => <div key={i} className="skeleton h-28 rounded-xl" />)}
        </div>
        <div className="skeleton h-64 rounded-xl mt-6" />
      </div>
    );
  }

  return (
    <div className="p-8 max-w-[1280px] mx-auto">
      {/* Greeting */}
      <motion.div className="mb-8" {...fadeInUp}>
        <h1 className="text-2xl font-bold text-text-primary mb-1">
          {greeting}, {user?.name?.split(' ')[0]} 👋
        </h1>
        <p className="text-sm text-text-secondary">
          {overdueTasks.length > 0
            ? `You have ${overdueTasks.length} overdue task${overdueTasks.length > 1 ? 's' : ''} that need attention`
            : todayTasks.length > 0
              ? `${todayTasks.length} task${todayTasks.length > 1 ? 's' : ''} due today`
              : pendingTasks.length > 0
                ? `${pendingTasks.length} task${pendingTasks.length > 1 ? 's' : ''} in progress`
                : "You're all caught up! Great work."
          }
        </p>
      </motion.div>

      {/* Metric Cards */}
      <motion.div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8"
        variants={staggerContainer} initial="initial" animate="animate">
        <MetricCard label="Total Tasks" value={myTasks.length} icon={ListTodo} color="#4f46e5" subtitle={`${pendingTasks.length} active`} />
        <MetricCard label="Completed" value={myTasks.filter(t => t.status === 'done').length} icon={CheckCircle2} color="#10b981" subtitle="This period" />
        <MetricCard label="Overdue" value={overdueTasks.length} icon={AlertTriangle} color="#ef4444" subtitle={overdueTasks.length > 0 ? 'Needs attention' : 'All on track'} />
        <MetricCard label="Due Today" value={todayTasks.length} icon={Target} color="#f59e0b" subtitle={todayTasks.length > 0 ? 'Focus on these' : 'No deadlines today'} />
      </motion.div>

      {/* Manager/Admin: Team Overview Metrics */}
      {canManage && stats && (
        <motion.div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8"
          variants={staggerContainer} initial="initial" animate="animate">
          <MetricCard label="Team Tasks" value={stats.totalTasks || 0} icon={Users} color="#8b5cf6" />
          <MetricCard label="In Progress" value={stats.statusBreakdown?.working_on_it || stats.statusBreakdown?.in_progress || 0} icon={TrendingUp} color="#3b82f6" />
          <MetricCard label="Stuck / Blocked" value={stats.statusBreakdown?.stuck || 0} icon={Flame} color="#ef4444" />
          <MetricCard label="Completion Rate" value={`${stats.completionRate || 0}%`} icon={BarChart3} color="#10b981" trend={stats.completionRate > 50 ? 12 : -5} trendUp={stats.completionRate > 50} />
        </motion.div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* My Tasks — Takes 2 columns */}
        <motion.div className="lg:col-span-2" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15, duration: 0.35, ease: [0.16, 1, 0.3, 1] }}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-md font-semibold text-text-primary flex items-center gap-2">
              <ListTodo size={16} strokeWidth={1.8} /> My Tasks
              {overdueTasks.length > 0 && <span className="badge badge-danger">{overdueTasks.length} overdue</span>}
            </h2>
            <motion.button onClick={() => navigate('/my-work')} className="text-xs text-primary-500 hover:text-primary-600 font-medium flex items-center gap-1" {...pressable}>
              View all <ArrowRight size={12} />
            </motion.button>
          </div>

          {myTasks.length === 0 ? (
            <motion.div className="widget-card text-center py-12" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.2 }}>
              <CheckCircle2 size={32} className="text-text-muted mx-auto mb-3" />
              <p className="text-sm text-text-secondary mb-1">No tasks assigned</p>
              <p className="text-xs text-text-tertiary">Tasks will appear here when assigned to you</p>
            </motion.div>
          ) : (
            <div className="widget-card p-0 overflow-hidden">
              {myTasks.map((task, idx) => {
                const statusConf = STATUS_CONFIG[task.status] || {};
                const priorityConf = PRIORITY_CONFIG[task.priority] || {};
                const isOverdue = task.dueDate && new Date(task.dueDate) < new Date() && task.status !== 'done';
                return (
                  <motion.div key={task.id}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.05 * idx, duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                    onClick={() => task.boardId && navigate(`/boards/${task.boardId}`)}
                    className={`flex items-center gap-3 px-4 py-3 border-b border-border/50 last:border-b-0 hover:bg-surface-50 cursor-pointer transition-colors ${task.status === 'done' ? 'opacity-50' : ''}`}>
                    <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: statusConf.color || '#94a3b8' }} />
                    <span className={`text-sm flex-1 truncate ${task.status === 'done' ? 'line-through text-text-tertiary' : 'text-text-primary'}`}>
                      {task.title}
                    </span>
                    <span className="text-[10px] font-medium px-2 py-0.5 rounded-md hidden sm:inline"
                      style={{ backgroundColor: `${priorityConf.color || '#94a3b8'}15`, color: priorityConf.color || '#666' }}>
                      {priorityConf.label || task.priority}
                    </span>
                    {task.dueDate && (
                      <span className={`text-[11px] flex-shrink-0 ${isOverdue ? 'text-danger font-semibold' : 'text-text-tertiary'}`}>
                        {isOverdue && '⚠ '}
                        {new Date(task.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </span>
                    )}
                  </motion.div>
                );
              })}
            </div>
          )}
        </motion.div>

        {/* Right column: Recent + Notifications */}
        <motion.div className="space-y-6" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.35, ease: [0.16, 1, 0.3, 1] }}>
          {/* Recent Boards */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-md font-semibold text-text-primary flex items-center gap-2">
                <Clock size={15} strokeWidth={1.8} /> Recent
              </h2>
              <button onClick={() => navigate('/boards')} className="text-xs text-primary-500 hover:text-primary-600 font-medium">All boards</button>
            </div>
            <motion.div className="space-y-2" variants={staggerContainer} initial="initial" animate="animate">
              {boards.slice(0, 4).map(board => (
                <motion.button key={board.id} onClick={() => navigate(`/boards/${board.id}`)}
                  variants={staggerItem}
                  whileHover={{ y: -1, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}
                  whileTap={{ scale: 0.99 }}
                  className="w-full flex items-center gap-3 p-3 bg-white rounded-xl border border-border hover:border-primary-200 transition-all text-left group">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ backgroundColor: `${board.color || '#4f46e5'}15` }}>
                    <FolderKanban size={14} style={{ color: board.color || '#4f46e5' }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text-primary group-hover:text-primary-600 transition-colors truncate">{board.name}</p>
                    <p className="text-[10px] text-text-tertiary">Workspace</p>
                  </div>
                  <ArrowRight size={14} className="text-text-muted opacity-0 group-hover:opacity-100 transition-opacity" />
                </motion.button>
              ))}
              {boards.length === 0 && (
                <div className="text-center py-6 text-text-tertiary text-xs">
                  <FolderKanban size={20} className="mx-auto mb-2 opacity-40" />
                  No boards yet
                </div>
              )}
            </motion.div>
          </div>

          {/* Notifications */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-md font-semibold text-text-primary flex items-center gap-2">
                <Bell size={15} strokeWidth={1.8} /> Updates
                {notifications.filter(n => !n.isRead).length > 0 && (
                  <motion.span className="badge badge-danger" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 400, damping: 15 }}>
                    {notifications.filter(n => !n.isRead).length}
                  </motion.span>
                )}
              </h2>
            </div>
            {notifications.length === 0 ? (
              <div className="text-center py-6 text-text-tertiary text-xs">
                <Bell size={20} className="mx-auto mb-2 opacity-40" />
                No updates
              </div>
            ) : (
              <motion.div className="space-y-1" variants={staggerContainer} initial="initial" animate="animate">
                {notifications.map(n => (
                  <motion.div key={n.id} variants={staggerItem}
                    className={`flex items-start gap-2.5 px-3 py-2.5 rounded-lg transition-colors cursor-pointer ${!n.isRead ? 'bg-primary-50/50 hover:bg-primary-50' : 'hover:bg-surface-100'}`}>
                    <div className={`w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0 ${!n.isRead ? 'bg-primary-500' : 'bg-transparent'}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-text-primary line-clamp-2">{n.message}</p>
                      <p className="text-[10px] text-text-muted mt-0.5">{n.createdAt ? new Date(n.createdAt).toLocaleDateString() : ''}</p>
                    </div>
                  </motion.div>
                ))}
              </motion.div>
            )}
          </div>
        </motion.div>
      </div>
    </div>
  );
}
