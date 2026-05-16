// Logical-stage grouping for approval chains.
//
// Backend stores one TaskApprovalFlow row per individual approver. We render
// the chain as max 3 LOGICAL stages instead of one dot per row, so that an
// approval chain with N reviewers still presents as a clean three-step
// workflow:
//
//   1. SUBMISSION    — the task assignee/creator who submitted (level 0)
//   2. STAGE_1_REVIEW — every Tier 3 reviewer row (sequential walk)
//   3. FINAL          — Tier 2 + Tier 1 reviewers (any-of)
//
// The internal stage key 'assistant_manager' is preserved as a stable
// identifier so persisted state and external integrations don't break, but
// every USER-FACING label is tier-based — never role names.

export const LOGICAL_STAGE = Object.freeze({
  SUBMISSION: 'submission',
  ASSISTANT_MANAGER: 'assistant_manager', // internal key — labels below use Stage 1 / Tier 3
  FINAL: 'final',
});

export const LOGICAL_STAGE_ORDER = [
  LOGICAL_STAGE.SUBMISSION,
  LOGICAL_STAGE.ASSISTANT_MANAGER,
  LOGICAL_STAGE.FINAL,
];

export const LOGICAL_STAGE_LABELS = {
  [LOGICAL_STAGE.SUBMISSION]: 'Submission',
  [LOGICAL_STAGE.ASSISTANT_MANAGER]: 'Stage 1 Review',
  [LOGICAL_STAGE.FINAL]: 'Final Approval',
};

export const LOGICAL_STAGE_SHORT_LABELS = {
  [LOGICAL_STAGE.SUBMISSION]: 'Submitted',
  [LOGICAL_STAGE.ASSISTANT_MANAGER]: 'Stage 1',
  [LOGICAL_STAGE.FINAL]: 'Final',
};

// isSuperAdmin can arrive either flattened on the row (loadChainForResponse)
// or nested under `.user` (raw Sequelize include from taskController).
export function isSuperAdminRow(row) {
  if (!row) return false;
  if (typeof row.isSuperAdmin === 'boolean') return row.isSuperAdmin;
  if (row.user && typeof row.user.isSuperAdmin === 'boolean') return row.user.isSuperAdmin;
  return false;
}

// Map a single row to one of the three logical stages.
// Level 0 is always SUBMISSION regardless of role (the submitter could be
// anyone — admin can submit too).
export function logicalStageOf(row) {
  if (!row) return LOGICAL_STAGE.FINAL;
  if (row.level === 0) return LOGICAL_STAGE.SUBMISSION;
  if (row.role === 'assistant_manager') return LOGICAL_STAGE.ASSISTANT_MANAGER;
  // manager, admin, super admin → final stage. Anything else (member acting
  // as a reviewer in some custom flow) also lands here — the final stage is
  // the catch-all for non-asst-manager approvers.
  return LOGICAL_STAGE.FINAL;
}

// Order rows within the FINAL stage: Manager → Admin → Super Admin.
// Within a tier, preserve the backend-supplied order (createdAt ASC, set in
// collectFinalStageMembers). Super Admin is always last per the product spec
// — "Admin must not appear after Super Admin".
function finalStageRank(row) {
  if (isSuperAdminRow(row)) return 3;
  if (row.role === 'admin') return 2;
  if (row.role === 'manager') return 1;
  return 0; // anything unexpected goes first
}

export function sortFinalStageRows(rows) {
  return [...rows].sort((a, b) => {
    const r = finalStageRank(a) - finalStageRank(b);
    if (r !== 0) return r;
    // Stable secondary order: by level (which mirrors backend insertion order).
    return (a.level ?? 0) - (b.level ?? 0);
  });
}

// Group rows into the three logical stages. Returns ONLY stages that have
// rows — so a task with no assistant managers shows two stages (Submission +
// Final), not three.
//
// Output shape:
//   [
//     { stage: 'submission',         label: 'Submission',                 rows: [...] },
//     { stage: 'assistant_manager',  label: 'Assistant Manager Review',   rows: [...] },
//     { stage: 'final',              label: 'Final Approval',             rows: [...] },
//   ]
export function groupFlowsByLogicalStage(flows) {
  if (!Array.isArray(flows) || flows.length === 0) return [];
  const buckets = {
    [LOGICAL_STAGE.SUBMISSION]: [],
    [LOGICAL_STAGE.ASSISTANT_MANAGER]: [],
    [LOGICAL_STAGE.FINAL]: [],
  };
  for (const row of flows) {
    buckets[logicalStageOf(row)].push(row);
  }
  // Sort assistant manager rows by level (sequential order from the org walk).
  buckets[LOGICAL_STAGE.ASSISTANT_MANAGER].sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
  // Sort final stage by role tier so Super Admin appears last.
  buckets[LOGICAL_STAGE.FINAL] = sortFinalStageRows(buckets[LOGICAL_STAGE.FINAL]);

  return LOGICAL_STAGE_ORDER
    .filter((s) => buckets[s].length > 0)
    .map((s) => ({
      stage: s,
      label: LOGICAL_STAGE_LABELS[s],
      shortLabel: LOGICAL_STAGE_SHORT_LABELS[s],
      rows: buckets[s],
    }));
}

// Roll up many rows in one logical stage to a single visual status.
//
// Rules:
//   - If ANY row is rejected → stage is rejected (a single reject in a
//     parallel any-of stage tears down the whole stage).
//   - Else if any row is changes_requested → changes_requested.
//   - Else if any row is approved → approved (any-of approval rule).
//   - Else if the level-0 submission exists → submitted (only applies to the
//     SUBMISSION bucket — the level-0 row uses status='submitted', not
//     'approved').
//   - Else if any row is pending → pending.
//   - Else → awaiting (every row is skipped/cancelled or in a future stage).
export function rollUpStageStatus(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 'awaiting';
  if (rows.some((r) => r.status === 'rejected')) return 'rejected';
  if (rows.some((r) => r.status === 'changes_requested')) return 'changes_requested';
  if (rows.some((r) => r.status === 'approved')) return 'approved';
  if (rows.some((r) => r.status === 'submitted')) return 'submitted';
  if (rows.some((r) => r.status === 'pending')) return 'pending';
  return 'awaiting';
}

// Returns the logical stage that is currently "active" — the lowest-ordered
// stage that still has a pending row. null when nothing is pending (chain is
// fully approved, rejected, or changes_requested).
export function currentLogicalStage(stageGroups) {
  if (!Array.isArray(stageGroups) || stageGroups.length === 0) return null;
  for (const g of stageGroups) {
    if (g.rows.some((r) => r.status === 'pending')) return g.stage;
  }
  return null;
}

// Human-friendly per-row label for the "what tier is this person?" column.
// Old role names ('Admin', 'Manager', 'Assistant Manager', 'Member',
// 'Super Admin') are NEVER shown — tier labels only.
//
// CURRENT vs. SNAPSHOT: TaskApprovalFlow stores a `role` snapshot captured
// when the chain was generated. For the live indicator we want the
// approver's CURRENT tier — promoting an approver from Tier 2 to Tier 1
// mid-approval should update the badge in the modal, not preserve the
// stale "Tier 2" label. loadChainForResponse now exposes the live identity
// alongside the snapshot:
//   row.role         — audit snapshot, captured when chain was generated
//   row.tier         — current tier from the joined live User row
//   row.currentRole  — current role string from the joined live User row
//   row.isSuperAdmin — current super-admin flag from the joined live User
// Preference order: live `tier` → live `isSuperAdmin` + live role → snapshot.
export function roleLabelFor(row) {
  if (!row) return '';
  if (Number.isInteger(row.tier) && row.tier >= 1 && row.tier <= 4) {
    return `Tier ${row.tier}`;
  }
  if (isSuperAdminRow(row)) return 'Tier 1';
  const live = row.currentRole || row.user?.role;
  if (live === 'admin' || live === 'manager') return 'Tier 2';
  if (live === 'assistant_manager') return 'Tier 3';
  if (live === 'member') return 'Tier 4';
  const snap = row.role;
  if (snap === 'admin' || snap === 'manager') return 'Tier 2';
  if (snap === 'assistant_manager') return 'Tier 3';
  if (snap === 'member') return 'Tier 4';
  return '';
}

// Convert a backend row.status to a one-word visual label for the row's chip.
// Centralised so the indicator tooltip and the modal stay in sync.
export function rowStatusLabel(status) {
  switch (status) {
    case 'submitted':         return 'Submitted';
    case 'approved':          return 'Approved';
    case 'pending':           return 'Pending';
    case 'rejected':          return 'Rejected';
    case 'changes_requested': return 'Changes requested';
    case 'skipped_parallel':  return 'Auto-skipped';
    case 'cancelled_peer':    return 'Cancelled';
    default:                  return (status || '').replace(/_/g, ' ');
  }
}
