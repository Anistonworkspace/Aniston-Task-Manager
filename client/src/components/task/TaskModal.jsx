import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  X, MessageSquare, Paperclip, Activity, Clock, Tag, Link2, Zap, Shield,
  HelpCircle, Calendar, Check, Lock, Settings, Plus, Pencil,
  ChevronDown, ChevronRight, RefreshCw, Bookmark, Bell, User as UserIcon,
  UserCheck, Flag, Circle, FileText, Star, Eye as EyeIcon, MoreHorizontal,
  ChevronUp, Maximize2, Copy, Trash2, Archive, Send,
} from 'lucide-react';
import { format, parseISO, formatDistanceToNowStrict } from 'date-fns';
import { useAuth } from '../../context/AuthContext';
import { STATUS_CONFIG, PRIORITY_CONFIG, DEFAULT_STATUSES, buildStatusLookup, getBoardStatuses, STATUS_PRESET_COLORS } from '../../utils/constants';
import api from '../../services/api';
import Avatar from '../common/Avatar';
import TaskComments from './TaskComments';
import TaskFiles from './TaskFiles';
import SubtaskList from './SubtaskList';
import WorkLogSection from './WorkLogSection';
import ActivityFeed from './ActivityFeed';
import DependencyBadge from '../dependencies/DependencyBadge';
import DependencySelector from '../dependencies/DependencySelector';
import DependencyWorkSection from '../dependencies/DependencyWorkSection';

import ApprovalSection from './ApprovalSection';
import DueDateExtensionModal from './DueDateExtensionModal';
import HelpRequestModal from './HelpRequestModal';
import ConflictWarning from './ConflictWarning';
import TaskReminderField from './TaskReminderField';
import { groupFlowsByLogicalStage, rollUpStageStatus, currentLogicalStage } from '../../utils/approvalStages';

function normalizeReminderProps(incoming) {
  if (!Array.isArray(incoming)) return [];
  return incoming.map((r) => {
    if (!r || typeof r !== 'object') return null;
    if (r.kind === 'offset' || r.reminderType === 'offset') {
      const m = Number(r.offsetMinutes);
      return Number.isFinite(m) ? { kind: 'offset', offsetMinutes: m } : null;
    }
    if (r.kind === 'at_due' || r.reminderType === 'at_due') return { kind: 'at_due' };
    if (r.kind === 'custom' || r.reminderType === 'custom') {
      const at = r.at || r.customReminderAt;
      if (!at) return null;
      const d = new Date(at);
      return Number.isNaN(d.getTime()) ? null : { kind: 'custom', at: d.toISOString() };
    }
    return null;
  }).filter(Boolean);
}
import useGrammarCorrection from '../../hooks/useGrammarCorrection';
import GrammarSuggestion from '../common/GrammarSuggestion';
import useRealtimeEvent from '../../realtime/useRealtimeEvent';
import useRealtimeQuery from '../../realtime/useRealtimeQuery';
import DetailModalShell from '../common/DetailModalShell';
import { useToast } from '../common/Toast';
import MarkDoneApprovalModal from './MarkDoneApprovalModal';
import { canEditTask as canEditTaskFn, canEditTaskTitle as canEditTaskTitleFn, canSetPriorityForTask, canEditDueDate as canEditDueDateFn } from '../../utils/permissions';
import { formatTaskDate } from '../../utils/dateFormat';
import { resolveTier, tierLabel } from '../../utils/tiers';
import RecurringInstanceDetails from './RecurringInstanceDetails';

// ── v3 design tokens ──────────────────────────────────────────────────────
const ACCENT = {
  purple: '#7C3AED',
  teal:   '#0D9488',
  amber:  '#D97706',
  rose:   '#E11D48',
  violet: '#6D5CE7',
};

// ── Tiny presentational helpers ───────────────────────────────────────────

function ChipPill({ icon: Icon, label, color, textColor = '#fff', tone, title, onClick, dim, urgent }) {
  const palette = {
    neutral: 'bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:border-zinc-700',
    soft:    'bg-zinc-50 text-zinc-600 border-zinc-200 dark:bg-zinc-800/60 dark:text-zinc-300 dark:border-zinc-700',
  };
  if (color) {
    return (
      <span
        onClick={onClick}
        title={title}
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${onClick ? 'cursor-pointer' : ''} ${urgent ? 'v3-urgent-pulse' : ''}`}
        style={{ backgroundColor: dim ? `${color}1a` : color, color: dim ? color : textColor, border: dim ? `1px solid ${color}33` : undefined }}
      >
        {Icon && <Icon size={10} />}
        <span className="tabular-nums">{label}</span>
      </span>
    );
  }
  return (
    <span
      onClick={onClick}
      title={title}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${palette[tone || 'neutral']} ${onClick ? 'cursor-pointer hover:bg-zinc-200/60 dark:hover:bg-zinc-700/60' : ''}`}
    >
      {Icon && <Icon size={10} />}
      <span className="tabular-nums">{label}</span>
    </span>
  );
}

function V3Card({ accent = 'purple', title, action, children }) {
  const color = ACCENT[accent] || ACCENT.purple;
  return (
    <section className="v3-card" style={{ '--card-accent': color }}>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
          <h4 className="text-[10px] font-bold uppercase tracking-[0.08em] text-text-secondary">
            {title}
          </h4>
        </div>
        {action}
      </div>
      <div className="v3-card-divider mb-2" />
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function V3Row({ icon: Icon, label, children }) {
  return (
    <div className="flex items-start gap-2 text-[12px] min-h-[24px]">
      <div className="flex items-center gap-1.5 w-[78px] flex-shrink-0 text-text-secondary pt-0.5">
        {Icon && <Icon size={12} className="text-text-tertiary" />}
        <span className="truncate">{label}</span>
      </div>
      <div className="flex-1 min-w-0 flex items-center flex-wrap gap-1">{children}</div>
    </div>
  );
}

// Local IST/timezone-aware datetime label.
function formatDateTime(iso, opts = {}) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const dateStr = format(d, 'MMM d, yyyy');
    const timeStr = format(d, 'h:mm a');
    const tz = opts.includeZone
      ? (Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
          .formatToParts(d).find(p => p.type === 'timeZoneName')?.value || '')
      : '';
    return tz ? `${dateStr} · ${timeStr} ${tz}` : `${dateStr} · ${timeStr}`;
  } catch {
    return null;
  }
}

// Shorter compact form for the People card (e.g. "May 9 · 12:42 PM")
function formatCompactDateTime(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return format(d, sameYear ? 'MMM d · h:mm a' : 'MMM d, yyyy · h:mm a');
  } catch {
    return null;
  }
}

// Compute due-countdown chip ("Due in 8h" / "Overdue 2h" / null when far away).
// `dueDate` is a YYYY-MM-DD string from the model. `dueTimeStr` is 'HH:mm:ss' or
// 'HH:mm' from the recurring template; absent for normal tasks (we treat the
// deadline as end-of-day local time).
function computeCountdown(dueDate, dueTimeStr) {
  if (!dueDate) return null;
  let target;
  try {
    if (dueTimeStr) {
      const t = String(dueTimeStr).slice(0, 5);
      target = new Date(`${dueDate}T${t}:00`);
    } else {
      target = new Date(`${dueDate}T23:59:59`);
    }
    if (Number.isNaN(target.getTime())) return null;
  } catch { return null; }
  const now = new Date();
  const diffMs = target.getTime() - now.getTime();
  const absHours = Math.abs(diffMs) / 3600000;
  if (diffMs < 0) {
    if (absHours < 1) return { label: `Overdue ${Math.max(1, Math.round(absHours * 60))}m`, urgent: true };
    if (absHours < 24) return { label: `Overdue ${Math.round(absHours)}h`, urgent: true };
    return { label: `Overdue ${Math.round(absHours / 24)}d`, urgent: true };
  }
  if (absHours < 1) return { label: `Due in ${Math.max(1, Math.round(absHours * 60))}m`, urgent: true };
  if (absHours < 24) return { label: `Due in ${Math.round(absHours)}h`, urgent: true };
  if (absHours < 24 * 7) return { label: `Due in ${Math.round(absHours / 24)}d`, urgent: false };
  return null;
}

// ── Activity ribbon — a compact horizontal feed of recent events ──────────
function ActivityRibbon({ taskId, onSeeAll }) {
  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    api.get(`/activities?taskId=${taskId}&limit=4`).then(res => {
      if (cancelled) return;
      const data = res.data?.data || res.data;
      setItems(data.activities || []);
      setLoaded(true);
    }).catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [taskId]);

  if (!loaded || items.length === 0) return null;

  return (
    <div className="v3-ribbon -mx-1 px-1 py-1.5">
      <Activity size={11} className="text-text-tertiary flex-shrink-0" />
      {items.slice(0, 4).map((act, i) => {
        const actor = act.actor?.name || act.user?.name || 'Someone';
        const verb = (act.action || 'updated').replace(/_/g, ' ');
        const when = act.createdAt
          ? formatDistanceToNowStrict(parseISO(act.createdAt), { addSuffix: false })
          : '';
        return (
          <React.Fragment key={act.id || i}>
            {i > 0 && <span className="w-1 h-1 rounded-full bg-zinc-300 dark:bg-zinc-700 flex-shrink-0" />}
            <span className="text-[11px] text-text-secondary inline-flex items-center gap-1 flex-shrink-0">
              <span className="font-medium text-text-primary">{actor}</span>
              <span className="text-text-secondary">{verb}</span>
              {when && <span className="text-text-tertiary tabular-nums">· {when}</span>}
            </span>
          </React.Fragment>
        );
      })}
      {onSeeAll && (
        <button onClick={onSeeAll} className="text-[11px] font-medium text-[#6D5CE7] dark:text-[#A78BFA] hover:underline flex-shrink-0 ml-2">
          All activity →
        </button>
      )}
    </div>
  );
}

// ── Compact approval pipeline card — Overview tab ─────────────────────────
function ApprovalSummaryCard({ task, onOpenTab }) {
  const flows = task?.approvalFlows || [];
  const status = task?.approvalStatus || null;
  const stageGroups = useMemo(() => groupFlowsByLogicalStage(flows), [flows]);
  const totalStages = stageGroups.length;
  const doneStages = stageGroups.filter(g => {
    const r = rollUpStageStatus(g.rows);
    return r === 'approved' || r === 'submitted';
  }).length;

  const overall = (() => {
    if (status === 'approved') return { tone: 'green', headline: 'Fully approved — task complete' };
    if (status === 'rejected') return { tone: 'red', headline: 'Rejected' };
    if (status === 'changes_requested') return { tone: 'orange', headline: 'Changes requested' };
    if (status === 'pending_approval') return { tone: 'amber', headline: 'Approval in progress' };
    if (totalStages > 0) return { tone: 'amber', headline: 'Approval started' };
    return null;
  })();

  const subtitle = (() => {
    if (!flows.length) return null;
    const lastWithComment = [...flows].reverse().find(f => f.comment);
    if (lastWithComment) return `“${lastWithComment.comment}” — ${lastWithComment.userName || ''}`.trim();
    if (status === 'approved') {
      const finalRow = [...flows].reverse().find(f => f.status === 'approved');
      if (finalRow?.userName) return `Approved by ${finalRow.userName}`;
    }
    return null;
  })();

  if (!overall) return null;

  const toneMap = {
    green:  { ring: 'border-emerald-200 dark:border-emerald-800/50',  bg: 'bg-emerald-50/60 dark:bg-emerald-900/10',  dot: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-300' },
    amber:  { ring: 'border-amber-200 dark:border-amber-800/50',      bg: 'bg-amber-50/60 dark:bg-amber-900/10',      dot: 'bg-amber-500',   text: 'text-amber-700 dark:text-amber-300' },
    red:    { ring: 'border-red-200 dark:border-red-800/50',          bg: 'bg-red-50/60 dark:bg-red-900/10',          dot: 'bg-red-500',     text: 'text-red-700 dark:text-red-300' },
    orange: { ring: 'border-orange-200 dark:border-orange-800/50',    bg: 'bg-orange-50/60 dark:bg-orange-900/10',    dot: 'bg-orange-500',  text: 'text-orange-700 dark:text-orange-300' },
  };
  const tone = toneMap[overall.tone];

  return (
    <section className={`rounded-xl border ${tone.ring} ${tone.bg} px-4 py-3.5`}>
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 w-7 h-7 rounded-full ${tone.dot} text-white flex items-center justify-center flex-shrink-0`}>
          <Check size={14} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-3">
            <div className={`font-semibold text-[13px] ${tone.text}`}>{overall.headline}</div>
            <span className={`text-[11px] font-medium ${tone.text} flex-shrink-0 tabular-nums`}>{doneStages}/{totalStages || 1} stages</span>
          </div>
          {subtitle && (
            <div className="text-[11px] text-text-secondary mt-0.5 truncate" title={subtitle}>
              {subtitle}
            </div>
          )}
        </div>
      </div>

      {totalStages > 0 && (
        <div className="grid grid-cols-3 gap-2 mt-3">
          {stageGroups.map((group, i) => {
            const r = rollUpStageStatus(group.rows);
            const isApproved = r === 'approved' || r === 'submitted';
            const isCurrent = currentLogicalStage(stageGroups) === group.stage;
            const skipped = group.rows.some(x => x.status === 'skipped_parallel');
            const firstRow = group.rows[0];
            const time = firstRow?.actionAt ? format(new Date(firstRow.actionAt), 'h:mm a') : null;
            const note = firstRow?.comment ? `“${firstRow.comment}”` : (skipped ? 'auto-approved' : (isApproved ? 'submitted' : (isCurrent ? 'in review' : '—')));

            return (
              <div key={group.stage} className="rounded-lg bg-white/80 dark:bg-zinc-900/40 border border-zinc-200/70 dark:border-zinc-800 px-2.5 py-2 min-w-0">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
                  {isApproved ? <Check size={10} className="text-emerald-500" /> : isCurrent ? <Clock size={10} className="text-amber-500" /> : <Circle size={9} className="text-text-tertiary" />}
                  <span className="tabular-nums">Stage {i + 1}</span>
                </div>
                <div className="text-[12px] font-medium text-text-primary truncate mt-0.5" title={group.label}>
                  {group.label}
                </div>
                {firstRow?.userName && (
                  <div className="flex items-center gap-1.5 mt-1 text-[11px] text-text-secondary truncate">
                    <Avatar name={firstRow.userName} size="xs" />
                    <span className="truncate">{firstRow.userName}</span>
                  </div>
                )}
                <div className="text-[10px] text-text-tertiary truncate mt-0.5 tabular-nums" title={note}>
                  {time ? `${time} · ` : ''}{note}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {onOpenTab && (
        <button
          type="button"
          onClick={onOpenTab}
          className={`mt-3 inline-flex items-center gap-1 text-[11px] font-medium ${tone.text} hover:underline`}
        >
          <ChevronDown size={11} /> See full approval timeline
        </button>
      )}
    </section>
  );
}

export default function TaskModal({
  task, boardId, board, members = [], boardStatuses,
  onClose, onUpdate, onDelete,
  // Optional navigation hooks (parent supplies if it can sequence tasks).
  // Buttons hide cleanly when not provided — no breaking changes for callers
  // that don't pass them (TasksPage, MemberDrillDown, etc.).
  onPrev, onNext,
}) {
  const { user, canManage, isMember, isSuperAdmin, granularPermissions, isTier1, isTier2 } = useAuth();
  const { error: toastError, success: toastSuccess } = useToast();
  const shellCloseRef = useRef(null);
  const handleClose = () => (shellCloseRef.current ? shellCloseRef.current() : onClose());
  const isApproved = task?.approvalStatus === 'approved';
  const denyEdit = granularPermissions?.['tasks.edit'] === false;
  // Tier-based RBAC: only Tier 1 / Tier 2 get unrestricted "edit all fields"
  // power. The earlier `(canManage && task.creator.role !== 'admin')` clause
  // was a stale role-string check from before the tier migration; `isTier1
  // || isTier2` already covers everything `canManage` and `isAdmin` did
  // without re-promoting Tier 3 to full edit. Mirrors the backend
  // `checkTaskAction('edit')` gate (Tier 3/4 fall to the assignee/creator
  // whitelist).
  const canEditAllFields = !isApproved && !denyEdit && (isTier1 || isTier2);
  // Due-date editability has its own tier rule on top of the general edit
  // gate: once a dueDate is set, only Tier 1/Tier 2 may change it. Tier 3/4
  // can still set the INITIAL value on a self-assigned task. Mirrors
  // `taskController.updateTask`'s DUE_DATE_LOCKED branch.
  const canChangeDueDate = canEditDueDateFn(user, task);
  const dueDateLockedReason = !canChangeDueDate
    ? 'Only Tier 1 or Tier 2 can change this due date.'
    : null;
  const canAssignOthers = isSuperAdmin || !!granularPermissions?.['tasks.assign_others'];
  const canSetPriority = canSetPriorityForTask(user, task, isSuperAdmin, granularPermissions);
  const canEditOwnFields = canEditTaskFn(user, task, granularPermissions);
  const canEditTitle = !isApproved && canEditTaskTitleFn(user, task, granularPermissions);
  const isBlockedByDependency = !!task?.customFields?.blockedByDependency;
  const canEditStatus = !isApproved && !isBlockedByDependency && (canEditAllFields || canEditOwnFields);

  const [title, setTitle] = useState(task?.title || '');
  const [description, setDescription] = useState(task?.description || '');
  const [status, setStatus] = useState(task?.status || 'not_started');
  const [showApprovalModal, setShowApprovalModal] = useState(false);
  const [priority, setPriority] = useState(task?.priority || 'medium');
  const [assignee, setAssignee] = useState(task?.assignedTo || null);

  const taskAssignees = task?.taskAssignees || [];
  const [selectedAssignees, setSelectedAssignees] = useState(() => {
    const assigneeIds = taskAssignees.filter(ta => ta.role === 'assignee').map(ta => ta.userId || ta.user?.id);
    if (assigneeIds.length === 0 && task?.assignedTo) return [typeof task.assignedTo === 'string' ? task.assignedTo : task.assignedTo?.id].filter(Boolean);
    return assigneeIds;
  });
  const [selectedSupervisors, setSelectedSupervisors] = useState(() => {
    return taskAssignees.filter(ta => ta.role === 'supervisor').map(ta => ta.userId || ta.user?.id);
  });
  const [showAssigneesPicker, setShowAssigneesPicker] = useState(false);
  const [assigneeSearch, setAssigneeSearch] = useState('');
  const [dueDate, setDueDate] = useState(task?.dueDate ? task.dueDate.slice(0, 10) : '');
  const [startDate, setStartDate] = useState(task?.startDate ? task.startDate.slice(0, 10) : '');

  const [reminders, setReminders] = useState(() => normalizeReminderProps(task?.reminders));
  useEffect(() => {
    setReminders(normalizeReminderProps(task?.reminders));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(task?.reminders || null)]);
  const [tags, setTags] = useState(task?.tags || []);
  const [newTag, setNewTag] = useState('');
  const [comments, setComments] = useState([]);
  const [files, setFiles] = useState([]);
  const [activeTab, setActiveTab] = useState('overview');
  const [showStatusDrop, setShowStatusDrop] = useState(false);
  const [showPriorityDrop, setShowPriorityDrop] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);

  const [taskStatusConfig, setTaskStatusConfig] = useState(task?.statusConfig || null);
  const [showStatusConfig, setShowStatusConfig] = useState(false);
  const [newStatusLabel, setNewStatusLabel] = useState('');
  const [newStatusColor, setNewStatusColor] = useState('#3b82f6');
  const [editingStatusKey, setEditingStatusKey] = useState(null);
  const [editStatusLabel, setEditStatusLabel] = useState('');

  const [showDepSelector, setShowDepSelector] = useState(false);
  const [depKey, setDepKey] = useState(0);
  const [deletedRemotely, setDeletedRemotely] = useState(false);
  const [showExtension, setShowExtension] = useState(false);
  const [showHelpRequest, setShowHelpRequest] = useState(false);
  const [recurringTemplate, setRecurringTemplate] = useState(
    task?.recurringTemplate || (task?.isRecurringInstance ? null : false)
  );
  const [saveStatus, setSaveStatus] = useState(null);
  const [savedAt, setSavedAt] = useState(null);
  const [savedAgo, setSavedAgo] = useState('');
  const saveTimerRef = useRef(null);
  const [conflicts, setConflicts] = useState([]);
  const [showConflicts, setShowConflicts] = useState(false);
  const [isDependencyReceiver, setIsDependencyReceiver] = useState(false);
  // Subtask counts mirror — keeps the footer progress meter accurate.
  const [subtaskCounts, setSubtaskCounts] = useState({ total: 0, done: 0 });
  // Watcher state — lifted from WatcherSection so the title-row star button
  // and the People card watchers preview share one source of truth.
  const [watching, setWatching] = useState(false);
  const [watchers, setWatchers] = useState([]);
  const [watchBusy, setWatchBusy] = useState(false);

  const dueDateInputRef = useRef(null);
  const startDateInputRef = useRef(null);
  function openDatePicker(ref) {
    const el = ref?.current;
    if (!el) return;
    if (typeof el.showPicker === 'function') {
      try { el.showPicker(); return; } catch { /* fall through */ }
    }
    el.focus();
  }
  const { checkGrammar: checkDescGrammar, suggestion: descGrammarSuggestion, isChecking: isCheckingDescGrammar, applySuggestion: applyDescGrammar, dismissSuggestion: dismissDescGrammar } = useGrammarCorrection();

  useEffect(() => {
    if (task?.id) {
      loadComments();
      loadFiles();
      loadDependencyRole();
      loadWatchers();
    }
  }, [task?.id]);

  useEffect(() => {
    if (!task?.id) return;
    if (!task?.isRecurringInstance) {
      setRecurringTemplate(false);
      return;
    }
    if (task.recurringTemplate) {
      setRecurringTemplate(task.recurringTemplate);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get(`/tasks/${task.id}`);
        const fresh = res.data?.data?.task || res.data?.task || res.data || null;
        if (cancelled) return;
        if (fresh && fresh.recurringTemplate) {
          setRecurringTemplate(fresh.recurringTemplate);
        } else {
          setRecurringTemplate(false);
        }
      } catch (_) {
        if (!cancelled) setRecurringTemplate(false);
      }
    })();
    return () => { cancelled = true; };
  }, [task?.id, task?.isRecurringInstance]);

  useEffect(() => {
    if (!task?.id || !user?.id) return;
    const assigneeRows = Array.isArray(task?.taskAssignees)
      ? task.taskAssignees.filter(ta => ta.role === 'assignee')
      : [];
    const isAssignee = assigneeRows.length > 0
      ? assigneeRows.some(ta => String(ta.userId || ta.user?.id) === String(user.id))
      : String(task?.assignedTo) === String(user.id);
    if (!isAssignee) return;
    api.post(`/tasks/${task.id}/receipt`, { event: 'seen' }, { _silent: true })
      .catch(() => { /* idempotent — ignore transient failures */ });
  }, [task?.id, user?.id]);

  // Periodic recompute of "Saved · 2s ago" footer stamp. Keeps the indicator
  // honest without hammering the DOM. Only ticks while the modal is open.
  useEffect(() => {
    if (!savedAt) { setSavedAgo(''); return undefined; }
    const tick = () => {
      try {
        setSavedAgo(formatDistanceToNowStrict(savedAt, { addSuffix: false }) + ' ago');
      } catch { setSavedAgo(''); }
    };
    tick();
    const id = setInterval(tick, 15_000);
    return () => clearInterval(id);
  }, [savedAt]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  useRealtimeEvent('comment:created', (data) => {
    if (data?.taskId === task?.id) {
      setComments(prev => {
        if (prev.some(c => c.id === data.comment?.id)) return prev;
        return [data.comment, ...prev];
      });
    }
  });

  useRealtimeEvent('comment:deleted', (data) => {
    if (data?.taskId === task?.id) {
      setComments(prev => prev.filter(c => c.id !== data.commentId));
    }
  });

  useEffect(() => { setDeletedRemotely(false); }, [task?.id]);

  useRealtimeEvent('task:deleted', (data) => {
    if (data?.taskId && data.taskId === task?.id) {
      setDeletedRemotely(true);
    }
  });

  // Watcher realtime sync — refresh both list + my-watching pill on any change.
  const refreshWatchers = useCallback(() => {
    if (!task?.id) return;
    api.get(`/task-extras/${task.id}/watchers`).then(r => setWatchers(r.data.watchers || [])).catch(() => {});
    api.get(`/task-extras/${task.id}/watching`).then(r => setWatching(!!r.data.watching)).catch(() => {});
  }, [task?.id]);
  useRealtimeQuery({
    queryKey: `watchers.task.${task?.id}`,
    refetch: refreshWatchers,
    enabled: !!task?.id,
  });

  async function loadComments() {
    try {
      const res = await api.get(`/comments?taskId=${task.id}`);
      setComments(res.data.comments || res.data || []);
    } catch {}
  }

  async function loadFiles() {
    try {
      const res = await api.get(`/files?taskId=${task.id}`);
      setFiles(res.data.files || res.data || []);
    } catch {}
  }

  async function loadDependencyRole() {
    try {
      const res = await api.get(`/tasks/${task.id}/dependencies`);
      const depData = res.data?.data || res.data;
      const blockingOthers = (depData.blocking || []).length > 0;
      setIsDependencyReceiver(blockingOthers);
    } catch {
      setIsDependencyReceiver(false);
    }
  }

  async function loadWatchers() {
    if (!task?.id) return;
    try {
      const [w, mine] = await Promise.all([
        api.get(`/task-extras/${task.id}/watchers`),
        api.get(`/task-extras/${task.id}/watching`),
      ]);
      setWatchers(w.data.watchers || []);
      setWatching(!!mine.data.watching);
    } catch {}
  }

  async function toggleWatch() {
    if (!task?.id || watchBusy) return;
    setWatchBusy(true);
    try {
      const res = await api.post(`/task-extras/${task.id}/watch`);
      setWatching(!!res.data.watching);
      refreshWatchers();
    } catch (e) {
      toastError?.('Could not update watch state.');
    } finally {
      setWatchBusy(false);
    }
  }

  async function save(updates) {
    setSaveStatus('saving');
    try {
      const res = await api.put(`/tasks/${task.id}`, updates);
      const echoed = res?.data?.task || res?.data?.data?.task || null;
      const merged = echoed ? { ...task, ...updates, ...echoed } : { ...task, ...updates };
      if (onUpdate) onUpdate(merged);
      const warnings = res?.data?.warnings || res?.data?.data?.warnings;
      if (warnings?.reminders?.length && toastError) {
        const msg = warnings.reminders.includes('reminders_save_failed')
          ? 'Could not save reminders. Please try again.'
          : `Reminder warning: ${warnings.reminders.join(', ')}`;
        toastError(msg);
      }
      setSaveStatus('saved');
      setSavedAt(new Date());
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveStatus(null), 2000);
    } catch (err) {
      const status = err.response?.status;
      const msg = err.response?.data?.message;
      const meta = err.response?.data?.meta;

      if (status === 403 && meta?.reason === 'dep_owner_cannot_complete_parent') {
        if (toastError) toastError(msg);
        setStatus(task.status);
        setSaveStatus('error');
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => setSaveStatus(null), 3000);
        return;
      }

      const approvalCode = err.response?.data?.code;
      if (status === 403 && (approvalCode === 'approval_required' || approvalCode === 'approval_pending')) {
        setStatus(task.status);
        setSaveStatus('error');
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => setSaveStatus(null), 3000);
        return;
      }

      if (approvalCode === 'description_locked') {
        setDescription(task.description || '');
        if (toastError) toastError(msg || 'Task description cannot be edited after it has been added.');
        setSaveStatus('error');
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => setSaveStatus(null), 3000);
        return;
      }

      if (status === 409 && meta?.requiresOverride && updates.status === 'done') {
        const proceed = window.confirm(
          `${msg}\n\nMark "${task.title}" done anyway? This action will be recorded as an admin override.`
        );
        if (proceed) {
          try {
            await api.put(`/tasks/${task.id}?force=true`, updates);
            if (onUpdate) onUpdate({ ...task, ...updates });
            setSaveStatus('saved');
            setSavedAt(new Date());
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
            saveTimerRef.current = setTimeout(() => setSaveStatus(null), 2000);
            return;
          } catch (retryErr) {
            console.error('Force-done retry failed:', retryErr);
            setSaveStatus('error');
          }
        }
        setStatus('stuck');
        setSaveStatus('error');
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => setSaveStatus(null), 3000);
        return;
      }

      console.error('Failed to update task:', err);
      setSaveStatus('error');
      if (msg && (msg.includes('blocked by') || msg.includes('active dependencies'))) {
        setStatus('stuck');
      }
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveStatus(null), 3000);
    }
  }

  function handleTitleBlur() {
    if (!title.trim()) { setTitle(task.title); return; }
    if (title !== task.title) save({ title });
  }
  function handleDescBlur() { if (description !== task.description) save({ description }); }

  const isTaskOwner = !!user?.id && (
    task?.assignedTo === user.id
    || task?.createdBy === user.id
    || (Array.isArray(task?.taskAssignees) && task.taskAssignees.some(ta => ta.userId === user.id))
  );

  const shouldInterceptDone = (val) =>
    val === 'done'
    && isTaskOwner
    && !isSuperAdmin
    && task?.approvalStatus !== 'pending_approval'
    && task?.approvalStatus !== 'approved';

  async function handleStatusChange(val) {
    if (val === 'done' && !isSuperAdmin && task?.approvalStatus === 'pending_approval') {
      setShowStatusDrop(false);
      toastError('Task is awaiting approval. The reviewer will mark it Done.');
      return;
    }
    if (shouldInterceptDone(val)) {
      setShowStatusDrop(false);
      setShowApprovalModal(true);
      return;
    }
    setStatus(val);
    setShowStatusDrop(false);
    const ACTIVE_STATUSES = ['working_on_it', 'stuck', 'review', 'done'];
    if (ACTIVE_STATUSES.includes(val) && !startDate) {
      const today = new Date().toISOString().slice(0, 10);
      setStartDate(today);
    }
    const updates = { status: val };
    if (val === 'done') updates.progress = 100;
    save(updates);
  }
  function handlePriorityChange(val) { setPriority(val); setShowPriorityDrop(false); save({ priority: val }); }

  async function saveTaskMembers(assignees, supervisors) {
    setSaveStatus('saving');
    try {
      const restrictedToSelf = !canAssignOthers;
      const isSelfOnly = (
        Array.isArray(assignees)
        && assignees.length <= 1
        && (!supervisors || supervisors.length === 0)
        && (assignees.length === 0 || assignees[0] === user?.id)
      );
      if (restrictedToSelf && isSelfOnly) {
        const next = assignees[0] || null;
        await api.put(`/tasks/${task.id}`, { assignedTo: next });
        if (onUpdate) onUpdate({ ...task, assignedTo: next });
      } else {
        await api.put(`/tasks/${task.id}/members`, { assignees, supervisors });
        if (onUpdate) onUpdate({ ...task, assignedTo: assignees[0] || null });
      }
      setSaveStatus('saved');
      setSavedAt(new Date());
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveStatus(null), 2000);
    } catch (err) {
      console.error('Failed to update task members:', err);
      setSaveStatus('error');
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveStatus(null), 3000);
    }
  }

  function ensureDueDateForAssignment(targetUid) {
    if (dueDate) return true;
    const isSelf = targetUid && targetUid === user?.id;
    toastError(isSelf
      ? 'Please set a due date before assigning this task.'
      : 'Please set a due date before assigning this task to another user.');
    return false;
  }

  function toggleAssignee(uid) {
    const isAdding = !selectedAssignees.includes(uid);
    if (isAdding && !canAssignOthers && uid !== user?.id) {
      toastError('You do not have permission to assign tasks to other users.');
      return;
    }
    if (isAdding && !ensureDueDateForAssignment(uid)) return;
    setSelectedAssignees(prev => {
      const next = prev.includes(uid) ? prev.filter(id => id !== uid) : [...prev, uid];
      saveTaskMembers(next, selectedSupervisors);
      return next;
    });
  }

  function handleDateChange(field, val) {
    if (field === 'dueDate') {
      setDueDate(val);
      save({ dueDate: val || null });
      if (val && (assignee || task?.assignedTo)) {
        const userId = assignee || task?.assignedTo;
        const startTime = new Date(val);
        const endTime = new Date(startTime.getTime() + (task?.estimatedHours || 1) * 60 * 60 * 1000);
        api.post('/tasks/check-conflicts', {
          userId,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          excludeTaskId: task?.id,
        }, { _silent: true }).then(res => {
          const data = res.data || res;
          if (data.hasConflicts) {
            setConflicts(data.conflicts);
            setShowConflicts(true);
          } else {
            setConflicts([]);
            setShowConflicts(false);
          }
        }).catch(() => {
          setConflicts([]);
          setShowConflicts(false);
        });
      }
    } else {
      setStartDate(val);
      save({ startDate: val || null });
    }
  }

  function handleAddTag(e) {
    if (e.key === 'Enter' && newTag.trim()) {
      const updated = [...tags, newTag.trim()];
      setTags(updated); setNewTag(''); save({ tags: updated });
    }
  }

  function removeTag(idx) { const updated = tags.filter((_, i) => i !== idx); setTags(updated); save({ tags: updated }); }

  async function handleAddComment(text) {
    const res = await api.post('/comments', { taskId: task.id, content: text });
    const newComment = res.data.comment || res.data;
    setComments(prev => {
      if (newComment?.id && prev.some(c => c.id === newComment.id)) return prev;
      return [newComment, ...prev];
    });
  }

  async function handleDeleteComment(id) { await api.delete(`/comments/${id}`); setComments(prev => prev.filter(c => c.id !== id)); }

  async function handleUploadFile(file) {
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('taskId', task.id);
      const res = await api.post('/files', formData);
      setFiles(prev => [...prev, res.data.file || res.data.data?.file || res.data]);
    } catch (err) {
      const msg = err.response?.data?.message || 'Failed to upload file.';
      alert(msg);
    }
  }

  async function handleDeleteFile(id) {
    try {
      await api.delete(`/files/${id}`);
      setFiles(prev => prev.filter(f => f.id !== id));
    } catch (err) {
      console.error('Failed to delete file:', err);
    }
  }

  // More-menu handlers — duplicate / archive (delete). Same backend endpoints
  // as before; we just route them through the new menu. Permissions still
  // enforced server-side.
  async function handleDuplicate() {
    setShowMoreMenu(false);
    try {
      const res = await api.post(`/tasks/${task.id}/duplicate`, { includeSubtasks: true });
      const newTask = res.data?.task || res.data?.data?.task;
      if (onUpdate && newTask) onUpdate(newTask);
      toastSuccess?.('Task duplicated.');
      handleClose();
    } catch (err) {
      console.error('Failed to duplicate:', err);
      toastError?.('Could not duplicate task.');
    }
  }

  async function handleArchive() {
    setShowMoreMenu(false);
    if (!confirm(`Archive "${task.title}"? You can restore it from the archive page.`)) return;
    try {
      await api.delete(`/tasks/${task.id}`);
      if (onDelete) onDelete(task.id);
      handleClose();
    } catch (err) {
      console.error('Failed to archive:', err);
      toastError?.('Could not archive task.');
    }
  }

  // Resolve statuses
  const activeStatuses = (taskStatusConfig && Array.isArray(taskStatusConfig) && taskStatusConfig.length > 0)
    ? taskStatusConfig
    : (boardStatuses && boardStatuses.length > 0 ? boardStatuses : DEFAULT_STATUSES);
  const statusLookup = buildStatusLookup(activeStatuses);
  const statusCfg = statusLookup[status] || STATUS_CONFIG[status] || { label: status || 'Unknown', color: '#c4c4c4', bgColor: '#c4c4c4', textColor: '#fff' };
  const availableStatusPalette = boardStatuses && boardStatuses.length > 0 ? boardStatuses : DEFAULT_STATUSES;
  const priorityCfg = PRIORITY_CONFIG[priority];
  const isMyTask = task?.assignedTo === user?.id || selectedAssignees.includes(user?.id);
  const canEditStartDate = !isApproved && !isDependencyReceiver && (canEditAllFields || isMyTask);

  // Assigned/created derived stamps for the People card.
  const assigneeRows = Array.isArray(task?.taskAssignees)
    ? task.taskAssignees.filter(ta => ta.role === 'assignee')
    : [];
  const latestAssignedAt = assigneeRows.map(r => r.assignedAt).filter(Boolean).sort().pop() || null;
  const assignedOnLabel = latestAssignedAt ? formatCompactDateTime(latestAssignedAt) : null;
  const createdOnLabel = task?.createdAt ? formatCompactDateTime(task.createdAt) : null;

  // Recurring template due-time chip + countdown source.
  const tmpl = recurringTemplate && typeof recurringTemplate === 'object' ? recurringTemplate : null;
  const dueTimeChipLabel = tmpl?.dueTime
    ? (() => {
        const m = String(tmpl.dueTime).match(/^(\d{1,2}):(\d{2})/);
        if (!m) return null;
        const h = parseInt(m[1], 10);
        const mm = m[2];
        const period = h >= 12 ? 'PM' : 'AM';
        const h12 = h % 12 === 0 ? 12 : h % 12;
        const tz = tmpl?.timezone || '';
        const tzShort = tz === 'Asia/Calcutta' || tz === 'Asia/Kolkata' ? 'IST' : tz;
        return `${h12}:${mm} ${period}${tzShort ? ' ' + tzShort : ''}`;
      })()
    : null;

  const countdown = useMemo(
    () => computeCountdown(dueDate, tmpl?.dueTime),
    // Re-evaluate when due date / template time changes; intentionally not a
    // ticking subscription — chip refreshes on any modal interaction, which
    // is acceptable for a deadline indicator that's accurate to the hour.
    [dueDate, tmpl?.dueTime]
  );

  // Project / board context
  const boardContext = board || task?.board || task?.Board || null;
  const boardLabel = boardContext?.name || null;
  const boardColor = boardContext?.color || ACCENT.violet;

  // Footer progress: prefer subtask ratio when subtasks exist, else task.progress.
  const footerProgress = (() => {
    if (subtaskCounts.total > 0) {
      const pct = Math.round((subtaskCounts.done / subtaskCounts.total) * 100);
      return { done: subtaskCounts.done, total: subtaskCounts.total, pct };
    }
    if (typeof task?.progress === 'number') {
      return { done: null, total: null, pct: Math.max(0, Math.min(100, task.progress)) };
    }
    return { done: 0, total: 0, pct: 0 };
  })();

  const TABS = [
    { id: 'overview', label: 'Overview', icon: FileText },
    { id: 'approval', label: 'Approval', icon: Shield, count: (task?.approvalFlows || []).length || undefined },
    { id: 'comments', label: 'Comments', icon: MessageSquare, count: comments.length },
    { id: 'files', label: 'Files', icon: Paperclip, count: files.length },
    { id: 'activity', label: 'Activity', icon: Activity },
  ];

  const titleElementId = `task-modal-title-${task?.id || 'new'}`;

  // Description editability — set-once for Tier 3/Tier 4 (mirrors backend).
  const savedDescription = typeof task?.description === 'string' ? task.description : '';
  const hasSavedDescription = !!savedDescription.trim();
  const canBypassDescriptionLock = isTier1 || isTier2;
  const isDescriptionLocked = hasSavedDescription && !canBypassDescriptionLock;
  const canEditDescription = !isApproved
    && (canEditAllFields || canEditOwnFields)
    && (!hasSavedDescription || canBypassDescriptionLock);

  // Subtasks scroll target — Subtask button in title row jumps user here.
  const subtasksRef = useRef(null);
  const focusSubtasks = () => {
    setActiveTab('overview');
    requestAnimationFrame(() => {
      subtasksRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  // Project color stripe — derive a lighter shade for the gradient mid-stop.
  const stripeColor = boardColor;
  const stripeColorLight = (() => {
    // Quick lighten: parse hex, mix toward white. Tolerant of bad input.
    if (typeof stripeColor !== 'string' || !stripeColor.startsWith('#')) return stripeColor;
    const hex = stripeColor.slice(1);
    const expand = hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex;
    if (expand.length !== 6) return stripeColor;
    const r = parseInt(expand.slice(0, 2), 16);
    const g = parseInt(expand.slice(2, 4), 16);
    const b = parseInt(expand.slice(4, 6), 16);
    const mix = (v) => Math.round(v + (255 - v) * 0.35);
    return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
  })();

  return (
    <>
      <DetailModalShell onClose={onClose} closeRef={shellCloseRef} ariaLabelledBy={titleElementId} size="sheet" placement="bottom-sheet">
        {/* ── Row 1: Project color stripe ─────────────────────────────── */}
        <div
          className="v3-project-stripe"
          style={{ '--proj-color': stripeColor, '--proj-light': stripeColorLight }}
          aria-hidden="true"
        />

        {/* Remote-deletion banner */}
        {deletedRemotely && (
          <div role="alert" className="flex items-center justify-between gap-3 px-6 py-2 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800 text-red-800 dark:text-red-200 text-sm flex-shrink-0">
            <span><strong>This task was deleted by another user.</strong> Your changes can no longer be saved. Close this panel to continue.</span>
            <button type="button" onClick={handleClose} className="px-3 py-1 rounded-md bg-red-600 text-white text-xs font-medium hover:bg-red-700 transition-colors flex-shrink-0">Close</button>
          </div>
        )}

        {/* ── Row 2: Header top — breadcrumb / nav / actions ─────────── */}
        <div className="flex items-center justify-between px-5 h-[42px] border-b border-border bg-white/95 dark:bg-[#1E1F23]/95 backdrop-blur flex-shrink-0">
          <div className="flex items-center gap-1.5 text-[12px] min-w-0 flex-1">
            <span className="text-text-tertiary">Task</span>
            {boardLabel && (<>
              <span className="text-text-tertiary">›</span>
              <span className="inline-flex items-center gap-1 text-text-primary font-medium truncate max-w-[180px]" title={boardLabel}>
                <span className="w-1.5 h-1.5 rounded-sm flex-shrink-0" style={{ backgroundColor: boardColor }} />
                <span className="truncate">{boardLabel}</span>
              </span>
            </>)}
            {task?.isRecurringInstance && (<>
              <span className="text-text-tertiary">›</span>
              <span className="text-text-secondary truncate">Daily Work</span>
            </>)}
            {task?.autoAssigned && (
              <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-purple/10 text-purple flex-shrink-0">
                <Zap size={9} /> Auto-assigned
              </span>
            )}
            {task?.isRecurringInstance && (
              <button
                type="button"
                onClick={() => { window.location.href = '/recurring-work'; }}
                className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 hover:bg-purple-200 dark:hover:bg-purple-900/30 transition-colors flex-shrink-0 v3-lift"
                title={`Generated for ${task.occurrenceDate || task.dueDate}`}
              >
                <RefreshCw size={9} className="v3-recur-spin" />
                <span className="tabular-nums">Recurring{task.occurrenceDate ? ` · ${task.occurrenceDate}` : ''}</span>
              </button>
            )}
          </div>
          <div className="flex items-center gap-0.5 flex-shrink-0">
            {(onPrev || onNext) && (
              <>
                <button
                  type="button"
                  onClick={() => onPrev?.()}
                  disabled={!onPrev}
                  className="p-1.5 rounded-md text-text-secondary hover:bg-surface disabled:opacity-30 disabled:cursor-not-allowed v3-lift"
                  title="Previous task"
                  aria-label="Previous task"
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => onNext?.()}
                  disabled={!onNext}
                  className="p-1.5 rounded-md text-text-secondary hover:bg-surface disabled:opacity-30 disabled:cursor-not-allowed v3-lift"
                  title="Next task"
                  aria-label="Next task"
                >
                  <ChevronDown size={14} />
                </button>
                <span className="w-px h-4 bg-border mx-1" aria-hidden="true" />
              </>
            )}
            <button onClick={() => setShowHelpRequest(true)}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-yellow-600 hover:bg-yellow-50 dark:hover:bg-yellow-900/10 transition-colors v3-lift" title="Request help">
              <HelpCircle size={12} /> Help
            </button>
            {task?.dueDate && (
              <button onClick={() => setShowExtension(true)}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/10 transition-colors v3-lift" title="Request due-date extension">
                <Calendar size={12} /> Extend
              </button>
            )}
            <button onClick={handleClose} aria-label="Close task" className="p-1.5 rounded-md hover:bg-surface text-text-secondary v3-lift"><X size={16} /></button>
          </div>
        </div>

        {/* ── Row 3: Header title row — star + title + watch/dep/subtask/more ── */}
        <div className="flex items-center gap-2 px-5 h-[56px] border-b border-border bg-white dark:bg-[#1E1F23] flex-shrink-0">
          <button
            type="button"
            onClick={toggleWatch}
            disabled={watchBusy}
            className={`p-1.5 rounded-md transition-colors v3-lift flex-shrink-0 ${watching ? 'text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/10' : 'text-text-tertiary hover:bg-surface hover:text-text-secondary'}`}
            title={watching ? 'Watching — click to unwatch' : 'Watch this task'}
            aria-pressed={watching}
            aria-label={watching ? 'Unwatch task' : 'Watch task'}
          >
            <Star size={16} fill={watching ? 'currentColor' : 'none'} />
          </button>
          <div className="flex-1 min-w-0">
            {canEditTitle ? (
              <input
                id={titleElementId}
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={handleTitleBlur}
                className="text-[18px] font-semibold text-text-primary border-none outline-none w-full bg-transparent placeholder:text-text-tertiary truncate focus:bg-surface/40 rounded px-1 -mx-1"
                placeholder="Task title"
              />
            ) : (
              <h2 id={titleElementId} className="text-[18px] font-semibold text-text-primary truncate" title={title}>
                {title}
              </h2>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <span className={`hidden sm:inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium border v3-lift ${watching ? 'bg-emerald-50 text-emerald-600 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-800' : 'text-text-secondary border-border'}`}>
              <EyeIcon size={11} /> {watching ? 'Watching' : 'Not watching'}
            </span>
            {status !== 'done' && (
              <button
                type="button"
                onClick={() => setShowDepSelector(true)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-text-secondary border border-border hover:border-[#6D5CE7]/40 hover:text-[#6D5CE7] transition-colors v3-lift"
                title="Add a task dependency"
              >
                <Link2 size={11} /> Add dependency
              </button>
            )}
            <button
              type="button"
              onClick={focusSubtasks}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-text-secondary border border-border hover:border-[#6D5CE7]/40 hover:text-[#6D5CE7] transition-colors v3-lift"
              title="Jump to subtasks"
            >
              <Plus size={11} /> Subtask
            </button>
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowMoreMenu(v => !v)}
                className="p-1.5 rounded-md text-text-secondary hover:bg-surface v3-lift"
                title="More actions"
                aria-haspopup="menu"
                aria-expanded={showMoreMenu}
              >
                <MoreHorizontal size={15} />
              </button>
              {showMoreMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowMoreMenu(false)} aria-hidden="true" />
                  <div role="menu" className="absolute top-full right-0 mt-1 z-50 min-w-[180px] bg-white dark:bg-zinc-900 rounded-lg shadow-lg border border-border p-1 dropdown-enter">
                    <button role="menuitem" onClick={handleDuplicate}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-[12px] text-text-primary hover:bg-surface text-left">
                      <Copy size={12} className="text-text-tertiary" /> Duplicate task
                    </button>
                    {canManage && (
                      <button role="menuitem" onClick={handleArchive}
                        className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-[12px] text-red-600 hover:bg-red-50 dark:hover:bg-red-900/10 text-left">
                        <Archive size={12} /> Archive task
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* ── Row 4: Body — main + right rail ────────────────────────── */}
        <div className="flex-1 flex min-h-0 relative">
          <div className="v3-aurora" aria-hidden="true" />

          {/* ============ LEFT — main content ============ */}
          <div className="flex-1 min-w-0 overflow-y-auto px-6 pt-4 pb-2 relative z-[1]">
            {/* Section 1: Chips strip */}
            <div className="flex flex-wrap items-center gap-1.5 mb-3">
              <ChipPill
                label={statusCfg.label}
                color={statusCfg.bgColor}
                onClick={canEditStatus ? () => setShowStatusDrop(s => !s) : undefined}
                title={isBlockedByDependency ? 'Blocked by dependency' : undefined}
                dim
              />
              {priorityCfg && (
                <ChipPill icon={Flag} label={priorityCfg.label} color={priorityCfg.bgColor} dim />
              )}
              <span className="w-px h-3.5 bg-border mx-0.5" aria-hidden="true" />
              <ChipPill
                icon={Calendar}
                label={dueDate ? `Due ${formatTaskDate(dueDate)}` : 'No due date'}
                tone="neutral"
              />
              {dueTimeChipLabel && (
                <ChipPill icon={Clock} label={dueTimeChipLabel} tone="neutral" />
              )}
              {countdown && (
                <ChipPill
                  icon={Clock}
                  label={countdown.label}
                  color={countdown.urgent ? '#E11D48' : '#D97706'}
                  dim
                  urgent={countdown.urgent}
                />
              )}
              {isApproved && <ChipPill icon={Check} label="Approved" color="#10b981" dim />}
              {isBlockedByDependency && <ChipPill icon={Lock} label="Blocked" color="#e2445c" dim />}
              {showStatusDrop && canEditStatus && (
                <div className="absolute mt-7 bg-white dark:bg-zinc-900 rounded-lg shadow-lg border border-border p-1.5 z-[60] min-w-[160px] dropdown-enter">
                  {activeStatuses.map(s => {
                    const sCfg = statusLookup[s.key] || { label: s.label, bgColor: s.color };
                    return (
                      <button key={s.key} onClick={() => handleStatusChange(s.key)}
                        className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-[12px] hover:bg-surface text-left">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: sCfg.bgColor }} />
                        <span className="text-text-primary">{sCfg.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Section 2: Activity ribbon */}
            <ActivityRibbon taskId={task?.id} onSeeAll={() => setActiveTab('activity')} />

            {/* Conflict warning */}
            {showConflicts && conflicts.length > 0 && (
              <div className="my-3">
                <ConflictWarning
                  conflicts={conflicts}
                  taskId={task?.id}
                  dueDate={dueDate}
                  estimatedHours={task?.estimatedHours || 1}
                  onRescheduled={(result) => {
                    setConflicts(prev => prev.filter(c => c.taskId !== result.taskId));
                    if (conflicts.length <= 1) setShowConflicts(false);
                    if (onUpdate) onUpdate({ ...task });
                  }}
                  onDismiss={() => setShowConflicts(false)}
                />
              </div>
            )}

            {/* Dependency badge — small pill, doesn't dominate */}
            <div className="mb-2">
              <DependencyBadge key={depKey} taskId={task?.id} boardId={boardId || task?.boardId} onRefresh={async () => {
                setDepKey(k => k + 1);
                try {
                  const res = await api.get(`/tasks/${task.id}`);
                  const updated = res.data?.data?.task || res.data?.task || res.data;
                  if (updated) {
                    setStatus(updated.status || status);
                    if (onUpdate) onUpdate(updated);
                  }
                } catch {}
                loadDependencyRole();
              }} />
            </div>

            {/* Section 3: Sticky tabs */}
            <div className="v3-tabs-sticky">
              <div className="v3-tabs" role="tablist">
                {TABS.map(t => (
                  <button
                    key={t.id}
                    role="tab"
                    aria-selected={activeTab === t.id}
                    onClick={() => setActiveTab(t.id)}
                    className="v3-tab"
                    type="button"
                  >
                    <t.icon size={13} />
                    <span>{t.label}</span>
                    {t.count !== undefined && (
                      <span className="v3-tab-count">{t.count}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* ── Tab bodies ────────────────────────────────────── */}

            {activeTab === 'overview' && (
              <div className="space-y-5 pt-4 pb-6 v3-stagger">
                <ApprovalSummaryCard task={task} onOpenTab={() => setActiveTab('approval')} />

                {/* Description */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-[10px] font-bold text-text-secondary uppercase tracking-[0.08em] inline-flex items-center gap-1.5">
                      <span className="w-4 h-4 rounded bg-[#6D5CE7]/10 inline-flex items-center justify-center">
                        <FileText size={10} className="text-[#6D5CE7]" />
                      </span>
                      Description
                    </label>
                    {isDescriptionLocked && (
                      <span className="text-[10px] text-text-tertiary inline-flex items-center gap-1" title="Description is locked once added">
                        <Lock size={10} /> Locked
                      </span>
                    )}
                  </div>
                  {canEditDescription ? (
                    <>
                      <textarea
                        value={description}
                        onChange={(e) => { setDescription(e.target.value); checkDescGrammar(e.target.value); }}
                        onBlur={handleDescBlur}
                        placeholder="Add details, paste a link, or @mention someone…"
                        className="w-full text-sm border border-border rounded-lg px-3 py-2.5 bg-surface/30 focus:outline-none focus:border-primary focus:bg-white dark:focus:bg-zinc-900 resize-none min-h-[64px] placeholder:text-text-tertiary"
                      />
                      <div className="flex items-center gap-1.5 mt-1.5">
                        <button type="button" className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-text-secondary border border-border hover:border-[#6D5CE7]/40 hover:text-[#6D5CE7] transition-colors v3-lift" onClick={() => document.querySelector(`#desc-${task?.id}`)?.focus()}>
                          <Pencil size={11} /> Write
                        </button>
                        <button type="button" className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-text-secondary border border-border hover:border-[#6D5CE7]/40 hover:text-[#6D5CE7] transition-colors v3-lift">
                          <Link2 size={11} /> Paste link
                        </button>
                        <button type="button" className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-text-secondary border border-border hover:border-[#6D5CE7]/40 hover:text-[#6D5CE7] transition-colors v3-lift">
                          @ Mention
                        </button>
                        <button type="button" className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-text-secondary border border-border hover:border-[#6D5CE7]/40 hover:text-[#6D5CE7] transition-colors v3-lift" onClick={() => setActiveTab('files')}>
                          <Paperclip size={11} /> Attach
                        </button>
                      </div>
                      <GrammarSuggestion
                        suggestion={descGrammarSuggestion}
                        isChecking={isCheckingDescGrammar}
                        onApply={() => { const corrected = applyDescGrammar(); if (corrected) { setDescription(corrected); save({ description: corrected }); } }}
                        onDismiss={dismissDescGrammar}
                      />
                    </>
                  ) : isDescriptionLocked ? (
                    <div aria-readonly="true" className="text-sm text-text-secondary px-3 py-2.5 border border-border rounded-lg min-h-[64px] bg-surface/30 whitespace-pre-wrap select-text">
                      {savedDescription}
                    </div>
                  ) : (
                    <p className="text-sm text-text-tertiary px-3 py-3 border border-dashed border-border rounded-lg bg-surface/20">
                      Add details, paste a link, or @mention someone…
                    </p>
                  )}
                </div>

                {/* Subtasks */}
                <div ref={subtasksRef}>
                  <SubtaskList taskId={task.id} members={members} onSubtaskCountChange={(counts) => {
                    setSubtaskCounts(counts || { total: 0, done: 0 });
                    if (onUpdate) onUpdate({ ...task, _subtaskCounts: counts });
                  }} />
                </div>

                <DependencyWorkSection
                  key={`dws-${depKey}`}
                  taskId={task?.id}
                  depKey={depKey}
                  onChanged={async () => {
                    setDepKey(k => k + 1);
                    try {
                      const res = await api.get(`/tasks/${task.id}`);
                      const updated = res.data?.data?.task || res.data?.task || res.data;
                      if (updated) {
                        setStatus(updated.status || status);
                        if (onUpdate) onUpdate(updated);
                      }
                    } catch {}
                    loadDependencyRole();
                  }}
                />

                {/* Comments */}
                <div>
                  <label className="text-[10px] font-bold text-text-secondary uppercase tracking-[0.08em] inline-flex items-center gap-1.5 mb-2">
                    <span className="w-4 h-4 rounded bg-[#0D9488]/10 inline-flex items-center justify-center">
                      <MessageSquare size={10} className="text-[#0D9488]" />
                    </span>
                    Comments
                  </label>
                  <TaskComments comments={comments} onAdd={handleAddComment} onDelete={handleDeleteComment} />
                </div>

                {/* Advanced: per-task status configuration (collapsed) */}
                {canEditAllFields && (
                  <div className="border border-border/60 rounded-lg overflow-hidden">
                    <button
                      onClick={() => setShowStatusConfig(!showStatusConfig)}
                      className="flex items-center gap-2 w-full px-3 py-2 text-[12px] font-medium text-text-secondary hover:bg-surface/40 transition-colors"
                    >
                      <Settings size={12} className="text-text-tertiary" />
                      <span className="flex-1 text-left">Configure task statuses</span>
                      {taskStatusConfig && taskStatusConfig.length > 0 && (
                        <span className="text-[10px] font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                          {taskStatusConfig.length} custom
                        </span>
                      )}
                      {showStatusConfig ? <ChevronDown size={13} className="text-text-tertiary" /> : <ChevronRight size={13} className="text-text-tertiary" />}
                    </button>
                    {showStatusConfig && (
                      <div className="px-3 pb-3 border-t border-border/40 space-y-2 pt-2">
                        <p className="text-[11px] text-text-tertiary mb-2">
                          Select which statuses are available for this task. Members will only see these options. Leave empty to use board defaults.
                        </p>
                        {(taskStatusConfig || []).map((s) => (
                          <div key={s.key} className="flex items-center gap-2 p-2 rounded-lg border border-border/40 bg-surface/20 group/status">
                            <div className="w-4 h-4 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
                            {editingStatusKey === s.key ? (
                              <div className="flex items-center gap-1.5 flex-1">
                                <input
                                  value={editStatusLabel}
                                  onChange={e => setEditStatusLabel(e.target.value)}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter') {
                                      if (!editStatusLabel.trim()) return;
                                      const updated = (taskStatusConfig || []).map(st => st.key === s.key ? { ...st, label: editStatusLabel.trim() } : st);
                                      setTaskStatusConfig(updated);
                                      save({ statusConfig: updated });
                                      setEditingStatusKey(null);
                                    }
                                  }}
                                  className="flex-1 px-2 py-1 border border-primary rounded text-xs focus:outline-none"
                                  autoFocus
                                  onClick={e => e.stopPropagation()}
                                />
                                <button onClick={() => {
                                  if (!editStatusLabel.trim()) return;
                                  const updated = (taskStatusConfig || []).map(st => st.key === s.key ? { ...st, label: editStatusLabel.trim() } : st);
                                  setTaskStatusConfig(updated);
                                  save({ statusConfig: updated });
                                  setEditingStatusKey(null);
                                }} className="p-0.5 text-green-600 hover:bg-green-50 rounded"><Check size={12} /></button>
                                <button onClick={() => setEditingStatusKey(null)} className="p-0.5 text-text-tertiary hover:bg-surface rounded"><X size={12} /></button>
                              </div>
                            ) : (
                              <>
                                <span className="text-xs font-medium text-text-primary flex-1">{s.label}</span>
                                <div className="flex items-center gap-0.5 opacity-0 group-hover/status:opacity-100 transition-opacity">
                                  {STATUS_PRESET_COLORS.slice(0, 6).map(c => (
                                    <button key={c} onClick={() => {
                                      const updated = (taskStatusConfig || []).map(st => st.key === s.key ? { ...st, color: c } : st);
                                      setTaskStatusConfig(updated);
                                      save({ statusConfig: updated });
                                    }}
                                      className={`w-3 h-3 rounded-full transition-all ${s.color === c ? 'ring-1 ring-offset-1 ring-primary' : 'hover:scale-110'}`}
                                      style={{ backgroundColor: c }}
                                    />
                                  ))}
                                </div>
                                <button onClick={() => { setEditingStatusKey(s.key); setEditStatusLabel(s.label); }}
                                  className="p-0.5 text-text-tertiary hover:text-primary opacity-0 group-hover/status:opacity-100 transition-opacity rounded">
                                  <Pencil size={11} />
                                </button>
                                <button onClick={() => {
                                  const updated = (taskStatusConfig || []).filter(st => st.key !== s.key);
                                  const result = updated.length > 0 ? updated : null;
                                  setTaskStatusConfig(result);
                                  save({ statusConfig: result });
                                }}
                                  className="p-0.5 text-text-tertiary hover:text-red-500 opacity-0 group-hover/status:opacity-100 transition-opacity rounded">
                                  <X size={11} />
                                </button>
                              </>
                            )}
                          </div>
                        ))}
                        <div className="pt-1">
                          <p className="text-[10px] text-text-tertiary mb-1.5 font-medium uppercase tracking-wider">Add from available statuses</p>
                          <div className="flex flex-wrap gap-1">
                            {availableStatusPalette
                              .filter(s => !(taskStatusConfig || []).some(ts => ts.key === s.key))
                              .map(s => (
                                <button key={s.key} onClick={() => {
                                  const updated = [...(taskStatusConfig || []), { key: s.key, label: s.label, color: s.color }];
                                  setTaskStatusConfig(updated);
                                  save({ statusConfig: updated });
                                }}
                                  className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-border/60 hover:border-primary/40 hover:bg-primary/5 transition-colors"
                                >
                                  <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: s.color }} />
                                  {s.label}
                                  <Plus size={10} className="text-text-tertiary" />
                                </button>
                              ))}
                          </div>
                        </div>
                        <div className="pt-1 border-t border-border/30">
                          <p className="text-[10px] text-text-tertiary mb-1.5 font-medium uppercase tracking-wider">Or create custom</p>
                          <div className="flex items-center gap-1.5">
                            <input
                              type="text"
                              value={newStatusLabel}
                              onChange={e => setNewStatusLabel(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter' && newStatusLabel.trim()) {
                                  const key = newStatusLabel.trim().toLowerCase().replace(/\s+/g, '_');
                                  if ((taskStatusConfig || []).some(s => s.key === key)) return;
                                  const updated = [...(taskStatusConfig || []), { key, label: newStatusLabel.trim(), color: newStatusColor }];
                                  setTaskStatusConfig(updated);
                                  save({ statusConfig: updated });
                                  setNewStatusLabel('');
                                }
                              }}
                              placeholder="Custom status name…"
                              className="flex-1 px-2 py-1.5 border border-border rounded-md text-xs focus:outline-none focus:border-primary"
                              onClick={e => e.stopPropagation()}
                            />
                            <div className="flex gap-0.5">
                              {STATUS_PRESET_COLORS.slice(0, 6).map(c => (
                                <button key={c} onClick={() => setNewStatusColor(c)}
                                  className={`w-4 h-4 rounded-full transition-all ${newStatusColor === c ? 'ring-2 ring-offset-1 ring-primary scale-110' : 'hover:scale-105'}`}
                                  style={{ backgroundColor: c }} />
                              ))}
                            </div>
                            <button
                              onClick={() => {
                                if (!newStatusLabel.trim()) return;
                                const key = newStatusLabel.trim().toLowerCase().replace(/\s+/g, '_');
                                if ((taskStatusConfig || []).some(s => s.key === key)) return;
                                const updated = [...(taskStatusConfig || []), { key, label: newStatusLabel.trim(), color: newStatusColor }];
                                setTaskStatusConfig(updated);
                                save({ statusConfig: updated });
                                setNewStatusLabel('');
                              }}
                              disabled={!newStatusLabel.trim()}
                              className="px-2.5 py-1.5 text-[11px] font-medium bg-primary text-white rounded-md hover:bg-primary-dark transition-colors disabled:opacity-40"
                            >
                              Add
                            </button>
                          </div>
                        </div>
                        {taskStatusConfig && taskStatusConfig.length > 0 && (
                          <button
                            onClick={() => { setTaskStatusConfig(null); save({ statusConfig: null }); }}
                            className="text-[11px] text-text-tertiary hover:text-text-secondary transition-colors mt-1"
                          >
                            Clear task statuses (use board defaults)
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'approval' && (
              <div className="pt-4 pb-6">
                <ApprovalSection task={task} onUpdate={(updated) => { if (onUpdate) onUpdate({ ...task, ...updated }); }} />
              </div>
            )}

            {activeTab === 'comments' && (
              <div className="pt-4 pb-6">
                <TaskComments comments={comments} onAdd={handleAddComment} onDelete={handleDeleteComment} />
              </div>
            )}

            {activeTab === 'files' && (
              <div className="pt-4 pb-6">
                <TaskFiles files={files} onUpload={handleUploadFile} onDelete={handleDeleteFile} />
              </div>
            )}

            {activeTab === 'activity' && (
              <div className="pt-4 pb-6">
                <ActivityFeed taskId={task.id} />
                <div className="mt-6">
                  <WorkLogSection taskId={task.id} />
                </div>
              </div>
            )}
          </div>

          {/* ============ RIGHT — properties rail (5 colored cards) ============ */}
          <aside className="w-[340px] flex-shrink-0 border-l border-border bg-[#FAFAF9] dark:bg-zinc-900/30 overflow-y-auto px-4 py-4 space-y-3 v3-stagger relative z-[1]">

            {/* Card 1 — PROPERTIES (purple) */}
            <V3Card accent="purple" title="Properties">
              <V3Row icon={Circle} label="Status">
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => canEditStatus && setShowStatusDrop(s => !s)}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${canEditStatus ? 'cursor-pointer' : 'cursor-default'}`}
                    style={{ backgroundColor: `${statusCfg.bgColor}1f`, color: statusCfg.bgColor, border: `1px solid ${statusCfg.bgColor}33` }}
                    title={isBlockedByDependency ? 'Blocked by dependency' : ''}
                  >
                    {isBlockedByDependency && <Lock size={10} />}
                    <span className="w-1.5 h-1.5 rounded-full v3-pulse-dot" style={{ backgroundColor: statusCfg.bgColor }} />
                    {statusCfg.label}
                  </button>
                </div>
              </V3Row>

              <V3Row icon={Flag} label="Priority">
                <div className="relative">
                  {canEditOwnFields && canSetPriority ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setShowPriorityDrop(!showPriorityDrop)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold cursor-pointer v3-lift"
                        style={{ backgroundColor: priorityCfg ? `${priorityCfg.bgColor}1f` : '#f3f4f6', color: priorityCfg ? priorityCfg.bgColor : '#6b7280', border: priorityCfg ? `1px solid ${priorityCfg.bgColor}33` : '1px solid #e5e7eb' }}
                      >
                        {priorityCfg && <Flag size={10} />}
                        {priorityCfg ? priorityCfg.label : 'None'}
                      </button>
                      {showPriorityDrop && (
                        <div className="absolute top-full right-0 mt-1 bg-white dark:bg-zinc-900 rounded-lg shadow-lg border border-border p-1.5 z-50 min-w-[140px] dropdown-enter">
                          {Object.entries(PRIORITY_CONFIG).map(([k, c]) => (
                            <button key={k} onClick={() => handlePriorityChange(k)}
                              className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-[12px] hover:bg-surface text-left">
                              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: c.bgColor }} />
                              <span className="text-text-primary">{c.label}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold select-none"
                      style={{ backgroundColor: priorityCfg ? `${priorityCfg.bgColor}1f` : '#f3f4f6', color: priorityCfg ? priorityCfg.bgColor : '#6b7280', border: priorityCfg ? `1px solid ${priorityCfg.bgColor}33` : '1px solid #e5e7eb' }}
                      title={!canSetPriority ? "You don't have permission to change priority" : undefined}
                    >
                      {priorityCfg ? priorityCfg.label : 'None'}
                    </span>
                  )}
                </div>
              </V3Row>

              <V3Row icon={Bookmark} label="Project">
                {boardLabel ? (
                  <span className="inline-flex items-center gap-1.5 text-[12px] text-text-primary truncate" title={boardLabel}>
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: boardColor }} />
                    <span className="truncate">{boardLabel}</span>
                  </span>
                ) : (
                  <span className="text-text-tertiary text-[12px]">—</span>
                )}
              </V3Row>
            </V3Card>

            {/* Card 2 — PEOPLE (teal) */}
            <V3Card
              accent="teal"
              title="People"
              action={(canEditAllFields || canEditOwnFields) && (
                <button
                  type="button"
                  onClick={() => setShowAssigneesPicker(!showAssigneesPicker)}
                  className="text-text-tertiary hover:text-[#0D9488] v3-lift"
                  title="Manage assignee"
                >
                  <Plus size={12} />
                </button>
              )}
            >
              <V3Row icon={UserIcon} label="Assignee">
                <div className="relative w-full">
                  {(canEditAllFields || canEditOwnFields) ? (
                    <>
                      <button
                        type="button"
                        onClick={() => { setShowAssigneesPicker(!showAssigneesPicker); setAssigneeSearch(''); }}
                        className="inline-flex items-center gap-1 flex-wrap min-h-[24px] text-[12px] text-left"
                      >
                        {selectedAssignees.length > 0 ? (
                          selectedAssignees.map(uid => {
                            const m = members.find(mm => (mm.id || mm.user?.id) === uid);
                            const n = m?.name || m?.user?.name || 'Unknown';
                            const removable = canAssignOthers || uid === user?.id;
                            return (
                              <span key={uid} className="inline-flex items-center gap-1 bg-[#0D9488]/10 text-[#0D9488] text-[11px] px-1.5 py-0.5 rounded-full">
                                <Avatar name={n} size="xs" />
                                <span className="max-w-[110px] truncate">{n}</span>
                                {removable && (
                                  <button onClick={(e) => { e.stopPropagation(); toggleAssignee(uid); }} className="hover:text-danger"><X size={9} /></button>
                                )}
                              </span>
                            );
                          })
                        ) : (
                          <span className="text-text-tertiary inline-flex items-center gap-1 border border-dashed border-border px-2 py-0.5 rounded-full">
                            <Plus size={10} /> {canAssignOthers ? 'Add assignee' : 'Assign to me'}
                          </span>
                        )}
                      </button>
                      {showAssigneesPicker && (
                        <div className="absolute top-full right-0 mt-1 bg-white dark:bg-zinc-900 rounded-lg shadow-lg border border-border z-50 min-w-[240px] max-h-[260px] overflow-hidden dropdown-enter">
                          {!canAssignOthers && (
                            <div className="px-3 py-1.5 bg-amber-50 text-[10px] text-amber-700 border-b border-amber-100 flex items-center gap-1.5">
                              <Lock size={10} /> You can only assign tasks to yourself.
                            </div>
                          )}
                          {canAssignOthers && (
                            <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
                              <input type="text" value={assigneeSearch} onChange={e => setAssigneeSearch(e.target.value)}
                                placeholder="Search people…" className="bg-transparent border-none outline-none text-xs w-full" onClick={e => e.stopPropagation()} autoFocus />
                            </div>
                          )}
                          <div className="max-h-[200px] overflow-y-auto py-1">
                            {(canAssignOthers
                              ? members.filter(m => (m.name || m.user?.name || '').toLowerCase().includes(assigneeSearch.toLowerCase()))
                              : members.filter(m => (m.id || m.user?.id) === user?.id)
                            ).map(m => {
                              const mId = m.id || m.user?.id;
                              const mName = m.name || m.user?.name || 'Unknown';
                              const isChecked = selectedAssignees.includes(mId);
                              return (
                                <button key={mId} onClick={(e) => { e.stopPropagation(); toggleAssignee(mId); }}
                                  className={`flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-surface w-full transition-colors ${isChecked ? 'bg-[#0D9488]/5' : ''}`}>
                                  <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${isChecked ? 'bg-[#0D9488] border-[#0D9488]' : 'border-[#c4c4c4]'}`}>
                                    {isChecked && <Check size={10} className="text-white" />}
                                  </div>
                                  <Avatar name={mName} size="xs" />
                                  <span className="truncate text-text-primary">{mName}</span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {selectedAssignees.length > 0 ? selectedAssignees.map(uid => {
                        const m = members.find(mm => (mm.id || mm.user?.id) === uid);
                        const n = m?.name || m?.user?.name || 'Unknown';
                        return <span key={uid} className="inline-flex items-center gap-1 text-[12px]"><Avatar name={n} size="xs" /><span>{n}</span></span>;
                      }) : <span className="text-text-tertiary text-[12px]">Unassigned</span>}
                    </div>
                  )}
                </div>
              </V3Row>

              <V3Row icon={UserCheck} label={latestAssignedAt ? 'Assigned by' : 'Created by'}>
                {(() => {
                  const creator = task?.creator;
                  if (!creator) return <span className="text-text-tertiary text-[12px]">—</span>;
                  return (
                    <span className="inline-flex items-center gap-1 text-[12px]">
                      <Avatar name={creator.name || 'Unknown'} size="xs" />
                      <span className="text-text-primary truncate">{creator.name || 'Unknown'}</span>
                      <span className="text-[9px] uppercase tracking-wider text-text-tertiary font-semibold tabular-nums">
                        {tierLabel(resolveTier(creator))}
                      </span>
                    </span>
                  );
                })()}
              </V3Row>

              <V3Row icon={Calendar} label={latestAssignedAt ? 'Assigned' : 'Created'}>
                <span className="text-[12px] text-text-primary tabular-nums" title={latestAssignedAt || task?.createdAt || ''}>
                  {assignedOnLabel || createdOnLabel || '—'}
                </span>
              </V3Row>

              <V3Row icon={EyeIcon} label="Watchers">
                <div className="flex items-center gap-1.5 flex-wrap">
                  {watchers.length === 0 ? (
                    <span className="text-text-tertiary text-[12px]">—</span>
                  ) : (
                    <>
                      <div className="flex -space-x-1.5">
                        {watchers.slice(0, 4).map(w => (
                          <div key={w.id} className="relative" title={w.user?.name}>
                            <Avatar name={w.user?.name || '?'} size="xs" />
                          </div>
                        ))}
                      </div>
                      <span className="text-[11px] text-text-tertiary tabular-nums">{watchers.length} watching</span>
                    </>
                  )}
                </div>
              </V3Row>
            </V3Card>

            {/* Card 3 — SCHEDULE (amber) */}
            <V3Card accent="amber" title="Schedule">
              <V3Row icon={Calendar} label="Due">
                {canEditOwnFields && canChangeDueDate ? (
                  <button
                    type="button"
                    onClick={() => openDatePicker(dueDateInputRef)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDatePicker(dueDateInputRef); } }}
                    className="relative text-[12px] px-2 py-0.5 border border-border rounded-md hover:border-primary/30 focus:outline-none focus:border-primary text-left bg-white dark:bg-zinc-900"
                  >
                    <span className={dueDate ? 'text-text-primary' : 'text-text-tertiary'}>
                      {dueDate ? formatTaskDate(dueDate) : 'Set date'}
                    </span>
                    <input
                      ref={dueDateInputRef}
                      type="date"
                      value={dueDate || ''}
                      onChange={(e) => {
                        handleDateChange('dueDate', e.target.value);
                        queueMicrotask(() => e.target.blur());
                      }}
                      tabIndex={-1}
                      aria-hidden="true"
                      style={{ position: 'absolute', inset: 0, opacity: 0, pointerEvents: 'none' }}
                    />
                  </button>
                ) : (
                  // Read-only display — covers two cases:
                  //   1. User can't edit at all (no permission) — render plain.
                  //   2. User can edit other fields but the due date is tier-
                  //      locked (`!canChangeDueDate`) — render with a Lock
                  //      affordance + tooltip so the user understands the
                  //      restriction. The date itself stays visible.
                  <span
                    className={`text-[12px] text-text-primary inline-flex items-center gap-1 ${dueDateLockedReason ? 'opacity-80' : ''}`}
                    title={dueDateLockedReason || undefined}
                  >
                    {dueDate ? formatTaskDate(dueDate) : '—'}
                    {dueDateLockedReason && canEditOwnFields && (
                      <Lock size={10} className="text-text-tertiary" aria-hidden="true" />
                    )}
                  </span>
                )}
                {dueTimeChipLabel && (
                  <span className="text-[11px] text-text-tertiary inline-flex items-center gap-0.5 ml-1 tabular-nums">
                    <Clock size={10} /> {dueTimeChipLabel}
                  </span>
                )}
                {countdown && (
                  <span
                    className={`text-[10px] font-semibold inline-flex items-center px-1.5 py-0.5 rounded-full ml-1 ${countdown.urgent ? 'v3-urgent-pulse' : ''}`}
                    style={{ backgroundColor: countdown.urgent ? '#E11D481a' : '#D976061a', color: countdown.urgent ? '#E11D48' : '#D97706' }}
                  >
                    {countdown.label}
                  </span>
                )}
              </V3Row>

              <V3Row icon={Clock} label="Start">
                {canEditStartDate ? (
                  <button
                    type="button"
                    onClick={() => openDatePicker(startDateInputRef)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDatePicker(startDateInputRef); } }}
                    className="relative text-[12px] px-2 py-0.5 border border-border rounded-md hover:border-primary/30 focus:outline-none focus:border-primary text-left bg-white dark:bg-zinc-900"
                  >
                    <span className={startDate ? 'text-text-primary' : 'text-text-tertiary'}>
                      {startDate ? formatTaskDate(startDate) : '—'}
                    </span>
                    <input
                      ref={startDateInputRef}
                      type="date"
                      value={startDate || ''}
                      onChange={(e) => {
                        handleDateChange('startDate', e.target.value);
                        queueMicrotask(() => e.target.blur());
                      }}
                      tabIndex={-1}
                      aria-hidden="true"
                      style={{ position: 'absolute', inset: 0, opacity: 0, pointerEvents: 'none' }}
                    />
                  </button>
                ) : (
                  <span className="text-[12px] text-text-primary">{startDate ? formatTaskDate(startDate) : '—'}</span>
                )}
              </V3Row>

              {(canEditOwnFields || !task) && (
                <V3Row icon={Bell} label="Reminders">
                  <TaskReminderField
                    value={reminders}
                    dueDate={dueDate}
                    disabled={deletedRemotely}
                    onChange={(next) => {
                      setReminders(next);
                      if (task?.id) save({ reminders: next });
                    }}
                  />
                </V3Row>
              )}
            </V3Card>

            {/* Card 4 — RECURRENCE (purple) — only when recurring */}
            {task?.isRecurringInstance && (
              <V3Card accent="purple" title="Recurrence">
                <RecurringInstanceDetails
                  task={task}
                  template={recurringTemplate || null}
                  templateLoading={recurringTemplate === null}
                  board={boardContext}
                  canManageTemplate={!!canManage}
                />
              </V3Card>
            )}

            {/* Card 5 — LABELS (rose) */}
            <V3Card accent="rose" title="Labels">
              <div className="flex items-center gap-1.5 flex-wrap">
                {tags.length === 0 && !canEditAllFields && (
                  <span className="text-text-tertiary text-[12px]">—</span>
                )}
                {tags.map((tag, i) => (
                  <span key={tag} className="inline-flex items-center gap-1 bg-[#E11D48]/10 text-[#E11D48] text-[11px] px-2 py-0.5 rounded-full">
                    <Tag size={9} /> {tag}
                    {canEditAllFields && <button onClick={() => removeTag(i)} className="hover:opacity-70"><X size={9} /></button>}
                  </span>
                ))}
                {canEditAllFields && (
                  <input
                    type="text"
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                    onKeyDown={handleAddTag}
                    placeholder={tags.length ? '+ Add' : 'Add label…'}
                    className="text-[11px] border-none outline-none bg-transparent min-w-[60px] placeholder:text-text-tertiary"
                  />
                )}
              </div>
            </V3Card>

          </aside>
        </div>

        {/* ── Row 5: Footer ─────────────────────────────────────────── */}
        <footer className="border-t border-border bg-zinc-50/80 dark:bg-zinc-900/40 px-5 h-[40px] flex items-center justify-between text-[11px] text-text-secondary flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <span className="font-medium text-text-secondary flex-shrink-0">Progress</span>
            <div className="w-32 h-1.5 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden flex-shrink-0">
              <div
                className="h-full transition-all"
                style={{
                  width: `${footerProgress.pct}%`,
                  background: 'linear-gradient(90deg, #6D5CE7, #A78BFA)',
                }}
              />
            </div>
            <span className="tabular-nums text-text-tertiary">
              {footerProgress.total ? `${footerProgress.done}/${footerProgress.total} · ` : ''}{footerProgress.pct}%
            </span>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <span className="hidden md:inline-flex items-center gap-1 text-text-tertiary">
              <kbd className="px-1.5 py-0.5 rounded border border-border text-[10px] font-mono">esc</kbd>
              <span>close</span>
            </span>
            <span className="hidden md:inline-flex items-center gap-1 text-text-tertiary">
              <kbd className="px-1.5 py-0.5 rounded border border-border text-[10px] font-mono">⌘ + ↵</kbd>
              <span>save</span>
            </span>
            <span className="hidden lg:inline-flex items-center gap-1 text-text-tertiary">
              <kbd className="px-1.5 py-0.5 rounded border border-border text-[10px] font-mono">e</kbd>
              <span>edit</span>
            </span>
            <div className="inline-flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${
                saveStatus === 'saving' ? 'bg-blue-500 v3-pulse-dot' :
                saveStatus === 'error' ? 'bg-red-500' :
                'bg-emerald-500'
              }`} />
              <span className="text-text-secondary">
                {saveStatus === 'saving' ? 'Saving…' :
                  saveStatus === 'error' ? 'Save failed' :
                  savedAt ? `Saved · ${savedAgo || 'just now'}` : 'Saved'}
              </span>
            </div>
          </div>
        </footer>
      </DetailModalShell>

      {/* Dependency Selector */}
      {showDepSelector && (
        <DependencySelector
          task={task}
          boardId={boardId || task.boardId}
          onClose={() => setShowDepSelector(false)}
          onCreated={async () => {
            setDepKey(k => k + 1);
            try {
              const res = await api.get(`/tasks/${task.id}`);
              const updated = res.data?.data?.task || res.data?.task || res.data;
              if (updated) {
                setStatus(updated.status || status);
                if (updated.startDate) setStartDate(updated.startDate.slice(0, 10));
                if (onUpdate) onUpdate(updated);
              }
            } catch {}
            loadDependencyRole();
          }}
        />
      )}

      {showExtension && (
        <DueDateExtensionModal task={task} onClose={() => setShowExtension(false)} onUpdated={() => { if (onUpdate) onUpdate({ ...task }); }} />
      )}

      {showHelpRequest && (
        <HelpRequestModal task={task} onClose={() => setShowHelpRequest(false)} />
      )}

      {showApprovalModal && (
        <MarkDoneApprovalModal
          task={task}
          onClose={() => setShowApprovalModal(false)}
          onSubmitted={(updated) => {
            if (updated && onUpdate) onUpdate(updated);
          }}
        />
      )}
    </>
  );
}
