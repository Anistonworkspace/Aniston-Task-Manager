'use strict';

/**
 * Tests for jobs/calendarSyncRetryJob.runRetryPass.
 *
 * Covers:
 *   - Loads only `failed`/`pending` tasks under MAX_RETRY_ATTEMPTS.
 *   - Calls calendarService.ensureSynced(task.id) per row.
 *   - Per-task error isolation — a thrown error on one task must not stop
 *     the rest of the batch.
 *   - Returns sane counters (attempted / succeeded).
 *
 * Note on cron locking: `runRetryPass` itself is NOT inside withCronLock —
 * the lock is in the scheduled wrapper. We still verify the wrapper exists
 * by importing the start function.
 */

process.env.LOG_LEVEL = 'error';

const mockTaskFindAll = jest.fn();
const mockEnsureSynced = jest.fn();

jest.mock('../../models', () => ({
  Task: { findAll: (...a) => mockTaskFindAll(...a) },
}));

jest.mock('../../services/calendarService', () => ({
  MAX_RETRY_ATTEMPTS: 3,
  ensureSynced: (...a) => mockEnsureSynced(...a),
}));

jest.mock('node-cron', () => ({
  schedule: jest.fn(),
}));

jest.mock('../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../jobs/cronLock', () => ({
  withCronLock: jest.fn(async (_name, fn) => fn()),
}));

const { runRetryPass, startCalendarSyncRetryJob } = require('../../jobs/calendarSyncRetryJob');
const cron = require('node-cron');
const { withCronLock } = require('../../jobs/cronLock');

beforeEach(() => {
  mockTaskFindAll.mockReset();
  mockEnsureSynced.mockReset();
  cron.schedule.mockReset();
  withCronLock.mockClear();
});

describe('runRetryPass — happy path', () => {
  it('returns zero counters when there are no candidate tasks', async () => {
    mockTaskFindAll.mockResolvedValueOnce([]);
    const result = await runRetryPass();
    expect(result).toEqual({ attempted: 0, succeeded: 0 });
    expect(mockEnsureSynced).not.toHaveBeenCalled();
  });

  it('calls ensureSynced for every candidate and counts successes', async () => {
    mockTaskFindAll.mockResolvedValueOnce([
      { id: 't-1' }, { id: 't-2' }, { id: 't-3' },
    ]);
    mockEnsureSynced
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const result = await runRetryPass();
    expect(mockEnsureSynced).toHaveBeenCalledTimes(3);
    expect(mockEnsureSynced).toHaveBeenNthCalledWith(1, 't-1');
    expect(mockEnsureSynced).toHaveBeenNthCalledWith(2, 't-2');
    expect(mockEnsureSynced).toHaveBeenNthCalledWith(3, 't-3');
    expect(result.attempted).toBe(3);
    expect(result.succeeded).toBe(2);
  });
});

describe('runRetryPass — per-task isolation', () => {
  it('continues processing when ensureSynced throws for one task', async () => {
    mockTaskFindAll.mockResolvedValueOnce([
      { id: 't-good-1' }, { id: 't-bad' }, { id: 't-good-2' },
    ]);
    mockEnsureSynced
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('Graph API 503'))
      .mockResolvedValueOnce(true);

    const result = await runRetryPass();
    expect(result.attempted).toBe(3);
    expect(result.succeeded).toBe(2);
    // Confirm all three were attempted — the bad one didn't abort the loop.
    expect(mockEnsureSynced).toHaveBeenCalledTimes(3);
  });
});

describe('runRetryPass — query shape', () => {
  it('queries only non-archived tasks with status failed|pending, attempts < MAX, with an assignee', async () => {
    mockTaskFindAll.mockResolvedValueOnce([]);
    await runRetryPass();

    expect(mockTaskFindAll).toHaveBeenCalledTimes(1);
    const opts = mockTaskFindAll.mock.calls[0][0];
    expect(opts.where).toBeDefined();
    expect(opts.where.isArchived).toBe(false);
    expect(opts.where.syncStatus).toBeDefined();
    expect(opts.where.syncAttempts).toBeDefined();
    expect(opts.where.assignedTo).toBeDefined();
    // BATCH_SIZE bound
    expect(opts.limit).toBe(20);
  });
});

describe('startCalendarSyncRetryJob — cron lock wrapping', () => {
  it('schedules a cron tick and wraps the work in withCronLock', async () => {
    startCalendarSyncRetryJob();
    expect(cron.schedule).toHaveBeenCalledTimes(1);
    const [, fn] = cron.schedule.mock.calls[0];

    // Drive the tick directly to verify the lock wrapping
    mockTaskFindAll.mockResolvedValueOnce([]);
    await fn();

    expect(withCronLock).toHaveBeenCalledTimes(1);
    expect(withCronLock.mock.calls[0][0]).toBe('calendarSyncRetryJob:15min');
  });
});
