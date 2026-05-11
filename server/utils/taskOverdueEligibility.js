'use strict';

/**
 * Task overdue-notification eligibility.
 *
 * Single source of truth for "should this task generate an overdue / due-soon
 * notification right now?". The same predicate must apply to:
 *
 *   - the hourly overdue cron        (server/jobs/reminderJob.js)
 *   - the due-soon cron              (server/jobs/reminderJob.js)
 *   - the 3-day-warning cron         (server/jobs/reminderJob.js)
 *   - the per-reminder cron handler  (server/services/reminderService.js)
 *   - any future manual / on-demand overdue notification path
 *
 * Before this helper existed, each path duplicated its own `status === 'done'`
 * check. None of them filtered approval state, none filtered "waiting for
 * review" status, so a user who had already submitted their work for approval
 * still received an overdue notification — the bug we are fixing.
 *
 * Status taxonomy (verified from the actual codebase, not guessed):
 *
 *   task.status (STRING(50), per-board customisable via statusConfig):
 *     - 'not_started', 'ready_to_start', 'working_on_it', 'in_progress'  → actionable
 *     - 'stuck'                                                          → actionable
 *     - 'waiting_for_review', 'review', 'pending_deploy'                 → NOT actionable
 *     - 'done'                                                           → NOT actionable
 *     - custom keys on a board may not match any of the above
 *
 *   task.approvalStatus (STRING(30)):
 *     - null                       → no approval workflow in flight
 *     - 'pending_approval'         → submitted, waiting reviewer       → NOT actionable
 *     - 'approved'                 → chain complete                    → NOT actionable
 *     - 'changes_requested'        → reviewer bounced back to user     → actionable again
 *
 *   task.isArchived (BOOLEAN):
 *     - true                       → task is hidden / soft-deleted     → NOT actionable
 *
 * The helper also accepts a few extra status keys the product prompt named
 * defensively ('pending_review', 'submitted_for_approval', 'approval_pending',
 * 'in_review', 'completed') so that any future boards that customise their
 * status column with one of those keys will be filtered correctly without a
 * code change. Lookup is case-insensitive and ignores surrounding whitespace.
 */

const { isCompletedStatus } = require('./taskPrioritization');

// Statuses that mean "user has already done their part, work is awaiting a
// reviewer / deployer / approver". Keep all values lower-case here — callers
// use `normalize()` below before checking membership.
const AWAITING_REVIEW_STATUSES = new Set([
  'waiting_for_review',
  'pending_review',
  'submitted_for_approval',
  'approval_pending',
  'in_review',
  'review',
  'pending_deploy',
]);

// approvalStatus values that mean "task is not currently actionable by the
// assignee" — submitter is waiting for the reviewer chain to act.
const NON_ACTIONABLE_APPROVAL_STATUSES = new Set([
  'pending_approval',
  'approved',
]);

function normalize(value) {
  if (value === null || value === undefined) return '';
  return String(value).toLowerCase().trim();
}

/**
 * True iff the task status indicates the assignee has handed work off for
 * review / approval / deployment and is no longer the actionable party.
 *
 * Case-insensitive. Returns false for null / unknown statuses — the caller
 * should also check `isCompletedStatus` (or use the combined predicate below).
 */
function isAwaitingReviewStatus(status) {
  const key = normalize(status);
  if (!key) return false;
  return AWAITING_REVIEW_STATUSES.has(key);
}

/**
 * True iff the task is in an approval-workflow state that makes the assignee
 * not the actionable party. Reads `task.approvalStatus`.
 *
 * `changes_requested` is intentionally NOT in this set: the reviewer bounced
 * the task back to the submitter, so the submitter IS the actionable party
 * again and overdue reminders should fire.
 */
function isPendingApprovalState(task) {
  if (!task) return false;
  const key = normalize(task.approvalStatus);
  if (!key) return false;
  return NON_ACTIONABLE_APPROVAL_STATUSES.has(key);
}

/**
 * Master predicate. Returns `{ eligible, reason }`:
 *   - eligible = true  → an overdue / due-soon notification IS appropriate
 *   - eligible = false → SKIP the notification. `reason` is a short stable
 *                        token suitable for logs and metrics.
 *
 * Order of checks is deliberately specific → general so the `reason` is the
 * most informative one when multiple flags apply (e.g. a task that is both
 * archived AND done logs `archived`, which is the user-facing cause).
 */
function isTaskEligibleForOverdueNotification(task) {
  if (!task) return { eligible: false, reason: 'task_missing' };

  if (task.isArchived === true) {
    return { eligible: false, reason: 'archived' };
  }

  if (isCompletedStatus(task.status)) {
    return { eligible: false, reason: 'completed_status' };
  }

  if (isAwaitingReviewStatus(task.status)) {
    return { eligible: false, reason: 'awaiting_review_status' };
  }

  if (isPendingApprovalState(task)) {
    return { eligible: false, reason: 'awaiting_approval' };
  }

  return { eligible: true, reason: null };
}

module.exports = {
  AWAITING_REVIEW_STATUSES,
  NON_ACTIONABLE_APPROVAL_STATUSES,
  isAwaitingReviewStatus,
  isPendingApprovalState,
  isTaskEligibleForOverdueNotification,
};
