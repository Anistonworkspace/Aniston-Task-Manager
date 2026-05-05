import React, { useState, useEffect } from 'react';
import { Shield, Check, X, Clock, MessageSquare, Send, RotateCcw, AlertCircle } from 'lucide-react';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import useRealtimeEvent from '../../realtime/useRealtimeEvent';
import MarkDoneApprovalModal from './MarkDoneApprovalModal';
import { useToast } from '../common/Toast';
import {
  groupFlowsByLogicalStage,
  rollUpStageStatus,
  currentLogicalStage,
  roleLabelFor,
  rowStatusLabel,
  isSuperAdminRow,
  LOGICAL_STAGE,
} from '../../utils/approvalStages';

// Visual mapping for the approvalStatus badge at the top of the section.
const STATUS_BADGE = {
  pending_approval:   { label: 'Pending Approval',   bg: 'bg-amber-50 dark:bg-amber-500/10',   text: 'text-amber-700 dark:text-amber-300',   border: 'border-amber-200 dark:border-amber-500/30' },
  approved:           { label: 'Approved',           bg: 'bg-emerald-50 dark:bg-emerald-500/10', text: 'text-emerald-700 dark:text-emerald-300', border: 'border-emerald-200 dark:border-emerald-500/30' },
  rejected:           { label: 'Rejected',           bg: 'bg-red-50 dark:bg-red-500/10',         text: 'text-red-700 dark:text-red-300',         border: 'border-red-200 dark:border-red-500/30' },
  changes_requested:  { label: 'Changes Requested',  bg: 'bg-orange-50 dark:bg-orange-500/10',   text: 'text-orange-700 dark:text-orange-300',   border: 'border-orange-200 dark:border-orange-500/30' },
};

// Per-row pip color in the timeline.
const ROW_STYLES = {
  submitted:          { bg: 'bg-emerald-500',  Icon: Check,           label: 'Submitted' },
  approved:           { bg: 'bg-emerald-500',  Icon: Check,           label: 'Approved' },
  pending:            { bg: 'bg-amber-400',    Icon: Clock,           label: 'Pending' },
  rejected:           { bg: 'bg-red-500',      Icon: X,               label: 'Rejected' },
  changes_requested:  { bg: 'bg-orange-400',   Icon: MessageSquare,   label: 'Changes requested' },
  awaiting:           { bg: 'bg-zinc-300 dark:bg-zinc-700', Icon: Clock, label: 'Awaiting' },
};

function formatTime(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return null; }
}

/**
 * Approvals tab content for TaskModal.
 *
 * Replaces the old single-button + JSONB-list view with a normalized
 * level-by-level timeline backed by task_approval_flows. Action buttons
 * (Approve / Reject / Request Changes) appear ONLY for the user who is the
 * current pending approver — role-based gating happens in the backend, this
 * is just the UX gate.
 *
 * Live updates: subscribes to `task:approval-updated` socket so a reviewer in
 * one tab and the submitter in another stay in sync without refresh.
 */
export default function ApprovalSection({ task, onUpdate }) {
  const { user, isSuperAdmin } = useAuth();
  const { success, error: toastError } = useToast();

  // Local mirror of the chain. Hydrated from props (flows ship via the task
  // include in Phase 6) and refreshed on the socket event so the timeline
  // stays current even when another user acts.
  const [flows, setFlows] = useState(() => task?.approvalFlows || []);
  const [approvalStatus, setApprovalStatus] = useState(task?.approvalStatus || null);
  // Server-supplied capability flags. Primary source of truth for which action
  // buttons render — kept in sync with backend authorization. Falls back to
  // local derivation if the server didn't include them (older endpoints, or
  // older clients holding stale task props).
  const [serverCapabilities, setServerCapabilities] = useState(
    () => task?.myApprovalCapabilities || null
  );

  // Action UI state
  const [showActionPanel, setShowActionPanel] = useState(null); // 'approve' | 'reject' | 'request_changes' | null
  const [actionComment, setActionComment] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Resubmit modal (after changes_requested / rejected)
  const [showResubmitModal, setShowResubmitModal] = useState(false);

  // Re-hydrate when the task prop changes (e.g. user switched tasks).
  useEffect(() => {
    setFlows(task?.approvalFlows || []);
    setApprovalStatus(task?.approvalStatus || null);
    setServerCapabilities(task?.myApprovalCapabilities || null);
  }, [task?.id, task?.approvalStatus, task?.approvalFlows, task?.myApprovalCapabilities]);

  // Authoritative capability fetch.
  //
  // The modal opens with whatever task object the parent supplies. Two paths:
  //   - From TasksPage.openTask: the task came from `GET /api/tasks/:id`,
  //     which now ships `myApprovalCapabilities`. Buttons render correctly.
  //   - From BoardPage: the task came from the board's list (`GET /tasks`),
  //     which does NOT include capabilities — only the modal/chain endpoint
  //     does. Without this fetch, the component falls back to local derivation,
  //     which doesn't know about Super Admin override / higher-stage Reject &
  //     Request Changes.
  //
  // To guarantee the modal always renders the same buttons as the /tasks page
  // (the user-facing invariant we're enforcing), we fetch the canonical caps
  // from the approval-chain endpoint whenever the task is in an active cycle
  // and we don't already have server caps. This adds one cheap GET per modal
  // open in the BoardPage path; the TasksPage path skips it because caps are
  // already present.
  useEffect(() => {
    if (!task?.id) return;
    if (task.approvalStatus !== 'pending_approval') return;
    if (task.myApprovalCapabilities) return; // already authoritative
    let cancelled = false;
    api.get(`/task-extras/${task.id}/approval-chain`)
      .then((res) => {
        if (cancelled) return;
        const payload = res.data?.data || res.data;
        if (payload?.myCapabilities) setServerCapabilities(payload.myCapabilities);
        if (Array.isArray(payload?.flows)) setFlows(payload.flows);
      })
      .catch(() => { /* non-fatal — local fallback covers */ });
    return () => { cancelled = true; };
  }, [task?.id, task?.approvalStatus, task?.myApprovalCapabilities]);

  // Live updates from the backend (emitted by approvalController on every
  // submit/approve/reject/changes_requested). Filtered to this task only.
  useRealtimeEvent('task:approval-updated', (data) => {
    if (data?.taskId !== task?.id) return;
    if (Array.isArray(data.flows)) setFlows(data.flows);
    // Approval action mutated the chain — re-pull capabilities so a stale
    // server snapshot doesn't keep buttons rendered after they no longer apply.
    api.get(`/task-extras/${task.id}/approval-chain`)
      .then((res) => {
        const payload = res.data?.data || res.data;
        if (payload?.myCapabilities) setServerCapabilities(payload.myCapabilities);
      })
      .catch(() => { /* non-fatal — local derivation will cover */ });
  });
  useRealtimeEvent('task:updated', (data) => {
    if (data?.task?.id !== task?.id) return;
    if (data.task.approvalStatus !== undefined) setApprovalStatus(data.task.approvalStatus);
  });

  // Logical stage groups (Submission / Assistant Manager / Final), derived
  // from the row roles. Always max 3 entries; missing stages omitted.
  const stageGroups = groupFlowsByLogicalStage(flows);
  const currentStageKey = currentLogicalStage(stageGroups); // 'assistant_manager' | 'final' | null

  // All pending rows in the currently-active logical stage. When the FINAL
  // stage is active it can contain multiple parallel approvers (Manager,
  // Admin, Super Admin) — every one of them is a "current approver".
  const currentStageGroup = stageGroups.find((g) => g.stage === currentStageKey);
  const currentStageRows = (currentStageGroup?.rows || []).filter((r) => r.status === 'pending');
  const currentPendingRow = currentStageRows[0] || null;
  const isCurrentApproverLocal = !!user?.id && currentStageRows.some((r) => r.userId === user.id);

  // Early-completion eligibility: the actor holds a pending row in a stage
  // LATER than the current one. Today the only meaningful "earlier vs later"
  // distinction is Assistant Manager (current) vs Final (later) — a final-
  // stage approver may approve early to skip a pending asst-manager step.
  const stageRank = { [LOGICAL_STAGE.SUBMISSION]: 0, [LOGICAL_STAGE.ASSISTANT_MANAGER]: 1, [LOGICAL_STAGE.FINAL]: 2 };
  const myAnyPendingRow = !!user?.id ? flows.find((f) => f.status === 'pending' && f.userId === user.id) : null;
  const myStageKey = myAnyPendingRow
    ? (stageGroups.find((g) => g.rows.some((r) => r === myAnyPendingRow || r.id === myAnyPendingRow.id))?.stage)
    : null;
  const canEarlyCompleteLocal =
    !!myAnyPendingRow
    && currentStageKey
    && myStageKey
    && stageRank[myStageKey] > stageRank[currentStageKey];
  const isInActiveCycle = approvalStatus === 'pending_approval';

  // ── Server-driven authorization (preferred) ────────────────────────────────
  //
  // If the backend included capability flags on the task (or on the
  // approval-chain refetch), use them verbatim. They cover three paths the
  // local derivation handled inconsistently:
  //   1. Current-stage approver       → approve / reject / request_changes
  //   2. Higher-stage approver (early) → approve / reject / request_changes
  //   3. Super Admin override          → approve / reject / request_changes
  //
  // Local fallbacks are used briefly before the mount-fetch above resolves
  // and as a defense for any future opener that forgets to include caps. The
  // fallback mirrors the server's three paths so the modal renders the same
  // buttons as `/tasks` even before the fetch returns:
  //   - current-stage approver   → all three (matches isCurrentApproverLocal)
  //   - higher-stage approver    → all three (matches canEarlyCompleteLocal —
  //                                 SA at final stage while asst-mgr is current
  //                                 lands here, which is the bug we're fixing)
  //   - Super Admin (any state)  → all three (override authority — backend
  //                                 still enforces; the worst case is a 403
  //                                 toast, never a silent privilege bypass)
  //
  // Backend remains the source of truth for every action call: a permissive
  // fallback only widens what's offered, never what's accepted.
  const isPotentialApprover = isCurrentApproverLocal || canEarlyCompleteLocal || isSuperAdmin;
  const caps = serverCapabilities;
  const canApprove = caps ? !!caps.canApprove : isPotentialApprover;
  const canReject  = caps ? !!caps.canReject  : isPotentialApprover;
  const canRequestChanges = caps ? !!caps.canRequestChanges : isPotentialApprover;
  const isOverrideApprover = caps ? !!caps.isOverrideApprover : (isSuperAdmin && !myAnyPendingRow);
  const isHigherLevelApprover = caps ? !!caps.canApproveEarly : !!canEarlyCompleteLocal;
  const showActionButtons = isInActiveCycle && (canApprove || canReject || canRequestChanges);
  const isCurrentApprover = caps ? !!caps.isCurrentApprover : isCurrentApproverLocal;

  // Resubmit button rules:
  //   - rejected / changes_requested: only the original submitter (the L0 row's
  //     user) sees it. The reviewer who rejected shouldn't be offered the
  //     resubmit affordance — that would be confusing.
  //   - never submitted: any task owner (assignee / creator / multi-assignee)
  //     can kick off the chain from here as a fallback path to the Done intercept.
  const submitterRow = flows.find((f) => f.level === 0);
  const submitterId = submitterRow?.userId;
  const isOwner = !!user?.id && (
    task?.assignedTo === user?.id
    || task?.createdBy === user?.id
    || (Array.isArray(task?.taskAssignees) && task.taskAssignees.some((ta) => (ta.userId || ta.user?.id) === user?.id))
  );
  const isOriginalSubmitter = !!user?.id && submitterId === user?.id;

  // Super Admin exemption — Super Admins are top of the hierarchy and have
  // no senior reviewer to route to. The backend rejects submitForApproval for
  // them (super_admin_no_approval) and the Done intercept skips the modal,
  // so we hide the Submit / Resubmit buttons here too. They retain full
  // visibility into existing chains (read-only) — only the initiate action
  // is suppressed.
  //
  // Self-assigned tasks are no longer exempt from approval — the prior
  // carve-out (`isSelfTask` empty state + `&& !isSelfTask` on the resubmit
  // gate) was the bypass we removed. The standard "submit for approval"
  // initiation path now applies to every non-super-admin owner regardless of
  // who else is on the assignee list.
  const canResubmit =
    !isSuperAdmin
    && (
      ((approvalStatus === 'changes_requested' || approvalStatus === 'rejected') && isOriginalSubmitter)
      || (!approvalStatus && isOwner)
    );

  function openActionPanel(action) {
    setShowActionPanel(action);
    setActionComment('');
  }
  function cancelActionPanel() {
    setShowActionPanel(null);
    setActionComment('');
  }

  async function performAction() {
    if (!showActionPanel) return;
    const requiresComment = showActionPanel === 'reject' || showActionPanel === 'request_changes';
    if (requiresComment && !actionComment.trim()) {
      toastError('A comment is required.');
      return;
    }
    const endpoint =
      showActionPanel === 'approve' ? 'approve' :
      showActionPanel === 'reject' ? 'reject' :
      'request-changes';
    setSubmitting(true);
    try {
      const res = await api.post(`/task-extras/${task.id}/${endpoint}`, { comment: actionComment.trim() || undefined });
      const data = res.data?.data || res.data;
      // Optimistic local apply (the socket event will arrive milliseconds later
      // and re-confirm). Saves a flicker.
      if (Array.isArray(data?.approvalFlows)) setFlows(data.approvalFlows);
      if (data?.task?.approvalStatus !== undefined) setApprovalStatus(data.task.approvalStatus);
      if (onUpdate && data?.task) onUpdate(data.task);
      success(
        showActionPanel === 'approve' ? 'Approved.' :
        showActionPanel === 'reject' ? 'Rejected — bounced back one level.' :
        'Changes requested.'
      );
      cancelActionPanel();
    } catch (err) {
      const msg = err.response?.data?.message || 'Action failed.';
      toastError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  const badge = approvalStatus ? STATUS_BADGE[approvalStatus] : null;

  return (
    <div className="mb-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider flex items-center gap-1.5">
          <Shield size={12} /> Approval
        </h3>
        {badge && (
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${badge.bg} ${badge.text} ${badge.border}`}>
            {badge.label}
          </span>
        )}
      </div>

      {/* Empty state — no flow yet. Two paths:
            - Super Admin: top-of-hierarchy, no approval ever needed
            - Everyone else (including self-assigned tasks): standard
              "mark Done to start approval" hint. The previous "Personal task
              — no approval needed" carve-out was the bypass we removed. */}
      {flows.length === 0 && isSuperAdmin && (
        <div className="flex items-start gap-2 text-[11px] text-zinc-600 dark:text-zinc-300 mb-3 p-2.5 rounded-md bg-purple-50 dark:bg-purple-500/10 border border-purple-200 dark:border-purple-500/30">
          <Shield size={12} className="text-purple-600 dark:text-purple-300 mt-0.5 flex-shrink-0" />
          <div>
            <div className="font-medium text-zinc-700 dark:text-zinc-200">No approval needed — Super Admin authority</div>
            <div className="text-zinc-500 dark:text-zinc-400 mt-0.5">Mark Done from the status column to complete the task directly.</div>
          </div>
        </div>
      )}
      {flows.length === 0 && !isSuperAdmin && (
        <div className="text-[11px] text-zinc-500 dark:text-zinc-400 mb-3">
          Mark this task <span className="font-medium text-zinc-700 dark:text-zinc-200">Done</span> from the status column to start an approval chain, or use the button below.
        </div>
      )}

      {/* Timeline — grouped into MAX 3 logical stages (Submission / Assistant
          Manager / Final). Multiple users in one stage render as a sub-list
          instead of separate timeline rows, so the chain reads as a workflow
          (3 phases) not a long roster of approvers. */}
      {stageGroups.length > 0 && (
        <ol className="relative ml-1 mb-3 space-y-3">
          {stageGroups.map((group, gIdx) => {
            const isLastGroup = gIdx === stageGroups.length - 1;
            const isCurrentStage = currentStageKey === group.stage;
            const isMultiMember = group.rows.length > 1;

            // Stage roll-up: drives the dot color + summary chip on the
            // stage header. A pending stage that isn't the current one is
            // a future stage → "awaiting" (visually neutral).
            let stageStatus = rollUpStageStatus(group.rows);
            if (stageStatus === 'pending' && !isCurrentStage) stageStatus = 'awaiting';
            const stageStyle = ROW_STYLES[stageStatus] || ROW_STYLES.awaiting;
            const StageIcon = stageStyle.Icon;
            const stageNumber = gIdx + 1;

            // Sub-headline hint: explains the parallel/sequential semantics
            // so the user understands why multiple names live under one dot.
            const stageHint =
              group.stage === LOGICAL_STAGE.FINAL && isMultiMember
                ? 'any one approves'
                : group.stage === LOGICAL_STAGE.ASSISTANT_MANAGER && isMultiMember
                ? 'all approve in order'
                : group.stage === LOGICAL_STAGE.SUBMISSION
                ? 'submitted by'
                : null;

            return (
              <li key={group.stage} className="text-[11px]">
                <div className="flex items-start gap-2.5">
                  <div className="flex flex-col items-center self-stretch">
                    <span className={`flex items-center justify-center w-5 h-5 rounded-full ${stageStyle.bg} ${isCurrentStage ? 'ring-2 ring-amber-300 ring-offset-1 ring-offset-white dark:ring-offset-[#1E1F23]' : ''}`}>
                      <StageIcon className="w-2.5 h-2.5 text-white" />
                    </span>
                    {!isLastGroup && (
                      <span className="flex-1 w-px bg-zinc-200 dark:bg-zinc-700 mt-1" />
                    )}
                  </div>
                  <div className="flex-1 pb-1">
                    <div className="flex items-center gap-1.5 flex-wrap mb-1">
                      <span className="font-semibold text-zinc-800 dark:text-zinc-100">
                        Stage {stageNumber} · {group.label}
                      </span>
                      {stageHint && (
                        <span className="text-[9px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                          {stageHint}
                        </span>
                      )}
                      <span className={`text-[9px] uppercase tracking-wide font-semibold px-1.5 py-px rounded ${stageStyle.bg} text-white`}>
                        {stageStyle.label}
                      </span>
                    </div>
                    {/* Member rows — one per user in this logical stage. */}
                    <ul className={`space-y-1 ${isMultiMember ? 'ml-1 border-l-2 border-zinc-200 dark:border-zinc-700 pl-3' : ''}`}>
                      {group.rows.map((row) => {
                        // Per-row visual status — pending rows in a future
                        // stage render as awaiting; everything else uses the
                        // backend status verbatim.
                        let memberVis = row.status;
                        if (memberVis === 'pending' && !isCurrentStage) memberVis = 'awaiting';
                        const memberStyle = ROW_STYLES[memberVis] || ROW_STYLES.awaiting;
                        const isYou = row.userId && row.userId === user?.id;
                        const memberColor =
                          row.status === 'approved' ? 'text-emerald-600 dark:text-emerald-400'
                          : row.status === 'rejected' ? 'text-red-600 dark:text-red-400'
                          : row.status === 'changes_requested' ? 'text-orange-600 dark:text-orange-400'
                          : row.status === 'pending' && isCurrentStage ? 'text-amber-600 dark:text-amber-400'
                          : row.status === 'submitted' ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-zinc-400 dark:text-zinc-500';
                        return (
                          <li key={row.id || row.level} className="flex items-start gap-2">
                            <span className={`flex-shrink-0 mt-0.5 inline-flex items-center justify-center w-3.5 h-3.5 rounded-full ${memberStyle.bg}`}>
                              <memberStyle.Icon className="w-2 h-2 text-white" />
                            </span>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="font-medium text-zinc-800 dark:text-zinc-100 truncate">
                                  {row.userName || '(deleted user)'}
                                </span>
                                {isYou && (
                                  <span className="text-[9px] uppercase tracking-wide text-emerald-600 dark:text-emerald-400 font-semibold">you</span>
                                )}
                                {(row.role || row.user?.role) && (
                                  <span className={`text-[9px] uppercase tracking-wide ${isSuperAdminRow(row) ? 'text-purple-600 dark:text-purple-300 font-semibold' : 'text-zinc-400 dark:text-zinc-500'}`}>
                                    {roleLabelFor(row)}
                                  </span>
                                )}
                                <span className={`text-[9px] uppercase tracking-wide font-semibold ${memberColor}`}>
                                  {rowStatusLabel(row.status)}
                                </span>
                              </div>
                              {row.comment && (
                                <p className="mt-0.5 text-zinc-600 dark:text-zinc-300 italic break-words">
                                  &ldquo;{row.comment}&rdquo;
                                </p>
                              )}
                              {row.actionAt && (
                                <p className="mt-0.5 text-[10px] text-zinc-400 dark:text-zinc-500">{formatTime(row.actionAt)}</p>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {/* Action panel — appears when current approver clicks Approve / Reject / Request Changes */}
      {showActionPanel && (
        <div className="rounded-md border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/40 p-2.5 mb-2 space-y-2">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-700 dark:text-zinc-200">
            {showActionPanel === 'approve' && <><Check size={12} className="text-emerald-500" /> Approve this level</>}
            {showActionPanel === 'reject' && <><X size={12} className="text-red-500" /> Reject — bounce back one level</>}
            {showActionPanel === 'request_changes' && <><MessageSquare size={12} className="text-orange-500" /> Request changes</>}
          </div>
          <textarea
            autoFocus
            value={actionComment}
            onChange={(e) => setActionComment(e.target.value)}
            disabled={submitting}
            placeholder={
              showActionPanel === 'approve'
                ? 'Optional comment…'
                : 'Required — explain what needs to change…'
            }
            rows={2}
            maxLength={2000}
            className="w-full text-xs px-2.5 py-1.5 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500 resize-none disabled:opacity-60"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={cancelActionPanel}
              disabled={submitting}
              className="text-[11px] font-medium text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={performAction}
              disabled={
                submitting
                || ((showActionPanel === 'reject' || showActionPanel === 'request_changes') && !actionComment.trim())
              }
              className={`text-[11px] font-semibold px-3 py-1.5 rounded-md text-white disabled:bg-zinc-300 dark:disabled:bg-zinc-700 disabled:text-zinc-500 disabled:cursor-not-allowed ${
                showActionPanel === 'approve' ? 'bg-emerald-500 hover:bg-emerald-600' :
                showActionPanel === 'reject' ? 'bg-red-500 hover:bg-red-600' :
                'bg-orange-500 hover:bg-orange-600'
              }`}
            >
              {submitting ? 'Working…' : (
                showActionPanel === 'approve' ? 'Confirm approve' :
                showActionPanel === 'reject' ? 'Confirm reject' :
                'Send request'
              )}
            </button>
          </div>
        </div>
      )}

      {/* Action buttons — rendered strictly from server-supplied capability
          flags when present, else from local derivation. Three paths, all
          unified into one button row:
            - Current-stage approver  (canApprove + canReject + canRequestChanges)
            - Higher-stage approver   (canApproveEarly → same three actions)
            - Super Admin override    (isOverrideApprover → same three actions)
          A small chip above the buttons explains override / higher-level so the
          user knows the action is a privileged path. */}
      {!showActionPanel && showActionButtons && (
        <div className="space-y-1.5">
          {(isOverrideApprover || isHigherLevelApprover) && currentPendingRow && (
            <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
              <Clock size={11} className="text-amber-500" />
              Currently with{' '}
              <span className="font-medium text-zinc-700 dark:text-zinc-200">
                {currentStageRows.length > 1
                  ? `${currentStageRows.length} parallel approvers`
                  : currentPendingRow.userName}
              </span>
              .{' '}
              {isOverrideApprover
                ? 'As Super Admin you may act with full override authority:'
                : 'As a higher-level approver, you may act early:'}
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            {canApprove && (
              <button
                onClick={() => openActionPanel('approve')}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white text-[11px] font-semibold rounded-md transition-colors"
              >
                <Check size={11} />{' '}
                {isHigherLevelApprover && !isOverrideApprover
                  ? 'Approve early (skip lower stages)'
                  : 'Approve'}
              </button>
            )}
            {canReject && (
              <button
                onClick={() => openActionPanel('reject')}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-red-500 hover:bg-red-600 text-white text-[11px] font-semibold rounded-md transition-colors"
              >
                <X size={11} /> Reject
              </button>
            )}
            {canRequestChanges && (
              <button
                onClick={() => openActionPanel('request_changes')}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-orange-500 hover:bg-orange-600 text-white text-[11px] font-semibold rounded-md transition-colors"
              >
                <MessageSquare size={11} /> Request changes
              </button>
            )}
          </div>
        </div>
      )}

      {/* Plain hint for users who are downstream watchers but not in the chain */}
      {isInActiveCycle && !showActionButtons && currentPendingRow && (
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400 mt-1">
          <Clock size={11} className="text-amber-500" />
          {currentStageRows.length > 1 ? (
            <>
              Waiting on the final stage — any of{' '}
              <span className="font-medium text-zinc-700 dark:text-zinc-200">
                {currentStageRows.map((r) => r.userName).filter(Boolean).slice(0, 3).join(', ')}
                {currentStageRows.length > 3 ? ` +${currentStageRows.length - 3}` : ''}
              </span>{' '}
              can approve.
            </>
          ) : (
            <>
              Waiting on <span className="font-medium text-zinc-700 dark:text-zinc-200">{currentPendingRow.userName}</span> to review.
            </>
          )}
        </div>
      )}

      {/* Resubmit / submit button — for changes_requested, rejected, or unsubmitted owned tasks */}
      {!isInActiveCycle && canResubmit && (
        <button
          onClick={() => setShowResubmitModal(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white text-[11px] font-semibold rounded-md transition-colors mt-1"
        >
          {approvalStatus ? <RotateCcw size={11} /> : <Send size={11} />}
          {approvalStatus === 'changes_requested' ? 'Address feedback & resubmit' :
           approvalStatus === 'rejected' ? 'Resubmit for approval' :
           'Submit for approval'}
        </button>
      )}

      {/* Approved terminal hint */}
      {approvalStatus === 'approved' && (
        <div className="flex items-center gap-1.5 text-[11px] text-emerald-700 dark:text-emerald-400 mt-1">
          <Check size={11} /> Fully approved — task is complete.
        </div>
      )}

      {/* Bottom-sheet for resubmission — reuses the same modal as the Done intercept */}
      {showResubmitModal && (
        <MarkDoneApprovalModal
          task={task}
          onClose={() => setShowResubmitModal(false)}
          onSubmitted={(updated) => {
            if (updated && onUpdate) onUpdate(updated);
            // Local mirror update happens via the socket event from the controller.
          }}
        />
      )}

      {/* Inline error banner if backend says they can't act (defensive — controller
          enforces this server-side, but if state drifts we surface gracefully) */}
      {isInActiveCycle && !isCurrentApprover && currentPendingRow && currentPendingRow.userId === null && (
        <div className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400 mt-2 p-2 bg-amber-50 dark:bg-amber-500/10 rounded-md border border-amber-200 dark:border-amber-500/30">
          <AlertCircle size={12} className="flex-shrink-0 mt-0.5" />
          <span>Current approver was deleted from the system. Contact an admin to resolve this chain.</span>
        </div>
      )}
    </div>
  );
}
