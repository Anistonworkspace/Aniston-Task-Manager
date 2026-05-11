'use strict';

/**
 * Tests for the deadline-reminder cron + the underlying
 * reminderService.processReminders pipeline.
 *
 * Coverage:
 *   - Cron wrapper is scheduled every 15 minutes and wrapped in withCronLock.
 *   - processReminders finds TaskReminder rows with scheduledFor <= now AND
 *     sentAt IS NULL AND NOT cancelled.
 *   - Each due reminder triggers ONE notification per recipient (here we
 *     verify the assignee path) and marks sentAt via the conditional UPDATE.
 *   - When the underlying Task no longer exists, the reminder is cancelled.
 *   - When the task is no longer eligible (e.g. status=done), the reminder is
 *     cancelled instead of fired.
 *   - On per-row failure, the loop continues with the rest.
 *
 * We mock the (lazy-required) models layer + the notificationService so no
 * real DB or socket I/O is exercised.
 */

process.env.LOG_LEVEL = 'error';

const mockTaskReminderFindAll = jest.fn();
const mockTaskReminderUpdate = jest.fn();
const mockTaskFindByPk = jest.fn();
const mockTaskAssigneeFindAll = jest.fn();
const mockUserFindByPk = jest.fn();
const mockSendNotification = jest.fn();
const mockIsEligible = jest.fn();

jest.mock('../../models', () => ({
  TaskReminder: {
    findAll: (...a) => mockTaskReminderFindAll(...a),
    update: (...a) => mockTaskReminderUpdate(...a),
  },
  Task: { findByPk: (...a) => mockTaskFindByPk(...a) },
  Board: {},
  TaskAssignee: { findAll: (...a) => mockTaskAssigneeFindAll(...a) },
  User: { findByPk: (...a) => mockUserFindByPk(...a) },
}));

jest.mock('../../config/db', () => ({ sequelize: {} }));

jest.mock('../../services/notificationService', () => ({
  sendNotification: (...a) => mockSendNotification(...a),
}));

jest.mock('../../utils/taskOverdueEligibility', () => ({
  isTaskEligibleForOverdueNotification: (...a) => mockIsEligible(...a),
}));

jest.mock('node-cron', () => ({ schedule: jest.fn() }));

jest.mock('../../jobs/cronLock', () => ({
  withCronLock: jest.fn(async (_name, fn) => fn()),
}));

jest.mock('../../utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const cron = require('node-cron');
const { withCronLock } = require('../../jobs/cronLock');
const { processReminders } = require('../../services/reminderService');
const { startDeadlineReminderJob } = require('../../jobs/deadlineReminderJob');

// ─── Helpers ─────────────────────────────────────────────────────────────

function makeReminder(overrides = {}) {
  const update = jest.fn().mockResolvedValue(true);
  return {
    id: overrides.id || 'rem-1',
    taskId: overrides.taskId || 't-1',
    reminderType: overrides.reminderType || 'custom',
    scheduledFor: overrides.scheduledFor || new Date(Date.now() - 1000),
    sentAt: null,
    cancelled: false,
    update,
    ...overrides,
  };
}

function makeTask(overrides = {}) {
  return {
    id: overrides.id || 't-1',
    title: overrides.title || 'Task',
    status: overrides.status ?? 'working_on_it',
    approvalStatus: null,
    isArchived: false,
    dueDate: '2026-04-10',
    assignedTo: overrides.assignedTo || 'u-1',
    board: overrides.board || { id: 'b-1', name: 'Board' },
    ...overrides,
  };
}

beforeEach(() => {
  mockTaskReminderFindAll.mockReset();
  mockTaskReminderUpdate.mockReset();
  mockTaskFindByPk.mockReset();
  mockTaskAssigneeFindAll.mockReset();
  mockUserFindByPk.mockReset();
  mockSendNotification.mockReset();
  mockIsEligible.mockReset();
  cron.schedule.mockReset();
  withCronLock.mockClear();

  // Defaults: claim succeeds, task is eligible, no TaskAssignee rows, send ok.
  mockTaskReminderUpdate.mockResolvedValue([1]);
  mockIsEligible.mockReturnValue({ eligible: true });
  mockTaskAssigneeFindAll.mockResolvedValue([]);
  mockSendNotification.mockResolvedValue(true);
  mockUserFindByPk.mockResolvedValue({ id: 'u-1', name: 'Assignee', email: 'a@x.test' });
});

// ─── Cron wrapper ────────────────────────────────────────────────────────

describe('startDeadlineReminderJob', () => {
  it('schedules every 15 minutes and wraps work in withCronLock', async () => {
    startDeadlineReminderJob();
    expect(cron.schedule).toHaveBeenCalledTimes(1);
    expect(cron.schedule.mock.calls[0][0]).toBe('*/15 * * * *');

    // Avoid the real processReminders inside the cron tick — drive it once
    // and check that withCronLock was called with the correct key.
    mockTaskReminderFindAll.mockResolvedValueOnce([]);
    await cron.schedule.mock.calls[0][1]();
    expect(withCronLock).toHaveBeenCalledWith('deadlineReminderJob', expect.any(Function));
  });
});

// ─── processReminders pipeline ──────────────────────────────────────────

describe('processReminders — empty queue', () => {
  it('returns silently when there are no due reminders', async () => {
    mockTaskReminderFindAll.mockResolvedValueOnce([]);
    await processReminders();
    expect(mockTaskFindByPk).not.toHaveBeenCalled();
    expect(mockSendNotification).not.toHaveBeenCalled();
  });
});

describe('processReminders — happy path', () => {
  it('sends a notification per recipient and marks sentAt via conditional UPDATE', async () => {
    const reminder = makeReminder();
    const task = makeTask();
    mockTaskReminderFindAll.mockResolvedValueOnce([reminder]);
    mockTaskFindByPk.mockResolvedValueOnce(task);

    await processReminders();

    // Claim flip: TaskReminder.update was called with sentAt: <Date>
    const claimCall = mockTaskReminderUpdate.mock.calls.find(
      (c) => c[0] && c[0].sentAt instanceof Date
    );
    expect(claimCall).toBeDefined();
    expect(claimCall[1].where).toMatchObject({
      id: reminder.id,
      sentAt: null,
      cancelled: false,
    });

    // One notification fired
    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    expect(mockSendNotification.mock.calls[0][0]).toBe('u-1');
  });
});

describe('processReminders — task deleted', () => {
  it('cancels the reminder when the underlying Task is gone', async () => {
    const reminder = makeReminder();
    mockTaskReminderFindAll.mockResolvedValueOnce([reminder]);
    mockTaskFindByPk.mockResolvedValueOnce(null);

    await processReminders();

    expect(reminder.update).toHaveBeenCalledWith({ cancelled: true });
    expect(mockSendNotification).not.toHaveBeenCalled();
  });
});

describe('processReminders — ineligible task', () => {
  it('cancels the reminder when the task is no longer eligible (e.g. status=done)', async () => {
    const reminder = makeReminder();
    const task = makeTask({ status: 'done' });
    mockTaskReminderFindAll.mockResolvedValueOnce([reminder]);
    mockTaskFindByPk.mockResolvedValueOnce(task);
    mockIsEligible.mockReturnValueOnce({ eligible: false, reason: 'done' });

    await processReminders();

    expect(reminder.update).toHaveBeenCalledWith({ cancelled: true });
    expect(mockSendNotification).not.toHaveBeenCalled();
  });
});

describe('processReminders — claim race', () => {
  it('skips sending when the conditional UPDATE returns affected=0 (another replica won)', async () => {
    const reminder = makeReminder();
    const task = makeTask();
    mockTaskReminderFindAll.mockResolvedValueOnce([reminder]);
    mockTaskFindByPk.mockResolvedValueOnce(task);
    // Claim UPDATE returns 0 rows affected
    mockTaskReminderUpdate.mockResolvedValueOnce([0]);

    await processReminders();

    expect(mockSendNotification).not.toHaveBeenCalled();
  });
});

describe('processReminders — per-row isolation', () => {
  it('continues with the next reminder when one row throws', async () => {
    const r1 = makeReminder({ id: 'good-1', taskId: 't-1' });
    const r2 = makeReminder({ id: 'bad',    taskId: 't-2' });
    const r3 = makeReminder({ id: 'good-2', taskId: 't-3' });
    mockTaskReminderFindAll.mockResolvedValueOnce([r1, r2, r3]);

    // r2's Task lookup throws
    mockTaskFindByPk
      .mockResolvedValueOnce(makeTask({ id: 't-1', assignedTo: 'u-1' }))
      .mockRejectedValueOnce(new Error('db blip'))
      .mockResolvedValueOnce(makeTask({ id: 't-3', assignedTo: 'u-3' }));

    mockUserFindByPk
      .mockResolvedValueOnce({ id: 'u-1', name: 'A', email: 'a@x.test' })
      .mockResolvedValueOnce({ id: 'u-3', name: 'C', email: 'c@x.test' });

    await processReminders();

    // r1 and r3 sent; r2 swallowed and continued
    expect(mockSendNotification).toHaveBeenCalledTimes(2);
  });
});
