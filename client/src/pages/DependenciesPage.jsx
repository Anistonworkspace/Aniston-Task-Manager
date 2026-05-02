import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  Link2, Inbox, Send, CheckCircle2, XCircle, Search,
  Calendar, Flag, ExternalLink, Play, Check, X, Trash2,
  AlertCircle, FileText, Archive, RefreshCw,
} from 'lucide-react';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/common/Toast';
import Avatar from '../components/common/Avatar';
import useRealtimeEvent from '../realtime/useRealtimeEvent';
import RejectDependencyDialog from '../components/dependencies/RejectDependencyDialog';

const STATUS_BADGES = {
  pending:        { label: 'Pending',        bg: 'bg-amber-100',   text: 'text-amber-700',   ring: 'ring-amber-200' },
  accepted:       { label: 'Accepted',       bg: 'bg-blue-100',    text: 'text-blue-700',    ring: 'ring-blue-200' },
  working_on_it:  { label: 'Working on it',  bg: 'bg-orange-100',  text: 'text-orange-700',  ring: 'ring-orange-200' },
  done:           { label: 'Done',           bg: 'bg-emerald-100', text: 'text-emerald-700', ring: 'ring-emerald-200' },
  rejected:       { label: 'Rejected',       bg: 'bg-red-100',     text: 'text-red-700',     ring: 'ring-red-200' },
  cancelled:      { label: 'Cancelled',      bg: 'bg-gray-100',    text: 'text-gray-600',    ring: 'ring-gray-200' },
};

const PRIORITY_BADGES = {
  low:      { label: 'Low',      color: '#9aa6b8' },
  medium:   { label: 'Medium',   color: '#fdab3d' },
  high:     { label: 'High',     color: '#ff7575' },
  critical: { label: 'Critical', color: '#e2445c' },
};

const TABS = [
  { key: 'assigned',  label: 'Assigned to Me',  icon: Inbox },
  { key: 'created',   label: 'Created by Me',   icon: Send },
  { key: 'completed', label: 'Completed',       icon: CheckCircle2 },
  { key: 'rejected',  label: 'Rejected / Cancelled', icon: XCircle },
];

const ACTIVE_STATUSES = ['pending', 'accepted', 'working_on_it'];

export default function DependenciesPage() {
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const [assigned, setAssigned] = useState([]);
  const [created, setCreated] = useState([]);
  // 'idle' (pre-mount) | 'initial' (first load, show skeleton) |
  // 'refreshing' (background refresh, keep list visible) |
  // 'ready' (data loaded) | 'error' (initial load failed, no cached data)
  const [phase, setPhase] = useState('initial');
  const [tab, setTab] = useState('assigned');
  const [search, setSearch] = useState('');
  const [rejectTarget, setRejectTarget] = useState(null);

  // ─── Stability refs ─────────────────────────────────────────────
  // useToast() returns a fresh object every render — the arrow wrappers
  // (msg) => ctx.addToast(msg, 'success') are recreated each call. Putting
  // it in a useCallback dep array would invalidate the callback every
  // render, which is exactly what was causing /cross-team to spin in an
  // infinite refetch loop and trip the 200/min general rate limiter.
  // Hide the unstable reference behind a ref so reload() can have empty
  // deps and a permanently stable identity.
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // In-flight dedupe: a socket event arriving while a fetch is pending
  // would otherwise queue a second identical fetch. Single source of
  // truth for "is there a fetch happening right now?".
  const inFlightRef = useRef(false);
  // Cooldown after a 429 — we stop trying for 15s. Without this, a real
  // rate-limit response immediately retries and re-trips the limiter.
  const cooldownUntilRef = useRef(0);
  // Toast spam guard. Same identical error message can fire from many
  // sources (initial load, socket-triggered refetch, retry); cap one toast
  // per 8s window for the same root cause.
  const lastErrorAtRef = useRef(0);
  // Debounce: cascade-cancellations etc. fan out N socket events for the
  // same parent in quick succession. Coalesce into one fetch.
  const debounceTimerRef = useRef(null);
  // Track whether we've ever loaded successfully so a background-refresh
  // failure doesn't wipe the list back to skeleton/error.
  const initialLoadedRef = useRef(false);
  // Avoid setState-after-unmount warnings + dropped fetches.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  // Stable reload — empty deps. Reads everything via refs so its identity
  // never changes; the mount-effect runs exactly once.
  const reload = useCallback(async () => {
    if (inFlightRef.current) return;
    if (Date.now() < cooldownUntilRef.current) return;

    inFlightRef.current = true;
    if (!initialLoadedRef.current) setPhase('initial');
    else setPhase('refreshing');

    try {
      const [a, c] = await Promise.all([
        api.get('/dependencies/assigned-to-me'),
        api.get('/dependencies/created-by-me'),
      ]);
      if (!mountedRef.current) return;
      setAssigned(a.data?.data?.dependencyRequests || []);
      setCreated(c.data?.data?.dependencyRequests || []);
      initialLoadedRef.current = true;
      setPhase('ready');
    } catch (err) {
      if (!mountedRef.current) return;
      const status = err.response?.status;
      const now = Date.now();

      // 429 → back off for 15s. Socket-triggered scheduleRefetch checks
      // the same cooldown ref and short-circuits during the window.
      if (status === 429) cooldownUntilRef.current = now + 15_000;

      // Cooldown the toast so the user gets one clear message instead of
      // many identical ones.
      if (now - lastErrorAtRef.current > 8_000) {
        lastErrorAtRef.current = now;
        toastRef.current.error(
          status === 429
            ? 'Slowing down — too many requests. Will retry shortly.'
            : 'Could not load dependencies.'
        );
      }

      // If we already had data, KEEP it on screen (background-refresh
      // failure shouldn't wipe the list back to error state).
      if (initialLoadedRef.current) {
        setPhase('ready');
      } else {
        setPhase('error');
      }
    } finally {
      inFlightRef.current = false;
    }
  // Empty deps on purpose — every external value used inside is read via
  // a ref. ESLint exhaustive-deps will flag this; the guarantee is that
  // refs always read the current value without invalidating identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initial load — runs once because reload identity is stable.
  useEffect(() => { reload(); }, [reload]);

  // Debounced refetch on socket events. Multiple events in a 250ms window
  // collapse into one fetch (e.g. parent-archive cascades cancel N deps).
  const scheduleRefetch = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      reload();
    }, 250);
  }, [reload]);

  useRealtimeEvent('dependency:requested',  scheduleRefetch);
  useRealtimeEvent('dependency:accepted',   scheduleRefetch);
  useRealtimeEvent('dependency:started',    scheduleRefetch);
  useRealtimeEvent('dependency:done',       scheduleRefetch);
  useRealtimeEvent('dependency:rejected',   scheduleRefetch);
  useRealtimeEvent('dependency:cancelled',  scheduleRefetch);
  useRealtimeEvent('dependency:reassigned', scheduleRefetch);

  const loading    = phase === 'initial';
  const refreshing = phase === 'refreshing';

  // Tab partitions. The "Completed" and "Rejected/Cancelled" tabs unify rows
  // from BOTH directions so the user sees their full history regardless of
  // whether they were the assignee or the requester.
  const tabRows = useMemo(() => {
    const ofMine = (xs, statuses) => xs.filter(r => statuses.includes(r.status));
    return {
      assigned:  ofMine(assigned, ACTIVE_STATUSES),
      created:   ofMine(created, ACTIVE_STATUSES),
      completed: dedupe([...ofMine(assigned, ['done']), ...ofMine(created, ['done'])]),
      rejected:  dedupe([
        ...ofMine(assigned, ['rejected', 'cancelled']),
        ...ofMine(created,  ['rejected', 'cancelled']),
      ]),
    };
  }, [assigned, created]);

  const counts = {
    assigned:  tabRows.assigned.length,
    created:   tabRows.created.length,
    completed: tabRows.completed.length,
    rejected:  tabRows.rejected.length,
  };

  const visibleRows = useMemo(() => {
    const base = tabRows[tab] || [];
    if (!search.trim()) return base;
    const q = search.toLowerCase();
    return base.filter(r =>
      (r.title || '').toLowerCase().includes(q) ||
      (r.parentTask?.title || '').toLowerCase().includes(q) ||
      (r.parentTask?.board?.name || '').toLowerCase().includes(q) ||
      (r.requestedBy?.name || '').toLowerCase().includes(q) ||
      (r.assignedTo?.name || '').toLowerCase().includes(q) ||
      (r.blockingReason || '').toLowerCase().includes(q)
    );
  }, [tabRows, tab, search]);

  // ─── Action handlers ─────────────────────────────────────────
  async function handleStatusChange(dep, newStatus, extraBody = {}) {
    try {
      await api.patch(`/dependencies/${dep.id}/status`, { status: newStatus, ...extraBody });
      toast.success(`Marked as ${newStatus.replace(/_/g, ' ')}.`);
      reload();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to update status.');
    }
  }

  async function handleCancel(dep) {
    if (!window.confirm(`Cancel dependency "${dep.title}"? The parent task will be unblocked once all dependencies clear.`)) return;
    try {
      await api.delete(`/dependencies/${dep.id}`);
      toast.success('Dependency cancelled.');
      reload();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to cancel.');
    }
  }

  async function handleArchive(dep) {
    try {
      await api.put(`/dependencies/${dep.id}/archive`);
      toast.success('Archived.');
      reload();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to archive.');
    }
  }

  function openParentTask(dep) {
    if (dep.parentTask?.boardId) {
      navigate(`/boards/${dep.parentTask.boardId}?task=${dep.parentTask.id}`);
    }
  }

  function openBoard(dep) {
    if (dep.parentTask?.boardId) {
      navigate(`/boards/${dep.parentTask.boardId}`);
    }
  }

  return (
    <div className="p-6 bg-white min-h-full">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="text-lg font-bold text-gray-800 flex items-center gap-2 mb-1">
            <Link2 size={18} className="text-purple-500" /> My Dependencies
          </h1>
          <p className="text-[12px] text-gray-400 mb-5">
            Track dependency work between you and your team
          </p>
        </motion.div>

        {/* Tabs */}
        <div className="flex items-center gap-1 mb-4 border-b border-gray-100 overflow-x-auto">
          {TABS.map(t => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`flex items-center gap-2 px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
                  active
                    ? 'border-purple-500 text-purple-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                <Icon size={13} />
                {t.label}
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                  active ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-500'
                }`}>
                  {counts[t.key]}
                </span>
              </button>
            );
          })}
        </div>

        {/* Search */}
        <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-lg border border-gray-200 bg-white">
          <Search size={14} className="text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by title, parent task, requester, board..."
            className="flex-1 bg-transparent border-none outline-none text-sm placeholder:text-gray-400"
          />
          {search && (
            <button onClick={() => setSearch('')} className="text-gray-400 hover:text-gray-600">
              <X size={14} />
            </button>
          )}
        </div>

        {/* Subtle refresh indicator — visible only during background refreshes,
            never on initial load (the skeleton already covers that case).
            Keeps the existing list visible underneath so the page doesn't
            jitter back to skeleton on every socket event. */}
        {refreshing && (
          <div className="flex items-center gap-2 text-[11px] text-gray-400 mb-2">
            <RefreshCw size={11} className="animate-spin" />
            <span>Refreshing…</span>
          </div>
        )}

        {/* Content */}
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="animate-pulse h-28 bg-gray-50 rounded-xl" />
            ))}
          </div>
        ) : visibleRows.length === 0 ? (
          <EmptyState tab={tab} hasSearch={!!search} />
        ) : (
          <div className="space-y-3">
            {visibleRows.map(dep => (
              <RequestCard
                key={dep.id}
                dep={dep}
                viewerId={user?.id}
                onStatus={handleStatusChange}
                onCancel={handleCancel}
                onArchive={handleArchive}
                onReject={() => setRejectTarget(dep)}
                onOpenParent={() => openParentTask(dep)}
                onOpenBoard={() => openBoard(dep)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Reject dialog */}
      {rejectTarget && (
        <RejectDependencyDialog
          dep={rejectTarget}
          onClose={() => setRejectTarget(null)}
          onSubmitted={() => { setRejectTarget(null); reload(); }}
        />
      )}
    </div>
  );
}

// ─── Request card ───────────────────────────────────────────────
function RequestCard({
  dep, viewerId,
  onStatus, onCancel, onArchive, onReject, onOpenParent, onOpenBoard,
}) {
  const status = STATUS_BADGES[dep.status] || STATUS_BADGES.pending;
  const priority = PRIORITY_BADGES[dep.priority] || PRIORITY_BADGES.medium;
  const isAssignee  = dep.assignedToUserId === viewerId;
  const isRequester = dep.requestedByUserId === viewerId;

  const dueOverdue = dep.dueDate && new Date(dep.dueDate) < new Date() && ACTIVE_STATUSES.includes(dep.status);

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className={`bg-white rounded-xl border p-4 hover:shadow-sm transition-shadow ${
        dep.status === 'rejected' ? 'border-red-200 bg-red-50/30' : 'border-gray-100'
      }`}
    >
      {/* Title row */}
      <div className="flex items-start gap-3 mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            {/* Phase 11 — distinguish dependency requests from regular tasks
                with a persistent "Dependency Request" type chip in the
                top-left of every card. */}
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 ring-1 ring-purple-200">
              <Link2 size={10} /> Dependency Request
            </span>
            <span className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full ring-1 ${status.bg} ${status.text} ${status.ring}`}>
              {status.label}
            </span>
            <span className="text-[10px] font-medium uppercase tracking-wide flex items-center gap-1" style={{ color: priority.color }}>
              <Flag size={10} /> {priority.label}
            </span>
            {dueOverdue && (
              <span className="text-[10px] font-bold uppercase text-red-600 flex items-center gap-1">
                <AlertCircle size={10} /> Overdue
              </span>
            )}
          </div>
          <h3 className="text-sm font-semibold text-gray-800 truncate">{dep.title}</h3>
          {dep.parentTask && (
            <button
              onClick={onOpenParent}
              className="text-[11px] text-gray-500 hover:text-purple-600 hover:underline mt-0.5 inline-flex items-center gap-1"
            >
              in parent task <span className="font-medium">{dep.parentTask.title}</span>
              <ExternalLink size={10} />
            </button>
          )}
        </div>
      </div>

      {/* Meta row */}
      <div className="flex items-center flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-500 mb-2">
        {dep.parentTask?.board?.name && (
          <button onClick={onOpenBoard} className="flex items-center gap-1 hover:text-purple-600">
            <span className="w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: dep.parentTask.board.color || '#0073ea' }} />
            {dep.parentTask.board.name}
          </button>
        )}
        {dep.dueDate && (
          <span className={`flex items-center gap-1 ${dueOverdue ? 'text-red-600 font-medium' : ''}`}>
            <Calendar size={11} /> {String(dep.dueDate).slice(0, 10)}
          </span>
        )}
      </div>

      {/* People row — only show roles that exist on this row, deduped */}
      <PeopleRow dep={dep} />

      {/* Blocking reason */}
      {dep.blockingReason && (
        <div className="flex gap-2 mt-2 px-3 py-2 rounded-md bg-gray-50 text-[11px] text-gray-600 leading-relaxed">
          <FileText size={11} className="mt-0.5 flex-shrink-0 text-gray-400" />
          <span className="italic">{dep.blockingReason}</span>
        </div>
      )}

      {/* Rejection reason — surface prominently when present */}
      {dep.status === 'rejected' && dep.rejectionReason && (
        <div className="flex gap-2 mt-2 px-3 py-2 rounded-md bg-red-50 text-[11px] text-red-700 leading-relaxed border border-red-200">
          <AlertCircle size={11} className="mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium">Rejected</p>
            <p>{dep.rejectionReason}</p>
          </div>
        </div>
      )}

      {/* Footer: timestamps + actions */}
      <div className="flex items-end justify-between mt-3 pt-2 border-t border-gray-50">
        <p className="text-[10px] text-gray-400">
          Created {formatRelative(dep.createdAt)}
          {dep.updatedAt && dep.updatedAt !== dep.createdAt && (
            <> · Updated {formatRelative(dep.updatedAt)}</>
          )}
        </p>
        <ActionBar
          dep={dep}
          isAssignee={isAssignee}
          isRequester={isRequester}
          onStatus={onStatus}
          onCancel={onCancel}
          onArchive={onArchive}
          onReject={onReject}
          onOpenParent={onOpenParent}
        />
      </div>
    </motion.div>
  );
}

function PeopleRow({ dep }) {
  // Build a list of distinct people with their role labels. requestedBy /
  // assignedTo / originalAssigner can each be null when the underlying user
  // was deleted (FK SET NULL); we still render the row label with an
  // "(unavailable)" fallback so the chain reads correctly.
  const people = [];
  people.push({ key: 'requester',  label: 'Requested by',   user: dep.requestedBy });
  people.push({ key: 'assignee',   label: 'Assigned to',    user: dep.assignedTo });
  if (dep.parentTask?.assignee && dep.parentTask.assignee.id !== dep.requestedBy?.id) {
    people.push({ key: 'parentOwner', label: 'Parent owner', user: dep.parentTask.assignee });
  }
  if (dep.originalAssigner && dep.originalAssigner.id !== dep.requestedBy?.id && dep.originalAssigner.id !== dep.parentTask?.assignee?.id) {
    people.push({ key: 'orig', label: 'Originally assigned by', user: dep.originalAssigner });
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 mb-1 text-[11px]">
      {people.map(p => (
        <span key={p.key} className="flex items-center gap-1 text-gray-500">
          <span className="text-gray-400">{p.label}</span>
          {p.user ? (
            <>
              <Avatar name={p.user.name} size="xs" />
              <span className="font-medium text-gray-700">{p.user.name}</span>
            </>
          ) : (
            <span className="italic text-amber-600">unavailable</span>
          )}
        </span>
      ))}
    </div>
  );
}

function ActionBar({ dep, isAssignee, isRequester, onStatus, onCancel, onArchive, onReject, onOpenParent }) {
  const status = dep.status;

  // Status-specific assignee actions (Phase 7 spec)
  const buttons = [];
  if (isAssignee && status === 'pending') {
    buttons.push(
      { key: 'accept', label: 'Accept',     icon: Check,  onClick: () => onStatus(dep, 'accepted'),       primary: false },
      { key: 'start',  label: 'Start Work', icon: Play,   onClick: () => onStatus(dep, 'working_on_it'),  primary: true  },
      { key: 'reject', label: 'Reject',     icon: X,      onClick: onReject,                              danger: true   },
    );
  } else if (isAssignee && status === 'accepted') {
    buttons.push(
      { key: 'start',  label: 'Start Work', icon: Play,   onClick: () => onStatus(dep, 'working_on_it'),  primary: true  },
      { key: 'done',   label: 'Mark Done',  icon: Check,  onClick: () => onStatus(dep, 'done'),           primary: false },
      { key: 'reject', label: 'Reject',     icon: X,      onClick: onReject,                              danger: true   },
    );
  } else if (isAssignee && status === 'working_on_it') {
    buttons.push(
      { key: 'done',   label: 'Mark Done', icon: Check, onClick: () => onStatus(dep, 'done'),           primary: true },
      { key: 'reject', label: 'Reject',    icon: X,     onClick: onReject,                              danger: true  },
    );
  }

  // Requester-side actions for active rows
  if (isRequester && ACTIVE_STATUSES.concat(['rejected']).includes(status)) {
    buttons.push(
      { key: 'cancel', label: 'Cancel', icon: Trash2, onClick: () => onCancel(dep), danger: true },
    );
  }

  // Closed-state actions: archive available to assignee/requester/manager
  if (['done', 'cancelled', 'rejected'].includes(status) && !dep.archivedAt) {
    buttons.push(
      { key: 'archive', label: 'Archive', icon: Archive, onClick: () => onArchive(dep), muted: true },
    );
  }

  // Always-available: open parent
  buttons.push(
    { key: 'parent', label: 'Open Parent', icon: ExternalLink, onClick: onOpenParent, muted: true },
  );

  return (
    <div className="flex items-center gap-1.5 flex-wrap justify-end">
      {buttons.map(b => {
        const Icon = b.icon;
        const cls = b.primary
          ? 'bg-emerald-500 text-white hover:bg-emerald-600'
          : b.danger
            ? 'bg-red-50 text-red-600 hover:bg-red-100 border border-red-100'
            : b.muted
              ? 'bg-gray-50 text-gray-500 hover:bg-gray-100'
              : 'bg-blue-50 text-blue-600 hover:bg-blue-100 border border-blue-100';
        return (
          <button
            key={b.key}
            onClick={b.onClick}
            className={`flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium rounded-md transition-colors ${cls}`}
          >
            <Icon size={11} /> {b.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Empty state ───────────────────────────────────────────────
function EmptyState({ tab, hasSearch }) {
  if (hasSearch) {
    return (
      <div className="text-center py-16 bg-gray-50 rounded-xl">
        <Search size={28} className="text-gray-200 mx-auto mb-3" />
        <p className="text-sm text-gray-500">No matches.</p>
      </div>
    );
  }
  const copy = {
    assigned:  { title: 'No dependency requests assigned to you.',   sub: 'When teammates need work from you to unblock their tasks, requests will appear here.' },
    created:   { title: 'You have not requested dependency work yet.', sub: 'Open a task and click "Add Dependency" to request blocker work from a teammate.' },
    completed: { title: 'No completed dependencies yet.',              sub: 'Finished dependency work — yours or work you requested — will be archived here.' },
    rejected:  { title: 'Nothing rejected or cancelled.',              sub: 'Dependency requests that were rejected or cancelled will be listed here.' },
  }[tab] || { title: 'Nothing here.', sub: '' };
  return (
    <div className="text-center py-16 bg-gray-50 rounded-xl">
      <Link2 size={28} className="text-gray-200 mx-auto mb-3" />
      <p className="text-sm text-gray-700 font-medium mb-1">{copy.title}</p>
      <p className="text-[12px] text-gray-400 max-w-sm mx-auto">{copy.sub}</p>
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────────
function dedupe(rows) {
  const seen = new Set();
  return rows.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

function formatRelative(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const day = Math.floor(h / 24); if (day < 30) return `${day}d ago`;
  return d.toLocaleDateString();
}
