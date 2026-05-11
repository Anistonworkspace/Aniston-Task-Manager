'use strict';

/**
 * Tests for the priority escalation cron tick (`runPriorityEscalation`).
 *
 * Verifies:
 *  - Uses central `notificationService.createNotification` (not raw insert).
 *  - Stable idempotency key per (taskId, userId, day) — running the cron
 *    twice produces identical keys (the partial unique index then
 *    collapses the second insert in the real DB; here we assert the
 *    key shape itself).
 *  - Eligibility: skips done, waiting_for_review, in_review,
 *    submitted_for_approval, approvalStatus = pending_approval/approved,
 *    archived.
 *  - Multi-assignee fan-out via `getTaskNotificationRecipients`.
 *  - Conditional UPDATE: a row that races and fails to flip → no notify.
 */

process.env.LOG_LEVEL = 'error';

const mockTaskFindAll = jest.fn();
const mockTaskUpdate = jest.fn();
const mockCreateNotification = jest.fn();
const mockGetRecipients = jest.fn();
const mockLogActivity = jest.fn();

jest.mock('../../models', () => ({
  Task: {
    findAll: (...a) => mockTaskFindAll(...a),
    update: (...a) => mockTaskUpdate(...a),
  },
}));

jest.mock('../../services/notificationService', () => {
  const actual = jest.requireActual('../../services/notificationService');
  return {
    buildIdempotencyKey: actual.buildIdempotencyKey,
    createNotification: (...a) => mockCreateNotification(...a),
  };
});

jest.mock('../../utils/taskNotificationRecipients', () => ({
  getTaskNotificationRecipients: (...a) => mockGetRecipients(...a),
}));

jest.mock('../../services/activityService', () => ({
  logActivity: (...a) => mockLogActivity(...a),
}));

const { runPriorityEscalation } = require('../../jobs/priorityEscalationJob');
const { buildIdempotencyKey } = require('../../services/notificationService');

function buildTask(overrides = {}) {
  return {
    id: overrides.id || 't-1',
    title: overrides.title || 'Important task',
    status: overrides.status ?? 'working_on_it',
    approvalStatus: overrides.approvalStatus ?? null,
    isArchived: overrides.isArchived ?? false,
    priority: overrides.priority ?? 'high',
    progress: overrides.progress ?? 85,
    boardId: overrides.boardId || 'b-1',
    assignedTo: overrides.assignedTo || 'u-assignee',
    createdBy: overrides.createdBy || 'u-creator',
    ...overrides,
  };
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

beforeEach(() => {
  mockTaskFindAll.mockReset();
  mockTaskUpdate.mockReset();
  mockCreateNotification.mockReset();
  mockGetRecipients.mockReset();
  mockLogActivity.mockReset();

  // Default: conditional UPDATE succeeds (affected=1).
  mockTaskUpdate.mockResolvedValue([1]);
  // Default: createNotification returns a fake row.
  mockCreateNotification.mockImplementation(({ idempotencyKey }) =>
    Promise.resolve({ id: 'n-' + (idempotencyKey || 'x') })
  );
  // Default: single legacy assignee.
  mockGetRecipients.mockImplementation(async (task) =>
    new Map([[task.assignedTo, { id: task.assignedTo, name: 'Assignee' }]])
  );
});

describe('runPriorityEscalation — central service migration', () => {
  it('calls notificationService.createNotification (not raw Notification.create)', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask()]);
    await runPriorityEscalation();
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith(expect.objectContaining({
      type: 'priority_change',
      entityType: 'task',
      entityId: 't-1',
    }));
  });

  it('uses stable per-day idempotency key — two runs same day produce same key', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask()]);
    await runPriorityEscalation();
    await runPriorityEscalation();
    const k1 = mockCreateNotification.mock.calls[0][0].idempotencyKey;
    const k2 = mockCreateNotification.mock.calls[1][0].idempotencyKey;
    expect(k1).toBe(k2);
    expect(k1).toBe(buildIdempotencyKey('priority-escalated', 't-1', 'u-assignee', todayISO()));
  });
});

describe('runPriorityEscalation — eligibility gate', () => {
  // SQL filter would normally exclude these rows; we drive findAll directly
  // to test the defence-in-depth JS check.
  it('skips status=done', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask({ status: 'done' })]);
    await runPriorityEscalation();
    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockTaskUpdate).not.toHaveBeenCalled();
  });

  it('skips status=waiting_for_review', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask({ status: 'waiting_for_review' })]);
    await runPriorityEscalation();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('skips status=in_review', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask({ status: 'in_review' })]);
    await runPriorityEscalation();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('skips status=submitted_for_approval', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask({ status: 'submitted_for_approval' })]);
    await runPriorityEscalation();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('skips approvalStatus=pending_approval', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask({ approvalStatus: 'pending_approval' })]);
    await runPriorityEscalation();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('skips approvalStatus=approved', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask({ approvalStatus: 'approved' })]);
    await runPriorityEscalation();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('skips archived tasks', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask({ isArchived: true })]);
    await runPriorityEscalation();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('DOES notify when approvalStatus=changes_requested (bounced back to user)', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask({ approvalStatus: 'changes_requested' })]);
    await runPriorityEscalation();
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
  });
});

describe('runPriorityEscalation — multi-assignee fan-out', () => {
  it('notifies every recipient returned by getTaskNotificationRecipients', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask()]);
    mockGetRecipients.mockResolvedValueOnce(new Map([
      ['u-1', { id: 'u-1', name: 'A' }],
      ['u-2', { id: 'u-2', name: 'B' }],
      ['u-3', { id: 'u-3', name: 'C' }],
    ]));
    await runPriorityEscalation();
    expect(mockCreateNotification).toHaveBeenCalledTimes(3);
    // Each gets a distinct per-user idempotency key.
    const keys = mockCreateNotification.mock.calls.map(c => c[0].idempotencyKey);
    expect(new Set(keys).size).toBe(3);
    const userIds = mockCreateNotification.mock.calls.map(c => c[0].userId).sort();
    expect(userIds).toEqual(['u-1', 'u-2', 'u-3']);
  });

  it('still flips priority + logs activity even when recipients map is empty', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask()]);
    mockGetRecipients.mockResolvedValueOnce(new Map());
    await runPriorityEscalation();
    // Priority flip happens regardless — the task itself was escalated even
    // if no notification could be sent (no one to notify).
    expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('does not flip priority again on a row that already raced to critical (affected=0)', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask()]);
    mockTaskUpdate.mockResolvedValueOnce([0]); // someone else flipped first
    await runPriorityEscalation();
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});

describe('runPriorityEscalation — per-task isolation', () => {
  it('one bad task does not abort the batch', async () => {
    mockTaskFindAll.mockResolvedValue([
      buildTask({ id: 't-good-1' }),
      buildTask({ id: 't-bad' }),
      buildTask({ id: 't-good-2' }),
    ]);
    // The middle task throws on its conditional UPDATE call.
    mockTaskUpdate
      .mockResolvedValueOnce([1])
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([1]);
    await runPriorityEscalation();
    // 2 successful tasks → 2 notifications (one recipient each by default).
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
  });
});
