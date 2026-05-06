import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ClipboardCheck, Clock, HelpCircle, ChevronDown, Check, X,
  AlertTriangle, Calendar, MessageSquare, ExternalLink, Filter, Inbox, Shield,
} from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import Avatar from '../components/common/Avatar';
import TaskModal from '../components/task/TaskModal';
import { useToast } from '../components/common/Toast';
import useRealtimeEvent from '../realtime/useRealtimeEvent';
import { getBoardStatuses } from '../utils/constants';

const TABS = [
  { id: 'approvals', label: 'Approvals', icon: ClipboardCheck, color: '#8b5cf6' },
  // Internal id stays `myFeedback` to avoid touching API/state plumbing —
  // only the visible label changes. Tab shows level-0 TaskApprovalFlow rows
  // (the submitter's side of an approval), which is best read as "submissions"
  // not "feedback received about my work."
  { id: 'myFeedback', label: 'My Submissions', icon: Inbox, color: '#10b981' },
  { id: 'extensions', label: 'Extensions', icon: Clock, color: '#f59e0b' },
  { id: 'help', label: 'Help Requests', icon: HelpCircle, color: '#e2445c' },
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

const STATUS_COLORS = {
  pending: { bg: 'bg-yellow-50', text: 'text-yellow-700', border: 'border-yellow-200', label: 'Pending' },
  pending_approval: { bg: 'bg-yellow-50', text: 'text-yellow-700', border: 'border-yellow-200', label: 'Pending Approval' },
  approved: { bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200', label: 'Approved' },
  rejected: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200', label: 'Rejected' },
  changes_requested: { bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200', label: 'Changes Requested' },
  in_review: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200', label: 'In Review' },
  resolved: { bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200', label: 'Resolved' },
  meeting_scheduled: { bg: 'bg-indigo-50', text: 'text-indigo-700', border: 'border-indigo-200', label: 'Meeting Scheduled' },
};

const URGENCY_COLORS = {
  low: 'bg-blue-100 text-blue-700',
  medium: 'bg-yellow-100 text-yellow-700',
  high: 'bg-orange-100 text-orange-700',
  critical: 'bg-red-100 text-red-700',
};

export default function TasksPage() {
  const { canManage, isAdmin, isAssistantManager } = useAuth();
  const canViewTeamFeedback = canManage || isAssistantManager;
  const { addToast } = useToast();
  const [activeTab, setActiveTab] = useState('approvals');
  const [data, setData] = useState({ approvals: [], extensions: [], helpRequests: [] });
  const [myFeedback, setMyFeedback] = useState([]);
  const [feedbackScope, setFeedbackScope] = useState('mine');
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [actionLoading, setActionLoading] = useState(null);
  const [selectedTask, setSelectedTask] = useState(null);
  const [selectedBoardId, setSelectedBoardId] = useState(null);
  const [boardMembers, setBoardMembers] = useState([]);
  const [boardStatuses, setBoardStatuses] = useState(null);

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

  async function handleReject(taskId) {
    const comment = prompt('Reason for rejection (required):');
    if (comment === null) return;
    if (!comment.trim()) {
      addToast('A reason is required to reject.', 'warning');
      return;
    }
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

  const filteredMyFeedback = useMemo(() => {
    if (statusFilter === 'all') return myFeedback;
    return myFeedback.filter((f) => f.status === statusFilter);
  }, [myFeedback, statusFilter]);

  function StatusBadge({ status }) {
    const cfg = STATUS_COLORS[status] || STATUS_COLORS.pending;
    return (
      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${cfg.bg} ${cfg.text} ${cfg.border}`}>
        {cfg.label}
      </span>
    );
  }

  return (
    <div className="min-h-screen bg-background p-6 space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-text-primary flex items-center gap-2">
          <ClipboardCheck size={24} className="text-primary" /> Tasks & Workflows
        </h1>
        <p className="text-sm text-text-tertiary mt-0.5">Approvals, your submissions, extensions, and help requests</p>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 bg-white rounded-xl border border-border p-1">
        {TABS.map(tab => (
          <button key={tab.id} onClick={() => { setActiveTab(tab.id); setStatusFilter('all'); }}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${activeTab === tab.id ? 'bg-primary text-white shadow-sm' : 'text-text-secondary hover:bg-surface'}`}>
            <tab.icon size={15} />
            {tab.label}
            {counts[tab.id] > 0 && (
              <span className={`ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${activeTab === tab.id ? 'bg-white/20 text-white' : 'bg-danger/10 text-danger'}`}>
                {counts[tab.id]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Status Filter */}
      <div className="flex items-center gap-2 flex-wrap">
        <Filter size={13} className="text-text-tertiary" />
        <span className="text-xs text-text-tertiary font-medium">Status:</span>
        {(STATUS_FILTERS[activeTab] || STATUS_FILTERS.approvals).map((opt) => (
          <button key={opt.value} onClick={() => setStatusFilter(opt.value)}
            className={`px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors ${statusFilter === opt.value ? 'bg-primary text-white border-primary' : 'border-border text-text-secondary hover:bg-surface'}`}>
            {opt.label}
          </button>
        ))}
        {activeTab === 'myFeedback' && canViewTeamFeedback && (
          <span className="ml-3 inline-flex items-center gap-1 border border-border rounded-md p-0.5">
            {[
              { id: 'mine', label: 'Mine' },
              { id: 'team', label: 'My Team' },
              ...(canManage ? [{ id: 'all', label: 'Org-wide' }] : []),
            ].map((opt) => (
              <button
                key={opt.id}
                onClick={() => setFeedbackScope(opt.id)}
                className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${feedbackScope === opt.id ? 'bg-primary text-white' : 'text-text-secondary hover:bg-surface'}`}
              >
                {opt.label}
              </button>
            ))}
          </span>
        )}
      </div>

      {loading ? (
        <div className="p-12 text-center text-text-tertiary text-sm">Loading...</div>
      ) : (
        <div className="space-y-3">

          {/* ═══ APPROVALS TAB ═══ */}
          {activeTab === 'approvals' && (
            filterByStatus(data.approvals || [], 'approvalStatus').length === 0 ? (
              <EmptyState icon={ClipboardCheck} message={getEmptyMessage('approvals', statusFilter)} />
            ) : filterByStatus(data.approvals || [], 'approvalStatus').map(task => (
              <div key={task.id} className="bg-white rounded-xl border border-border p-4 hover:shadow-sm transition-shadow">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-sm font-semibold text-text-primary">
                        <button
                          onClick={() => openTask(task.id, task.board?.id || task.boardId)}
                          className="hover:text-primary hover:underline transition-colors cursor-pointer text-left"
                        >
                          {task.title}
                        </button>
                      </h3>
                      <StatusBadge status={task.approvalStatus} />
                    </div>
                    <div className="flex items-center gap-3 text-xs text-text-tertiary">
                      {task.board && (
                        <span className="flex items-center gap-1">
                          <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: task.board.color || '#0073ea' }} />
                          {task.board.name}
                        </span>
                      )}
                      {task.assignee && (
                        <span className="flex items-center gap-1">
                          <Avatar name={task.assignee.name} size="xs" /> {task.assignee.name}
                        </span>
                      )}
                      <span>Updated {formatDistanceToNow(new Date(task.updatedAt), { addSuffix: true })}</span>
                    </div>
                    {task.approvalChain?.length > 0 && (
                      <div className="mt-2 space-y-1.5">
                        {task.approvalChain.slice(-3).map((entry, i) => (
                          <div key={i} className="text-[11px]">
                            <p className="text-text-tertiary">
                              <span className="font-medium text-text-secondary">{entry.userName}</span>
                              {' '}<span className={`font-semibold ${entry.action === 'approved' ? 'text-green-600' : entry.action === 'changes_requested' ? 'text-orange-600' : 'text-blue-600'}`}>
                                {entry.action === 'changes_requested' ? 'requested changes' : entry.action === 'submitted' ? 'submitted for approval' : entry.action}
                              </span>
                              {entry.timestamp && <span className="text-text-tertiary ml-1">· {new Date(entry.timestamp).toLocaleString()}</span>}
                            </p>
                            {entry.comment && (
                              <p className="text-xs text-text-secondary bg-surface/50 px-2.5 py-1.5 rounded-md mt-1 border-l-2 border-primary/30 italic">
                                "{entry.comment}"
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* Action buttons strictly from server-supplied capability
                      flags. The server is the single source of truth — never
                      gate on `canManage` here, because manager+admin includes
                      users who aren't current approvers. The capability flags
                      already encode current-stage / higher-stage / Super Admin
                      override, plus self-approval guard. */}
                  {task.approvalStatus === 'pending_approval' && task.myCapabilities && (
                    (task.myCapabilities.canApprove || task.myCapabilities.canReject || task.myCapabilities.canRequestChanges) ? (
                      <div className="flex flex-col items-end gap-1.5 ml-4">
                        {(task.myCapabilities.isOverrideApprover || task.myCapabilities.canApproveEarly) && (
                          <span className={`inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${task.myCapabilities.isOverrideApprover ? 'bg-purple-100 text-purple-700' : 'bg-amber-100 text-amber-700'}`}>
                            <Shield size={9} />
                            {task.myCapabilities.isOverrideApprover ? 'Super Admin Override' : 'Higher-Level Approver'}
                          </span>
                        )}
                        <div className="flex items-center gap-2">
                          {task.myCapabilities.canApprove && (
                            <button onClick={() => handleApprove(task.id)} disabled={actionLoading === task.id}
                              className="px-3 py-1.5 text-xs font-medium bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:opacity-50 flex items-center gap-1">
                              <Check size={12} /> {task.myCapabilities.canApproveEarly ? 'Approve early' : 'Approve'}
                            </button>
                          )}
                          {task.myCapabilities.canReject && (
                            <button onClick={() => handleReject(task.id)} disabled={actionLoading === task.id}
                              className="px-3 py-1.5 text-xs font-medium bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-50 flex items-center gap-1">
                              <X size={12} /> Reject
                            </button>
                          )}
                          {task.myCapabilities.canRequestChanges && (
                            <button onClick={() => handleRequestChanges(task.id)} disabled={actionLoading === task.id}
                              className="px-3 py-1.5 text-xs font-medium bg-orange-500 text-white rounded-lg hover:bg-orange-600 disabled:opacity-50 flex items-center gap-1">
                              <MessageSquare size={12} /> Request Changes
                            </button>
                          )}
                        </div>
                      </div>
                    ) : task.myCapabilities.reasonIfCannotAct ? (
                      <div className="ml-4 text-[10px] text-text-tertiary italic max-w-[200px] text-right" title={task.myCapabilities.reasonIfCannotAct}>
                        {task.myCapabilities.currentApproverNames?.length > 0
                          ? `Waiting on ${task.myCapabilities.currentApproverNames.slice(0, 2).join(', ')}${task.myCapabilities.currentApproverNames.length > 2 ? ` +${task.myCapabilities.currentApproverNames.length - 2}` : ''}`
                          : null}
                      </div>
                    ) : null
                  )}
                </div>
              </div>
            ))
          )}

          {/* ═══ MY FEEDBACK TAB ═══ */}
          {activeTab === 'myFeedback' && (
            filteredMyFeedback.length === 0 ? (
              <EmptyState icon={Inbox} message={getEmptyMessage('myFeedback', statusFilter)} />
            ) : filteredMyFeedback.map(item => {
              const taskAvailable = !!item.task && !item.task.isArchived;
              return (
                <div key={item.id} className="bg-white rounded-xl border border-border p-4 hover:shadow-sm transition-shadow">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <h3 className="text-sm font-semibold text-text-primary truncate">
                          {item.task ? (
                            <button
                              onClick={() => taskAvailable && openTask(item.task.id, item.task.boardId)}
                              disabled={!taskAvailable}
                              className={`text-left ${taskAvailable ? 'hover:text-primary hover:underline cursor-pointer' : 'text-text-tertiary cursor-not-allowed'} transition-colors`}
                              title={!taskAvailable ? 'Task is archived or unavailable' : ''}
                            >
                              {item.task.title}
                              {item.task.isArchived && <span className="ml-2 text-[10px] uppercase text-text-tertiary">(archived)</span>}
                            </button>
                          ) : (
                            <span className="text-text-tertiary italic">(Task deleted)</span>
                          )}
                        </h3>
                        <StatusBadge status={item.status} />
                        <span className="text-[10px] text-text-tertiary font-mono">
                          #{(item.taskId || '').slice(0, 8)}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-text-tertiary mb-2 flex-wrap">
                        {item.task?.board && (
                          <span className="flex items-center gap-1">
                            <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: item.task.board.color || '#0073ea' }} />
                            {item.task.board.name}
                          </span>
                        )}
                        <span className="flex items-center gap-1">
                          <Avatar name={item.submittedBy.name} size="xs" />
                          {item.submittedBy.name}
                        </span>
                        <span title={item.submittedAt ? new Date(item.submittedAt).toLocaleString() : ''}>
                          Submitted {item.submittedAt ? formatDistanceToNow(new Date(item.submittedAt), { addSuffix: true }) : 'recently'}
                        </span>
                        {item.actionTakenAt && (
                          <span title={new Date(item.actionTakenAt).toLocaleString()}>
                            · Last action {formatDistanceToNow(new Date(item.actionTakenAt), { addSuffix: true })}
                          </span>
                        )}
                      </div>

                      {/* Stage / current approver line */}
                      <div className="flex items-center gap-2 text-[11px] text-text-secondary mb-2">
                        <span className="font-semibold text-text-tertiary uppercase tracking-wide text-[10px]">Stage:</span>
                        <span className="font-medium">{item.stageLabel}</span>
                        {item.currentApprover && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-surface rounded">
                            <Avatar name={item.currentApprover.name} size="xs" />
                            <span>{item.currentApprover.name}</span>
                            {item.currentApprover.role && (
                              <span className="text-text-tertiary">· {item.currentApprover.role.replace('_', ' ')}</span>
                            )}
                          </span>
                        )}
                      </div>

                      {/* Submitted comment */}
                      {item.comment && (
                        <p className="text-xs text-text-secondary bg-surface/60 px-2.5 py-1.5 rounded-md border-l-2 border-primary/30 italic mb-2">
                          "{item.comment}"
                        </p>
                      )}

                      {/* Timeline (last 4 entries) — submitter row + decisive actions */}
                      {item.timeline?.length > 1 && (
                        <div className="mt-2 space-y-1">
                          {item.timeline
                            .filter((t) => t.level > 0)
                            .slice(-4)
                            .map((entry, i) => (
                              <div key={`${entry.level}-${i}`} className="text-[11px]">
                                <p className="text-text-tertiary">
                                  <span className="font-medium text-text-secondary">L{entry.level} · {entry.userName}</span>
                                  {' — '}
                                  <span className={`font-semibold ${
                                    entry.status === 'approved' ? 'text-green-600'
                                      : entry.status === 'rejected' ? 'text-red-600'
                                      : entry.status === 'changes_requested' ? 'text-orange-600'
                                      : 'text-text-tertiary'
                                  }`}>
                                    {entry.status === 'pending' ? 'pending' : entry.status.replace('_', ' ')}
                                  </span>
                                  {entry.actionAt && (
                                    <span className="text-text-tertiary ml-1">
                                      · {new Date(entry.actionAt).toLocaleString()}
                                    </span>
                                  )}
                                </p>
                                {entry.comment && (
                                  <p className="text-[11px] text-text-secondary bg-surface/40 px-2 py-1 rounded mt-0.5 ml-3 italic">
                                    "{entry.comment}"
                                  </p>
                                )}
                              </div>
                            ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}

          {/* ═══ EXTENSIONS TAB ═══ */}
          {activeTab === 'extensions' && (
            filterByStatus(data.extensions || []).length === 0 ? (
              <EmptyState icon={Clock} message={getEmptyMessage('extensions', statusFilter)} />
            ) : filterByStatus(data.extensions || []).map(ext => (
              <div key={ext.id} className="bg-white rounded-xl border border-border p-4 hover:shadow-sm transition-shadow">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-sm font-semibold text-text-primary">
                        {ext.task ? (
                          <button
                            onClick={() => openTask(ext.task.id, ext.task.boardId || ext.task.board?.id)}
                            className="hover:text-primary hover:underline transition-colors cursor-pointer text-left"
                          >
                            {ext.task.title}
                          </button>
                        ) : 'Task'}
                      </h3>
                      <StatusBadge status={ext.status} />
                    </div>
                    <div className="flex items-center gap-3 text-xs text-text-tertiary mb-2">
                      {ext.task?.board && (
                        <span className="flex items-center gap-1">
                          <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: ext.task.board.color || '#0073ea' }} />
                          {ext.task.board.name}
                        </span>
                      )}
                      {ext.requester && (
                        <span className="flex items-center gap-1">
                          <Avatar name={ext.requester.name} size="xs" /> {ext.requester.name}
                        </span>
                      )}
                      <span>{formatDistanceToNow(new Date(ext.createdAt), { addSuffix: true })}</span>
                    </div>
                    <div className="flex items-center gap-4 text-xs">
                      <span className="text-text-secondary">Current: <span className="font-semibold">{ext.currentDueDate}</span></span>
                      <span className="text-primary font-bold">→</span>
                      <span className="text-text-secondary">Proposed: <span className="font-semibold text-primary">{ext.proposedDueDate}</span></span>
                    </div>
                    {ext.reason && <p className="text-xs text-text-tertiary mt-1 italic">"{ext.reason}"</p>}
                    {ext.reviewNote && <p className="text-xs text-text-secondary mt-1">Review: {ext.reviewNote}</p>}
                  </div>
                  {canManage && ext.status === 'pending' && (
                    <div className="flex items-center gap-2 ml-4">
                      <button onClick={() => handleApproveExtension(ext.id, ext.proposedDueDate)} disabled={actionLoading === ext.id}
                        className="px-3 py-1.5 text-xs font-medium bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:opacity-50 flex items-center gap-1">
                        <Check size={12} /> Approve
                      </button>
                      <button onClick={() => {
                        const newDate = prompt('Suggest a different date (YYYY-MM-DD):', ext.proposedDueDate);
                        if (newDate) handleApproveExtension(ext.id, newDate);
                      }} disabled={actionLoading === ext.id}
                        className="px-3 py-1.5 text-xs font-medium bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 flex items-center gap-1">
                        <Calendar size={12} /> Edit Date
                      </button>
                      <button onClick={() => handleRejectExtension(ext.id)} disabled={actionLoading === ext.id}
                        className="px-3 py-1.5 text-xs font-medium bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-50 flex items-center gap-1">
                        <X size={12} /> Reject
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}

          {/* ═══ HELP REQUESTS TAB ═══ */}
          {activeTab === 'help' && (
            filterByStatus(data.helpRequests || []).length === 0 ? (
              <EmptyState icon={HelpCircle} message={getEmptyMessage('help', statusFilter)} />
            ) : filterByStatus(data.helpRequests || []).map(hr => (
              <div key={hr.id} className="bg-white rounded-xl border border-border p-4 hover:shadow-sm transition-shadow">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-sm font-semibold text-text-primary">
                        {hr.task ? (
                          <button
                            onClick={() => openTask(hr.task.id, hr.task.boardId || hr.task.board?.id)}
                            className="hover:text-primary hover:underline transition-colors cursor-pointer text-left"
                          >
                            {hr.task.title}
                          </button>
                        ) : 'Task'}
                      </h3>
                      <StatusBadge status={hr.status} />
                      {hr.urgency && (
                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${URGENCY_COLORS[hr.urgency] || ''}`}>
                          {hr.urgency}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-text-tertiary mb-1">
                      {hr.requester && <span className="flex items-center gap-1"><Avatar name={hr.requester.name} size="xs" /> From: {hr.requester.name}</span>}
                      {hr.helper && <span className="flex items-center gap-1">→ To: {hr.helper.name}</span>}
                      {hr.task?.board && (
                        <span className="flex items-center gap-1">
                          <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: hr.task.board.color || '#0073ea' }} />
                          {hr.task.board.name}
                        </span>
                      )}
                      <span>{formatDistanceToNow(new Date(hr.createdAt), { addSuffix: true })}</span>
                    </div>
                    <p className="text-xs text-text-secondary">{hr.description}</p>
                    {hr.preferredTime && <p className="text-[10px] text-text-tertiary mt-1">Preferred time: {hr.preferredTime}</p>}
                    {hr.meetingLink && <a href={hr.meetingLink} target="_blank" rel="noreferrer" className="text-[10px] text-primary flex items-center gap-1 mt-1"><ExternalLink size={10} /> Meeting Link</a>}
                  </div>
                  {hr.status !== 'resolved' && (
                    <div className="flex items-center gap-2 ml-4">
                      <button onClick={() => handleResolveHelp(hr.id)} disabled={actionLoading === hr.id}
                        className="px-3 py-1.5 text-xs font-medium bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:opacity-50 flex items-center gap-1">
                        <Check size={12} /> Resolve
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Task Modal */}
      {selectedTask && (
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
      )}
    </div>
  );
}

function EmptyState({ icon: Icon, message }) {
  return (
    <div className="text-center py-16 bg-white rounded-xl border border-border">
      <Icon size={32} className="mx-auto text-text-tertiary mb-2" />
      <p className="text-sm text-text-secondary">{message}</p>
    </div>
  );
}
