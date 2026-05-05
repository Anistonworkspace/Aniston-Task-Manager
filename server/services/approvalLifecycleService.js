'use strict';

/**
 * Approval lifecycle state transitions.
 *
 * Centralizes the rule that "task fields the user sees" (status, progress,
 * groupId) move in lockstep with the approval state. Without this the board
 * row is stuck on the pre-submission status until the user manually flips it
 * — the bug we're fixing.
 *
 *   submitted          → status='waiting_for_review', progress=100
 *   approved (final)   → status='done',               progress=100, group→Done
 *   rejected (terminal)→ restore prior status/progress (or 'not_started'/0)
 *   changes_requested  → restore prior status/progress (or 'not_started'/0)
 *
 * Pre-submission status/progress are snapshotted into
 * `task.customFields._approvalSnapshot` when submitForApproval runs. The
 * snapshot is consumed (cleared) by approve / reject / request_changes —
 * one cycle's snapshot, one consumer.
 *
 * Pure helpers — no DB writes, no Sequelize model dependencies. Each function
 * returns a partial Task patch that the controller applies inside its
 * existing transaction. This keeps the lifecycle logic unit-testable and
 * removes the need to coordinate two separate write paths.
 */

const { resolveStatusByLabel } = require('../utils/statusConfig');
const { findGroupForStatus } = require('../utils/taskPrioritization');

const SNAPSHOT_KEY = '_approvalSnapshot';

// ── Snapshot helpers ──────────────────────────────────────────────────────

function snapshotFrom(task) {
  // customFields can be a plain object, JSON string, or null on legacy rows.
  let cf = task?.customFields;
  if (typeof cf === 'string') {
    try { cf = JSON.parse(cf); } catch { cf = null; }
  }
  return cf?.[SNAPSHOT_KEY] || null;
}

function withSnapshot(task, snap) {
  const cf = (typeof task?.customFields === 'object' && task.customFields !== null)
    ? { ...task.customFields }
    : {};
  cf[SNAPSHOT_KEY] = snap;
  return cf;
}

function withoutSnapshot(task) {
  const cf = (typeof task?.customFields === 'object' && task.customFields !== null)
    ? { ...task.customFields }
    : {};
  delete cf[SNAPSHOT_KEY];
  return cf;
}

// ── Group resolution ──────────────────────────────────────────────────────

// Resolve a target group for a status on this board. Wraps findGroupForStatus
// with a defensive guard — returns null when no good match (caller skips the
// move rather than dropping the task into the wrong column).
function resolveGroupForStatus(status, board) {
  if (!status || !board) return null;
  const groups = Array.isArray(board.groups) ? board.groups : null;
  if (!groups || groups.length === 0) return null;
  return findGroupForStatus(status, groups) || null;
}

// ── Lifecycle: submit ─────────────────────────────────────────────────────
//
// Called when an assignee submits a task for approval. Snapshots the prior
// status/progress so reject/request_changes can restore exactly what the
// user had before they tried to mark Done. progress=100 is the product
// requirement — even though the task isn't actually done yet, the user
// signaled "I'm done" by submitting, and the bar reflects that.

function applyApprovalSubmittedState(task, board) {
  const targetStatusKey = resolveStatusByLabel(
    ['Waiting for Review', 'In Review', 'review'],
    task,
    board
  ) || task.status; // never blank-out the cell — if no review status exists, keep what we have
  const snapshot = {
    status:   task.status || null,
    progress: typeof task.progress === 'number' ? task.progress : 0,
    groupId:  task.groupId || null,
    capturedAt: new Date().toISOString(),
  };

  return {
    status: targetStatusKey,
    progress: 100,
    customFields: withSnapshot(task, snapshot),
    // groupId intentionally NOT changed during submission — the task should
    // visually stay in its current column with a "Pending Approval" badge.
    // Moving to a Done column on submit would be misleading.
  };
}

// ── Lifecycle: approved (final) ───────────────────────────────────────────
//
// Called when the chain's last pending row is approved and the task should
// now be Done. Sets status=done, progress=100, moves the row to a Done-named
// group (if one exists), and clears the snapshot — the cycle is complete.

function applyApprovalApprovedState(task, board) {
  const doneKey = resolveStatusByLabel(['Done', 'done'], task, board) || 'done';
  const targetGroupId = resolveGroupForStatus(doneKey, board);

  const patch = {
    status: doneKey,
    progress: 100,
    customFields: withoutSnapshot(task),
  };
  if (targetGroupId) patch.groupId = targetGroupId;
  return patch;
}

// ── Lifecycle: rejected / changes_requested ───────────────────────────────
//
// Called when reviewer terminates the chain. The user's prior state was
// snapshotted at submit time — we restore it verbatim so the board and the
// progress bar look exactly the way they did before submission, minus the
// approval indicator (which the controller updates separately).
//
// When no snapshot is available (legacy task, missing customFields, etc.),
// fall back to the safe defaults the user explicitly asked for: status =
// 'not_started', progress = 0. Group movement follows the restored status.

function applyApprovalRestoredState(task, board) {
  const snap = snapshotFrom(task);
  const fallbackStatusKey = resolveStatusByLabel(['Not Started'], task, board) || 'not_started';

  const restoredStatus = snap?.status || fallbackStatusKey;
  const restoredProgress = (snap && typeof snap.progress === 'number') ? snap.progress : 0;
  const restoredGroupId = snap?.groupId || resolveGroupForStatus(restoredStatus, board) || null;

  const patch = {
    status: restoredStatus,
    progress: restoredProgress,
    customFields: withoutSnapshot(task),
  };
  if (restoredGroupId) patch.groupId = restoredGroupId;
  return patch;
}

// Specific aliases keep the calling code self-documenting at the call site —
// approve / reject / request_changes each get a named helper even though
// reject and request_changes share the same restoration logic. Diverging the
// behavior in the future requires only one line to change here.
const applyApprovalRejectedState = applyApprovalRestoredState;
const applyApprovalChangesRequestedState = applyApprovalRestoredState;

module.exports = {
  applyApprovalSubmittedState,
  applyApprovalApprovedState,
  applyApprovalRejectedState,
  applyApprovalChangesRequestedState,
  // Exported for tests:
  snapshotFrom,
  withSnapshot,
  withoutSnapshot,
  SNAPSHOT_KEY,
};
