import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  Link2, Inbox, Send, CheckCircle2, XCircle, Search,
  Calendar, Flag, ExternalLink, Play, Check, X, Trash2,
  AlertCircle, FileText, Archive, RefreshCw, ArrowRight,
  Network,
} from 'lucide-react';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useT } from '../context/LanguageContext';
import { useToast } from '../components/common/Toast';

// TODO i18n: further strings (form labels, error messages, dialogs) still hardcoded — extend in a future pass
import Avatar from '../components/common/Avatar';
import useRealtimeEvent from '../realtime/useRealtimeEvent';
import RejectDependencyDialog from '../components/dependencies/RejectDependencyDialog';

// ── Soft Neumorphic design tokens (aligned with the Approvals page) ──
// Mirrors the canonical app palette used in TasksPage (Approvals & Requests):
// neutral slate surfaces + indigo brand accent, semantic mint/amber/coral
// for status meaning. Old purple/pink/lavender pastels removed.
const TONE = {
  pageBg:        '#F3F5FA',
  tile:          '#F6F7FB',
  textPrimary:   '#323338',
  textSecondary: '#676879',
  textMuted:     '#94A3B8',
  onDark:        '#FAFAFA',
  indigo:        '#4F46E5',
  indigoDeep:    '#4338CA',
  indigoSoft:    '#EEF2FF',
  mint:          '#10B981',
  mintText:      '#047857',
  coral:         '#DC2626',
  coralText:     '#B91C1C',
  amber:         '#F59E0B',
  amberText:     '#C2410C',
};

// Subtle gradients — indigo/mint hint instead of the previous strong
// lavender/pink/peach pastels. Hero gets a soft mint tail to signal "this
// is your active piece of work"; secondary stays in an indigo-soft band.
const HERO_GRADIENT      = 'linear-gradient(135deg, #EEF2FF 0%, #F3F4F6 55%, #ECFDF5 100%)';
const SECONDARY_GRADIENT = 'linear-gradient(135deg, #EEF2FF 0%, #E0E7FF 100%)';

// Slate-based neumorphic shadows — match the Approvals page exactly so
// both pages read as part of the same surface system.
const SHADOW_RAISED    = '5px 5px 12px rgba(148, 163, 184, 0.30), -5px -5px 12px rgba(255, 255, 255, 0.95)';
const SHADOW_RAISED_LG = '7px 7px 16px rgba(148, 163, 184, 0.36), -7px -7px 16px rgba(255, 255, 255, 1), inset 1px 1px 2px rgba(255, 255, 255, 0.5)';
const SHADOW_PRESSED   = 'inset 2px 2px 5px rgba(148, 163, 184, 0.22), inset -2px -2px 5px rgba(255, 255, 255, 0.95)';
const SHADOW_BUTTON    = '3px 3px 6px rgba(148, 163, 184, 0.32), -3px -3px 6px rgba(255, 255, 255, 0.95)';

const STATUS_BADGES = {
  pending:        { label: 'Pending',       bg: '#F1F5F9', fg: '#475569' }, // slate neutral
  accepted:       { label: 'Accepted',      bg: '#E0E7FF', fg: '#4338CA' }, // indigo soft
  working_on_it:  { label: 'Working on it', bg: '#FEF3C7', fg: '#92400E' }, // amber soft
  done:           { label: 'Done',          bg: '#D1FAE5', fg: '#047857' }, // mint
  rejected:       { label: 'Rejected',      bg: '#FEE2E2', fg: '#B91C1C' }, // coral
  cancelled:      { label: 'Cancelled',     bg: '#E5E7EB', fg: '#4B5563' }, // slate
};

const PRIORITY_BADGES = {
  low:      { label: 'Low',      fg: '#047857' }, // mint
  medium:   { label: 'Medium',   fg: '#C2410C' }, // amber text
  high:     { label: 'High',     fg: '#B91C1C' }, // coral
  critical: { label: 'Critical', fg: '#7F1D1D' }, // deep coral
};

const TABS = [
  { key: 'assigned',  label: 'Assigned to Me',      icon: Inbox },
  { key: 'created',   label: 'Created by Me',       icon: Send },
  { key: 'completed', label: 'Completed',           icon: CheckCircle2 },
  { key: 'rejected',  label: 'Rejected / Cancelled', icon: XCircle },
];

const ACTIVE_STATUSES = ['pending', 'accepted', 'working_on_it'];

export default function DependenciesPage() {
  const { user } = useAuth();
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  // Map TABS[].key → translation key. Untranslated keys fall back to t.label.
  const DEP_TAB_LABEL_KEYS = {
    assigned: 'dependenciesPage.tabs.assigned',
    created: 'dependenciesPage.tabs.created',
    completed: 'dependenciesPage.tabs.completed',
    rejected: 'dependenciesPage.tabs.rejected',
  };

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
  const errored    = phase === 'error';

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

  // Global stats — derived from already-loaded arrays only. No new API.
  const stats = useMemo(() => {
    const activeUnion = dedupe([...tabRows.assigned, ...tabRows.created]);
    const now = startOfDay(new Date());
    const in7 = new Date(now.getTime() + 7 * 86_400_000);
    const dueSoon = activeUnion.filter(r => {
      if (!r.dueDate) return false;
      const d = startOfDay(new Date(r.dueDate));
      return d >= now && d <= in7;
    });
    return {
      active:    activeUnion.length,
      dueSoon:   dueSoon.length,
      completed: tabRows.completed.length,
      rejected:  tabRows.rejected.length,
    };
  }, [tabRows]);

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

  // Bento split — backend order is preserved, no client-side resort.
  const hero      = visibleRows[0] || null;
  const secondary = visibleRows[1] || null;
  const rest      = visibleRows.slice(2);

  const cardCommonProps = {
    viewerId: user?.id,
    onStatus: handleStatusChange,
    onCancel: handleCancel,
    onArchive: handleArchive,
    onReject: (dep) => setRejectTarget(dep),
    onOpenParent: openParentTask,
    onOpenBoard: openBoard,
  };

  return (
    <div className="min-h-full p-4 sm:p-6" style={{ backgroundColor: TONE.pageBg }}>
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="mb-4"
        >
          <div className="flex items-start gap-2">
            <h1
              className="text-xl sm:text-2xl font-bold flex items-center gap-2.5 mb-0.5 flex-1 min-w-0"
              style={{ color: TONE.textPrimary, letterSpacing: '-0.02em' }}
            >
              <span
                className="w-9 h-9 flex items-center justify-center"
                style={{ background: HERO_GRADIENT, boxShadow: SHADOW_BUTTON, borderRadius: 12 }}
                aria-hidden="true"
              >
                <Link2 size={16} style={{ color: TONE.indigo }} />
              </span>
              {t('dependenciesPage.title')}
            </h1>
            {/* View graph — visual companion at /dependencies/graph. Surfaced
                inline (not behind a tab) so users discover it on first visit. */}
            <button
              type="button"
              onClick={() => navigate('/dependencies/graph')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold border border-border bg-surface text-text-secondary hover:bg-surface-100 hover:text-primary flex-shrink-0"
              title="See task → task dependencies as a visual graph"
            >
              <Network size={12} /> View graph
            </button>
          </div>
          <p className="text-[13px] ml-[46px]" style={{ color: TONE.textSecondary }}>
            {t('dependenciesPage.subtitle')}
          </p>
        </motion.div>

        {/* Tabs as pill chips */}
        <div className="flex items-center gap-1.5 mb-3 flex-wrap" role="tablist" aria-label="Dependency views">
          {TABS.map(tabItem => {
            const Icon = tabItem.icon;
            const active = tab === tabItem.key;
            const label = DEP_TAB_LABEL_KEYS[tabItem.key] ? t(DEP_TAB_LABEL_KEYS[tabItem.key]) : tabItem.label;
            return (
              <button
                key={tabItem.key}
                role="tab"
                aria-selected={active}
                onClick={() => setTab(tabItem.key)}
                className="flex items-center gap-1.5 px-3 sm:px-3.5 py-1.5 text-[11px] sm:text-[12px] font-semibold transition-all duration-200 whitespace-nowrap"
                style={{
                  borderRadius: 999,
                  ...(active
                    ? { backgroundColor: TONE.indigoDeep, color: TONE.onDark, boxShadow: SHADOW_BUTTON }
                    : { backgroundColor: TONE.pageBg, color: TONE.textSecondary, boxShadow: SHADOW_PRESSED }),
                }}
              >
                <Icon size={12} />
                <span>{label}</span>
                <span
                  className="text-[10px] font-bold px-1.5 py-0.5"
                  style={{
                    borderRadius: 999,
                    ...(active
                      ? { backgroundColor: 'rgba(255,255,255,0.18)', color: TONE.onDark }
                      : { backgroundColor: 'rgba(45,48,71,0.06)', color: TONE.textPrimary }),
                  }}
                >
                  {counts[tabItem.key]}
                </span>
              </button>
            );
          })}
        </div>

        {/* Search */}
        <div
          className="flex items-center gap-2.5 mb-4 px-3.5 py-2.5"
          style={{ backgroundColor: TONE.pageBg, boxShadow: SHADOW_PRESSED, borderRadius: 12 }}
        >
          <Search size={14} style={{ color: TONE.textMuted }} />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('dependenciesPage.searchPlaceholder')}
            className="flex-1 bg-transparent border-none outline-none text-[13px]"
            style={{ color: TONE.textPrimary }}
            aria-label={t('dependenciesPage.searchPlaceholder')}
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              aria-label="Clear search"
              className="p-1 transition-opacity hover:opacity-70"
              style={{ color: TONE.textMuted }}
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Subtle refresh indicator — visible only during background refreshes,
            never on initial load (the skeleton already covers that case). */}
        {refreshing && (
          <div className="flex items-center gap-2 text-[11px] mb-2" style={{ color: TONE.textMuted }}>
            <RefreshCw size={11} className="animate-spin" />
            <span>Refreshing…</span>
          </div>
        )}

        {/* Content */}
        {loading ? (
          <LoadingSkeleton />
        ) : errored ? (
          <ErrorState onRetry={reload} />
        ) : visibleRows.length === 0 ? (
          <EmptyState tab={tab} hasSearch={!!search} />
        ) : (
          <>
            {/* Bento: hero + optional secondary */}
            {secondary ? (
              <div className="grid gap-3 sm:gap-4 mb-4 lg:grid-cols-3">
                <div className="lg:col-span-2">
                  <HeroCard dep={hero} {...cardCommonProps} />
                </div>
                <div>
                  <SecondaryCard dep={secondary} {...cardCommonProps} />
                </div>
              </div>
            ) : (
              <div className="mb-4">
                <HeroCard dep={hero} {...cardCommonProps} />
              </div>
            )}

            {/* Stats — global summary, derived from already-loaded data */}
            <StatsRow stats={stats} />

            {/* Compact rows for #3+ */}
            {rest.length > 0 && (
              <div className="mt-4 space-y-2.5">
                {rest.map((dep, idx) => (
                  <CompactRow
                    key={dep.id}
                    dep={dep}
                    delay={Math.min(idx * 0.04, 0.24)}
                    {...cardCommonProps}
                  />
                ))}
              </div>
            )}
          </>
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

// ─── Hero card ──────────────────────────────────────────────────
function HeroCard({ dep, viewerId, onStatus, onCancel, onArchive, onReject, onOpenParent, onOpenBoard }) {
  if (!dep) return null;
  const isAssignee  = dep.assignedToUserId === viewerId;
  const isRequester = dep.requestedByUserId === viewerId;
  const dueInfo = dueLabel(dep);

  return (
    <motion.section
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      className="relative p-4 sm:p-5 h-full"
      style={{ background: HERO_GRADIENT, borderRadius: 20, boxShadow: SHADOW_RAISED_LG }}
      aria-label={`Dependency request: ${dep.title}`}
    >
      {/* Pills */}
      <div className="flex flex-wrap items-center gap-1.5 mb-3">
        <StatusPill status={dep.status} />
        <PriorityPill priority={dep.priority} />
        {dep.parentTask?.board?.name && (
          <BoardPill
            name={dep.parentTask.board.name}
            color={dep.parentTask.board.color}
            onClick={() => onOpenBoard(dep)}
          />
        )}
        {dueInfo && (
          <span
            className="ml-auto text-[10.5px] font-semibold px-2.5 py-0.5 inline-flex items-center gap-1"
            style={{
              backgroundColor: 'rgba(255,255,255,0.7)',
              color: dueInfo.overdue ? TONE.coral : TONE.textPrimary,
              boxShadow: SHADOW_BUTTON,
              borderRadius: 999,
            }}
          >
            <Calendar size={10} /> {dueInfo.label}
          </span>
        )}
      </div>

      {/* Title */}
      <h2
        className="text-lg sm:text-xl lg:text-[26px] font-bold leading-tight mb-2"
        style={{ color: TONE.textPrimary, letterSpacing: '-0.02em' }}
      >
        {dep.title}
      </h2>

      {/* Parent chip */}
      {dep.parentTask && (
        <button
          onClick={() => onOpenParent(dep)}
          className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 mb-3 transition-transform hover:-translate-y-px max-w-full"
          style={{
            backgroundColor: 'rgba(255,255,255,0.55)',
            color: TONE.textPrimary,
            boxShadow: SHADOW_BUTTON,
            borderRadius: 999,
          }}
          aria-label={`Open parent task ${dep.parentTask.title}`}
        >
          <span style={{ color: TONE.textMuted }}>in</span>
          <span className="font-semibold truncate">{dep.parentTask.title}</span>
          <ExternalLink size={10} />
        </button>
      )}

      {/* Requester → Assignee chain */}
      <div
        className="flex items-center gap-3 sm:gap-4 px-3 py-2.5 mb-3 flex-wrap"
        style={{ backgroundColor: 'rgba(255,255,255,0.6)', borderRadius: 14 }}
      >
        <PersonBlock label="Requester" user={dep.requestedBy} highlightIfSelf={viewerId} />
        <ArrowRight size={14} style={{ color: TONE.textMuted }} className="flex-shrink-0" aria-hidden="true" />
        <PersonBlock label="Assignee" user={dep.assignedTo} highlightIfSelf={viewerId} />
      </div>

      {/* Blocking reason */}
      {dep.blockingReason && (
        <div
          className="flex gap-2 mb-3 px-3 py-2 text-[12px] leading-relaxed"
          style={{ backgroundColor: 'rgba(255,255,255,0.55)', color: TONE.textSecondary, borderRadius: 12 }}
        >
          <FileText size={12} className="mt-0.5 flex-shrink-0" style={{ color: TONE.textMuted }} />
          <span className="italic">{dep.blockingReason}</span>
        </div>
      )}

      {/* Rejection reason — surface prominently when present */}
      {dep.status === 'rejected' && dep.rejectionReason && (
        <div
          className="flex gap-2 mb-3 px-3 py-2 text-[12px]"
          style={{ backgroundColor: '#FEE2E2', color: '#991B1B', borderRadius: 12 }}
        >
          <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-semibold">Rejected</p>
            <p>{dep.rejectionReason}</p>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
        <p className="text-[11px]" style={{ color: TONE.textMuted }}>
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
          onOpenParent={() => onOpenParent(dep)}
          variant="hero"
        />
      </div>
    </motion.section>
  );
}

// ─── Secondary card ─────────────────────────────────────────────
function SecondaryCard({ dep, viewerId, onStatus, onCancel, onArchive, onReject, onOpenParent }) {
  if (!dep) return null;
  const isAssignee  = dep.assignedToUserId === viewerId;
  const isRequester = dep.requestedByUserId === viewerId;
  const dueInfo = dueLabel(dep);

  return (
    <motion.section
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: 0.05 }}
      className="p-4 h-full flex flex-col"
      style={{ background: SECONDARY_GRADIENT, borderRadius: 20, boxShadow: SHADOW_RAISED_LG }}
      aria-label={`Dependency request: ${dep.title}`}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <StatusPill status={dep.status} compact />
        {dueInfo && (
          <span
            className="text-[10px] font-semibold"
            style={{ color: dueInfo.overdue ? TONE.coral : TONE.amberText }}
          >
            {dueInfo.label}
          </span>
        )}
      </div>

      <h3
        className="text-base sm:text-lg font-bold leading-tight mb-1.5"
        style={{ color: TONE.textPrimary, letterSpacing: '-0.01em' }}
      >
        {dep.title}
      </h3>

      {dep.parentTask && (
        <button
          onClick={() => onOpenParent(dep)}
          className="inline-flex items-center gap-1.5 text-[10px] font-medium px-2 py-0.5 self-start mb-2.5 transition-transform hover:-translate-y-px max-w-full"
          style={{
            backgroundColor: 'rgba(255,255,255,0.55)',
            color: TONE.textPrimary,
            boxShadow: SHADOW_BUTTON,
            borderRadius: 999,
          }}
          aria-label={`Open parent task ${dep.parentTask.title}`}
        >
          <span style={{ color: TONE.textMuted }}>in</span>
          <span className="font-semibold truncate">{dep.parentTask.title}</span>
          <ExternalLink size={9} />
        </button>
      )}

      <div className="flex items-center gap-2 mt-auto flex-wrap">
        <PersonBlock label={isAssignee ? 'From' : 'To'} user={isAssignee ? dep.requestedBy : dep.assignedTo} small highlightIfSelf={viewerId} />
      </div>

      <div className="mt-3 flex justify-end">
        <ActionBar
          dep={dep}
          isAssignee={isAssignee}
          isRequester={isRequester}
          onStatus={onStatus}
          onCancel={onCancel}
          onArchive={onArchive}
          onReject={onReject}
          onOpenParent={() => onOpenParent(dep)}
          variant="secondary"
        />
      </div>
    </motion.section>
  );
}

// ─── Compact row (3rd+ dependency) ──────────────────────────────
function CompactRow({ dep, viewerId, onStatus, onCancel, onArchive, onReject, onOpenParent, delay = 0 }) {
  const isAssignee  = dep.assignedToUserId === viewerId;
  const isRequester = dep.requestedByUserId === viewerId;
  const dueInfo = dueLabel(dep);

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay }}
      className="p-3 sm:p-3.5 transition-shadow duration-200"
      style={{ backgroundColor: TONE.pageBg, borderRadius: 16, boxShadow: SHADOW_RAISED }}
    >
      <div className="flex flex-col lg:flex-row lg:items-center gap-2.5 lg:gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 mb-1">
            <StatusPill status={dep.status} compact />
            <PriorityPill priority={dep.priority} compact />
            {dueInfo && (
              <span
                className="text-[10px] font-semibold inline-flex items-center gap-1"
                style={{ color: dueInfo.overdue ? TONE.coral : TONE.textMuted }}
              >
                <Calendar size={10} /> {dueInfo.label}
              </span>
            )}
          </div>
          <h4 className="text-[13px] font-bold truncate" style={{ color: TONE.textPrimary }}>
            {dep.title}
          </h4>
          {dep.parentTask && (
            <button
              onClick={() => onOpenParent(dep)}
              className="text-[11px] inline-flex items-center gap-1 mt-0.5 hover:underline"
              style={{ color: TONE.textSecondary }}
              aria-label={`Open parent task ${dep.parentTask.title}`}
            >
              in parent task <span className="font-medium" style={{ color: TONE.textPrimary }}>{dep.parentTask.title}</span>
              <ExternalLink size={10} />
            </button>
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[11px]" style={{ color: TONE.textSecondary }}>
            <PersonInline label="Requested by" user={dep.requestedBy} />
            <PersonInline label="Assigned to" user={dep.assignedTo} />
          </div>

          {dep.status === 'rejected' && dep.rejectionReason && (
            <div
              className="flex gap-2 mt-2 px-2.5 py-1.5 text-[11px]"
              style={{ backgroundColor: '#FEE2E2', color: '#991B1B', borderRadius: 10 }}
            >
              <AlertCircle size={11} className="mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-semibold">Rejected</p>
                <p>{dep.rejectionReason}</p>
              </div>
            </div>
          )}
        </div>

        <ActionBar
          dep={dep}
          isAssignee={isAssignee}
          isRequester={isRequester}
          onStatus={onStatus}
          onCancel={onCancel}
          onArchive={onArchive}
          onReject={onReject}
          onOpenParent={() => onOpenParent(dep)}
          variant="compact"
        />
      </div>
    </motion.div>
  );
}

// ─── Action bar ─────────────────────────────────────────────────
// Visibility rules preserved verbatim from the original (Phase 7 spec).
function ActionBar({ dep, isAssignee, isRequester, onStatus, onCancel, onArchive, onReject, onOpenParent, variant = 'compact' }) {
  const status = dep.status;
  const buttons = [];

  if (isAssignee && status === 'pending') {
    buttons.push(
      { key: 'accept', label: 'Accept',     icon: Check, onClick: () => onStatus(dep, 'accepted'),      kind: 'soft'    },
      { key: 'start',  label: 'Start Work', icon: Play,  onClick: () => onStatus(dep, 'working_on_it'), kind: 'primary' },
      { key: 'reject', label: 'Reject',     icon: X,     onClick: () => onReject(dep),                  kind: 'danger'  },
    );
  } else if (isAssignee && status === 'accepted') {
    buttons.push(
      { key: 'start',  label: 'Start Work', icon: Play,  onClick: () => onStatus(dep, 'working_on_it'), kind: 'primary' },
      { key: 'done',   label: 'Mark Done',  icon: Check, onClick: () => onStatus(dep, 'done'),          kind: 'soft'    },
      { key: 'reject', label: 'Reject',     icon: X,     onClick: () => onReject(dep),                  kind: 'danger'  },
    );
  } else if (isAssignee && status === 'working_on_it') {
    buttons.push(
      { key: 'done',   label: 'Mark Done', icon: Check, onClick: () => onStatus(dep, 'done'), kind: 'primary' },
      { key: 'reject', label: 'Reject',    icon: X,     onClick: () => onReject(dep),         kind: 'danger'  },
    );
  }

  if (isRequester && ACTIVE_STATUSES.concat(['rejected']).includes(status)) {
    buttons.push(
      { key: 'cancel', label: 'Cancel', icon: Trash2, onClick: () => onCancel(dep), kind: 'danger' },
    );
  }

  if (['done', 'cancelled', 'rejected'].includes(status) && !dep.archivedAt) {
    buttons.push(
      { key: 'archive', label: 'Archive', icon: Archive, onClick: () => onArchive(dep), kind: 'muted' },
    );
  }

  buttons.push(
    { key: 'parent', label: 'Open Parent', icon: ExternalLink, onClick: onOpenParent, kind: 'muted' },
  );

  return (
    <div className={`flex items-center gap-2 flex-wrap ${variant === 'compact' ? 'lg:justify-end' : 'justify-end'}`}>
      {buttons.map(b => (
        <NeoButton key={b.key} kind={b.kind} onClick={b.onClick} icon={b.icon}>
          {b.label}
        </NeoButton>
      ))}
    </div>
  );
}

// ─── Pill / button / person helpers ─────────────────────────────
function NeoButton({ kind = 'soft', onClick, icon: Icon, children }) {
  let style;
  if (kind === 'primary') {
    style = { backgroundColor: TONE.indigoDeep, color: TONE.onDark, boxShadow: SHADOW_BUTTON };
  } else if (kind === 'danger') {
    style = { backgroundColor: 'rgba(255,255,255,0.7)', color: TONE.coral, boxShadow: SHADOW_BUTTON };
  } else if (kind === 'muted') {
    style = { backgroundColor: TONE.pageBg, color: TONE.textSecondary, boxShadow: SHADOW_BUTTON };
  } else {
    // soft
    style = { backgroundColor: 'rgba(255,255,255,0.8)', color: TONE.textPrimary, boxShadow: SHADOW_BUTTON };
  }
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold transition-transform duration-150 hover:-translate-y-px active:translate-y-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
      style={{ ...style, borderRadius: 12 }}
    >
      {Icon ? <Icon size={11} /> : null}
      <span>{children}</span>
    </button>
  );
}

function StatusPill({ status, compact = false }) {
  const s = STATUS_BADGES[status] || STATUS_BADGES.pending;
  return (
    <span
      className={`inline-flex items-center font-semibold uppercase tracking-wide ${
        compact ? 'text-[9px] px-1.5 py-0.5' : 'text-[10px] px-2 py-0.5'
      }`}
      style={{ backgroundColor: s.bg, color: s.fg, borderRadius: 999 }}
    >
      {s.label}
    </span>
  );
}

function PriorityPill({ priority, compact = false }) {
  const p = PRIORITY_BADGES[priority] || PRIORITY_BADGES.medium;
  return (
    <span
      className={`inline-flex items-center gap-1 font-semibold uppercase tracking-wide ${
        compact ? 'text-[9px] px-1.5 py-0.5' : 'text-[10px] px-2 py-0.5'
      }`}
      style={{ backgroundColor: 'rgba(255,255,255,0.7)', color: p.fg, borderRadius: 999 }}
    >
      <Flag size={compact ? 8 : 9} /> {p.label}
    </span>
  );
}

function BoardPill({ name, color, onClick }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 text-[10px] font-semibold px-2 py-0.5 transition-transform hover:-translate-y-px max-w-[180px]"
      style={{ backgroundColor: 'rgba(255,255,255,0.7)', color: TONE.textPrimary, borderRadius: 999 }}
      aria-label={`Open board ${name}`}
    >
      <span className="w-1.5 h-1.5 flex-shrink-0" style={{ backgroundColor: color || TONE.indigo, borderRadius: 2 }} />
      <span className="truncate">{name}</span>
    </button>
  );
}

function PersonBlock({ label, user, small = false, highlightIfSelf }) {
  const isSelf = user?.id && highlightIfSelf && user.id === highlightIfSelf;
  return (
    <div className="flex items-center gap-2 min-w-0">
      <Avatar name={user?.name || '?'} image={user?.avatar} size={small ? 'xs' : 'sm'} />
      <div className="min-w-0">
        <p className="text-[9px] uppercase tracking-wide font-semibold" style={{ color: TONE.textMuted }}>{label}</p>
        <p className="text-[12px] sm:text-[13px] font-semibold truncate" style={{ color: TONE.textPrimary }}>
          {user?.name || <span className="italic" style={{ color: TONE.amberText }}>unavailable</span>}
          {isSelf && user?.name && <span className="ml-1 font-normal" style={{ color: TONE.textMuted }}>(you)</span>}
        </p>
      </div>
    </div>
  );
}

function PersonInline({ label, user }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span style={{ color: TONE.textMuted }}>{label}</span>
      {user ? (
        <>
          <Avatar name={user.name} image={user.avatar} size="xs" />
          <span className="font-medium" style={{ color: TONE.textPrimary }}>{user.name}</span>
        </>
      ) : (
        <span className="italic" style={{ color: TONE.amberText }}>unavailable</span>
      )}
    </span>
  );
}

// ─── Stats row ──────────────────────────────────────────────────
function StatsRow({ stats }) {
  const tiles = [
    { key: 'active',    label: 'Active',           value: stats.active,    accent: TONE.indigo },
    { key: 'dueSoon',   label: 'Due Soon',         value: stats.dueSoon,   accent: TONE.amber  },
    { key: 'completed', label: 'Completed',        value: stats.completed, accent: TONE.mint   },
    { key: 'rejected',  label: 'Rejected / Canc.', value: stats.rejected,  accent: TONE.coral  },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 sm:gap-3">
      {tiles.map(tile => <StatTile key={tile.key} {...tile} />)}
    </div>
  );
}

function StatTile({ label, value, accent }) {
  return (
    <div
      className="px-3.5 py-3 sm:px-4 sm:py-3.5"
      style={{ backgroundColor: TONE.pageBg, borderRadius: 16, boxShadow: SHADOW_RAISED }}
    >
      <p
        className="text-[10px] uppercase tracking-wide font-semibold mb-1"
        style={{ color: TONE.textMuted }}
      >
        {label}
      </p>
      <p
        className="text-xl sm:text-2xl font-bold leading-tight"
        style={{ color: TONE.textPrimary, letterSpacing: '-0.02em' }}
      >
        {value}
      </p>
      <span
        className="inline-block w-6 h-0.5 mt-1.5"
        style={{ backgroundColor: accent, opacity: 0.55, borderRadius: 999 }}
      />
    </div>
  );
}

// ─── Loading / error / empty ────────────────────────────────────
function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:gap-4 lg:grid-cols-3">
        <div
          className="h-44 lg:col-span-2 animate-pulse"
          style={{ background: HERO_GRADIENT, opacity: 0.5, borderRadius: 20, boxShadow: SHADOW_RAISED }}
          aria-hidden="true"
        />
        <div
          className="h-44 animate-pulse"
          style={{ background: SECONDARY_GRADIENT, opacity: 0.5, borderRadius: 20, boxShadow: SHADOW_RAISED }}
          aria-hidden="true"
        />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        {[1, 2, 3, 4].map(i => (
          <div
            key={i}
            className="h-[88px] animate-pulse"
            style={{ backgroundColor: TONE.pageBg, borderRadius: 16, boxShadow: SHADOW_RAISED }}
            aria-hidden="true"
          />
        ))}
      </div>
      <div className="space-y-2.5">
        {[1, 2].map(i => (
          <div
            key={i}
            className="h-[76px] animate-pulse"
            style={{ backgroundColor: TONE.pageBg, borderRadius: 16, boxShadow: SHADOW_RAISED }}
            aria-hidden="true"
          />
        ))}
      </div>
    </div>
  );
}

function ErrorState({ onRetry }) {
  return (
    <div
      className="text-center py-10 px-6"
      style={{ backgroundColor: TONE.pageBg, borderRadius: 18, boxShadow: SHADOW_PRESSED }}
    >
      <div
        className="w-12 h-12 mx-auto mb-3 flex items-center justify-center"
        style={{ background: HERO_GRADIENT, boxShadow: SHADOW_BUTTON, borderRadius: 999 }}
        aria-hidden="true"
      >
        <AlertCircle size={20} style={{ color: TONE.coral }} />
      </div>
      <p className="text-[13px] font-semibold mb-1" style={{ color: TONE.textPrimary }}>
        Could not load dependencies.
      </p>
      <p className="text-[12px] mb-3" style={{ color: TONE.textSecondary }}>
        Check your connection and try again.
      </p>
      <button
        onClick={onRetry}
        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[12px] font-semibold"
        style={{ backgroundColor: TONE.indigoDeep, color: TONE.onDark, borderRadius: 12, boxShadow: SHADOW_BUTTON }}
      >
        <RefreshCw size={11} /> Retry
      </button>
    </div>
  );
}

function EmptyState({ tab, hasSearch }) {
  if (hasSearch) {
    return (
      <div
        className="text-center py-10 px-6"
        style={{ backgroundColor: TONE.pageBg, borderRadius: 18, boxShadow: SHADOW_PRESSED }}
      >
        <div
          className="w-12 h-12 mx-auto mb-3 flex items-center justify-center"
          style={{ backgroundColor: TONE.pageBg, boxShadow: SHADOW_RAISED, borderRadius: 999 }}
          aria-hidden="true"
        >
          <Search size={18} style={{ color: TONE.textMuted }} />
        </div>
        <p className="text-[13px] font-semibold" style={{ color: TONE.textPrimary }}>No matches.</p>
        <p className="text-[12px] mt-1" style={{ color: TONE.textSecondary }}>Try a different search term.</p>
      </div>
    );
  }
  const copy = {
    assigned:  { title: 'All clear',                       sub: 'When teammates need work from you to unblock their tasks, requests will appear here.' },
    created:   { title: 'Nothing requested yet',           sub: 'Open a task and click "Add Dependency" to request blocker work from a teammate.' },
    completed: { title: 'No completed dependencies yet',   sub: 'Finished dependency work — yours or work you requested — will appear here.' },
    rejected:  { title: 'Nothing rejected or cancelled',   sub: 'Dependency requests that were rejected or cancelled will be listed here.' },
  }[tab] || { title: 'Nothing here.', sub: '' };
  return (
    <div
      className="text-center py-10 px-6"
      style={{ backgroundColor: TONE.pageBg, borderRadius: 18, boxShadow: SHADOW_PRESSED }}
    >
      <div
        className="w-14 h-14 mx-auto mb-3 flex items-center justify-center"
        style={{ background: HERO_GRADIENT, boxShadow: SHADOW_BUTTON, borderRadius: 999 }}
        aria-hidden="true"
      >
        <Link2 size={20} style={{ color: TONE.indigo }} />
      </div>
      <p className="text-[14px] font-bold mb-1" style={{ color: TONE.textPrimary }}>{copy.title}</p>
      <p className="text-[12px] max-w-sm mx-auto" style={{ color: TONE.textSecondary }}>{copy.sub}</p>
    </div>
  );
}

// ─── Pure helpers ───────────────────────────────────────────────
function dedupe(rows) {
  const seen = new Set();
  return rows.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function dueLabel(dep) {
  if (!dep?.dueDate) return null;
  const due = startOfDay(new Date(dep.dueDate));
  const now = startOfDay(new Date());
  const days = Math.round((due - now) / 86_400_000);
  const isActive = ACTIVE_STATUSES.includes(dep.status);
  if (days < 0) {
    if (isActive) return { label: `${Math.abs(days)}d overdue`, overdue: true };
    return { label: String(dep.dueDate).slice(0, 10), overdue: false };
  }
  if (days === 0) return { label: 'Today',     overdue: false };
  if (days === 1) return { label: '1d left',   overdue: false };
  return            { label: `${days}d left`, overdue: false };
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
