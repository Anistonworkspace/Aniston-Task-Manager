import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ClipboardCheck, Clock, HelpCircle, Check, X,
  Calendar, MessageSquare, ExternalLink, Filter, Inbox, Shield, Search,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useT } from '../context/LanguageContext';
import Avatar from '../components/common/Avatar';
import TaskModal from '../components/task/TaskModal';

// TODO i18n: further strings (form labels, error messages, dialogs) still hardcoded — extend in a future pass
import Modal from '../components/common/Modal';
import ErrorBoundary from '../components/common/ErrorBoundary';
import { useToast } from '../components/common/Toast';
import useRealtimeEvent from '../realtime/useRealtimeEvent';
import { getBoardStatuses } from '../utils/constants';
import { roleLabelFor } from '../utils/approvalStages';

// ── Soft Neumorphic design tokens (scoped to this page) ─────────
// Tuned to the app's actual palette: neutral slate surfaces + indigo
// accent (`primary` = #4f46e5). The pink/purple gradients from the
// first redesign pass were too candy-coloured for the rest of the
// dashboard — replaced with subtle indigo/neutral/mint hints that
// read as a professional admin surface.
const TONE = {
  pageBg:        '#F3F5FA',
  tile:          '#F6F7FB',
  // Mirror the app's CSS variable text tokens so this page reads as
  // part of the same surface system (--text-primary / --text-secondary).
  textPrimary:   '#323338',
  textSecondary: '#676879',
  textMuted:     '#94A3B8',
  onDark:        '#FAFAFA',
  indigo:        '#4F46E5', // tailwind `primary` (#4f46e5)
  indigoDeep:    '#4338CA',
  indigoSoft:    '#EEF2FF',
  mint:          '#10B981',
  mintText:      '#047857',
  coral:         '#DC2626',
  coralText:     '#B91C1C',
  amber:         '#F59E0B',
  amberText:     '#C2410C',
};

// Subtle gradients — small indigo hint instead of the previous strong
// pink/violet pastel. Defaults stay near-white so cards blend with the
// app shell; the hero variant adds a soft mint tail to signal
// "your action is requested" without screaming.
const HERO_GRADIENT          = 'linear-gradient(135deg, #EEF2FF 0%, #F3F4F6 55%, #ECFDF5 100%)';
const DEFAULT_CARD_GRADIENT  = 'linear-gradient(135deg, #F8FAFC 0%, #EEF2FF 55%, #F5F7FB 100%)';
const ACCENT_GRADIENT        = 'linear-gradient(135deg, #EEF2FF 0%, #E0E7FF 100%)';
// Action gradients kept colourful — they need to remain instantly
// distinguishable as Approve / Reject / Request changes affordances.
const APPROVE_GRADIENT       = 'linear-gradient(135deg, #A7F3D0 0%, #6EE7B7 100%)';
const REJECT_GRADIENT        = 'linear-gradient(135deg, #FECACA 0%, #FCA5A5 100%)';
const CHANGES_GRADIENT       = 'linear-gradient(135deg, #FED7AA 0%, #FDBA74 100%)';

// Neumorphic shadow system. Same philosophy as DependenciesPage but the
// dark-side shadow is slightly softer to suit the lighter page bg.
const SHADOW_RAISED    = '5px 5px 12px rgba(148, 163, 184, 0.30), -5px -5px 12px rgba(255, 255, 255, 0.95)';
const SHADOW_RAISED_LG = '7px 7px 16px rgba(148, 163, 184, 0.36), -7px -7px 16px rgba(255, 255, 255, 1), inset 1px 1px 2px rgba(255, 255, 255, 0.5)';
const SHADOW_PRESSED   = 'inset 2px 2px 5px rgba(148, 163, 184, 0.22), inset -2px -2px 5px rgba(255, 255, 255, 0.95)';
const SHADOW_BUTTON    = '3px 3px 6px rgba(148, 163, 184, 0.32), -3px -3px 6px rgba(255, 255, 255, 0.95)';
const SHADOW_HOVER     = '7px 7px 16px rgba(148, 163, 184, 0.38), -7px -7px 16px rgba(255, 255, 255, 1)';

const TABS = [
  { id: 'approvals', label: 'Approvals', icon: ClipboardCheck },
  // Internal id stays `myFeedback` to avoid touching API/state plumbing —
  // only the visible label changes. Tab shows level-0 TaskApprovalFlow rows
  // (the submitter's side of an approval), which is best read as "submissions"
  // not "feedback received about my work."
  { id: 'myFeedback', label: 'My Submissions', icon: Inbox },
  { id: 'extensions', label: 'Extensions', icon: Clock },
  { id: 'help', label: 'Help Requests', icon: HelpCircle },
];

// Per-tab status filters. Values must EXACTLY match the backend status field
// each tab queries against, so the filter equality check actually matches:
//   - approvals       → Task.approvalStatus  (pending_approval | approved | rejected | changes_requested)
//   - myFeedback      → mapped status        (pending | approved | rejected | changes_requested)
//   - extensions      → DueDateExtension.status (pending | approved | rejected)
//   - help            → HelpRequest.status   (pending | in_review | resolved)
// Each tab gets its own list because the workflows are genuinely different —
// "resolved" is only meaningful for help requests, "changes_requested" only
// for approval flows, etc. A shared list would always be wrong somewhere.
const STATUS_FILTERS = {
  approvals: [
    { value: 'all', label: 'All' },
    { value: 'pending_approval', label: 'Pending Approval' },
    { value: 'approved', label: 'Approved' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'changes_requested', label: 'Changes Requested' },
  ],
  // Submitter-perspective labels. The `value` field MUST stay aligned with the
  // backend status the my-feedback endpoint returns (pending | approved |
  // rejected | changes_requested) — only the human-facing `label` is softened
  // to read like "things I sent in" instead of "decisions I made."
  myFeedback: [
    { value: 'all', label: 'All' },
    { value: 'pending', label: 'Awaiting Review' },
    { value: 'approved', label: 'Accepted' },
    { value: 'rejected', label: 'Declined' },
    { value: 'changes_requested', label: 'Revision Needed' },
  ],
  extensions: [
    { value: 'all', label: 'All' },
    { value: 'pending', label: 'Pending' },
    { value: 'approved', label: 'Approved' },
    { value: 'rejected', label: 'Rejected' },
  ],
  help: [
    { value: 'all', label: 'All' },
    { value: 'pending', label: 'Pending' },
    { value: 'in_review', label: 'In Review' },
    { value: 'resolved', label: 'Resolved' },
  ],
};

const EMPTY_ALL = {
  approvals: 'No approval items',
  myFeedback: 'No submissions sent for approval yet',
  extensions: 'No extension requests',
  help: 'No help requests',
};

// Per-tab overrides for the filtered empty state. Used when "No <label> items"
// reads awkwardly (e.g. "No revision needed items" vs the cleaner "No
// submissions needing revision"). Falls back to the generic builder below.
const EMPTY_FILTERED = {
  myFeedback: {
    pending: 'No submissions awaiting review',
    approved: 'No accepted submissions',
    rejected: 'No declined submissions',
    changes_requested: 'No submissions needing revision',
  },
};

function getEmptyMessage(activeTab, statusFilter) {
  if (statusFilter === 'all') return EMPTY_ALL[activeTab] || 'No items';
  const override = EMPTY_FILTERED[activeTab]?.[statusFilter];
  if (override) return override;
  const filter = STATUS_FILTERS[activeTab]?.find((f) => f.value === statusFilter);
  return filter ? `No ${filter.label.toLowerCase()} items` : EMPTY_ALL[activeTab];
}

const STATUS_BADGES = {
  pending:           { label: 'Pending',           bg: '#FEF3C7', fg: '#92400E' },
  pending_approval:  { label: 'Pending Approval',  bg: '#FEF3C7', fg: '#92400E' },
  approved:          { label: 'Approved',          bg: '#D1FAE5', fg: '#047857' },
  rejected:          { label: 'Rejected',          bg: '#FEE2E2', fg: '#B91C1C' },
  changes_requested: { label: 'Changes Requested', bg: '#FED7AA', fg: '#C2410C' },
  in_review:         { label: 'In Review',         bg: '#DBEAFE', fg: '#1D4ED8' },
  resolved:          { label: 'Resolved',          bg: '#D1FAE5', fg: '#047857' },
  meeting_scheduled: { label: 'Meeting Scheduled', bg: '#E0E7FF', fg: '#3730A3' },
};

const URGENCY_BADGES = {
  low:      { bg: '#DBEAFE', fg: '#1D4ED8' },
  medium:   { bg: '#FEF3C7', fg: '#C2410C' },
  high:     { bg: '#FED7AA', fg: '#C2410C' },
  critical: { bg: '#FEE2E2', fg: '#B91C1C' },
};

// ── Search + grouping helpers ────────────────────────────────────
// Pure helpers — receive already-loaded data and return filtered/grouped
// views. No new API calls, no shape changes. Insertion order is preserved
// from the server response so existing sort (updatedAt DESC etc.) survives.
function matchesQuery(query, ...fields) {
  if (!query) return true;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some(f => String(f ?? '').toLowerCase().includes(q));
}

function groupByBoard(items, getBoard) {
  const order = [];
  const map = new Map();
  for (const it of items) {
    const b = getBoard(it);
    const key = b?.id || (b?.name ? `name:${b.name}` : '__unassigned');
    if (!map.has(key)) {
      map.set(key, {
        key,
        name: b?.name || 'Other',
        color: b?.color || null,
        items: [],
      });
      order.push(key);
    }
    map.get(key).items.push(it);
  }
  return order.map(k => map.get(k));
}

export default function TasksPage() {
  const { canManage, isAdmin, isAssistantManager } = useAuth();
  const t = useT();
  const canViewTeamFeedback = canManage || isAssistantManager;
  const { addToast } = useToast();
  // Map TABS[].id → translation key. Untranslated ids fall back to tab.label.
  const TAB_LABEL_KEYS = {
    approvals: 'tasksPage.tabs.approvals',
    myFeedback: 'tasksPage.tabs.mySubmissions',
    extensions: 'tasksPage.tabs.extensions',
    help: 'tasksPage.tabs.helpRequests',
  };
  const [activeTab, setActiveTab] = useState('approvals');
  const [data, setData] = useState({ approvals: [], extensions: [], helpRequests: [] });
  const [myFeedback, setMyFeedback] = useState([]);
  const [feedbackScope, setFeedbackScope] = useState('mine');
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [actionLoading, setActionLoading] = useState(null);
  const [selectedTask, setSelectedTask] = useState(null);
  const [selectedBoardId, setSelectedBoardId] = useState(null);
  const [boardMembers, setBoardMembers] = useState([]);
  const [boardStatuses, setBoardStatuses] = useState(null);
  // P2: replace browser prompt() with state-driven Modal. `null` = closed, else
  // an object `{ kind, taskId, defaultValue, label, title, submitLabel }` that
  // both renders the dialog and tells the submit handler which action to fire.
  const [reasonDialog, setReasonDialog] = useState(null);
  const [reasonValue, setReasonValue] = useState('');

  const openTask = useCallback(async (taskId, boardId) => {
    try {
      const [taskRes, boardRes] = await Promise.all([
        api.get(`/tasks/${taskId}`),
        boardId ? api.get(`/boards/${boardId}`) : Promise.resolve(null),
      ]);
      // Task API returns { success, data: { task: {...} } }
      const taskPayload = taskRes.data.data || taskRes.data;
      const fullTask = taskPayload.task || taskPayload;
      // Board API returns { success, data: { board: {...} } }
      const boardPayload = boardRes?.data?.data || boardRes?.data;
      const board = boardPayload?.board || boardPayload;
      setSelectedTask(fullTask);
      setSelectedBoardId(boardId);
      setBoardMembers(board?.members || []);
      setBoardStatuses(board ? getBoardStatuses(board) : null);
    } catch (err) {
      // CP-3 RBAC: a 403 here means the viewer is no longer in the task's
      // visibility scope (e.g. reassigned away). Show a clean message rather
      // than the raw error.
      const status = err?.response?.status;
      if (status === 403) {
        addToast('You do not have permission to view this task.', 'warning');
      } else if (status === 404) {
        addToast('Task not found or has been archived.', 'warning');
      } else {
        addToast('Failed to open task.', 'error');
      }
      console.error('Failed to open task:', err);
    }
  }, [addToast]);

  const closeTaskModal = useCallback(() => {
    setSelectedTask(null);
    setSelectedBoardId(null);
    setBoardMembers([]);
    setBoardStatuses(null);
  }, []);

  const fetchMyFeedback = useCallback(async (scope) => {
    try {
      const res = await api.get('/task-extras/my-feedback', { params: scope ? { scope } : {} });
      const payload = res.data?.data || res.data;
      setMyFeedback(Array.isArray(payload?.feedback) ? payload.feedback : []);
    } catch (err) {
      // Non-fatal — don't blank the rest of the page if just this endpoint fails.
      console.error('Failed to load my feedback:', err);
      setMyFeedback([]);
    }
  }, []);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      // workflow-items only — my-feedback is handled by the scope-driven effect
      // below so changing the scope toggle doesn't re-pull the whole page.
      const workflowRes = await api.get('/task-extras/workflow-items');
      setData(workflowRes.data.data || workflowRes.data);
    } catch (err) {
      console.error('Failed to load workflow items:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Re-pull my-feedback whenever the scope toggle changes (and on mount).
  useEffect(() => {
    fetchMyFeedback(feedbackScope === 'mine' ? undefined : feedbackScope);
  }, [feedbackScope, fetchMyFeedback]);

  // Live-refresh feedback view when any approval action fires anywhere — covers
  // the case where the submitter is watching the page and an approver acts.
  // Cheap (limit 200, indexed) and keeps the UI honest without a full reload.
  useRealtimeEvent('task:approval-updated', () => {
    fetchMyFeedback(feedbackScope === 'mine' ? undefined : feedbackScope);
  });

  // Approval actions. Optional comment for approve, required (non-empty) for
  // reject and request-changes — server enforces this; client matches so we
  // don't even make the call if the user cancels the prompt.
  async function handleApprove(taskId) {
    setActionLoading(taskId);
    try {
      await api.post(`/task-extras/${taskId}/approve`, { comment: '' });
      fetchData();
    } catch (err) {
      const msg = err.response?.data?.message || 'Failed to approve.';
      addToast(msg, 'error');
      console.error(err);
    } finally { setActionLoading(null); }
  }

  // P2: was a browser prompt(); now opens the inline Modal. The actual API
  // call moved to performReject() which the modal's submit button invokes
  // with the typed-in reason — keeping the same downstream behavior.
  function handleReject(taskId) {
    setReasonValue('');
    setReasonDialog({
      kind: 'reject',
      taskId,
      title: 'Reject submission',
      label: 'Reason for rejection (required):',
      submitLabel: 'Reject',
      required: true,
    });
  }

  async function performReject(taskId, comment) {
    setActionLoading(taskId);
    try {
      await api.post(`/task-extras/${taskId}/reject`, { comment });
      fetchData();
    } catch (err) {
      const msg = err.response?.data?.message || 'Failed to reject.';
      addToast(msg, 'error');
      console.error(err);
    } finally { setActionLoading(null); }
  }

  async function handleRequestChanges(taskId) {
    // TODO: replace prompt() with Modal — see P2 fix template above (handleReject + performReject + reasonDialog state).
    const comment = prompt('Reason for requesting changes (required):');
    if (comment === null) return;
    if (!comment.trim()) {
      addToast('A reason is required to request changes.', 'warning');
      return;
    }
    setActionLoading(taskId);
    try {
      await api.post(`/task-extras/${taskId}/request-changes`, { comment });
      fetchData();
    } catch (err) {
      const msg = err.response?.data?.message || 'Failed to request changes.';
      addToast(msg, 'error');
      console.error(err);
    } finally { setActionLoading(null); }
  }

  // Extension actions
  async function handleApproveExtension(extId, suggestedDate) {
    setActionLoading(extId);
    try {
      await api.put(`/extensions/${extId}/approve`, { reviewNote: '', suggestedDate });
      fetchData();
    } catch (err) { console.error(err); } finally { setActionLoading(null); }
  }

  async function handleRejectExtension(extId) {
    // TODO: replace prompt() with Modal — see P2 fix template above (handleReject + performReject + reasonDialog state).
    const note = prompt('Reason for rejection:');
    if (note === null) return;
    setActionLoading(extId);
    try {
      await api.put(`/extensions/${extId}/reject`, { reviewNote: note });
      fetchData();
    } catch (err) { console.error(err); } finally { setActionLoading(null); }
  }

  // Help request actions
  async function handleResolveHelp(helpId) {
    setActionLoading(helpId);
    try {
      await api.put(`/help-requests/${helpId}/status`, { status: 'resolved' });
      fetchData();
    } catch (err) { console.error(err); } finally { setActionLoading(null); }
  }

  // Filter items by status
  function filterByStatus(items, statusField = 'approvalStatus') {
    if (statusFilter === 'all') return items;
    return items.filter(item => (item[statusField] || item.status) === statusFilter);
  }

  const counts = {
    approvals: data.approvals?.filter(t => t.approvalStatus === 'pending_approval').length || 0,
    myFeedback: myFeedback?.filter(f => f.status === 'pending').length || 0,
    extensions: data.extensions?.filter(e => e.status === 'pending').length || 0,
    help: data.helpRequests?.filter(h => h.status !== 'resolved').length || 0,
  };

  // Compact stats — derived only from already-loaded `data` and `myFeedback`.
  // No new API calls; metrics like "approved this week" / "avg decision time"
  // are intentionally omitted because the backend doesn't expose them.
  const stats = useMemo(() => {
    const pending = (data.approvals || []).filter(x => x.approvalStatus === 'pending_approval');
    const higherLevel = pending.filter(x =>
      x.myCapabilities?.isOverrideApprover || x.myCapabilities?.canApproveEarly
    ).length;
    return {
      pending: pending.length,
      higherLevel,
      extensions: (data.extensions || []).filter(e => e.status === 'pending').length,
      help: (data.helpRequests || []).filter(h => h.status !== 'resolved').length,
    };
  }, [data]);

  // ── Visible items per tab — pipeline: tab → status → search → group ─
  // Computed in useMemo so unrelated state changes (action loading, modal
  // open, etc.) don't re-walk the lists.
  const approvalGroups = useMemo(() => {
    const byStatus = filterByStatus(data.approvals || [], 'approvalStatus');
    const bySearch = byStatus.filter((task) => matchesQuery(
      search,
      task.title,
      task.board?.name,
      task.assignee?.name,
      STATUS_BADGES[task.approvalStatus]?.label,
      ...(task.approvalChain || []).flatMap(e => [e.userName, e.comment, e.action]),
    ));
    return groupByBoard(bySearch, (it) => it.board);
  }, [data.approvals, statusFilter, search]);

  const submissionGroups = useMemo(() => {
    const byStatus = statusFilter === 'all'
      ? myFeedback
      : myFeedback.filter((f) => f.status === statusFilter);
    const bySearch = byStatus.filter((item) => matchesQuery(
      search,
      item.task?.title,
      item.task?.board?.name,
      item.submittedBy?.name,
      item.currentApprover?.name,
      item.stageLabel,
      item.status,
      item.comment,
    ));
    return groupByBoard(bySearch, (it) => it.task?.board);
  }, [myFeedback, statusFilter, search]);

  const extensionGroups = useMemo(() => {
    const byStatus = filterByStatus(data.extensions || []);
    const bySearch = byStatus.filter((ext) => matchesQuery(
      search,
      ext.task?.title,
      ext.task?.board?.name,
      ext.requester?.name,
      ext.status,
      ext.reason,
      ext.reviewNote,
    ));
    return groupByBoard(bySearch, (it) => it.task?.board);
  }, [data.extensions, statusFilter, search]);

  const helpGroups = useMemo(() => {
    const byStatus = filterByStatus(data.helpRequests || []);
    const bySearch = byStatus.filter((hr) => matchesQuery(
      search,
      hr.task?.title,
      hr.task?.board?.name,
      hr.requester?.name,
      hr.helper?.name,
      hr.status,
      hr.description,
      hr.urgency,
    ));
    return groupByBoard(bySearch, (it) => it.task?.board);
  }, [data.helpRequests, statusFilter, search]);

  const visibleCount = useMemo(() => {
    const groups = activeTab === 'approvals' ? approvalGroups
      : activeTab === 'myFeedback' ? submissionGroups
      : activeTab === 'extensions' ? extensionGroups
      : helpGroups;
    return groups.reduce((n, g) => n + g.items.length, 0);
  }, [activeTab, approvalGroups, submissionGroups, extensionGroups, helpGroups]);

  // Reset search when switching tabs to avoid sticky-empty-state confusion
  // (a query that matched the previous tab's data could leave the new tab
  // looking empty for no obvious reason).
  function switchTab(id) {
    setActiveTab(id);
    setStatusFilter('all');
    setSearch('');
  }

  return (
    <div className="min-h-full p-4 sm:p-6" style={{ backgroundColor: TONE.pageBg }}>
      <div className="max-w-7xl mx-auto space-y-5">
        {/* ── Compact header with right-aligned search ────────────────
            `items-center` on ≥sm keeps the search bar visually anchored
            to the title row; `flex-wrap` lets it slide below the title
            on narrow widths. The search is given `order` so on mobile
            it lands directly under the header instead of after the
            subtitle. */}
        <div className="flex flex-wrap sm:flex-nowrap sm:items-center items-start justify-between gap-3 sm:gap-4">
          <div className="min-w-0 flex-1">
            <h1
              className="flex items-center gap-3 text-[22px] sm:text-[24px] font-bold leading-none"
              style={{ color: TONE.textPrimary, letterSpacing: '-0.02em' }}
            >
              <span
                className="inline-flex items-center justify-center w-9 h-9 flex-shrink-0"
                style={{ background: HERO_GRADIENT, boxShadow: SHADOW_BUTTON, borderRadius: 12 }}
                aria-hidden="true"
              >
                <ClipboardCheck size={16} style={{ color: TONE.indigo }} />
              </span>
              {t('tasksPage.title')}
            </h1>
            <p className="text-[13px] mt-1.5 ml-[46px]" style={{ color: TONE.textSecondary }}>
              {t('tasksPage.subtitle')}
            </p>
          </div>
          <div className="w-full sm:w-auto sm:flex-shrink-0">
            <SearchBox value={search} onChange={setSearch} />
          </div>
        </div>

        {/* ── Compact stats row (derived from loaded data only) ───── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatTile label="Pending Review" value={stats.pending} icon={ClipboardCheck} accent={TONE.indigo} />
          <StatTile label="Higher-Level" value={stats.higherLevel} icon={Shield} accent={TONE.indigoDeep} hint={stats.higherLevel ? 'Your approval needed' : 'None pending'} />
          <StatTile label="Extensions" value={stats.extensions} icon={Clock} accent={TONE.amber} />
          <StatTile label="Help Requests" value={stats.help} icon={HelpCircle} accent={TONE.coral} />
        </div>

        {/* ── Compact tab pill row ─────────────────────────────────── */}
        <div
          className="flex items-center gap-1.5 flex-wrap p-1.5 rounded-2xl"
          style={{ backgroundColor: TONE.pageBg, boxShadow: SHADOW_PRESSED }}
        >
          {TABS.map(tab => {
            const active = activeTab === tab.id;
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => switchTab(tab.id)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-[12.5px] font-semibold transition-all"
                style={active
                  ? { backgroundColor: TONE.textPrimary, color: TONE.onDark, boxShadow: SHADOW_BUTTON }
                  : { backgroundColor: 'transparent', color: TONE.textSecondary }}
              >
                <Icon size={13} />
                {TAB_LABEL_KEYS[tab.id] ? t(TAB_LABEL_KEYS[tab.id]) : tab.label}
                {counts[tab.id] > 0 && (
                  <span
                    className="ml-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold"
                    style={active
                      ? { backgroundColor: 'rgba(255,255,255,0.22)', color: TONE.onDark }
                      : { backgroundColor: 'rgba(79,70,229,0.12)', color: TONE.indigo }}
                  >
                    {counts[tab.id]}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* ── Compact status filter chips ──────────────────────────── */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <Filter size={12} style={{ color: TONE.textMuted }} aria-hidden="true" />
          <span
            className="text-[10.5px] font-semibold uppercase tracking-wide mr-1"
            style={{ color: TONE.textMuted }}
          >
            Status
          </span>
          {(STATUS_FILTERS[activeTab] || STATUS_FILTERS.approvals).map((opt) => {
            const active = statusFilter === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => setStatusFilter(opt.value)}
                className="px-2.5 py-1 rounded-full text-[11px] font-medium transition-all"
                style={active
                  ? { background: ACCENT_GRADIENT, color: TONE.indigoDeep, boxShadow: SHADOW_BUTTON }
                  : { backgroundColor: TONE.pageBg, color: TONE.textSecondary, boxShadow: SHADOW_PRESSED }}
              >
                {opt.label}
              </button>
            );
          })}
          {activeTab === 'myFeedback' && canViewTeamFeedback && (
            <span
              className="ml-2 inline-flex items-center gap-1 p-0.5 rounded-full"
              style={{ backgroundColor: TONE.pageBg, boxShadow: SHADOW_PRESSED }}
            >
              {[
                { id: 'mine', label: 'Mine' },
                { id: 'team', label: 'My Team' },
                ...(canManage ? [{ id: 'all', label: 'Org-wide' }] : []),
              ].map((opt) => {
                const active = feedbackScope === opt.id;
                return (
                  <button
                    key={opt.id}
                    onClick={() => setFeedbackScope(opt.id)}
                    className="px-2 py-0.5 rounded-full text-[11px] font-medium transition-all"
                    style={active
                      ? { backgroundColor: TONE.textPrimary, color: TONE.onDark, boxShadow: SHADOW_BUTTON }
                      : { backgroundColor: 'transparent', color: TONE.textSecondary }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </span>
          )}
        </div>

        {loading ? (
          <SkeletonGrid />
        ) : (
          <div className="space-y-5">

            {/* ═══ APPROVALS TAB ═══ */}
            {activeTab === 'approvals' && (
              visibleCount === 0 ? (
                <EmptyState
                  icon={search ? Search : ClipboardCheck}
                  message={search ? 'No approvals found' : getEmptyMessage('approvals', statusFilter)}
                  hint={search ? 'Try a different search or filter.' : null}
                />
              ) : approvalGroups.map((group) => (
                <BoardGroup key={group.key} name={group.name} color={group.color} count={group.items.length}>
                  {group.items.map(task => {
                    const cap = task.myCapabilities;
                    const isHero = !!(cap?.isOverrideApprover || cap?.canApproveEarly);
                    return (
                      <div
                        key={task.id}
                        className="p-4 sm:p-5 transition-shadow"
                        style={{
                          background: isHero ? HERO_GRADIENT : DEFAULT_CARD_GRADIENT,
                          borderRadius: 18,
                          boxShadow: isHero ? SHADOW_RAISED_LG : SHADOW_RAISED,
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.boxShadow = SHADOW_HOVER; }}
                        onMouseLeave={(e) => { e.currentTarget.style.boxShadow = isHero ? SHADOW_RAISED_LG : SHADOW_RAISED; }}
                      >
                        <div className="flex items-start justify-between gap-3 mb-2">
                          <div className="flex items-center gap-2 flex-wrap min-w-0">
                            <h3 className="text-[15px] sm:text-[16px] font-bold truncate" style={{ color: TONE.textPrimary, letterSpacing: '-0.01em' }}>
                              <button
                                onClick={() => openTask(task.id, task.board?.id || task.boardId)}
                                className="hover:underline text-left"
                                style={{ color: TONE.textPrimary }}
                              >
                                {task.title}
                              </button>
                            </h3>
                            <NeoStatusBadge status={task.approvalStatus} />
                          </div>
                          {(cap?.isOverrideApprover || cap?.canApproveEarly) && (
                            <span
                              className="inline-flex items-center gap-1 text-[9.5px] font-bold uppercase tracking-wide px-2 py-1 flex-shrink-0"
                              style={{
                                backgroundColor: 'rgba(255,255,255,0.75)',
                                color: cap.isOverrideApprover ? TONE.indigoDeep : TONE.amberText,
                                borderRadius: 999,
                                boxShadow: SHADOW_BUTTON,
                              }}
                            >
                              <Shield size={9} />
                              {cap.isOverrideApprover ? 'Tier 1 Override' : 'Higher-Level Approver'}
                            </span>
                          )}
                        </div>

                        {/* Meta row */}
                        <div className="flex items-center gap-3 flex-wrap text-[11.5px] mb-2.5" style={{ color: TONE.textSecondary }}>
                          {task.assignee && (
                            <span className="inline-flex items-center gap-1.5">
                              <Avatar name={task.assignee.name} size="xs" />
                              <span>{task.assignee.name}</span>
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1" style={{ color: TONE.textMuted }}>
                            <Calendar size={10} /> Updated {formatDistanceToNow(new Date(task.updatedAt), { addSuffix: true })}
                          </span>
                        </div>

                        {/* Approval chain entries (last 3) — each rendered as a soft white recessed note */}
                        {task.approvalChain?.length > 0 && (
                          <div className="space-y-1.5 mb-3">
                            {task.approvalChain.slice(-3).map((entry, i) => (
                              <div
                                key={i}
                                className="px-3 py-2"
                                style={{ backgroundColor: 'rgba(255,255,255,0.65)', borderRadius: 12 }}
                              >
                                <p className="text-[11px]" style={{ color: TONE.textSecondary }}>
                                  <span className="font-semibold" style={{ color: TONE.textPrimary }}>{entry.userName}</span>{' '}
                                  <span
                                    className="font-semibold"
                                    style={{
                                      color: entry.action === 'approved' ? TONE.mintText
                                        : entry.action === 'changes_requested' ? TONE.amberText
                                        : entry.action === 'rejected' ? TONE.coralText
                                        : TONE.indigo,
                                    }}
                                  >
                                    {entry.action === 'changes_requested' ? 'requested changes'
                                      : entry.action === 'submitted' ? 'submitted for approval'
                                      : entry.action}
                                  </span>
                                  {entry.timestamp && (
                                    <span className="ml-1" style={{ color: TONE.textMuted }}>
                                      · {new Date(entry.timestamp).toLocaleString()}
                                    </span>
                                  )}
                                </p>
                                {entry.comment && (
                                  <p className="text-[11.5px] mt-1 italic" style={{ color: TONE.textPrimary }}>
                                    "{entry.comment}"
                                  </p>
                                )}
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Action buttons strictly from server-supplied capability
                            flags. The server is the single source of truth — never
                            gate on `canManage` here, because manager+admin includes
                            users who aren't current approvers. The capability flags
                            already encode current-stage / higher-stage / Super Admin
                            override, plus self-approval guard. */}
                        {task.approvalStatus === 'pending_approval' && cap && (
                          (cap.canApprove || cap.canReject || cap.canRequestChanges) ? (
                            <div className="flex items-center justify-end gap-2 flex-wrap">
                              {cap.canRequestChanges && (
                                <NeoActionButton
                                  onClick={() => handleRequestChanges(task.id)}
                                  disabled={actionLoading === task.id}
                                  gradient={CHANGES_GRADIENT}
                                  fg={TONE.amberText}
                                  icon={MessageSquare}
                                  label="Request changes"
                                />
                              )}
                              {cap.canReject && (
                                <NeoActionButton
                                  onClick={() => handleReject(task.id)}
                                  disabled={actionLoading === task.id}
                                  gradient={REJECT_GRADIENT}
                                  fg={TONE.coralText}
                                  icon={X}
                                  label="Reject"
                                />
                              )}
                              {cap.canApprove && (
                                <NeoActionButton
                                  onClick={() => handleApprove(task.id)}
                                  disabled={actionLoading === task.id}
                                  gradient={APPROVE_GRADIENT}
                                  fg={TONE.mintText}
                                  icon={Check}
                                  label={cap.canApproveEarly ? 'Approve early' : 'Approve'}
                                />
                              )}
                            </div>
                          ) : cap.reasonIfCannotAct ? (
                            <div className="flex items-center justify-end text-right">
                              <p
                                className="text-[11px] italic max-w-[260px]"
                                style={{ color: TONE.textMuted }}
                                title={cap.reasonIfCannotAct}
                              >
                                {cap.currentApproverNames?.length > 0
                                  ? `Waiting on ${cap.currentApproverNames.slice(0, 2).join(', ')}${cap.currentApproverNames.length > 2 ? ` +${cap.currentApproverNames.length - 2}` : ''}`
                                  : null}
                              </p>
                            </div>
                          ) : null
                        )}
                      </div>
                    );
                  })}
                </BoardGroup>
              ))
            )}

            {/* ═══ MY SUBMISSIONS TAB ═══ */}
            {activeTab === 'myFeedback' && (
              visibleCount === 0 ? (
                <EmptyState
                  icon={search ? Search : Inbox}
                  message={search ? 'No submissions found' : getEmptyMessage('myFeedback', statusFilter)}
                  hint={search ? 'Try a different search or filter.' : null}
                />
              ) : submissionGroups.map((group) => (
                <BoardGroup key={group.key} name={group.name} color={group.color} count={group.items.length}>
                  {group.items.map(item => {
                    const taskAvailable = !!item.task && !item.task.isArchived;
                    return (
                      <div
                        key={item.id}
                        className="p-4 sm:p-5 transition-shadow"
                        style={{
                          background: DEFAULT_CARD_GRADIENT,
                          borderRadius: 18,
                          boxShadow: SHADOW_RAISED,
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.boxShadow = SHADOW_HOVER; }}
                        onMouseLeave={(e) => { e.currentTarget.style.boxShadow = SHADOW_RAISED; }}
                      >
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          <h3 className="text-[15px] sm:text-[16px] font-bold truncate" style={{ color: TONE.textPrimary, letterSpacing: '-0.01em' }}>
                            {item.task ? (
                              <button
                                onClick={() => taskAvailable && openTask(item.task.id, item.task.boardId)}
                                disabled={!taskAvailable}
                                className={`text-left ${taskAvailable ? 'hover:underline' : 'cursor-not-allowed'}`}
                                style={{ color: taskAvailable ? TONE.textPrimary : TONE.textMuted }}
                                title={!taskAvailable ? 'Task is archived or unavailable' : ''}
                              >
                                {item.task.title}
                                {item.task.isArchived && (
                                  <span className="ml-2 text-[10px] uppercase font-semibold" style={{ color: TONE.textMuted }}>(archived)</span>
                                )}
                              </button>
                            ) : (
                              <span className="italic" style={{ color: TONE.textMuted }}>(Task deleted)</span>
                            )}
                          </h3>
                          <NeoStatusBadge status={item.status} />
                          <span className="text-[10px] font-mono" style={{ color: TONE.textMuted }}>
                            #{(item.taskId || '').slice(0, 8)}
                          </span>
                        </div>

                        {/* Meta row */}
                        <div className="flex items-center gap-3 flex-wrap text-[11.5px] mb-2" style={{ color: TONE.textSecondary }}>
                          <span className="inline-flex items-center gap-1.5">
                            <Avatar name={item.submittedBy.name} size="xs" />
                            <span>{item.submittedBy.name}</span>
                          </span>
                          <span title={item.submittedAt ? new Date(item.submittedAt).toLocaleString() : ''} style={{ color: TONE.textMuted }}>
                            Submitted {item.submittedAt ? formatDistanceToNow(new Date(item.submittedAt), { addSuffix: true }) : 'recently'}
                          </span>
                          {item.actionTakenAt && (
                            <span title={new Date(item.actionTakenAt).toLocaleString()} style={{ color: TONE.textMuted }}>
                              · Last action {formatDistanceToNow(new Date(item.actionTakenAt), { addSuffix: true })}
                            </span>
                          )}
                        </div>

                        {/* Stage / current approver line */}
                        <div className="flex items-center gap-2 flex-wrap text-[11px] mb-2" style={{ color: TONE.textSecondary }}>
                          <span className="font-semibold uppercase tracking-wide text-[10px]" style={{ color: TONE.textMuted }}>Stage</span>
                          <span className="font-semibold" style={{ color: TONE.textPrimary }}>{item.stageLabel}</span>
                          {item.currentApprover && (
                            <span
                              className="inline-flex items-center gap-1.5 px-2 py-0.5"
                              style={{ backgroundColor: 'rgba(255,255,255,0.7)', color: TONE.textPrimary, borderRadius: 999 }}
                            >
                              <Avatar name={item.currentApprover.name} size="xs" />
                              <span>{item.currentApprover.name}</span>
                              {(() => {
                                const lbl = roleLabelFor(item.currentApprover);
                                return lbl ? <span style={{ color: TONE.textMuted }}>· {lbl}</span> : null;
                              })()}
                            </span>
                          )}
                        </div>

                        {/* Submitted comment — white recessed note */}
                        {item.comment && (
                          <p
                            className="text-[12px] italic px-3 py-2 mb-2"
                            style={{
                              backgroundColor: 'rgba(255,255,255,0.65)',
                              color: TONE.textPrimary,
                              borderRadius: 12,
                              borderLeft: `3px solid ${TONE.indigo}`,
                            }}
                          >
                            "{item.comment}"
                          </p>
                        )}

                        {/* Timeline (last 4 entries) — submitter row + decisive actions */}
                        {item.timeline?.length > 1 && (
                          <div className="space-y-1">
                            {item.timeline
                              .filter((tl) => tl.level > 0)
                              .slice(-4)
                              .map((entry, i) => (
                                <div
                                  key={`${entry.level}-${i}`}
                                  className="px-3 py-1.5"
                                  style={{ backgroundColor: 'rgba(255,255,255,0.5)', borderRadius: 10 }}
                                >
                                  <p className="text-[11px]" style={{ color: TONE.textSecondary }}>
                                    <span className="font-semibold" style={{ color: TONE.textPrimary }}>L{entry.level} · {entry.userName}</span>
                                    {' — '}
                                    <span
                                      className="font-semibold"
                                      style={{
                                        color: entry.status === 'approved' ? TONE.mintText
                                          : entry.status === 'rejected' ? TONE.coralText
                                          : entry.status === 'changes_requested' ? TONE.amberText
                                          : TONE.textMuted,
                                      }}
                                    >
                                      {entry.status === 'pending' ? 'pending' : entry.status.replace('_', ' ')}
                                    </span>
                                    {entry.actionAt && (
                                      <span className="ml-1" style={{ color: TONE.textMuted }}>
                                        · {new Date(entry.actionAt).toLocaleString()}
                                      </span>
                                    )}
                                  </p>
                                  {entry.comment && (
                                    <p className="text-[11px] italic mt-0.5 ml-3" style={{ color: TONE.textPrimary }}>
                                      "{entry.comment}"
                                    </p>
                                  )}
                                </div>
                              ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </BoardGroup>
              ))
            )}

            {/* ═══ EXTENSIONS TAB ═══ */}
            {activeTab === 'extensions' && (
              visibleCount === 0 ? (
                <EmptyState
                  icon={search ? Search : Clock}
                  message={search ? 'No extensions found' : getEmptyMessage('extensions', statusFilter)}
                  hint={search ? 'Try a different search or filter.' : null}
                />
              ) : extensionGroups.map((group) => (
                <BoardGroup key={group.key} name={group.name} color={group.color} count={group.items.length}>
                  {group.items.map(ext => (
                    <div
                      key={ext.id}
                      className="p-4 sm:p-5 transition-shadow"
                      style={{
                        background: DEFAULT_CARD_GRADIENT,
                        borderRadius: 18,
                        boxShadow: SHADOW_RAISED,
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.boxShadow = SHADOW_HOVER; }}
                      onMouseLeave={(e) => { e.currentTarget.style.boxShadow = SHADOW_RAISED; }}
                    >
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <h3 className="text-[15px] sm:text-[16px] font-bold truncate" style={{ color: TONE.textPrimary, letterSpacing: '-0.01em' }}>
                          {ext.task ? (
                            <button
                              onClick={() => openTask(ext.task.id, ext.task.boardId || ext.task.board?.id)}
                              className="hover:underline text-left"
                              style={{ color: TONE.textPrimary }}
                            >
                              {ext.task.title}
                            </button>
                          ) : 'Task'}
                        </h3>
                        <NeoStatusBadge status={ext.status} />
                      </div>

                      <div className="flex items-center gap-3 flex-wrap text-[11.5px] mb-2" style={{ color: TONE.textSecondary }}>
                        {ext.requester && (
                          <span className="inline-flex items-center gap-1.5">
                            <Avatar name={ext.requester.name} size="xs" /> {ext.requester.name}
                          </span>
                        )}
                        <span style={{ color: TONE.textMuted }}>{formatDistanceToNow(new Date(ext.createdAt), { addSuffix: true })}</span>
                      </div>

                      <div
                        className="inline-flex items-center gap-3 px-3 py-2 text-[12px] mb-2"
                        style={{ backgroundColor: 'rgba(255,255,255,0.65)', borderRadius: 12 }}
                      >
                        <span style={{ color: TONE.textSecondary }}>Current: <span className="font-bold" style={{ color: TONE.textPrimary }}>{ext.currentDueDate}</span></span>
                        <span className="font-bold" style={{ color: TONE.indigo }}>→</span>
                        <span style={{ color: TONE.textSecondary }}>Proposed: <span className="font-bold" style={{ color: TONE.indigoDeep }}>{ext.proposedDueDate}</span></span>
                      </div>

                      {ext.reason && (
                        <p
                          className="text-[12px] italic px-3 py-1.5 mb-2"
                          style={{
                            backgroundColor: 'rgba(255,255,255,0.5)',
                            color: TONE.textSecondary,
                            borderRadius: 12,
                            borderLeft: `3px solid ${TONE.indigo}`,
                          }}
                        >
                          "{ext.reason}"
                        </p>
                      )}
                      {ext.reviewNote && (
                        <p className="text-[11.5px] mb-2" style={{ color: TONE.textSecondary }}>Review: {ext.reviewNote}</p>
                      )}

                      {canManage && ext.status === 'pending' && (
                        <div className="flex items-center justify-end gap-2 flex-wrap">
                          <NeoActionButton
                            onClick={() => {
                              // TODO: replace prompt() with Modal — see P2 fix template above (handleReject + performReject + reasonDialog state).
                              const newDate = prompt('Suggest a different date (YYYY-MM-DD):', ext.proposedDueDate);
                              if (newDate) handleApproveExtension(ext.id, newDate);
                            }}
                            disabled={actionLoading === ext.id}
                            gradient={CHANGES_GRADIENT}
                            fg={TONE.amberText}
                            icon={Calendar}
                            label="Edit Date"
                          />
                          <NeoActionButton
                            onClick={() => handleRejectExtension(ext.id)}
                            disabled={actionLoading === ext.id}
                            gradient={REJECT_GRADIENT}
                            fg={TONE.coralText}
                            icon={X}
                            label="Reject"
                          />
                          <NeoActionButton
                            onClick={() => handleApproveExtension(ext.id, ext.proposedDueDate)}
                            disabled={actionLoading === ext.id}
                            gradient={APPROVE_GRADIENT}
                            fg={TONE.mintText}
                            icon={Check}
                            label="Approve"
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </BoardGroup>
              ))
            )}

            {/* ═══ HELP REQUESTS TAB ═══ */}
            {activeTab === 'help' && (
              visibleCount === 0 ? (
                <EmptyState
                  icon={search ? Search : HelpCircle}
                  message={search ? 'No help requests found' : getEmptyMessage('help', statusFilter)}
                  hint={search ? 'Try a different search or filter.' : null}
                />
              ) : helpGroups.map((group) => (
                <BoardGroup key={group.key} name={group.name} color={group.color} count={group.items.length}>
                  {group.items.map(hr => (
                    <div
                      key={hr.id}
                      className="p-4 sm:p-5 transition-shadow"
                      style={{
                        background: DEFAULT_CARD_GRADIENT,
                        borderRadius: 18,
                        boxShadow: SHADOW_RAISED,
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.boxShadow = SHADOW_HOVER; }}
                      onMouseLeave={(e) => { e.currentTarget.style.boxShadow = SHADOW_RAISED; }}
                    >
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <h3 className="text-[15px] sm:text-[16px] font-bold truncate" style={{ color: TONE.textPrimary, letterSpacing: '-0.01em' }}>
                          {hr.task ? (
                            <button
                              onClick={() => openTask(hr.task.id, hr.task.boardId || hr.task.board?.id)}
                              className="hover:underline text-left"
                              style={{ color: TONE.textPrimary }}
                            >
                              {hr.task.title}
                            </button>
                          ) : 'Task'}
                        </h3>
                        <NeoStatusBadge status={hr.status} />
                        {hr.urgency && (
                          <span
                            className="px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide"
                            style={{
                              backgroundColor: URGENCY_BADGES[hr.urgency]?.bg || '#E5E7EB',
                              color: URGENCY_BADGES[hr.urgency]?.fg || TONE.textSecondary,
                              borderRadius: 999,
                            }}
                          >
                            {hr.urgency}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-3 flex-wrap text-[11.5px] mb-2" style={{ color: TONE.textSecondary }}>
                        {hr.requester && (
                          <span className="inline-flex items-center gap-1.5">
                            <Avatar name={hr.requester.name} size="xs" />
                            <span>From: <span className="font-medium" style={{ color: TONE.textPrimary }}>{hr.requester.name}</span></span>
                          </span>
                        )}
                        {hr.helper && (
                          <span className="inline-flex items-center gap-1">
                            → To: <span className="font-medium" style={{ color: TONE.textPrimary }}>{hr.helper.name}</span>
                          </span>
                        )}
                        <span style={{ color: TONE.textMuted }}>{formatDistanceToNow(new Date(hr.createdAt), { addSuffix: true })}</span>
                      </div>

                      {hr.description && (
                        <p
                          className="text-[12px] px-3 py-2 mb-2"
                          style={{ backgroundColor: 'rgba(255,255,255,0.65)', color: TONE.textPrimary, borderRadius: 12 }}
                        >
                          {hr.description}
                        </p>
                      )}
                      {hr.preferredTime && (
                        <p className="text-[11px] mb-1" style={{ color: TONE.textMuted }}>
                          Preferred time: {hr.preferredTime}
                        </p>
                      )}
                      {hr.meetingLink && (
                        <a
                          href={hr.meetingLink}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-[11px] font-semibold mb-2"
                          style={{ color: TONE.indigo }}
                        >
                          <ExternalLink size={11} /> Meeting Link
                        </a>
                      )}

                      {hr.status !== 'resolved' && (
                        <div className="flex items-center justify-end gap-2 flex-wrap">
                          <NeoActionButton
                            onClick={() => handleResolveHelp(hr.id)}
                            disabled={actionLoading === hr.id}
                            gradient={APPROVE_GRADIENT}
                            fg={TONE.mintText}
                            icon={Check}
                            label="Resolve"
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </BoardGroup>
              ))
            )}
          </div>
        )}
      </div>

      {/* Task Modal — wrapped so a render crash in the modal subtree
          doesn't take down the surrounding tasks list. resetKeys on the
          task id auto-clears any prior crash when the user opens a
          different task. */}
      {selectedTask && (
        <ErrorBoundary name="Task details" variant="section" resetKeys={[selectedTask.id]}>
          <TaskModal
            task={selectedTask}
            boardId={selectedBoardId}
            members={boardMembers}
            boardStatuses={boardStatuses}
            onClose={closeTaskModal}
            onUpdate={(updated) => {
              setSelectedTask(updated);
              fetchData();
            }}
            onDelete={() => {
              closeTaskModal();
              fetchData();
            }}
          />
        </ErrorBoundary>
      )}

      {/* P2: Reason-prompt modal — replaces window.prompt() for the
          reject-approval flow. The same shell is reusable for any future
          conversions (request-changes, extension reject) — just push a new
          dialog descriptor into `reasonDialog`. */}
      <Modal
        isOpen={!!reasonDialog}
        onClose={() => setReasonDialog(null)}
        title={reasonDialog?.title || 'Reason'}
        size="sm"
        footer={
          <>
            <button
              onClick={() => setReasonDialog(null)}
              className="px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface rounded-lg border border-border transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                if (!reasonDialog) return;
                const trimmed = (reasonValue || '').trim();
                if (reasonDialog.required && !trimmed) {
                  addToast('A reason is required.', 'warning');
                  return;
                }
                const dlg = reasonDialog;
                setReasonDialog(null);
                if (dlg.kind === 'reject') performReject(dlg.taskId, trimmed);
              }}
              className="px-3 py-1.5 text-xs font-medium bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
            >
              {reasonDialog?.submitLabel || 'Submit'}
            </button>
          </>
        }
      >
        <label className="block text-xs font-medium text-text-secondary mb-2">
          {reasonDialog?.label || 'Reason:'}
        </label>
        <textarea
          autoFocus
          value={reasonValue}
          onChange={(e) => setReasonValue(e.target.value)}
          placeholder="Type a clear reason so the submitter understands the decision…"
          rows={4}
          className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all resize-y"
        />
      </Modal>
    </div>
  );
}

// ── Reusable neumorphic sub-components (page-scoped) ─────────────

function SearchBox({ value, onChange }) {
  const [focused, setFocused] = useState(false);
  // Inset neumorphic surface + focus ring in app's primary indigo. The
  // ring uses `boxShadow` so we don't depend on the Tailwind ring utility
  // and stay consistent with the page's neumorphic system.
  const baseShadow = focused
    ? `${SHADOW_PRESSED}, 0 0 0 2px rgba(79, 70, 229, 0.35)`
    : SHADOW_PRESSED;
  return (
    <div
      className="flex items-center gap-2 px-3.5 h-11 w-full sm:w-[300px]"
      style={{
        backgroundColor: '#FFFFFF',
        boxShadow: baseShadow,
        borderRadius: 12,
        transition: 'box-shadow 0.15s ease',
      }}
    >
      <Search size={15} style={{ color: focused ? TONE.indigo : TONE.textSecondary }} aria-hidden="true" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder="Search approvals…"
        aria-label="Search approvals"
        className="flex-1 bg-transparent outline-none text-[13px] min-w-0 placeholder:text-[#94A3B8]"
        style={{ color: TONE.textPrimary }}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="flex-shrink-0 p-1 rounded-full hover:bg-slate-100 transition-colors"
          style={{ color: TONE.textSecondary }}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

// Slim, board section header. Made the contrast stronger so the
// grouping is immediately scannable — name uses the primary text
// token, the count pill is a real indigo chip (#EEF2FF / #4F46E5),
// and the divider is bumped to slate 0.35 alpha. Still compact: the
// header sits on a single line and adds only ~12px of vertical noise.
function BoardGroup({ name, color, count, children }) {
  return (
    <section className="space-y-3 pt-1">
      <div className="flex items-center gap-2.5 px-0.5">
        <span
          className="flex-shrink-0"
          style={{
            width: 9,
            height: 9,
            backgroundColor: color || '#94A3B8',
            borderRadius: 3,
            boxShadow: '0 0 0 2px rgba(255,255,255,0.6)',
          }}
          aria-hidden="true"
        />
        <span
          className="text-[12.5px] font-extrabold uppercase truncate"
          style={{ color: TONE.textPrimary, letterSpacing: '0.05em' }}
        >
          {name}
        </span>
        <span
          className="text-[10.5px] font-bold px-2 py-0.5 flex-shrink-0"
          style={{
            backgroundColor: TONE.indigoSoft,
            color: TONE.indigo,
            borderRadius: 999,
          }}
        >
          {count}
        </span>
        <span
          className="flex-1 h-px ml-1"
          style={{ backgroundColor: 'rgba(148, 163, 184, 0.35)' }}
        />
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function StatTile({ label, value, icon: Icon, accent, hint }) {
  return (
    <div
      className="p-3 sm:p-4 flex items-start gap-2.5"
      style={{ backgroundColor: TONE.pageBg, borderRadius: 16, boxShadow: SHADOW_RAISED }}
    >
      <span
        className="inline-flex items-center justify-center flex-shrink-0"
        style={{
          width: 34,
          height: 34,
          backgroundColor: TONE.pageBg,
          boxShadow: SHADOW_PRESSED,
          borderRadius: 10,
        }}
        aria-hidden="true"
      >
        <Icon size={14} style={{ color: accent }} />
      </span>
      <div className="min-w-0">
        <p
          className="text-[10px] font-bold uppercase tracking-wide"
          style={{ color: TONE.textMuted }}
        >
          {label}
        </p>
        <p
          className="text-[26px] font-bold leading-none mt-1"
          style={{ color: TONE.textPrimary, letterSpacing: '-0.02em' }}
        >
          {value}
        </p>
        {hint && (
          <p className="text-[10.5px] mt-1 truncate" style={{ color: TONE.textMuted }}>
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}

function NeoStatusBadge({ status }) {
  const cfg = STATUS_BADGES[status] || STATUS_BADGES.pending;
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 text-[10px] font-bold"
      style={{ backgroundColor: cfg.bg, color: cfg.fg, borderRadius: 999 }}
    >
      {cfg.label}
    </span>
  );
}

function NeoActionButton({ onClick, disabled, gradient, fg, icon: Icon, label }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      style={{
        background: gradient,
        color: fg,
        borderRadius: 999,
        boxShadow: SHADOW_BUTTON,
      }}
      onMouseDown={(e) => { if (!disabled) e.currentTarget.style.boxShadow = SHADOW_PRESSED; }}
      onMouseUp={(e) => { if (!disabled) e.currentTarget.style.boxShadow = SHADOW_BUTTON; }}
      onMouseLeave={(e) => { if (!disabled) e.currentTarget.style.boxShadow = SHADOW_BUTTON; }}
    >
      <Icon size={12} />
      {label}
    </button>
  );
}

function EmptyState({ icon: Icon, message, hint }) {
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
        <Icon size={18} style={{ color: TONE.indigo }} />
      </div>
      <p className="text-[13px] font-semibold" style={{ color: TONE.textPrimary }}>{message}</p>
      {hint && (
        <p className="text-[12px] mt-1" style={{ color: TONE.textSecondary }}>{hint}</p>
      )}
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="space-y-3" aria-hidden="true">
      {[1, 2, 3].map(i => (
        <div
          key={i}
          className="h-[120px] animate-pulse"
          style={{ backgroundColor: TONE.pageBg, borderRadius: 18, boxShadow: SHADOW_RAISED }}
        />
      ))}
    </div>
  );
}
