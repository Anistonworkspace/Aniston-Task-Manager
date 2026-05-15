import React, { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Check, X, MessageSquare, Clock, CircleDot, Send } from 'lucide-react';
import {
  groupFlowsByLogicalStage,
  rollUpStageStatus,
  currentLogicalStage,
  roleLabelFor,
  rowStatusLabel,
  LOGICAL_STAGE,
} from '../../utils/approvalStages';

// Status -> Tailwind classes for the segment fill.
const SEGMENT_STYLES = {
  approved:           'bg-success',
  pending:            'bg-amber-400 animate-pulse',
  rejected:           'bg-danger',
  changes_requested:  'bg-orange-400',
  awaiting:           'bg-zinc-300 dark:bg-zinc-700',
  submitted:          'bg-success',
};

const STATUS_ICON = {
  approved:           Check,
  pending:            Clock,
  rejected:           X,
  changes_requested:  MessageSquare,
  submitted:          Send,
  awaiting:           CircleDot,
};

const STATUS_LABEL = {
  approved:           'Approved',
  pending:            'Pending — current',
  rejected:           'Rejected',
  changes_requested:  'Changes requested',
  submitted:          'Submitted',
  awaiting:           'Awaiting',
};

const STATUS_TEXT_COLOR = {
  approved:          'text-emerald-400',
  pending:           'text-amber-300',
  rejected:          'text-red-400',
  changes_requested: 'text-orange-300',
  submitted:         'text-emerald-400',
  awaiting:          'text-zinc-400',
};

const PER_ROW_TEXT_COLOR = {
  approved:          'text-emerald-300',
  pending:           'text-amber-300',
  rejected:          'text-red-300',
  changes_requested: 'text-orange-300',
  submitted:         'text-emerald-300',
  skipped_parallel:  'text-zinc-500',
  cancelled_peer:    'text-zinc-500',
  awaiting:          'text-zinc-500',
};

// Multi-step approval pip indicator. Always shows MAX 3 dots — one per
// LOGICAL stage (Submission / Assistant Manager / Final). Multiple users
// inside one stage are collapsed into the tooltip; the dots themselves
// represent workflow phases, not individual approvers.
export default function ApprovalStepIndicator({ flows, approvalStatus }) {
  const [showTip, setShowTip] = useState(false);
  const [tipPos, setTipPos] = useState({ left: 0, top: 0 });
  const wrapRef = useRef(null);

  if (!Array.isArray(flows) || flows.length === 0) return null;

  // Group by logical role-based stage. Only stages with rows are included.
  const stageGroups = groupFlowsByLogicalStage(flows);
  if (stageGroups.length === 0) return null;

  const currentStage = currentLogicalStage(stageGroups);

  // Build per-stage display segments.
  const segments = stageGroups.map((g) => {
    const isCurrent = currentStage === g.stage;
    let visualStatus = rollUpStageStatus(g.rows);
    // A pending stage that isn't the CURRENT one is still future work — show
    // it as awaiting so the eye can quickly find the active step.
    if (visualStatus === 'pending' && !isCurrent) visualStatus = 'awaiting';
    return { ...g, visualStatus, isCurrent, isParallel: g.rows.length > 1 };
  });

  function handleMouseEnter() {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setTipPos({
      left: rect.left + rect.width / 2,
      top: rect.bottom + 6,
    });
    setShowTip(true);
  }

  // Top-level pill ring summarises the chain at a glance.
  const summaryRing =
    approvalStatus === 'approved'           ? 'ring-emerald-500/50'
    : approvalStatus === 'rejected'           ? 'ring-red-500/50'
    : approvalStatus === 'changes_requested'  ? 'ring-orange-400/50'
    : 'ring-amber-400/50';

  const totalApprovers = flows.filter((f) => f.level >= 1).length;

  return (
    <div
      ref={wrapRef}
      className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md ring-1 ${summaryRing} bg-white/60 dark:bg-zinc-900/40 cursor-help`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={() => setShowTip(false)}
      onFocus={handleMouseEnter}
      onBlur={() => setShowTip(false)}
      tabIndex={0}
      role="img"
      aria-label={`Approval workflow: ${segments.length} stages, ${totalApprovers} approvers, status ${approvalStatus || 'in progress'}`}
    >
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        const fill = SEGMENT_STYLES[seg.visualStatus] || SEGMENT_STYLES.awaiting;
        return (
          <React.Fragment key={seg.stage}>
            <span
              className={`relative block w-2.5 h-2.5 rounded-full ${fill} ${seg.isCurrent ? 'ring-2 ring-amber-300 ring-offset-1 ring-offset-white dark:ring-offset-zinc-900' : ''}`}
            >
              {/* "Stack" indicator when multiple users belong to this stage. */}
              {seg.isParallel && (
                <span className="absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-white dark:bg-zinc-900 ring-1 ring-zinc-400 dark:ring-zinc-500" />
              )}
            </span>
            {!isLast && <span className="block w-1.5 h-px bg-zinc-300 dark:bg-zinc-700" />}
          </React.Fragment>
        );
      })}

      {showTip && createPortal(
        <div
          className="fixed z-[200] -translate-x-1/2 px-3 py-2 rounded-lg bg-zinc-900 dark:bg-zinc-800 text-white text-xs shadow-xl border border-zinc-700 min-w-[260px] max-w-[360px] pointer-events-none"
          style={{ left: tipPos.left, top: tipPos.top }}
          role="tooltip"
        >
          <div className="font-semibold text-[11px] uppercase tracking-wide text-zinc-400 mb-1.5">
            Approval workflow
          </div>
          <ul className="space-y-2">
            {segments.map((seg, idx) => {
              const Icon = STATUS_ICON[seg.visualStatus] || CircleDot;
              const labelColor = STATUS_TEXT_COLOR[seg.visualStatus] || 'text-zinc-400';
              const stageNumber = idx + 1;

              // Sub-header for the stage. Includes a hint when the stage is a
              // parallel any-of (final stage with multiple approvers).
              const stageHint =
                seg.stage === LOGICAL_STAGE.FINAL && seg.isParallel ? ' · any one approves'
                : seg.stage === LOGICAL_STAGE.ASSISTANT_MANAGER && seg.isParallel ? ' · all approve'
                : '';

              return (
                <li key={seg.stage} className="text-[10px]">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full ${SEGMENT_STYLES[seg.visualStatus] || SEGMENT_STYLES.awaiting}`}>
                      <Icon className="w-2.5 h-2.5 text-white" />
                    </span>
                    <span className="flex-1 font-semibold text-zinc-200 truncate">
                      Stage {stageNumber} · {seg.label}{stageHint}
                    </span>
                    <span className={`text-[10px] uppercase tracking-wide ${labelColor}`}>
                      {STATUS_LABEL[seg.visualStatus] || seg.visualStatus}
                    </span>
                  </div>
                  <ul className="ml-6 space-y-0.5">
                    {seg.rows.map((m) => {
                      const mLabel = rowStatusLabel(m.status);
                      const mColor = PER_ROW_TEXT_COLOR[m.status] || 'text-zinc-500';
                      return (
                        <li key={m.id || m.level} className="flex items-center gap-1.5">
                          <span className="text-zinc-300 truncate flex-1">
                            · {m.userName || '(unknown)'}
                            {(m.role || m.user?.role) && (
                              <span className="ml-1 text-zinc-500 uppercase tracking-wide text-[9px]">
                                {roleLabelFor(m)}
                              </span>
                            )}
                          </span>
                          <span className={`text-[9px] uppercase tracking-wide ${mColor}`}>
                            {mLabel}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        </div>,
        document.body
      )}
    </div>
  );
}
