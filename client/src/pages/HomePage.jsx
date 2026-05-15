import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Clock, ArrowRight, ArrowDownRight, ArrowUpRight, FolderKanban, Bell, BellOff,
  ListTodo, CheckCircle2, AlertTriangle, TrendingUp, Target,
  Flame, Info,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useT } from '../context/LanguageContext';
import { translatePriority } from '../utils/i18nLabels';
import { STATUS_CONFIG, PRIORITY_CONFIG } from '../utils/constants';
import api from '../services/api';
import useRealtimeQuery from '../realtime/useRealtimeQuery';
import { staggerContainer, fadeInUp, pressable } from '../utils/animations';
import { useToast } from '../components/common/Toast';
import { sortTasksByPendingPriority } from '../utils/taskPrioritization';
import { openTaskFromAnywhere } from '../utils/taskNavigation';
import StatTile, { CountUp } from '../components/home/StatTile';
import Sparkline from '../components/home/Sparkline';
import RingChart from '../components/home/RingChart';
import MiniBars from '../components/home/MiniBars';
import EmptyState from '../components/home/EmptyState';
import RecentBoardCard from '../components/home/RecentBoardCard';
import WaveHand from '../components/home/WaveHand';
import UpdatesModal from '../components/home/UpdatesModal';

// ── Tile primitives ────────────────────────────────────────────────────
function TileLabel({ children }) {
  return (
    <span className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
      {children}
    </span>
  );
}

// Static icon chip. The earlier `pulse` prop animated a dot for non-zero
// alert states; that motion was removed because the same information is
// already conveyed by the (red) numeric value, and the loop drew the eye
// every time the page was visible.
function TileIconChip({ icon: Icon, color }) {
  return (
    <span
      className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
      style={{ backgroundColor: `${color}14` }}
      aria-hidden="true"
    >
      <Icon size={16} style={{ color }} strokeWidth={1.9} />
    </span>
  );
}

// ── Page ───────────────────────────────────────────────────────────────
export default function HomePage() {
  const { user, canManage } = useAuth();
  const t = useT();
  const navigate = useNavigate();
  const { error: toastError } = useToast();
  const [boards, setBoards] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [myTasks, setMyTasks] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [updatesOpen, setUpdatesOpen] = useState(false);

  useEffect(() => {
    // loadStats is for ALL roles, not just managers. The endpoint applies
    // taskVisibility server-side, so a member's response only contains
    // their own tasks (memberStats[me] is the user's accurate per-status
    // counts, untruncated by /tasks limits). The `Completed = 0` bug came
    // from gating this call to canManage and then deriving counts from a
    // 20-row /tasks slice that drops Done tasks to the bottom.
    Promise.all([
      loadBoards(),
      loadNotifications(),
      loadMyTasks(),
      loadStats(),
    ]).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useRealtimeQuery({ queryKey: 'tasks.assignedTo.me', refetch: loadMyTasks });
  useRealtimeQuery({ queryKey: 'notifications.list', refetch: loadNotifications });
  useRealtimeQuery({ queryKey: 'boards.list', refetch: loadBoards });

  async function loadBoards() {
    try {
      const res = await api.get('/boards');
      setBoards((res.data.boards || res.data || []).slice(0, 6));
    } catch { toastError('Failed to load boards'); }
  }
  async function loadNotifications() {
    try {
      // Fetch up to 50 so the Updates modal has the full list to render. The
      // preview tile still only renders the first 3 — the rest are revealed
      // when the user opens the modal. Single source of truth, no double fetch.
      const res = await api.get('/notifications?limit=50');
      setNotifications(res.data.notifications || res.data || []);
    } catch { toastError('Failed to load notifications'); }
  }
  async function markNotificationRead(id) {
    // Local-first: flip the flag immediately so the badge/dot updates without
    // waiting for the server. The error swallow is intentional — realtime
    // will reconcile on the next event if the request fails.
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
    try { await api.put(`/notifications/${id}/read`); } catch { /* reconcile via realtime */ }
  }
  async function loadMyTasks() {
    try {
      const res = await api.get('/tasks?assignedTo=me&limit=20');
      let tasks = res.data.tasks || res.data || [];
      tasks = sortTasksByPendingPriority(tasks);
      setMyTasks(tasks.slice(0, 10));
    } catch { toastError('Failed to load tasks'); }
  }
  async function loadStats() {
    try { const res = await api.get('/dashboard/stats'); setStats(res.data); }
    catch { toastError('Failed to load dashboard stats'); }
  }

  // ── Derived metrics ──────────────────────────────────────────────────
  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  })();

  const unreadCount = notifications.filter(n => !n.isRead).length;

  // ── Stat-tile data sources (corrected) ──────────────────────────────
  // GET /dashboard/stats returns:
  //   summary.{totalTasks, done, working, stuck, notStarted, overdue}
  //   statusCounts.{not_started, working_on_it, stuck, done, ...}
  //   memberStats[]: per-user {id, total, done, working, stuck, overdue,
  //                            dueToday, dueThisWeek, ...}
  //
  // Personal-scoped tiles (Total/Completed/DueToday/Overdue/InProgress
  // for members) were previously derived from the /tasks?assignedTo=me
  // slice — which truncates at 20 with done-last ordering, dropping Done
  // counts entirely. memberStats[me] is computed from ALL the user's
  // visible tasks server-side, so it's the right source.
  //
  // Team-scoped tiles (managers only) read summary.* directly.
  const summary = stats?.summary;
  const statusCounts = stats?.statusCounts || {};
  const memberStats = Array.isArray(stats?.memberStats) ? stats.memberStats : [];
  const me = memberStats.find((m) => m.id === user?.id) || null;

  // myTasks is still used for the My Tasks list rendered on the page —
  // that list intentionally only shows the top 10 active items.
  const overdueTasks = myTasks.filter(
    t => t.dueDate && new Date(t.dueDate) < new Date() && t.status !== 'done'
  );
  const pendingTasks = myTasks.filter(t => t.status !== 'done');

  // ── Personal counts: server-truth (memberStats) with safe fallback ──
  const personalTotal = me ? me.total : pendingTasks.length;
  const personalDone = me ? me.done : myTasks.filter(t => t.status === 'done').length;
  const personalDueToday = me ? me.dueToday : myTasks.filter(t => {
    if (!t.dueDate) return false;
    const d = new Date(t.dueDate); const today = new Date();
    return d.toDateString() === today.toDateString();
  }).length;
  const personalOverdue = me ? me.overdue : overdueTasks.length;
  const personalInProgress = me ? me.working : myTasks.filter(
    t => t.status === 'working_on_it' || t.status === 'in_progress'
  ).length;
  const personalStuck = me ? me.stuck : myTasks.filter(t => t.status === 'stuck').length;
  const personalCompletionRate = personalTotal === 0
    ? 0
    : Math.round((personalDone / personalTotal) * 100);

  // ── Tile values: managers see team-scoped; members see personal ────
  // Due Today and Overdue stay personal for both roles — they're
  // "what should I focus on today" not team-management metrics.
  const totalCount = canManage && summary ? (summary.totalTasks || 0) : personalTotal;
  const completedCount = canManage && summary ? (summary.done || 0) : personalDone;
  const inProgressCount = canManage && stats
    ? (statusCounts.working_on_it || statusCounts.in_progress || summary?.working || 0)
    : personalInProgress;
  const stuckCount = canManage && stats
    ? (statusCounts.stuck || summary?.stuck || 0)
    : personalStuck;
  const dueTodayCount = personalDueToday;
  const overdueCount = personalOverdue;
  const activeCount = Math.max(0, totalCount - completedCount);

  const teamCompletionRate = (() => {
    if (!summary) return 0;
    // Forward-compat: handle the proposed { current, previous, delta } shape
    // documented in TODO_BACKEND.md without breaking the current numeric/derived path.
    if (typeof stats.completionRate === 'object' && stats.completionRate) {
      return stats.completionRate.current ?? 0;
    }
    if (typeof stats.completionRate === 'number') return stats.completionRate;
    const total = summary.totalTasks || 0;
    const done = summary.done || 0;
    return total > 0 ? Math.round((done / total) * 100) : 0;
  })();
  const completionRate = canManage ? teamCompletionRate : personalCompletionRate;

  // Week-over-week delta. Only render the trend chip when the backend
  // returns a real number — never fabricate one. The current endpoint does
  // not surface this; the chip stays hidden until /dashboard/stats ships
  // the proposed { current, previous, delta } shape.
  const completionDelta = canManage && stats && typeof stats.completionRate === 'object'
    ? (typeof stats.completionRate.delta === 'number' ? stats.completionRate.delta : null)
    : null;
  const showTrendChip = completionDelta !== null && completionDelta !== 0;
  const trendUp = (completionDelta ?? 0) > 0;

  const todayLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

  if (loading) {
    return (
      <div className="p-6 lg:p-8 max-w-[1440px] mx-auto space-y-4">
        <div className="skeleton h-24 w-full rounded-2xl" />
        <div className="grid grid-cols-12 gap-4">
          <div className="skeleton h-64 col-span-6 rounded-2xl" />
          <div className="skeleton h-32 col-span-3 rounded-2xl" />
          <div className="skeleton h-32 col-span-3 rounded-2xl" />
          <div className="skeleton h-32 col-span-3 rounded-2xl" />
          <div className="skeleton h-32 col-span-3 rounded-2xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-[1440px] mx-auto">
      <motion.div
        className="grid grid-cols-1 sm:grid-cols-6 lg:grid-cols-12 auto-rows-[minmax(0,auto)] gap-4"
        variants={staggerContainer}
        initial="initial"
        animate="animate"
      >
        {/* ─── Row 1: Compact greeting strip ─────────────────────────── */}
        <motion.section
          {...fadeInUp}
          className="col-span-1 sm:col-span-6 lg:col-span-12 relative overflow-hidden rounded-lg px-3.5 py-1.5 sm:px-4 sm:py-2"
          style={{
            background:
              'radial-gradient(ellipse at top right, rgba(0, 115, 234, 0.06), transparent 60%)',
          }}
        >
          <h1 className="font-neu-machina text-base sm:text-lg font-semibold text-text-primary flex items-center gap-2 leading-tight tracking-tight">
            {greeting}, {user?.name?.split(' ')[0]}{' '}
            <WaveHand />
          </h1>
        </motion.section>

        {/* ─── Row 2: Completion Rate hero (col-6, row-2) + 4 KPI ─────
            Hero shrunk per UX review: number 48px (was 64), ring 100px
            (was 132), padding tightened, footer sparkline removed.
            Still col-6 row-2 so the right-side 2x2 KPI grid stays balanced. */}
        {/* Completion Rate is intentionally NOT clickable — it's a summary
            metric, not a task-list shortcut. Drilling into "20% completion"
            doesn't have an obvious destination, and routing it somewhere
            would be more confusing than helpful. */}
        <StatTile
          hero
          className="col-span-1 sm:col-span-6 lg:col-span-6 lg:row-span-2 flex flex-col p-3 sm:p-4"
          ariaLabel={`Completion Rate: ${completionRate}%`}
        >
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-2">
              <TileLabel>
                {canManage ? 'Team Completion Rate' : 'Your Completion Rate'}
              </TileLabel>
              <Info size={11} className="text-text-tertiary" aria-hidden="true" />
            </div>
            {showTrendChip && (
              <span
                className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                  trendUp
                    ? 'bg-success-light text-success-dark dark:bg-success/15 dark:text-success'
                    : 'bg-danger-light text-danger-dark dark:bg-danger/15 dark:text-danger'
                }`}
              >
                {trendUp ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
                {trendUp ? '+' : ''}{completionDelta}% vs last week
              </span>
            )}
          </div>

          <div className="flex-1 flex items-center justify-between gap-4 mt-2">
            <div>
              <p className="text-4xl sm:text-5xl font-semibold tabular-nums text-text-primary leading-none">
                {completionRate}%
              </p>
              <p className="text-xs text-text-secondary mt-2">
                {canManage ? 'This period' : 'Across your tasks'}
                {totalCount > 0 && (
                  <span className="text-text-tertiary">
                    {' · '}{completedCount}/{totalCount} done
                  </span>
                )}
              </p>
            </div>
            <div className="hidden sm:flex items-center justify-center">
              <RingChart value={completionRate} size={100} strokeWidth={10} />
            </div>
          </div>
        </StatTile>

        {/* All clickable stat tiles route to /my-work?filter=<key>. RBAC is
            preserved because /my-work's data source (/tasks?assignedTo=me)
            is server-side scoped to the user's own assignments — the URL
            filter only narrows the view, never widens it. For managers the
            tile shows team counts but the click lands on their personal
            filtered view, which is the closest existing destination. */}
        <StatTile
          className="col-span-1 sm:col-span-3 lg:col-span-3 p-3 sm:p-4"
          onClick={() => navigate('/my-work?filter=done')}
          ariaLabel={`Completed tasks: ${completedCount}. Open list.`}
        >
          <div className="flex items-start justify-between mb-2">
            <TileLabel>Completed</TileLabel>
            <TileIconChip icon={CheckCircle2} color="#00854d" />
          </div>
          <p className="text-3xl font-semibold tabular-nums text-text-primary leading-none">
            {completedCount}
          </p>
          <p className="text-[11px] text-text-tertiary mt-1.5">
            {canManage ? 'This period' : 'Across your tasks'}
          </p>
        </StatTile>

        <StatTile
          className="col-span-1 sm:col-span-3 lg:col-span-3 p-3 sm:p-4"
          onClick={() => navigate('/my-work?filter=today')}
          ariaLabel={`Due today: ${dueTodayCount}. Open list.`}
        >
          <div className="flex items-start justify-between mb-2">
            <TileLabel>Due Today</TileLabel>
            <TileIconChip icon={Target} color="#eaaa15" />
          </div>
          <p className="text-3xl font-semibold tabular-nums text-text-primary leading-none">
            {dueTodayCount}
          </p>
          <div className="flex items-end justify-between mt-1.5">
            <p className="text-[11px] text-text-tertiary">
              {dueTodayCount > 0 ? 'Focus on these' : 'No deadlines today'}
            </p>
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border border-border text-text-secondary">
              {todayLabel}
            </span>
          </div>
        </StatTile>

        <StatTile
          danger={overdueCount > 0}
          className="col-span-1 sm:col-span-3 lg:col-span-3 p-3 sm:p-4"
          onClick={() => navigate('/my-work?filter=overdue')}
          ariaLabel={`Overdue tasks: ${overdueCount}. Open list.`}
        >
          <div className="flex items-start justify-between mb-2">
            <TileLabel>Overdue</TileLabel>
            <TileIconChip icon={AlertTriangle} color="#d83a52" />
          </div>
          <p
            className={`text-3xl font-semibold tabular-nums leading-none ${
              overdueCount > 0 ? 'text-danger dark:text-danger' : 'text-text-primary'
            }`}
          >
            {overdueCount}
          </p>
          <div className="flex items-center gap-1.5 mt-1.5">
            {overdueCount === 0 && (
              <span className="inline-block w-2 h-2 rounded-full bg-success" aria-hidden="true" />
            )}
            <p className="text-[11px] text-text-tertiary">
              {overdueCount > 0 ? 'Needs attention' : 'All on track'}
            </p>
          </div>
        </StatTile>

        <StatTile
          className="col-span-1 sm:col-span-3 lg:col-span-3 p-3 sm:p-4"
          onClick={() => navigate('/my-work?filter=in_progress')}
          ariaLabel={`In progress tasks: ${inProgressCount}. Open list.`}
        >
          <div className="flex items-start justify-between mb-2">
            <TileLabel>In Progress</TileLabel>
            <TileIconChip icon={TrendingUp} color="#0073ea" />
          </div>
          <p className="text-3xl font-semibold tabular-nums text-text-primary leading-none">
            {inProgressCount}
          </p>
          <p className="text-[11px] text-text-tertiary mt-1.5">
            {canManage ? 'Across your team' : 'Currently working'}
          </p>
        </StatTile>

        {/* ─── Row 3: Total Tasks + Stuck/Blocked + Updates (col-4 each)
            All three tiles share their CSS-grid row, so the row's height
            tracks the tallest sibling (Updates' empty state). Without
            distribution, content here would clump at the top with empty
            space below.

            Pattern: `flex flex-col` on the tile, `mt-auto` on the subtitle
            so it pins to the bottom while the value sits in the
            upper-middle band. Same visual rhythm Due Today / Overdue use
            via their bottom date-pill / status-dot. ─── */}
        <StatTile
          className="col-span-1 sm:col-span-3 lg:col-span-4 p-3 sm:p-4 flex flex-col"
          onClick={() => navigate('/my-work')}
          ariaLabel={`Total tasks: ${totalCount}. Open list.`}
        >
          <div className="flex items-start justify-between mb-2">
            <TileLabel>Total Tasks</TileLabel>
            <TileIconChip icon={ListTodo} color="#0073ea" />
          </div>
          <p className="text-3xl font-semibold tabular-nums text-text-primary leading-none">
            {totalCount}
          </p>
          <p className="text-[11px] text-text-tertiary mt-auto pt-2">
            {activeCount} active
            {canManage && totalCount > 0 ? ' · across your team' : ''}
          </p>
        </StatTile>

        <StatTile
          className="col-span-1 sm:col-span-3 lg:col-span-4 p-3 sm:p-4 flex flex-col"
          onClick={() => navigate('/my-work?filter=stuck')}
          ariaLabel={`Stuck or blocked tasks: ${stuckCount}. Open list.`}
        >
          <div className="flex items-start justify-between mb-2">
            <TileLabel>Stuck / Blocked</TileLabel>
            <TileIconChip icon={Flame} color="#d83a52" />
          </div>
          <p
            className={`text-3xl font-semibold tabular-nums leading-none ${
              stuckCount > 0 ? 'text-danger dark:text-danger' : 'text-text-primary'
            }`}
          >
            {stuckCount}
          </p>
          <p className="text-[11px] text-text-tertiary mt-auto pt-2">
            {stuckCount > 0 ? 'Unblock these' : 'Nothing blocked'}
          </p>
        </StatTile>

        {/* Updates tile — col-4 single-row at lg, full-width on mobile.
            Click anywhere on the tile (or the explicit "View all" link)
            opens the UpdatesModal. The previous onClick used to navigate
            to a non-existent /notifications route, which is why clicks
            silently did nothing. */}
        <StatTile
          className="col-span-1 sm:col-span-3 lg:col-span-4 flex flex-col p-3 sm:p-4"
          onClick={() => setUpdatesOpen(true)}
          ariaLabel="Open updates"
        >
          <div className="flex items-start justify-between mb-2">
            <div className="flex items-center gap-2">
              <TileLabel>Updates</TileLabel>
              {unreadCount > 0 && (
                <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded-full bg-primary-100 text-primary-700 text-[10px] font-bold min-w-[18px]">
                  {unreadCount}
                </span>
              )}
            </div>
            <TileIconChip icon={Bell} color="#0073ea" />
          </div>
          {notifications.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-4">
              <BellOff
                size={36}
                strokeWidth={1.4}
                className="text-text-tertiary mb-2"
                aria-hidden="true"
              />
              <p className="text-sm font-semibold text-text-primary">No updates</p>
              <p className="text-xs text-text-secondary mt-0.5">You're all caught up</p>
            </div>
          ) : (
            <div className="flex-1 flex flex-col">
              <div className="space-y-1.5 flex-1">
                {notifications.slice(0, 3).map(n => (
                  <p
                    key={n.id}
                    className="text-[11px] text-text-secondary line-clamp-1 leading-snug"
                  >
                    <span
                      className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle ${
                        n.isRead ? 'bg-transparent' : 'bg-primary-500'
                      }`}
                    />
                    {n.message}
                  </p>
                ))}
              </div>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setUpdatesOpen(true); }}
                className="text-[11px] text-primary-600 hover:text-primary-700 font-semibold pt-2 self-start"
              >
                View all {notifications.length} updates →
              </button>
            </div>
          )}
        </StatTile>

        {/* ─── Row 4: My Tasks (col-8) + Recent (col-4) ─────────────── */}
        <StatTile
          className="col-span-1 sm:col-span-6 lg:col-span-8 flex flex-col min-h-[260px] p-3 sm:p-4"
        >
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-md font-semibold text-text-primary flex items-center gap-2">
              <ListTodo size={16} strokeWidth={1.9} /> My Tasks
              <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-surface-100 text-text-secondary text-[11px] font-semibold">
                {myTasks.length}
              </span>
              {overdueTasks.length > 0 && (
                <span className="badge badge-danger">{overdueTasks.length} overdue</span>
              )}
            </h2>
            <motion.button
              onClick={() => navigate('/my-work')}
              className="text-xs text-primary-500 hover:text-primary-600 font-semibold flex items-center gap-1"
              {...pressable}
            >
              View all <ArrowRight size={12} />
            </motion.button>
          </div>

          {/* Filter chips (visual only — clicking routes to My Work) */}
          <div className="flex flex-wrap gap-1.5 mb-3">
            {['All', 'Today', 'This week', 'Overdue'].map((label, i) => (
              <button
                key={label}
                onClick={() => navigate('/my-work')}
                className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
                  i === 0
                    ? 'bg-primary-50 text-primary-700 dark:bg-primary-900/20 dark:text-primary-400'
                    : 'bg-surface-50 text-text-secondary hover:bg-surface-100'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {myTasks.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <EmptyState
                title="You're all caught up"
                subtitle="Tasks will appear here when assigned to you"
                action={
                  <motion.button
                    {...pressable}
                    onClick={() => navigate('/boards')}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-primary-600 hover:bg-primary-50 dark:hover:bg-primary-900/20 transition-colors"
                  >
                    Browse boards <ArrowRight size={12} />
                  </motion.button>
                }
              />
            </div>
          ) : (
            <div className="flex-1 overflow-hidden -mx-1">
              <div className="space-y-0.5">
                {myTasks.map((task, idx) => {
                  const statusConf = STATUS_CONFIG[task.status] || {};
                  const priorityConf = PRIORITY_CONFIG[task.priority] || {};
                  const isOverdue =
                    task.dueDate && new Date(task.dueDate) < new Date() && task.status !== 'done';
                  return (
                    <motion.button
                      key={task.id}
                      initial={{ opacity: 0, x: -6 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{
                        delay: 0.04 * idx,
                        duration: 0.25,
                        ease: [0.16, 1, 0.3, 1],
                      }}
                      onClick={() =>
                        openTaskFromAnywhere(navigate, { taskId: task.id, boardId: task.boardId })
                      }
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-surface-50 dark:hover:bg-surface-100 transition-colors text-left group ${
                        task.status === 'done' ? 'opacity-50' : ''
                      }`}
                    >
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: statusConf.color || 'var(--ui-border-color)' }}
                        aria-hidden="true"
                      />
                      <span
                        className={`text-sm flex-1 truncate group-hover:text-primary ${
                          task.status === 'done'
                            ? 'line-through text-text-tertiary'
                            : 'text-text-primary'
                        }`}
                      >
                        {task.title}
                      </span>
                      <span
                        className="text-[10px] font-medium px-2 py-0.5 rounded-md hidden sm:inline"
                        style={{
                          backgroundColor: `${priorityConf.color || '#c3c6d4'}15`,
                          color: priorityConf.color || 'var(--secondary-text-color)',
                        }}
                      >
                        {translatePriority(task.priority, t, priorityConf.label || task.priority)}
                      </span>
                      {task.dueDate && (
                        <span
                          className={`text-[11px] flex-shrink-0 ${
                            isOverdue ? 'text-danger font-semibold' : 'text-text-tertiary'
                          }`}
                        >
                          {isOverdue && '⚠ '}
                          {new Date(task.dueDate).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </span>
                      )}
                    </motion.button>
                  );
                })}
              </div>
            </div>
          )}
        </StatTile>

        <StatTile className="col-span-1 sm:col-span-6 lg:col-span-4 flex flex-col p-3 sm:p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-md font-semibold text-text-primary flex items-center gap-2">
              <Clock size={15} strokeWidth={1.9} /> Recent
            </h2>
            <motion.button
              onClick={() => navigate('/boards')}
              className="text-xs text-primary-500 hover:text-primary-600 font-semibold"
              {...pressable}
            >
              All boards
            </motion.button>
          </div>
          <motion.div
            className="space-y-2 flex-1"
            variants={staggerContainer}
            initial="initial"
            animate="animate"
          >
            {boards.slice(0, 4).map((board, i) => (
              <RecentBoardCard
                key={board.id}
                board={board}
                index={i}
                active={i === 0}
                onClick={() => navigate(`/boards/${board.id}`)}
              />
            ))}
            {boards.length === 0 && (
              <div className="flex flex-col items-center justify-center py-8 text-text-tertiary text-xs">
                <FolderKanban size={22} className="mb-2 opacity-40" aria-hidden="true" />
                No boards yet
              </div>
            )}
          </motion.div>
        </StatTile>
      </motion.div>

      <UpdatesModal
        isOpen={updatesOpen}
        onClose={() => setUpdatesOpen(false)}
        notifications={notifications}
        unreadCount={unreadCount}
        onMarkRead={markNotificationRead}
      />
    </div>
  );
}
