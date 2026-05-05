'use strict';

/**
 * Unit tests for the approval lifecycle helpers.
 *
 * The helpers are pure functions returning Task patches — no mocks needed.
 * These tests lock down:
 *   - submit:    snapshot + status=Waiting for Review + progress=100
 *   - approve:   status=Done + progress=100 + group→Done + snapshot cleared
 *   - reject /
 *     request_changes: restore snapshot, or fall back to Not Started / 0
 *   - label resolution honors task statusConfig > board columns > defaults
 */

const {
  applyApprovalSubmittedState,
  applyApprovalApprovedState,
  applyApprovalRejectedState,
  applyApprovalChangesRequestedState,
  snapshotFrom,
  SNAPSHOT_KEY,
} = require('../../services/approvalLifecycleService');

const DEFAULT_BOARD = {
  id: 'board-1',
  // No columns -> falls back to global DEFAULT_STATUS_KEYS
  columns: null,
  groups: [
    { id: 'todo', title: 'To Do' },
    { id: 'in-progress', title: 'In Progress' },
    { id: 'done-group', title: 'Done' },
  ],
};

function task(overrides = {}) {
  return {
    id: 'task-1',
    status: 'working_on_it',
    progress: 40,
    groupId: 'in-progress',
    customFields: {},
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Submit
// ────────────────────────────────────────────────────────────────────────

describe('applyApprovalSubmittedState', () => {
  it('sets status to waiting_for_review and progress to 100', () => {
    const patch = applyApprovalSubmittedState(task(), DEFAULT_BOARD);
    expect(patch.status).toBe('waiting_for_review');
    expect(patch.progress).toBe(100);
  });

  it('snapshots the prior status, progress, and groupId', () => {
    const t = task({ status: 'in_progress', progress: 60, groupId: 'in-progress' });
    const patch = applyApprovalSubmittedState(t, DEFAULT_BOARD);
    const snap = patch.customFields[SNAPSHOT_KEY];
    expect(snap.status).toBe('in_progress');
    expect(snap.progress).toBe(60);
    expect(snap.groupId).toBe('in-progress');
    expect(snap.capturedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('does not move the task to a different group on submit', () => {
    const patch = applyApprovalSubmittedState(task(), DEFAULT_BOARD);
    expect(patch.groupId).toBeUndefined();
  });

  it('preserves other customFields keys', () => {
    const t = task({ customFields: { tags: ['a', 'b'], priority: 'high' } });
    const patch = applyApprovalSubmittedState(t, DEFAULT_BOARD);
    expect(patch.customFields.tags).toEqual(['a', 'b']);
    expect(patch.customFields.priority).toBe('high');
    expect(patch.customFields[SNAPSHOT_KEY]).toBeDefined();
  });

  it('falls back to current status if no review-style status is configured', () => {
    // Board with custom statusConfig that has no review/waiting variant
    const t = task({
      statusConfig: [
        { key: 'todo',     label: 'To Do' },
        { key: 'doing',    label: 'Doing' },
        { key: 'done',     label: 'Done' },
      ],
      status: 'doing',
    });
    const patch = applyApprovalSubmittedState(t, DEFAULT_BOARD);
    // Resolver returns null for "Waiting for Review" — patch keeps current status
    expect(patch.status).toBe('doing');
    expect(patch.progress).toBe(100);
  });

  it('respects custom board status labels (e.g. "In Review" alias)', () => {
    const board = {
      ...DEFAULT_BOARD,
      columns: [
        {
          type: 'status',
          statuses: [
            { key: 'in_review_custom', label: 'In Review' },
            { key: 'done',             label: 'Done' },
          ],
        },
      ],
    };
    const patch = applyApprovalSubmittedState(task(), board);
    // Falls back to "In Review" label since "Waiting for Review" not present.
    expect(patch.status).toBe('in_review_custom');
  });
});

// ────────────────────────────────────────────────────────────────────────
// Approved (final)
// ────────────────────────────────────────────────────────────────────────

describe('applyApprovalApprovedState', () => {
  it('sets status=done, progress=100, and clears snapshot', () => {
    const t = task({
      status: 'waiting_for_review',
      progress: 100,
      customFields: { [SNAPSHOT_KEY]: { status: 'working_on_it', progress: 40 } },
    });
    const patch = applyApprovalApprovedState(t, DEFAULT_BOARD);
    expect(patch.status).toBe('done');
    expect(patch.progress).toBe(100);
    expect(patch.customFields[SNAPSHOT_KEY]).toBeUndefined();
  });

  it('moves the task to the Done group', () => {
    const t = task({ status: 'waiting_for_review', groupId: 'in-progress' });
    const patch = applyApprovalApprovedState(t, DEFAULT_BOARD);
    expect(patch.groupId).toBe('done-group');
  });

  it('omits groupId when the board has no Done-style group', () => {
    const board = {
      ...DEFAULT_BOARD,
      groups: [{ id: 'g1', title: 'Active' }],
    };
    const t = task();
    const patch = applyApprovalApprovedState(t, board);
    expect(patch.groupId).toBeUndefined();
    // status / progress still flow through:
    expect(patch.status).toBe('done');
    expect(patch.progress).toBe(100);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Rejected / Request Changes (shared restore logic)
// ────────────────────────────────────────────────────────────────────────

describe('applyApprovalRejectedState / applyApprovalChangesRequestedState', () => {
  it('restores the prior snapshot exactly', () => {
    const t = task({
      status: 'waiting_for_review',
      progress: 100,
      groupId: 'in-progress',
      customFields: {
        [SNAPSHOT_KEY]: {
          status: 'in_progress',
          progress: 60,
          groupId: 'in-progress',
          capturedAt: '2026-05-05T10:00:00.000Z',
        },
      },
    });
    const patch = applyApprovalRejectedState(t, DEFAULT_BOARD);
    expect(patch.status).toBe('in_progress');
    expect(patch.progress).toBe(60);
    expect(patch.groupId).toBe('in-progress');
    expect(patch.customFields[SNAPSHOT_KEY]).toBeUndefined();
  });

  it('falls back to not_started + 0 when no snapshot exists', () => {
    const t = task({ status: 'waiting_for_review', progress: 100, customFields: {} });
    const patch = applyApprovalChangesRequestedState(t, DEFAULT_BOARD);
    expect(patch.status).toBe('not_started');
    expect(patch.progress).toBe(0);
  });

  it('moves the task to the To Do group when restoring to not_started', () => {
    const t = task({ status: 'waiting_for_review', progress: 100, customFields: {} });
    const patch = applyApprovalRejectedState(t, DEFAULT_BOARD);
    // not_started fallback → first group via STATUS_GROUP_MAP
    expect(patch.groupId).toBe('todo');
  });

  it('does not move the task to the Done group when rejected', () => {
    const t = task({ customFields: {} });
    const patch = applyApprovalRejectedState(t, DEFAULT_BOARD);
    expect(patch.groupId).not.toBe('done-group');
  });

  it('rejected and changes_requested apply identical patches', () => {
    const t = task({
      customFields: {
        [SNAPSHOT_KEY]: { status: 'stuck', progress: 25, groupId: 'in-progress' },
      },
    });
    const a = applyApprovalRejectedState(t, DEFAULT_BOARD);
    const b = applyApprovalChangesRequestedState(t, DEFAULT_BOARD);
    expect(a).toEqual(b);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Snapshot helper edges
// ────────────────────────────────────────────────────────────────────────

describe('snapshot helpers', () => {
  it('returns null when customFields is missing', () => {
    expect(snapshotFrom({ customFields: null })).toBeNull();
    expect(snapshotFrom({})).toBeNull();
  });

  it('parses stringified customFields (legacy rows)', () => {
    const t = {
      customFields: JSON.stringify({
        [SNAPSHOT_KEY]: { status: 'stuck', progress: 30 },
      }),
    };
    expect(snapshotFrom(t)).toEqual({ status: 'stuck', progress: 30 });
  });

  it('survives malformed customFields strings without throwing', () => {
    const t = { customFields: '{not json' };
    expect(snapshotFrom(t)).toBeNull();
  });
});
