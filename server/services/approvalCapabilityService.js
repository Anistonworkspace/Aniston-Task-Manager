// Single source of truth for "what approval action can THIS user perform on
// THIS task right now?". Used by every approval-related endpoint so the
// frontend renders action buttons strictly from server-supplied capability
// flags. Eliminates the previous TasksPage bug where buttons were gated on
// `canManage` (a role check) while the controller actually enforced approval-
// chain membership — a manager who wasn't in the chain saw the buttons and
// got a 403 on click ("You are not a current approver for this task").
//
// Pure function. No DB writes. Safe to call inside getters that already have
// the chain rows loaded.
//
// Capability rules — kept exactly in sync with processApprovalAction in
// approvalController.js:
//
//   1. Submitter (level 0)   → no actions, ever (self-approval guard).
//   2. Current-stage approver → Approve / Reject / Request Changes.
//   3. Higher-stage approver  → Approve / Reject / Request Changes
//                                (early — controller treats reject &
//                                 request-changes as terminal disposition).
//   4. Super Admin not in chain → Approve / Reject / Request Changes
//                                (override — controller synthesizes a
//                                 task_approval_flow row at the current
//                                 stage so the audit trail records it).
//   5. Anyone else            → no actions; reasonIfCannotAct populated.

const stageOf = (row) => (row.stage != null ? row.stage : row.level);

function emptyCapabilities(reason = null, currentStage = null, currentApproverNames = []) {
  return {
    canApprove: false,
    canReject: false,
    canRequestChanges: false,
    canApproveEarly: false,
    isCurrentApprover: false,
    isOverrideApprover: false,
    currentStage,
    currentApproverNames,
    reasonIfCannotAct: reason,
  };
}

/**
 * @param {Object} args
 * @param {Object} args.task   — Task row. Must have approvalStatus.
 * @param {Array}  args.flows  — TaskApprovalFlow rows (any order). May include
 *                                an attached `user` association (used to
 *                                resolve names when userName is null).
 * @param {Object} args.user   — req.user. Must have id and isSuperAdmin.
 */
function computeApprovalCapabilities({ task, flows, user }) {
  if (!user || !user.id) {
    return emptyCapabilities('Not authenticated.');
  }

  // Capabilities only exist while the chain is active. Terminal states
  // (approved / rejected / changes_requested) and "no chain" both return
  // empty so the UI never renders buttons that would 409.
  if (!task || task.approvalStatus !== 'pending_approval') {
    return emptyCapabilities('Approval is not in progress for this task.');
  }

  const chain = Array.isArray(flows) ? flows : [];

  // Self-approval guard. Mirrors approvalController.js line ~407 — even Super
  // Admin cannot act on a task they themselves submitted. submitForApproval
  // already blocks Super Admins from being submitters in the first place, but
  // this defends against future product changes that loosen that rule.
  const submitterRow = chain.find((r) => r.level === 0);
  if (submitterRow && String(submitterRow.userId) === String(user.id)) {
    return emptyCapabilities('You submitted this task — someone else must review it.');
  }

  // Find the lowest pending stage. Empty pending set means the chain is in
  // an inconsistent state (controller will return 409 if anyone tries to act).
  const pendingRows = chain.filter((r) => r.status === 'pending');
  if (pendingRows.length === 0) {
    return emptyCapabilities('No pending approval step.');
  }
  const lowestPendingStage = Math.min(...pendingRows.map(stageOf));
  const currentStageRows = pendingRows.filter((r) => stageOf(r) === lowestPendingStage);
  const currentApproverNames = currentStageRows
    .map((r) => r.userName || r.user?.name || null)
    .filter(Boolean);

  // 1. Current-stage approver — full standard action set.
  const inCurrentStage = currentStageRows.some(
    (r) => String(r.userId) === String(user.id)
  );
  if (inCurrentStage) {
    return {
      canApprove: true,
      canReject: true,
      canRequestChanges: true,
      canApproveEarly: false,
      isCurrentApprover: true,
      isOverrideApprover: false,
      currentStage: lowestPendingStage,
      currentApproverNames,
      reasonIfCannotAct: null,
    };
  }

  // 2. Higher-stage approver — early action. Per the product spec all three
  //    actions are allowed (controller treats reject & request_changes as
  //    terminal disposition; no bouncing through skipped intermediate stages).
  const myPendingRow = pendingRows.find(
    (r) => String(r.userId) === String(user.id)
  );
  if (myPendingRow && stageOf(myPendingRow) > lowestPendingStage) {
    return {
      canApprove: true,
      canReject: true,
      canRequestChanges: true,
      canApproveEarly: true,
      isCurrentApprover: false,
      isOverrideApprover: false,
      currentStage: lowestPendingStage,
      currentApproverNames,
      reasonIfCannotAct: null,
    };
  }

  // 3. Super Admin override — actor holds no row in the chain but has
  //    organisational authority to act on every approval task. Controller
  //    synthesizes a task_approval_flow row at the current stage so the
  //    decision is preserved in the audit trail.
  if (user.isSuperAdmin) {
    return {
      canApprove: true,
      canReject: true,
      canRequestChanges: true,
      canApproveEarly: false,        // not "early" — they are override authority
      isCurrentApprover: false,
      isOverrideApprover: true,
      currentStage: lowestPendingStage,
      currentApproverNames,
      reasonIfCannotAct: null,
    };
  }

  // 4. Everyone else — read-only. Surface a reason so UIs can render a tooltip
  //    instead of just hiding the buttons silently.
  return emptyCapabilities(
    'You are not in this approval chain.',
    lowestPendingStage,
    currentApproverNames
  );
}

module.exports = { computeApprovalCapabilities, stageOf };
