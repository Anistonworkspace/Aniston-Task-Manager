import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useNavigate } from 'react-router-dom';
import { motion, useMotionValue, useTransform, animate as fmAnimate } from 'framer-motion';
import {
  ArrowLeft, Users, AlertTriangle, CheckCircle2, Clock, ListChecks, FileText,
  Activity, ChevronRight, Search, Filter, ChevronDown, X, AlertCircle, Tag,
  User as UserIcon, Calendar,
} from 'lucide-react';
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line, AreaChart, Area } from 'recharts';
import { formatDistanceToNow, parseISO, format } from 'date-fns';
import api from '../services/api';
import { STATUS_CONFIG, PRIORITY_CONFIG } from '../utils/constants';
import { resolveTier, tierLabel } from '../utils/tiers';
import Avatar from '../components/common/Avatar';
import MemberDrillDown from '../components/dashboard/MemberDrillDown';
import useRealtimeQuery from '../realtime/useRealtimeQuery';
import { SkeletonDashboard } from '../components/common/Skeleton';
import { useAuth } from '../context/AuthContext';

const DR_POPOVER_WIDTH = 280;
const DR_GAP = 8;

// Member row with a portal-rendered Direct Reports hover popover. The popover
// renders to document.body so it isn't clipped by the table's overflow-x-auto
// wrapper, and defaults to opening ABOVE the row — falling back to below only
// when there isn't enough room above. Position is recomputed on scroll/resize.
function TeamMemberRow({ member, onSelect }) {
  const rowRef = useRef(null);
  const popoverRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, ready: false });
  const showTimer = useRef(null);
  const hideTimer = useRef(null);

  const pct = member.total > 0 ? Math.round((member.done / member.total) * 100) : 0;
  const children = Array.isArray(member.children) ? member.children : [];
  const secondary = member.designation || member.role || ' ';

  function updatePosition() {
    if (!rowRef.current) return;
    const rect = rowRef.current.getBoundingClientRect();
    const popH = popoverRef.current?.offsetHeight || 120;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Default: place above the row.
    let top = rect.top - popH - DR_GAP;
    // Fallback: not enough space above → place below. If below also overflows,
    // clamp to viewport so it stays visible.
    if (top < DR_GAP) {
      const belowTop = rect.bottom + DR_GAP;
      top = belowTop + popH <= vh - DR_GAP
        ? belowTop
        : Math.max(DR_GAP, vh - popH - DR_GAP);
    }

    let left = rect.left + 12;
    if (left + DR_POPOVER_WIDTH > vw - DR_GAP) left = vw - DR_POPOVER_WIDTH - DR_GAP;
    if (left < DR_GAP) left = DR_GAP;

    setPos({ top, left, ready: true });
  }

  function handleEnter() {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    if (open) return;
    showTimer.current = setTimeout(() => setOpen(true), 60);
  }

  function handleLeave() {
    if (showTimer.current) { clearTimeout(showTimer.current); showTimer.current = null; }
    hideTimer.current = setTimeout(() => setOpen(false), 150);
  }

  // Measure and position synchronously after the popover mounts so the first
  // paint is correct (no flash at 0,0).
  useLayoutEffect(() => {
    if (!open) { setPos(p => ({ ...p, ready: false })); return; }
    updatePosition();
  }, [open, children.length]);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => updatePosition();
    const onResize = () => updatePosition();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  useEffect(() => () => {
    if (showTimer.current) clearTimeout(showTimer.current);
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);

  return (
    <tr
      ref={rowRef}
      onClick={() => onSelect(member.id)}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      className="border-b border-border/30 last:border-b-0 hover:bg-primary/5 cursor-pointer transition-colors group/row"
    >
      <td className="py-2.5 px-4 align-middle">
        <div className="flex items-center gap-3 min-h-[40px]">
          <Avatar name={member.name} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-text-primary group-hover/row:text-primary truncate leading-snug">{member.name}</p>
            <p className="text-[11px] text-text-tertiary truncate leading-snug mt-0.5">{secondary}</p>
          </div>
          <ChevronRight size={14} className="text-text-tertiary opacity-0 group-hover/row:opacity-100 transition-opacity flex-shrink-0" />
        </div>
      </td>
      <td className="text-center py-2.5 px-2 align-middle text-[13px] font-semibold tabular-nums">{member.total}</td>
      <td className="text-center py-2.5 px-2 align-middle tabular-nums"><span className="text-success font-semibold text-[13px]">{member.done}</span></td>
      <td className="text-center py-2.5 px-2 align-middle tabular-nums"><span className="text-warning font-semibold text-[13px]">{member.working}</span></td>
      <td className="text-center py-2.5 px-2 align-middle tabular-nums"><span className={`text-[13px] ${member.stuck > 0 ? 'text-danger font-semibold' : 'text-text-tertiary'}`}>{member.stuck}</span></td>
      <td className="text-center py-2.5 px-2 align-middle tabular-nums"><span className={`text-[13px] ${member.overdue > 0 ? 'text-danger font-semibold' : 'text-text-tertiary'}`}>{member.overdue}</span></td>
      <td className="py-2.5 px-4 align-middle">
        <div className="flex items-center gap-2.5">
          <div className="flex-1 h-1.5 bg-surface-100 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: pct === 100 ? '#00c875' : '#0073ea' }} />
          </div>
          <span className="text-[11px] font-semibold text-text-secondary w-9 text-right tabular-nums">{pct}%</span>
        </div>
      </td>
      {open && createPortal(
        <div
          ref={popoverRef}
          onClick={e => e.stopPropagation()}
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
          role="tooltip"
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            width: DR_POPOVER_WIDTH,
            zIndex: 9999,
            visibility: pos.ready ? 'visible' : 'hidden',
          }}
          className="rounded-lg border border-border bg-white dark:bg-[#1E1F23] shadow-xl p-2 cursor-default"
        >
          <p className="text-[10px] font-semibold text-text-tertiary uppercase tracking-wider px-1 mb-1.5">
            Direct reports {children.length > 0 && <span className="ml-1 text-text-secondary">({children.length})</span>}
          </p>
          {children.length > 0 ? (
            <div className="space-y-0.5 max-h-[200px] overflow-y-auto">
              {children.map(c => (
                <div key={c.id} className="flex items-center gap-2 px-1.5 py-1 rounded">
                  <Avatar name={c.name} size="xs" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-text-primary truncate">{c.name}</p>
                    <p className="text-[10px] text-text-tertiary truncate">
                      {c.designation || tierLabel(resolveTier(c))}{c.department ? ` · ${c.department}` : ''}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-text-tertiary text-center py-2">No child members</p>
          )}
        </div>,
        document.body
      )}
    </tr>
  );
}

export default function DashboardPage() {
  const { id: boardId } = useParams();
  const navigate = useNavigate();
  const { user: currentUser } = useAuth();
  const [data, setData] = useState(null);
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedMember, setSelectedMember] = useState(null);

  // Team Overview filter state — mirrors the Tasks-table toolbar on the
  // Admin/Member/Manager dashboards but applies to per-member aggregates
  // instead of individual tasks.
  const [teamFilters, setTeamFilters] = useState({ statuses: [], priorities: [], member: '', search: '', smartView: '' });
  const [showTeamFilters, setShowTeamFilters] = useState(false);
  const [smartViewOpen, setSmartViewOpen] = useState(false);
  const [memberOpen, setMemberOpen] = useState(false);
  const smartViewRef = useRef(null);
  const memberRef = useRef(null);
  // Anchors for stat-card click-to-scroll. Team Overview is the per-member
  // roll-up (used for Total/Completed/In Progress/Stuck); the Overdue Tasks
  // widget is a flat task list (used for Overdue) — see jumpFromStatCard().
  const teamOverviewRef = useRef(null);
  const overdueWidgetRef = useRef(null);

  useEffect(() => {
    function onDocClick(e) {
      if (smartViewRef.current && !smartViewRef.current.contains(e.target)) setSmartViewOpen(false);
      if (memberRef.current && !memberRef.current.contains(e.target)) setMemberOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  useEffect(() => {
    loadDashboard();
  }, [boardId]);

  // Live refresh — every task event hits dashboard.stats per the router.
  useRealtimeQuery({ queryKey: 'dashboard.stats', refetch: loadDashboard });

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

  // Each card jumps to the most relevant section and pre-applies a filter that
  // matches its label. `target` picks which anchor to scroll to; `apply`
  // mutates teamFilters so the Team Overview lands pre-filtered. Overdue uses
  // the dedicated widget so the user sees the actual overdue task list rather
  // than the per-member roll-up.
  function jumpFromStatCard(kind) {
    const scrollTo = (ref) => {
      if (ref?.current) {
        ref.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };
    switch (kind) {
      case 'total':
        setTeamFilters({ statuses: [], priorities: [], member: '', search: '', smartView: '' });
        scrollTo(teamOverviewRef);
        break;
      case 'done':
        setTeamFilters({ statuses: ['done'], priorities: [], member: '', search: '', smartView: '' });
        scrollTo(teamOverviewRef);
        break;
      case 'working':
        setTeamFilters({ statuses: ['working_on_it'], priorities: [], member: '', search: '', smartView: '' });
        scrollTo(teamOverviewRef);
        break;
      case 'stuck':
        setTeamFilters({ statuses: [], priorities: [], member: '', search: '', smartView: 'stuck' });
        scrollTo(teamOverviewRef);
        break;
      case 'overdue':
        // Prefer the flat task widget when it has data; fall back to the
        // Team Overview with the overdue smart view if there are zero
        // overdue tasks (widget isn't rendered then).
        if (overdueTasks.length > 0) {
          scrollTo(overdueWidgetRef);
        } else {
          setTeamFilters({ statuses: [], priorities: [], member: '', search: '', smartView: 'overdue' });
          scrollTo(teamOverviewRef);
        }
        break;
      default:
        break;
    }
  }

  const statCards = [
    { kind: 'total',   label: 'Total Tasks', value: summary.totalTasks, color: '#0073ea', icon: ListChecks },
    { kind: 'done',    label: 'Completed',   value: summary.done,       color: '#00c875', icon: CheckCircle2 },
    { kind: 'working', label: 'In Progress', value: summary.working,    color: '#fdab3d', icon: Clock },
    { kind: 'stuck',   label: 'Stuck',       value: summary.stuck,      color: '#e2445c', icon: AlertTriangle },
    { kind: 'overdue', label: 'Overdue',     value: summary.overdue,    color: '#e2445c', icon: AlertTriangle },
  ];

  return (
    <motion.div className="p-6 max-w-[1400px] mx-auto" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
      {/* Header */}
      <motion.div className="flex items-center gap-3 mb-6" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}>
        {boardId && (
          <button onClick={() => navigate(`/boards/${boardId}`)} className="p-1.5 rounded-md hover:bg-surface text-text-secondary"><ArrowLeft size={18} /></button>
        )}
        <div className="flex-1">
          <h1 className="text-xl font-bold text-text-primary">Team Dashboard</h1>
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
            <motion.button
              key={card.label}
              type="button"
              onClick={() => jumpFromStatCard(card.kind)}
              title={`Jump to ${card.label}`}
              className="widget-card text-left cursor-pointer hover:shadow-md focus:outline-none focus:ring-2 focus:ring-primary/40"
              variants={{ initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0, transition: { duration: 0.25, ease: [0.16, 1, 0.3, 1] } } }}
              whileHover={{ y: -1, transition: { duration: 0.15 } }}>
              <div className="flex items-center gap-2 mb-2">
                <Icon size={14} style={{ color: card.color }} />
                <span className="text-xs text-text-secondary font-medium">{card.label}</span>
              </div>
              <p className="text-2xl font-bold" style={{ color: card.color }}>{card.value}</p>
            </motion.button>
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

      {/* Team Overview — grouped by department with org-hierarchy hover popover */}
      {memberStats.length > 0 && (() => {
        const NO_DEPT = 'No Department';
        const lcSearch = teamFilters.search.trim().toLowerCase();

        // Default behaviour matches what the page rendered before filters
        // existed: hide the synthetic Unassigned bucket. Reveal it only when
        // the user explicitly opts in via the member dropdown or the
        // Unassigned smart view, otherwise it would clutter every Team
        // Overview render.
        const showsUnassigned = teamFilters.smartView === 'unassigned' || teamFilters.member === 'unassigned';

        // Apply every active filter dimension. Each guard uses the
        // per-member metadata from /dashboard/stats — no fabricated counts.
        const filteredMembers = memberStats.filter(m => {
          if (m.id === 'unassigned' && !showsUnassigned) return false;

          if (teamFilters.member === 'unassigned' && m.id !== 'unassigned') return false;
          if (teamFilters.member && teamFilters.member !== 'unassigned' && m.id !== teamFilters.member) return false;

          switch (teamFilters.smartView) {
            case 'overdue':       if (!(m.overdue > 0)) return false; break;
            case 'due_today':     if (!(m.dueToday > 0)) return false; break;
            case 'my_tasks':      if (!currentUser || m.id !== currentUser.id) return false; break;
            case 'this_week':     if (!(m.dueThisWeek > 0)) return false; break;
            case 'stuck':         if (!(m.stuck > 0)) return false; break;
            case 'high_priority': {
              const hi = (m.priorityCounts?.high || 0) + (m.priorityCounts?.critical || 0);
              if (!(hi > 0)) return false;
              break;
            }
            case 'unassigned':    if (m.id !== 'unassigned') return false; break;
            default: break;
          }

          if (teamFilters.statuses.length > 0) {
            const hit = teamFilters.statuses.some(s => (m.statusCounts?.[s] || 0) > 0);
            if (!hit) return false;
          }
          if (teamFilters.priorities.length > 0) {
            const hit = teamFilters.priorities.some(p => (m.priorityCounts?.[p] || 0) > 0);
            if (!hit) return false;
          }

          if (lcSearch) {
            const hay = [m.name, m.designation, m.role, m.department].filter(Boolean).join(' ').toLowerCase();
            if (!hay.includes(lcSearch)) return false;
          }
          return true;
        });

        const byDept = filteredMembers.reduce((acc, m) => {
          const key = (m.department && m.department.trim()) || NO_DEPT;
          if (!acc[key]) acc[key] = [];
          acc[key].push(m);
          return acc;
        }, {});
        const deptOrder = Object.keys(byDept).sort((a, b) => {
          if (a === NO_DEPT) return 1;
          if (b === NO_DEPT) return -1;
          return a.localeCompare(b);
        });

        // Dropdown options derive from the unfiltered list so users can
        // re-target the table without first clearing their selection.
        const memberOptions = memberStats.filter(m => m.id !== 'unassigned');
        const hasUnassigned = memberStats.some(m => m.id === 'unassigned');

        const SMART_VIEWS = [
          { id: 'overdue',       label: 'Overdue',       icon: AlertTriangle, color: '#e2445c' },
          { id: 'due_today',     label: 'Due Today',     icon: Clock,         color: '#fdab3d' },
          { id: 'my_tasks',      label: 'My Tasks',      icon: UserIcon,      color: '#0073ea' },
          { id: 'this_week',     label: 'This Week',     icon: Calendar,      color: '#00c875' },
          { id: 'stuck',         label: 'Stuck Tasks',   icon: AlertCircle,   color: '#e2445c' },
          { id: 'high_priority', label: 'High Priority', icon: Tag,           color: '#e2445c' },
          ...(hasUnassigned ? [{ id: 'unassigned', label: 'Unassigned', icon: Users, color: '#c4c4c4' }] : []),
        ];
        const activeSmart = SMART_VIEWS.find(v => v.id === teamFilters.smartView);

        const chipsCount = teamFilters.statuses.length + teamFilters.priorities.length;
        const activeFilterCount = chipsCount + (teamFilters.member ? 1 : 0) + (teamFilters.smartView ? 1 : 0);
        const hasAnyFilter = activeFilterCount > 0 || !!teamFilters.search.trim();

        function applySmartView(viewId) {
          // Smart Views replace other filters to match the Tasks-table
          // behaviour on the Admin Dashboard. Re-clicking the active view
          // toggles it off rather than re-applying.
          if (teamFilters.smartView === viewId) {
            setTeamFilters(f => ({ ...f, smartView: '' }));
          } else {
            setTeamFilters({ statuses: [], priorities: [], member: '', search: '', smartView: viewId });
          }
          setSmartViewOpen(false);
        }
        function toggleStatus(s) {
          setTeamFilters(f => ({
            ...f,
            statuses: f.statuses.includes(s) ? f.statuses.filter(x => x !== s) : [...f.statuses, s],
            smartView: '',
          }));
        }
        function togglePriority(p) {
          setTeamFilters(f => ({
            ...f,
            priorities: f.priorities.includes(p) ? f.priorities.filter(x => x !== p) : [...f.priorities, p],
            smartView: '',
          }));
        }
        function clearAll() {
          setTeamFilters({ statuses: [], priorities: [], member: '', search: '', smartView: '' });
        }

        return (
          <div ref={teamOverviewRef} className="widget-card mb-6 scroll-mt-20">
            <h3 className="text-sm font-semibold mb-1 flex items-center gap-2">
              <Users size={15} /> Team Overview
            </h3>
            <p className="text-xs text-text-tertiary mb-3">Grouped by department · hover a member to see their direct reports · click to view tasks</p>

            {/* Filter toolbar — same controls as the Tasks table on My Dashboard,
                applied to per-member aggregates. */}
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <div className="relative" ref={memberRef}>
                <button
                  onClick={() => { setMemberOpen(o => !o); setSmartViewOpen(false); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-border hover:border-primary/40 bg-white transition-colors"
                  title="Filter by member"
                >
                  <Users size={12} />
                  <span className="truncate max-w-[140px]">
                    {teamFilters.member === 'unassigned'
                      ? 'Unassigned'
                      : teamFilters.member
                        ? (memberOptions.find(u => u.id === teamFilters.member)?.name || 'Selected')
                        : 'All Members'}
                  </span>
                  <ChevronDown size={12} />
                </button>
                {memberOpen && (
                  <div className="absolute top-full left-0 mt-1 bg-white border border-border rounded-lg shadow-xl z-30 w-60 max-h-72 overflow-y-auto py-1">
                    <button
                      onClick={() => {
                        setTeamFilters(f => ({ ...f, member: '', smartView: f.smartView === 'unassigned' ? '' : f.smartView }));
                        setMemberOpen(false);
                      }}
                      className={`w-full text-left px-3 py-2 text-xs hover:bg-surface ${!teamFilters.member ? 'bg-primary/5 font-semibold' : ''}`}
                    >
                      All Members
                    </button>
                    {hasUnassigned && (
                      <button
                        onClick={() => { setTeamFilters(f => ({ ...f, member: 'unassigned', smartView: '' })); setMemberOpen(false); }}
                        className={`w-full text-left px-3 py-2 text-xs hover:bg-surface ${teamFilters.member === 'unassigned' ? 'bg-primary/5 font-semibold' : ''}`}
                      >
                        Unassigned
                      </button>
                    )}
                    {memberOptions.map(u => (
                      <button
                        key={u.id}
                        onClick={() => { setTeamFilters(f => ({ ...f, member: u.id, smartView: '' })); setMemberOpen(false); }}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-surface ${teamFilters.member === u.id ? 'bg-primary/5 font-semibold' : ''}`}
                      >
                        <Avatar name={u.name} size="xs" />
                        <span className="truncate">{u.name}</span>
                        {(u.designation || u.role) && (
                          <span className="text-[9px] text-text-tertiary ml-auto truncate max-w-[80px]">{u.designation || tierLabel(resolveTier(u))}</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="relative" ref={smartViewRef}>
                <button
                  onClick={() => { setSmartViewOpen(o => !o); setMemberOpen(false); }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${activeSmart ? 'bg-primary text-white border-primary' : 'bg-surface border-border text-text-primary hover:border-primary/40'}`}
                >
                  <Filter size={13} />
                  {activeSmart ? activeSmart.label : 'Smart Views'}
                  <ChevronDown size={12} />
                </button>
                {smartViewOpen && (
                  <div className="absolute top-full left-0 mt-1 bg-white border border-border rounded-lg shadow-xl z-30 w-48 py-1">
                    {SMART_VIEWS.map(v => {
                      const Icon = v.icon;
                      return (
                        <button
                          key={v.id}
                          onClick={() => applySmartView(v.id)}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-surface transition-colors ${teamFilters.smartView === v.id ? 'bg-primary/5 font-semibold' : ''}`}
                        >
                          <Icon size={13} style={{ color: v.color }} /> {v.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <button
                onClick={() => setShowTeamFilters(s => !s)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${showTeamFilters || chipsCount > 0 ? 'bg-primary/10 border-primary/30 text-primary' : 'border-border hover:border-primary/40 text-text-secondary'}`}
              >
                <Filter size={12} />
                Filters
                {chipsCount > 0 && (
                  <span className="w-4 h-4 rounded-full bg-primary text-white text-[9px] font-bold flex items-center justify-center">{chipsCount}</span>
                )}
              </button>

              <div className="relative ml-auto">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary" />
                <input
                  type="text"
                  placeholder="Search members..."
                  value={teamFilters.search}
                  onChange={e => setTeamFilters(f => ({ ...f, search: e.target.value }))}
                  className="pl-8 pr-3 py-1.5 text-xs border border-border rounded-lg w-56 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                />
              </div>

              {hasAnyFilter && (
                <button onClick={clearAll} className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-medium text-danger hover:bg-danger/5 transition-colors">
                  <X size={12} /> Clear
                </button>
              )}
            </div>

            {showTeamFilters && (
              <div className="mb-3 pt-3 border-t border-border space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-bold text-text-tertiary uppercase tracking-wider">Status</span>
                  {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
                    <button
                      key={key}
                      onClick={() => toggleStatus(key)}
                      className="px-2 py-0.5 rounded text-[10px] font-semibold transition-all border"
                      style={{
                        backgroundColor: teamFilters.statuses.includes(key) ? cfg.color : 'transparent',
                        color: teamFilters.statuses.includes(key) ? '#fff' : cfg.color,
                        borderColor: teamFilters.statuses.includes(key) ? cfg.color : '#e5e7eb',
                      }}
                    >
                      {cfg.label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-bold text-text-tertiary uppercase tracking-wider">Priority</span>
                  {Object.entries(PRIORITY_CONFIG).map(([key, cfg]) => (
                    <button
                      key={key}
                      onClick={() => togglePriority(key)}
                      className="px-2 py-0.5 rounded text-[10px] font-semibold transition-all border"
                      style={{
                        backgroundColor: teamFilters.priorities.includes(key) ? cfg.color : 'transparent',
                        color: teamFilters.priorities.includes(key) ? '#fff' : cfg.color,
                        borderColor: teamFilters.priorities.includes(key) ? cfg.color : '#e5e7eb',
                      }}
                    >
                      {cfg.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {filteredMembers.length === 0 ? (
              <div className="py-12 text-center border border-dashed border-border rounded-lg">
                <Users size={28} className="mx-auto text-text-tertiary mb-2" />
                <p className="text-sm text-text-secondary">No team members match the selected filters</p>
                {hasAnyFilter && (
                  <button onClick={clearAll} className="mt-2 text-xs text-primary hover:underline">Clear filters</button>
                )}
              </div>
            ) : (
            <div className="overflow-x-auto rounded-lg border border-border/50">
              <table className="w-full text-sm">
                <thead className="bg-surface/40">
                  <tr className="border-b border-border/50">
                    <th className="text-left py-2.5 px-4 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">Member</th>
                    <th className="text-center py-2.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary w-[72px]">Total</th>
                    <th className="text-center py-2.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary w-[72px]">Done</th>
                    <th className="text-center py-2.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary w-[80px]">Working</th>
                    <th className="text-center py-2.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary w-[72px]">Stuck</th>
                    <th className="text-center py-2.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary w-[80px]">Overdue</th>
                    <th className="text-left py-2.5 px-4 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary w-[180px]">Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {deptOrder.map((dept, deptIdx) => (
                    <React.Fragment key={dept}>
                      {/* Department header — visually distinct band, with top
                          breathing room before each group except the first. */}
                      <tr>
                        <td colSpan={7} className={`${deptIdx === 0 ? 'pt-0' : 'pt-2'} pb-0 px-0`}>
                          <div className="flex items-center gap-2.5 px-4 h-9 bg-surface/50 border-y border-border/40">
                            <span className="w-1 h-3.5 rounded-sm bg-primary/70 flex-shrink-0" />
                            <span className="text-[11px] font-bold uppercase tracking-wider text-text-secondary">{dept}</span>
                            <span className="text-[10px] font-semibold leading-[16px] px-1.5 rounded-full bg-primary/10 text-primary">
                              {byDept[dept].length} {byDept[dept].length === 1 ? 'member' : 'members'}
                            </span>
                          </div>
                        </td>
                      </tr>
                      {byDept[dept].map(member => (
                        <TeamMemberRow key={member.id} member={member} onSelect={setSelectedMember} />
                      ))}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            )}
          </div>
        );
      })()}

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
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
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
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
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

        {/* Team Workload — dynamic height + scrollable when many members */}
        {workloadData.length > 0 && (() => {
          const rowHeight = 32;
          const baseHeight = 180;
          const verticalPadding = 24; // chart top/bottom padding
          const chartHeight = Math.max(baseHeight, workloadData.length * rowHeight + verticalPadding);
          return (
            <div className="widget-card">
              <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
                <Users size={15} className="text-primary" /> Team Workload
              </h3>
              <div className="max-h-[280px] overflow-y-auto pr-1">
                <ResponsiveContainer width="100%" height={chartHeight}>
                  <BarChart data={workloadData} layout="vertical" margin={{ top: 4, right: 12, bottom: 4, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e6e9ef" />
                    <XAxis type="number" tick={{ fontSize: 10 }} allowDecimals={false} />
                    <YAxis
                      dataKey="name"
                      type="category"
                      tick={{ fontSize: 10 }}
                      width={100}
                      interval={0}
                      tickFormatter={v => (v && v.length > 14 ? `${v.slice(0, 13)}…` : v)}
                    />
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                    <Bar dataKey="active" fill="#0073ea" name="Active" stackId="stack" radius={[0, 0, 0, 0]} />
                    <Bar dataKey="done" fill="#00c875" name="Done" stackId="stack" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          );
        })()}
      </div>

      {/* Overdue Tasks Widget */}
      {overdueTasks.length > 0 && (
        <div ref={overdueWidgetRef} className="widget-card scroll-mt-20">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <AlertTriangle size={15} className="text-danger" /> Overdue Tasks
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-danger text-white">{overdueTasks.length}</span>
          </h3>
          <div className="space-y-1.5">
            {overdueTasks.map(task => {
              // Open the exact task sheet on its board via the ?taskId= deep
              // link consumed by BoardPage (same pattern used by MemberDrillDown
              // and RecurringWorkPage).
              const openOverdueTask = () => {
                if (!task.boardId) return;
                navigate(`/boards/${task.boardId}?taskId=${task.id}`);
              };
              return (
                <div key={task.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-danger/5 border border-danger/10 hover:bg-danger/10 transition-colors cursor-pointer"
                  onClick={openOverdueTask}>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text-primary truncate hover:text-primary hover:underline">{task.title}</p>
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
              );
            })}
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