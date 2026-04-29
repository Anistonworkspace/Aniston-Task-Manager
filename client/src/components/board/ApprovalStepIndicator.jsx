import React, { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Check, X, MessageSquare, Clock, CircleDot } from 'lucide-react';

// Status -> Tailwind classes for the segment fill. Kept terse so the TaskRow
// stays compact; the tooltip carries the verbose info.
const SEGMENT_STYLES = {
  approved:           'bg-emerald-500',
  pending:            'bg-amber-400 animate-pulse',
  rejected:           'bg-red-500',
  changes_requested:  'bg-orange-400',
  awaiting:           'bg-zinc-300 dark:bg-zinc-700',
  submitted:          'bg-emerald-500', // level-0 row, treated as a starting tick
};

const STATUS_ICON = {
  approved:           Check,
  pending:            Clock,
  rejected:           X,
  changes_requested:  MessageSquare,
  submitted:          Check,
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

// Effective stage for a flow row. Backward-compat: rows missing the `stage`
// field (legacy chains created before the parallel-stage rework) fall back to
// using their level as the stage value, preserving sequential semantics.
function stageOf(row) {
  return row.stage != null ? row.stage : row.level;
}

// Multi-step approval pip indicator. Shown next to the Status pill when a task
// has any approvalFlows row (i.e. has been submitted at least once).
//
// Parallel-stage aware: groups rows by stage. Each STAGE renders one pip; a
// stage with multiple parallel approvers (e.g. final Manager+Admin+SuperAdmin)
// gets a single "Final stage" pip whose tooltip lists every member. Sequential
// stages render as before (one pip per stage). The current stage gets the
// pulse + ring.
export default function ApprovalStepIndicator({ flows, approvalStatus }) {
  const [showTip, setShowTip] = useState(false);
  const [tipPos, setTipPos] = useState({ left: 0, top: 0 });
  const wrapRef = useRef(null);

  if (!Array.isArray(flows) || flows.length === 0) return null;

  // Approver rows only (level >= 1). Sort defensive — rely on backend ASC.
  const approvers = flows.filter((f) => f.level >= 1).sort((a, b) => stageOf(a) - stageOf(b) || a.level - b.level);
  if (approvers.length === 0) return null;

  // Group approver rows by stage value. A "stage segment" represents one step
  // in the chain — sequential stages have one row, parallel stages have many.
  const stageMap = new Map();
  for (const row of approvers) {
    const s = stageOf(row);
    if (!stageMap.has(s)) stageMap.set(s, []);
    stageMap.get(s).push(row);
  }
  const stages = Array.from(stageMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([stageValue, rows]) => ({ stage: stageValue, rows }));

  // Lowest pending stage = the current step.
  const currentStageEntry = stages.find((st) => st.rows.some((r) => r.status === 'pending'));
  const currentStageValue = currentStageEntry?.stage ?? null;

  // Compute a single visual status PER STAGE (rolled-up from member rows).
  const segments = stages.map(({ stage, rows }) => {
    const isParallel = rows.length > 1;
    const isCurrent = currentStageValue !== null && stage === currentStageValue;
    const isAfterCurrent = currentStageValue !== null && stage > currentStageValue;

    // Roll-up rule: any rejection wins; then changes_requested; then
    // approved (any-of for parallel, all for sequential — but a parallel
    // stage with even one approval IS approved by spec); then pending if
    // current; then awaiting for above-current; else last status.
    let visualStatus;
    if (rows.some((r) => r.status === 'rejected')) {
      visualStatus = 'rejected';
    } else if (rows.some((r) => r.status === 'changes_requested')) {
      visualStatus = 'changes_requested';
    } else if (rows.some((r) => r.status === 'approved')) {
      visualStatus = 'approved';
    } else if (isCurrent) {
      visualStatus = 'pending';
    } else if (isAfterCurrent) {
      visualStatus = 'awaiting';
    } else if (rows.every((r) => r.status === 'skipped_parallel' || r.status === 'cancelled_peer')) {
      visualStatus = 'awaiting';
    } else {
      visualStatus = 'awaiting';
    }
    return { stage, rows, isParallel, isCurrent, visualStatus };
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

  // Top-level pill color summarises the chain state at a glance, mirroring
  // the segment palette so the eye reads "what's happening here?" instantly.
  const summaryRing =
    approvalStatus === 'approved'           ? 'ring-emerald-500/50'
    : approvalStatus === 'rejected'           ? 'ring-red-500/50'
    : approvalStatus === 'changes_requested'  ? 'ring-orange-400/50'
    : 'ring-amber-400/50';

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
      aria-label={`Approval chain: ${approvers.length} levels, status ${approvalStatus || 'in progress'}`}
    >
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        const fill = SEGMENT_STYLES[seg.visualStatus] || SEGMENT_STYLES.awaiting;
        return (
          <React.Fragment key={seg.stage}>
            <span
              className={`relative block w-2.5 h-2.5 rounded-full ${fill} ${seg.isCurrent ? 'ring-2 ring-amber-300 ring-offset-1 ring-offset-white dark:ring-offset-zinc-900' : ''}`}
            >
              {/* Tiny "stack" indicator when this stage is parallel (final any-of). */}
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
          className="fixed z-[200] -translate-x-1/2 px-3 py-2 rounded-lg bg-zinc-900 dark:bg-zinc-800 text-white text-xs shadow-xl border border-zinc-700 min-w-[220px] max-w-[320px] pointer-events-none"
          style={{ left: tipPos.left, top: tipPos.top }}
          role="tooltip"
        >
          <div className="font-semibold text-[11px] uppercase tracking-wide text-zinc-400 mb-1">
            Approval chain
          </div>
          <ul className="space-y-1.5">
            {segments.map((seg) => {
              const Icon = STATUS_ICON[seg.visualStatus] || CircleDot;
              const labelColor =
                seg.visualStatus === 'approved' ? 'text-emerald-400'
                : seg.visualStatus === 'rejected' ? 'text-red-400'
                : seg.visualStatus === 'pending' ? 'text-amber-300'
                : seg.visualStatus === 'changes_requested' ? 'text-orange-300'
                : 'text-zinc-400';

              // Parallel any-of stage: render the stage header + the member list.
              if (seg.isParallel) {
                // Roll-up label: who actually approved (if any), else "any of".
                const approvedBy = seg.rows.find((r) => r.status === 'approved');
                const stageHeader = approvedBy
                  ? `Stage ${seg.stage} · Final stage — approved by ${approvedBy.userName || '(unknown)'}`
                  : `Stage ${seg.stage} · Final stage (any one approves)`;
                return (
                  <li key={seg.stage} className="text-[10px]">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full ${SEGMENT_STYLES[seg.visualStatus] || SEGMENT_STYLES.awaiting}`}>
                        <Icon className="w-2.5 h-2.5 text-white" />
                      </span>
                      <span className="flex-1 font-semibold text-zinc-200 truncate">
                        {stageHeader}
                      </span>
                      <span className={`text-[10px] uppercase tracking-wide ${labelColor}`}>
                        {STATUS_LABEL[seg.visualStatus] || seg.visualStatus}
                      </span>
                    </div>
                    <ul className="ml-6 space-y-0.5">
                      {seg.rows.map((m) => {
                        const mLabel =
                          m.status === 'approved' ? 'Approved'
                          : m.status === 'pending' ? 'Pending'
                          : m.status === 'rejected' ? 'Rejected'
                          : m.status === 'changes_requested' ? 'Changes requested'
                          : m.status === 'skipped_parallel' ? 'Auto-skipped (peer approved)'
                          : m.status === 'cancelled_peer' ? 'Cancelled (peer rolled back)'
                          : m.status;
                        const mColor =
                          m.status === 'approved' ? 'text-emerald-300'
                          : m.status === 'pending' ? 'text-amber-300'
                          : m.status === 'rejected' ? 'text-red-300'
                          : m.status === 'changes_requested' ? 'text-orange-300'
                          : 'text-zinc-500';
                        return (
                          <li key={m.id || m.level} className="flex items-center gap-1.5">
                            <span className="text-zinc-300 truncate flex-1">
                              · {m.userName || '(unknown)'}
                              {m.role && (
                                <span className="ml-1 text-zinc-500 uppercase tracking-wide text-[9px]">
                                  {m.role.replace('_', ' ')}
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
              }

              // Sequential single-row stage (asst manager etc.).
              const row = seg.rows[0];
              return (
                <li key={seg.stage} className="flex items-center gap-2">
                  <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full ${SEGMENT_STYLES[seg.visualStatus] || SEGMENT_STYLES.awaiting}`}>
                    <Icon className="w-2.5 h-2.5 text-white" />
                  </span>
                  <span className="flex-1 truncate">
                    L{seg.stage} · {row.userName || '(unknown)'}
                  </span>
                  <span className={`text-[10px] uppercase tracking-wide ${labelColor}`}>
                    {STATUS_LABEL[seg.visualStatus] || seg.visualStatus}
                  </span>
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
