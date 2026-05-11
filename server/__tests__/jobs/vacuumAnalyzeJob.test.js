'use strict';

/**
 * Tests for the weekly VACUUM ANALYZE maintenance job.
 *
 * The job:
 *   - Issues VACUUM (ANALYZE) "<table>" for each of a whitelisted set of
 *     hot tables.
 *   - Continues on per-table failure (one corrupt table doesn't skip the
 *     rest).
 *   - Sweeps expired refresh_tokens older than 14 days.
 *   - Wrapped in withCronLock so replicas don't double-vacuum the same tables.
 */

process.env.LOG_LEVEL = 'error';

const mockSequelizeQuery = jest.fn();

jest.mock('../../models', () => ({
  sequelize: { query: (...a) => mockSequelizeQuery(...a) },
}));

jest.mock('node-cron', () => ({ schedule: jest.fn() }));

jest.mock('../../jobs/cronLock', () => ({
  withCronLock: jest.fn(async (_name, fn) => fn()),
}));

const cron = require('node-cron');
const { withCronLock } = require('../../jobs/cronLock');
const { runVacuumAnalyze, startVacuumAnalyzeJob } = require('../../jobs/vacuumAnalyzeJob');

beforeEach(() => {
  mockSequelizeQuery.mockReset();
  cron.schedule.mockReset();
  withCronLock.mockClear();
});

describe('runVacuumAnalyze — happy path', () => {
  it('issues VACUUM (ANALYZE) on every whitelisted table', async () => {
    mockSequelizeQuery.mockResolvedValue([[], { rowCount: 0 }]);
    await runVacuumAnalyze();

    // We expect at least the tasks + a handful of other hot tables.
    const sqls = mockSequelizeQuery.mock.calls.map((c) => c[0]);
    expect(sqls).toEqual(expect.arrayContaining([
      'VACUUM (ANALYZE) "tasks"',
      'VACUUM (ANALYZE) "task_assignees"',
      'VACUUM (ANALYZE) "subtasks"',
      'VACUUM (ANALYZE) "comments"',
      'VACUUM (ANALYZE) "notifications"',
      'VACUUM (ANALYZE) "users"',
      'VACUUM (ANALYZE) "boards"',
    ]));
  });

  it('runs the refresh_tokens GC (DELETE ... < NOW() - 14 days)', async () => {
    mockSequelizeQuery.mockResolvedValue([[], { rowCount: 0 }]);
    await runVacuumAnalyze();

    const deleteCall = mockSequelizeQuery.mock.calls.find((c) =>
      typeof c[0] === 'string' && c[0].includes('DELETE FROM refresh_tokens')
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall[0]).toMatch(/INTERVAL '14 days'/);
  });
});

describe('runVacuumAnalyze — per-table failure isolation', () => {
  it('continues maintenance on remaining tables if one fails', async () => {
    // Fail the very first VACUUM ('tasks'); succeed on everything else.
    mockSequelizeQuery
      .mockImplementationOnce(() => Promise.reject(new Error('vacuum disk full')))
      .mockImplementation(() => Promise.resolve([[], { rowCount: 0 }]));

    // Must not throw.
    await expect(runVacuumAnalyze()).resolves.toBeUndefined();

    // The loop reached more tables after the failed one.
    expect(mockSequelizeQuery.mock.calls.length).toBeGreaterThan(2);
  });

  it('absorbs an error from the refresh_tokens GC without throwing', async () => {
    // Make all VACUUM calls succeed but the GC query fail.
    mockSequelizeQuery.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('DELETE FROM refresh_tokens')) {
        return Promise.reject(new Error('relation does not exist'));
      }
      return Promise.resolve([[], { rowCount: 0 }]);
    });

    await expect(runVacuumAnalyze()).resolves.toBeUndefined();
  });
});

describe('startVacuumAnalyzeJob — cron schedule + advisory lock', () => {
  it('schedules a Sunday 03:00 cron tick wrapped in withCronLock', async () => {
    mockSequelizeQuery.mockResolvedValue([[], { rowCount: 0 }]);
    startVacuumAnalyzeJob();

    expect(cron.schedule).toHaveBeenCalledTimes(1);
    // Sunday at 03:00 — "minute hour day month day-of-week" → "0 3 * * 0"
    expect(cron.schedule.mock.calls[0][0]).toBe('0 3 * * 0');

    // Drive the tick. The job uses `withCronLock(name, fn)`.
    await cron.schedule.mock.calls[0][1]();
    expect(withCronLock).toHaveBeenCalledTimes(1);
    expect(withCronLock.mock.calls[0][0]).toBe('vacuumAnalyze');
  });
});
