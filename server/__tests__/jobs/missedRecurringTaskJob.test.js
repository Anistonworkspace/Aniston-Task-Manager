'use strict';

/**
 * Tests for the missed recurring task escalation cron.
 *
 * The job:
 *   - Loads candidate Tasks (isRecurringInstance, missedEscalationSent=false,
 *     status not 'done', occurrenceDate in the past).
 *   - Filters out templates without escalateIfMissed.
 *   - Performs a conditional UPDATE to "claim" the row exactly once across
 *     replicas — only on a non-zero affected count does it actually notify.
 *   - Sends one notification per recipient (assignee / managers / admins).
 *   - Per-row errors don't abort the loop.
 */

process.env.LOG_LEVEL = 'error';

const mockTaskFindAll = jest.fn();
const mockTaskUpdate = jest.fn();
const mockUserFindByPk = jest.fn();
const mockUserFindOne = jest.fn();
const mockUserFindAll = jest.fn();
const mockMgrFindAll = jest.fn();
const mockSendNotification = jest.fn();
const mockDueAtUtc = jest.fn();

jest.mock('../../models', () => ({
  Task: {
    findAll: (...a) => mockTaskFindAll(...a),
    update: (...a) => mockTaskUpdate(...a),
  },
  RecurringTaskTemplate: {},
  User: {
    findByPk: (...a) => mockUserFindByPk(...a),
    findOne: (...a) => mockUserFindOne(...a),
    findAll: (...a) => mockUserFindAll(...a),
  },
  ManagerRelation: { findAll: (...a) => mockMgrFindAll(...a) },
}));

jest.mock('../../services/notificationService', () => ({
  sendNotification: (...a) => mockSendNotification(...a),
}));

jest.mock('../../services/recurringTaskService', () => ({
  dueAtUtc: (...a) => mockDueAtUtc(...a),
  parseDueTime: jest.fn(() => '18:00'),
}));

jest.mock('node-cron', () => ({ schedule: jest.fn() }));

jest.mock('../../jobs/cronLock', () => ({
  withCronLock: jest.fn(async (_name, fn) => fn()),
}));

jest.mock('../../utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { _tickOnce: tickOnce } = require('../../jobs/missedRecurringTaskJob');

function makeMissedTask(overrides = {}) {
  return {
    id: overrides.id || 'task-instance-1',
    isRecurringInstance: true,
    missedEscalationSent: false,
    status: 'working_on_it',
    isArchived: false,
    occurrenceDate: overrides.occurrenceDate || '2026-04-01',
    recurringTemplateId: 'tpl-1',
    boardId: 'b-1',
    groupId: 'g-1',
    assignedTo: overrides.assignedTo || 'u-assignee',
    recurringTemplate: overrides.recurringTemplate || {
      id: 'tpl-1',
      title: 'Daily standup',
      dueTime: '18:00',
      timezone: 'UTC',
      escalateIfMissed: true,
      escalationTargets: ['assignee'],
    },
    ...overrides,
  };
}

beforeEach(() => {
  mockTaskFindAll.mockReset();
  mockTaskUpdate.mockReset();
  mockUserFindByPk.mockReset();
  mockUserFindOne.mockReset();
  mockUserFindAll.mockReset();
  mockMgrFindAll.mockReset();
  mockSendNotification.mockReset();
  mockDueAtUtc.mockReset();

  // Default: claim succeeds (affected=1).
  mockTaskUpdate.mockResolvedValue([1]);
  // Default: dueAt is in the past (so escalation should run).
  mockDueAtUtc.mockReturnValue(new Date(0));
  // Default: no extra managers / admins.
  mockUserFindByPk.mockResolvedValue(null);
  mockMgrFindAll.mockResolvedValue([]);
  mockUserFindAll.mockResolvedValue([]);
  mockSendNotification.mockResolvedValue(true);
});

describe('missedRecurringTaskJob.tickOnce — happy path', () => {
  it('returns zero counters when there are no candidates', async () => {
    mockTaskFindAll.mockResolvedValueOnce([]);
    const r = await tickOnce(new Date());
    expect(r).toEqual({ processed: 0, escalated: 0, skipped: 0, errors: 0 });
    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it('escalates a missed task and sends one notification per recipient (assignee)', async () => {
    const task = makeMissedTask();
    mockTaskFindAll.mockResolvedValueOnce([task]);

    const r = await tickOnce(new Date());

    expect(r.escalated).toBe(1);
    expect(r.processed).toBe(1);
    expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
    // The conditional claim — flag flip is the lock.
    expect(mockTaskUpdate.mock.calls[0][0]).toEqual(expect.objectContaining({
      missedEscalationSent: true,
    }));
    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    expect(mockSendNotification.mock.calls[0][0]).toBe('u-assignee');
  });
});

describe('missedRecurringTaskJob.tickOnce — eligibility gates', () => {
  it('skips when the template has escalateIfMissed=false', async () => {
    const task = makeMissedTask({
      recurringTemplate: {
        id: 'tpl-1', title: 't', dueTime: '18:00', timezone: 'UTC',
        escalateIfMissed: false, escalationTargets: ['assignee'],
      },
    });
    mockTaskFindAll.mockResolvedValueOnce([task]);

    const r = await tickOnce(new Date());
    expect(r.escalated).toBe(0);
    expect(r.skipped).toBe(1);
    expect(mockSendNotification).not.toHaveBeenCalled();
    expect(mockTaskUpdate).not.toHaveBeenCalled();
  });

  it('skips when the template was deleted (FK SET NULL)', async () => {
    const task = makeMissedTask({ recurringTemplate: null });
    mockTaskFindAll.mockResolvedValueOnce([task]);

    const r = await tickOnce(new Date());
    expect(r.skipped).toBe(1);
    expect(r.escalated).toBe(0);
  });

  it('skips when the computed dueAt is still in the future', async () => {
    const task = makeMissedTask();
    mockTaskFindAll.mockResolvedValueOnce([task]);
    // Override: dueAt is one hour ahead of "now"
    mockDueAtUtc.mockReturnValueOnce(new Date(Date.now() + 60 * 60 * 1000));

    const r = await tickOnce(new Date());
    expect(r.skipped).toBe(1);
    expect(mockSendNotification).not.toHaveBeenCalled();
  });
});

describe('missedRecurringTaskJob.tickOnce — claim race', () => {
  it('does NOT notify when the conditional UPDATE returns affected=0 (claim lost)', async () => {
    const task = makeMissedTask();
    mockTaskFindAll.mockResolvedValueOnce([task]);
    mockTaskUpdate.mockResolvedValueOnce([0]); // another replica already claimed

    const r = await tickOnce(new Date());
    expect(r.escalated).toBe(0);
    expect(r.skipped).toBe(1);
    expect(mockSendNotification).not.toHaveBeenCalled();
  });
});

describe('missedRecurringTaskJob.tickOnce — per-row isolation', () => {
  it('errors on one row do not abort the rest of the batch', async () => {
    const t1 = makeMissedTask({ id: 'good-1' });
    const t2 = makeMissedTask({ id: 'bad' });
    const t3 = makeMissedTask({ id: 'good-2' });
    mockTaskFindAll.mockResolvedValueOnce([t1, t2, t3]);

    // Middle claim throws
    mockTaskUpdate
      .mockResolvedValueOnce([1])
      .mockRejectedValueOnce(new Error('db blip'))
      .mockResolvedValueOnce([1]);

    const r = await tickOnce(new Date());
    // 2 good rows escalate, 1 errors
    expect(r.escalated).toBe(2);
    expect(r.errors).toBe(1);
    expect(mockSendNotification).toHaveBeenCalledTimes(2);
  });
});

describe('missedRecurringTaskJob.tickOnce — query shape', () => {
  it('filters by isRecurringInstance, missedEscalationSent=false, not archived', async () => {
    mockTaskFindAll.mockResolvedValueOnce([]);
    await tickOnce(new Date());
    const opts = mockTaskFindAll.mock.calls[0][0];
    expect(opts.where.isRecurringInstance).toBe(true);
    expect(opts.where.missedEscalationSent).toBe(false);
    expect(opts.where.isArchived).toBe(false);
    expect(opts.where.recurringTemplateId).toBeDefined();
    expect(opts.limit).toBe(500);
  });
});
