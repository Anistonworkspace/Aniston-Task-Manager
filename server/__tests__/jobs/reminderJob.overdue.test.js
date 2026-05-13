'use strict';

/**
 * Tests for the overdue / due-soon / 3-day cron handlers.
 *
 * Goal: verify the eligibility gate — a task that is done, archived,
 * submitted for review, or in pending approval MUST NOT produce an overdue
 * notification, while a genuinely-open overdue task still does. Also covers
 * idempotency: invoking the same cron twice on the same calendar day must
 * not create a second notification row for the same (taskId, userId).
 *
 * The Task model + notificationService are mocked so the test runs without
 * Postgres or socket.io.
 */

// Quiet down winston file transports in test runs — the helper logger has a
// `combined.log` file transport, and we don't want test output writing to
// disk. The logger module is required transitively; setting LOG_LEVEL='error'
// is the lightest-touch fix that doesn't break the real production config.
process.env.LOG_LEVEL = 'error';

const mockTaskFindAll = jest.fn();
const mockCreateNotification = jest.fn();
const mockGetRecipients = jest.fn();

jest.mock('../../models', () => ({
  Task: {
    findAll: (...a) => mockTaskFindAll(...a),
  },
  // The other models are referenced only in `include:` clauses; the mocked
  // findAll never actually runs those joins, so plain empty objects suffice.
  User: {},
  Board: {},
  TaskAssignee: {},
}));

jest.mock('../../services/notificationService', () => {
  const actual = jest.requireActual('../../services/notificationService');
  return {
    // buildIdempotencyKey is pure and used by both the SUT and assertions —
    // keep the real implementation so test expectations match call sites.
    buildIdempotencyKey: actual.buildIdempotencyKey,
    createNotification: (...a) => mockCreateNotification(...a),
  };
});

// Mock the recipients helper so each task's notification fan-out is driven
// directly from the test fixture (`task.assignee`) without wiring up
// TaskAssignee + User model mocks. The helper itself has its own unit test
// in __tests__/utils/taskNotificationRecipients.test.js.
jest.mock('../../utils/taskNotificationRecipients', () => ({
  getTaskNotificationRecipients: (...a) => mockGetRecipients(...a),
}));

const { checkOverdue, checkDueSoon, checkDueIn3Days } = require('../../jobs/reminderJob');
const { buildIdempotencyKey } = require('../../services/notificationService');

// ─── Helpers ───────────────────────────────────────────────────────────────

function buildTask(overrides = {}) {
  return {
    id: overrides.id || 't-1',
    title: overrides.title || 'Test task',
    status: overrides.status ?? 'working_on_it',
    approvalStatus: overrides.approvalStatus ?? null,
    isArchived: overrides.isArchived ?? false,
    boardId: overrides.boardId || 'b-1',
    dueDate: overrides.dueDate || '2020-01-01', // overdue by default
    assignedTo: overrides.assignedTo || 'u-assignee',
    assignee: overrides.assignee || { id: 'u-assignee', name: 'Assignee' },
    creator: overrides.creator ?? null,
    board: overrides.board || { id: 'b-1', name: 'Board' },
    ...overrides,
  };
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

beforeEach(() => {
  mockTaskFindAll.mockReset();
  mockCreateNotification.mockReset();
  mockGetRecipients.mockReset();
  // Default: createNotification "succeeds" and returns a fake row.
  mockCreateNotification.mockImplementation(({ idempotencyKey }) =>
    Promise.resolve({ id: 'notif-' + (idempotencyKey || 'x') })
  );
  // Default: recipients = the single legacy assignee on the task fixture.
  // Individual tests override for multi-assignee scenarios.
  mockGetRecipients.mockImplementation(async (task) => {
    const m = new Map();
    if (task?.assignee) m.set(task.assignee.id, task.assignee);
    else if (task?.assignedTo) m.set(task.assignedTo, { id: task.assignedTo, name: 'X' });
    return m;
  });
});

// ─── checkOverdue ──────────────────────────────────────────────────────────

describe('checkOverdue — eligibility gate', () => {
  it('sends overdue notification for an open, in-progress overdue task', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask({ status: 'working_on_it' })]);
    await checkOverdue();
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u-assignee',
      type: 'task_updated',
      entityType: 'task',
      entityId: 't-1',
      idempotencyKey: buildIdempotencyKey('overdue', 't-1', 'u-assignee', todayISO()),
    }));
  });

  it('does NOT send overdue notification when status = done', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask({ status: 'done' })]);
    await checkOverdue();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('does NOT send overdue notification when status = waiting_for_review', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask({ status: 'waiting_for_review' })]);
    await checkOverdue();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('does NOT send overdue notification when status = in_review', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask({ status: 'in_review' })]);
    await checkOverdue();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('does NOT send overdue notification when status = submitted_for_approval', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask({ status: 'submitted_for_approval' })]);
    await checkOverdue();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('does NOT send overdue notification when approvalStatus = pending_approval', async () => {
    mockTaskFindAll.mockResolvedValue([
      // Defence-in-depth: even if SQL pre-filter is bypassed (e.g. row drift)
      // the per-task helper must reject this row.
      buildTask({ status: 'working_on_it', approvalStatus: 'pending_approval' }),
    ]);
    await checkOverdue();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('does NOT send overdue notification when approvalStatus = approved', async () => {
    mockTaskFindAll.mockResolvedValue([
      buildTask({ status: 'working_on_it', approvalStatus: 'approved' }),
    ]);
    await checkOverdue();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('does NOT send overdue notification when isArchived', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask({ isArchived: true })]);
    await checkOverdue();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('DOES send overdue notification when approvalStatus = changes_requested', async () => {
    // Reviewer bounced the task back — user is the actionable party again,
    // overdue reminders should resume firing.
    mockTaskFindAll.mockResolvedValue([
      buildTask({ status: 'working_on_it', approvalStatus: 'changes_requested' }),
    ]);
    await checkOverdue();
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
  });

  it('also notifies creator when different from assignee, with separate idempotency key', async () => {
    mockTaskFindAll.mockResolvedValue([
      buildTask({ creator: { id: 'u-creator', name: 'Creator' } }),
    ]);
    await checkOverdue();
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
    expect(mockCreateNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u-assignee',
      idempotencyKey: buildIdempotencyKey('overdue', 't-1', 'u-assignee', todayISO()),
    }));
    expect(mockCreateNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u-creator',
      idempotencyKey: buildIdempotencyKey('overdue', 't-1', 'u-creator', todayISO()),
    }));
  });

  it('does NOT notify creator twice when creator === assignee', async () => {
    mockTaskFindAll.mockResolvedValue([
      buildTask({ creator: { id: 'u-assignee', name: 'Same user' } }),
    ]);
    await checkOverdue();
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
  });

  it('isolates per-task failure — one bad row does not abort the batch', async () => {
    mockTaskFindAll.mockResolvedValue([
      buildTask({ id: 't-good-1' }),
      buildTask({ id: 't-bad' }),
      buildTask({ id: 't-good-2' }),
    ]);
    mockCreateNotification.mockImplementationOnce(() => Promise.resolve({ id: 'n-1' }));
    mockCreateNotification.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    mockCreateNotification.mockImplementationOnce(() => Promise.resolve({ id: 'n-3' }));
    await checkOverdue();
    expect(mockCreateNotification).toHaveBeenCalledTimes(3);
  });

  it('uses stable per-day idempotency key — running the cron twice does not duplicate', async () => {
    // First tick: createNotification returns a row. Second tick: the real
    // service would short-circuit on the partial unique index; we mimic it
    // by returning the SAME row id both times. The assertion is that BOTH
    // ticks compute the SAME idempotency key — the DB layer is what
    // actually prevents the duplicate row, and we have a separate test
    // proving the service uses that index (notificationService.test.js).
    mockTaskFindAll.mockResolvedValue([buildTask()]);
    await checkOverdue();
    await checkOverdue();
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
    const firstKey = mockCreateNotification.mock.calls[0][0].idempotencyKey;
    const secondKey = mockCreateNotification.mock.calls[1][0].idempotencyKey;
    expect(firstKey).toBe(secondKey);
    expect(firstKey).toBe(buildIdempotencyKey('overdue', 't-1', 'u-assignee', todayISO()));
  });
});

// ─── checkDueSoon ─────────────────────────────────────────────────────────

describe('checkDueSoon — eligibility gate', () => {
  it('sends due-soon for an open task due today', async () => {
    const today = todayISO();
    mockTaskFindAll.mockResolvedValue([
      buildTask({ id: 't-soon', dueDate: today, status: 'working_on_it' }),
    ]);
    await checkDueSoon();
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith(expect.objectContaining({
      type: 'due_date',
      idempotencyKey: buildIdempotencyKey('due-soon', 't-soon', 'u-assignee', today),
    }));
  });

  it('does NOT send due-soon when task is already waiting for review', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask({
      id: 't-rev', dueDate: todayISO(), status: 'waiting_for_review',
    })]);
    await checkDueSoon();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('does NOT send due-soon when approvalStatus = pending_approval', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask({
      dueDate: todayISO(), status: 'working_on_it', approvalStatus: 'pending_approval',
    })]);
    await checkDueSoon();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});

// ─── checkDueIn3Days ──────────────────────────────────────────────────────

describe('checkDueIn3Days — eligibility gate', () => {
  it('sends 3-day reminder for an open task', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask({ id: 't-3', status: 'in_progress' })]);
    await checkDueIn3Days();
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith(expect.objectContaining({
      type: 'due_date',
      idempotencyKey: buildIdempotencyKey('due-3day', 't-3', 'u-assignee', todayISO()),
    }));
  });

  it('does NOT send 3-day reminder when task is done', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask({ status: 'done' })]);
    await checkDueIn3Days();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('does NOT send 3-day reminder when task is archived', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask({ isArchived: true })]);
    await checkDueIn3Days();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});

// ─── Multi-assignee fan-out ────────────────────────────────────────────────

describe('reminderJob — multi-assignee fan-out', () => {
  it('checkOverdue notifies every recipient returned by getTaskNotificationRecipients', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask()]);
    mockGetRecipients.mockResolvedValueOnce(new Map([
      ['u-1', { id: 'u-1', name: 'A', email: 'a@x' }],
      ['u-2', { id: 'u-2', name: 'B', email: 'b@x' }],
      ['u-3', { id: 'u-3', name: 'C', email: 'c@x' }],
    ]));
    await checkOverdue();
    expect(mockCreateNotification).toHaveBeenCalledTimes(3);
    const ids = mockCreateNotification.mock.calls.map(c => c[0].userId).sort();
    expect(ids).toEqual(['u-1', 'u-2', 'u-3']);
    // Each recipient gets a distinct (taskId, userId, day) idempotency key.
    const keys = mockCreateNotification.mock.calls.map(c => c[0].idempotencyKey);
    expect(new Set(keys).size).toBe(3);
  });

  it('checkDueSoon notifies every recipient', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask({ dueDate: todayISO() })]);
    mockGetRecipients.mockResolvedValueOnce(new Map([
      ['u-1', { id: 'u-1' }],
      ['u-2', { id: 'u-2' }],
    ]));
    await checkDueSoon();
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
  });

  it('checkDueIn3Days notifies every recipient', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask()]);
    mockGetRecipients.mockResolvedValueOnce(new Map([
      ['u-1', { id: 'u-1' }],
      ['u-2', { id: 'u-2' }],
    ]));
    await checkDueIn3Days();
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
  });

  it('checkOverdue: zero recipients → no notifications, no creator fallback', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask({
      creator: { id: 'u-creator', name: 'Creator' },
    })]);
    mockGetRecipients.mockResolvedValueOnce(new Map());
    await checkOverdue();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('checkOverdue: creator already in recipients → not double-notified', async () => {
    mockTaskFindAll.mockResolvedValue([buildTask({
      assignedTo: 'u-creator',
      creator: { id: 'u-creator', name: 'Creator' },
    })]);
    mockGetRecipients.mockResolvedValueOnce(new Map([
      ['u-creator', { id: 'u-creator', name: 'Creator' }],
    ]));
    await checkOverdue();
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification.mock.calls[0][0].userId).toBe('u-creator');
  });
});

// ─── Phase 5: per-user notification cap ─────────────────────────────────
// Storm-prevention regression: an unlucky user with many overdue tasks
// used to get one notification per task in a single tick. The cap
// (default 5) collapses the rest into "deferred until next tick" — the
// idempotency-keyed insert guarantees no duplicate when the next tick
// reconsiders the same row.

describe('checkOverdue — Phase 5 per-user cap', () => {
  it('caps notifications per user per tick to MAX_NOTIFICATIONS_PER_USER_PER_RUN', async () => {
    const { MAX_NOTIFICATIONS_PER_USER_PER_RUN } = require('../../config/notificationLimits');
    // 10 overdue tasks, all assigned to the same user.
    const tasks = [];
    for (let i = 0; i < 10; i += 1) {
      tasks.push(buildTask({ id: `t-${i}`, assignedTo: 'over-user',
        assignee: { id: 'over-user', name: 'Over' } }));
    }
    mockTaskFindAll.mockResolvedValue(tasks);

    await checkOverdue();

    // Only MAX_NOTIFICATIONS_PER_USER_PER_RUN are emitted; the rest are
    // deferred to the next tick (idempotency keeps them de-duped).
    expect(mockCreateNotification).toHaveBeenCalledTimes(MAX_NOTIFICATIONS_PER_USER_PER_RUN);
  });

  it('respects per-user cap independently across distinct users', async () => {
    const { MAX_NOTIFICATIONS_PER_USER_PER_RUN } = require('../../config/notificationLimits');
    // Two different users, MAX*2 tasks total. Each user should be capped
    // separately — total notifications = MAX*2.
    const tasks = [];
    for (let i = 0; i < MAX_NOTIFICATIONS_PER_USER_PER_RUN * 2; i += 1) {
      const uid = i % 2 === 0 ? 'user-a' : 'user-b';
      tasks.push(buildTask({
        id: `t-${i}`, assignedTo: uid, assignee: { id: uid, name: uid },
      }));
    }
    mockTaskFindAll.mockResolvedValue(tasks);

    await checkOverdue();

    expect(mockCreateNotification).toHaveBeenCalledTimes(MAX_NOTIFICATIONS_PER_USER_PER_RUN * 2);
    const a = mockCreateNotification.mock.calls.filter(c => c[0].userId === 'user-a').length;
    const b = mockCreateNotification.mock.calls.filter(c => c[0].userId === 'user-b').length;
    expect(a).toBe(MAX_NOTIFICATIONS_PER_USER_PER_RUN);
    expect(b).toBe(MAX_NOTIFICATIONS_PER_USER_PER_RUN);
  });
});

// ─── Mixed batch — sanity check the loop continues correctly ───────────────

describe('checkOverdue — mixed batch', () => {
  it('skips ineligible rows, sends for eligible ones, all within one cron tick', async () => {
    mockTaskFindAll.mockResolvedValue([
      buildTask({ id: 't-1', status: 'working_on_it' }),                            // send
      buildTask({ id: 't-2', status: 'done' }),                                     // skip
      buildTask({ id: 't-3', status: 'waiting_for_review' }),                       // skip
      buildTask({ id: 't-4', status: 'working_on_it', approvalStatus: 'approved' }),// skip
      buildTask({ id: 't-5', status: 'stuck' }),                                    // send
      buildTask({ id: 't-6', isArchived: true, status: 'working_on_it' }),          // skip
    ]);
    await checkOverdue();
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
    const sentTaskIds = mockCreateNotification.mock.calls.map(c => c[0].entityId);
    expect(sentTaskIds.sort()).toEqual(['t-1', 't-5']);
  });
});
