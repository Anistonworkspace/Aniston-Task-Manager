'use strict';

const {
  AWAITING_REVIEW_STATUSES,
  NON_ACTIONABLE_APPROVAL_STATUSES,
  isAwaitingReviewStatus,
  isPendingApprovalState,
  isTaskEligibleForOverdueNotification,
} = require('../../utils/taskOverdueEligibility');

// ─── Constants ──────────────────────────────────────────────────────────────

describe('AWAITING_REVIEW_STATUSES', () => {
  test('contains the canonical waiting-for-review keys', () => {
    expect(AWAITING_REVIEW_STATUSES.has('waiting_for_review')).toBe(true);
    expect(AWAITING_REVIEW_STATUSES.has('review')).toBe(true);
    expect(AWAITING_REVIEW_STATUSES.has('pending_deploy')).toBe(true);
  });

  test('contains the defensive aliases from the product prompt', () => {
    expect(AWAITING_REVIEW_STATUSES.has('pending_review')).toBe(true);
    expect(AWAITING_REVIEW_STATUSES.has('submitted_for_approval')).toBe(true);
    expect(AWAITING_REVIEW_STATUSES.has('approval_pending')).toBe(true);
    expect(AWAITING_REVIEW_STATUSES.has('in_review')).toBe(true);
  });

  test('does NOT contain actionable statuses', () => {
    expect(AWAITING_REVIEW_STATUSES.has('not_started')).toBe(false);
    expect(AWAITING_REVIEW_STATUSES.has('working_on_it')).toBe(false);
    expect(AWAITING_REVIEW_STATUSES.has('in_progress')).toBe(false);
    expect(AWAITING_REVIEW_STATUSES.has('stuck')).toBe(false);
  });

  test('does NOT contain terminal "done" statuses (covered by isCompletedStatus)', () => {
    expect(AWAITING_REVIEW_STATUSES.has('done')).toBe(false);
    expect(AWAITING_REVIEW_STATUSES.has('completed')).toBe(false);
  });
});

describe('NON_ACTIONABLE_APPROVAL_STATUSES', () => {
  test('treats pending_approval and approved as non-actionable', () => {
    expect(NON_ACTIONABLE_APPROVAL_STATUSES.has('pending_approval')).toBe(true);
    expect(NON_ACTIONABLE_APPROVAL_STATUSES.has('approved')).toBe(true);
  });

  test('treats changes_requested as actionable (bounced back to user)', () => {
    expect(NON_ACTIONABLE_APPROVAL_STATUSES.has('changes_requested')).toBe(false);
  });
});

// ─── isAwaitingReviewStatus ────────────────────────────────────────────────

describe('isAwaitingReviewStatus', () => {
  test('recognises waiting_for_review (real lifecycle value)', () => {
    expect(isAwaitingReviewStatus('waiting_for_review')).toBe(true);
  });

  test('recognises review / in_review / pending_review aliases', () => {
    expect(isAwaitingReviewStatus('review')).toBe(true);
    expect(isAwaitingReviewStatus('in_review')).toBe(true);
    expect(isAwaitingReviewStatus('pending_review')).toBe(true);
  });

  test('recognises submission/approval-pending aliases', () => {
    expect(isAwaitingReviewStatus('submitted_for_approval')).toBe(true);
    expect(isAwaitingReviewStatus('approval_pending')).toBe(true);
  });

  test('recognises pending_deploy (post-review release pipeline)', () => {
    expect(isAwaitingReviewStatus('pending_deploy')).toBe(true);
  });

  test('is case- and whitespace-insensitive', () => {
    expect(isAwaitingReviewStatus(' Waiting_For_Review ')).toBe(true);
    expect(isAwaitingReviewStatus('REVIEW')).toBe(true);
  });

  test('returns false for actionable / terminal / unknown statuses', () => {
    expect(isAwaitingReviewStatus('not_started')).toBe(false);
    expect(isAwaitingReviewStatus('working_on_it')).toBe(false);
    expect(isAwaitingReviewStatus('done')).toBe(false);
    expect(isAwaitingReviewStatus('stuck')).toBe(false);
    expect(isAwaitingReviewStatus('something_custom')).toBe(false);
    expect(isAwaitingReviewStatus(null)).toBe(false);
    expect(isAwaitingReviewStatus(undefined)).toBe(false);
    expect(isAwaitingReviewStatus('')).toBe(false);
  });
});

// ─── isPendingApprovalState ───────────────────────────────────────────────

describe('isPendingApprovalState', () => {
  test('true when approvalStatus = pending_approval', () => {
    expect(isPendingApprovalState({ approvalStatus: 'pending_approval' })).toBe(true);
  });

  test('true when approvalStatus = approved', () => {
    expect(isPendingApprovalState({ approvalStatus: 'approved' })).toBe(true);
  });

  test('false when approvalStatus = changes_requested (back to user)', () => {
    expect(isPendingApprovalState({ approvalStatus: 'changes_requested' })).toBe(false);
  });

  test('false when no approval workflow in flight', () => {
    expect(isPendingApprovalState({ approvalStatus: null })).toBe(false);
    expect(isPendingApprovalState({})).toBe(false);
  });

  test('handles null/undefined task safely', () => {
    expect(isPendingApprovalState(null)).toBe(false);
    expect(isPendingApprovalState(undefined)).toBe(false);
  });
});

// ─── isTaskEligibleForOverdueNotification — the master predicate ──────────

describe('isTaskEligibleForOverdueNotification', () => {
  // Each test uses an explicit baseline so the relevant flag is the only
  // variable. This makes failures point at the exact condition that broke.
  const actionable = {
    id: 't-1',
    status: 'working_on_it',
    approvalStatus: null,
    isArchived: false,
    dueDate: '2026-04-10',
  };

  test('eligible: open / in-progress task with no approval flow', () => {
    const r = isTaskEligibleForOverdueNotification(actionable);
    expect(r).toEqual({ eligible: true, reason: null });
  });

  test('eligible: stuck task (still actionable by assignee)', () => {
    const r = isTaskEligibleForOverdueNotification({ ...actionable, status: 'stuck' });
    expect(r.eligible).toBe(true);
  });

  test('eligible: changes_requested approval (bounced back to user)', () => {
    const r = isTaskEligibleForOverdueNotification({
      ...actionable, approvalStatus: 'changes_requested',
    });
    expect(r.eligible).toBe(true);
  });

  test('skip: done status', () => {
    const r = isTaskEligibleForOverdueNotification({ ...actionable, status: 'done' });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('completed_status');
  });

  test('skip: completed alias status', () => {
    const r = isTaskEligibleForOverdueNotification({ ...actionable, status: 'completed' });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('completed_status');
  });

  test('skip: waiting_for_review (canonical submitted-for-approval status)', () => {
    const r = isTaskEligibleForOverdueNotification({
      ...actionable, status: 'waiting_for_review',
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('awaiting_review_status');
  });

  test('skip: in_review status', () => {
    const r = isTaskEligibleForOverdueNotification({ ...actionable, status: 'in_review' });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('awaiting_review_status');
  });

  test('skip: pending_review status', () => {
    const r = isTaskEligibleForOverdueNotification({ ...actionable, status: 'pending_review' });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('awaiting_review_status');
  });

  test('skip: submitted_for_approval status', () => {
    const r = isTaskEligibleForOverdueNotification({
      ...actionable, status: 'submitted_for_approval',
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('awaiting_review_status');
  });

  test('skip: approvalStatus = pending_approval (status may still be working_on_it on legacy rows)', () => {
    const r = isTaskEligibleForOverdueNotification({
      ...actionable, approvalStatus: 'pending_approval',
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('awaiting_approval');
  });

  test('skip: approvalStatus = approved (chain done)', () => {
    const r = isTaskEligibleForOverdueNotification({
      ...actionable, approvalStatus: 'approved',
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('awaiting_approval');
  });

  test('skip: archived task', () => {
    const r = isTaskEligibleForOverdueNotification({ ...actionable, isArchived: true });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('archived');
  });

  test('archived reason wins over other flags (most-specific cause first)', () => {
    const r = isTaskEligibleForOverdueNotification({
      ...actionable, isArchived: true, status: 'done',
    });
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('archived');
  });

  test('handles missing task safely', () => {
    expect(isTaskEligibleForOverdueNotification(null)).toEqual({
      eligible: false, reason: 'task_missing',
    });
    expect(isTaskEligibleForOverdueNotification(undefined)).toEqual({
      eligible: false, reason: 'task_missing',
    });
  });
});
