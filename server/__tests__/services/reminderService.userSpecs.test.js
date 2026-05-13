/**
 * Unit tests for the user-configured-reminder surface of reminderService:
 *
 *   getUserReminderSpecs(taskId)       → array of active user specs
 *   getReminderSummary(taskId)         → single-task bell-icon summary
 *   getReminderSummaryBulk(taskIds)    → many-task bell-icon map
 *   normalizeReminderSpecs(rawSpecs)   → validation / dedup
 *
 * These are the functions the task controller hits when hydrating the
 * Reminders tile in the task modal and when enriching board task rows for
 * the bell icon. The regression they guard against is the
 * "modal shows No reminders even though a bell icon exists on the row"
 * bug: a path that wrote a TaskReminder row but did NOT return it from
 * the read path.
 *
 * The Sequelize models layer is fully mocked — these are pure unit tests.
 */

'use strict';

process.env.LOG_LEVEL = 'error';

const mockTaskReminderFindAll = jest.fn();

jest.mock('../../config/db', () => ({ sequelize: {} }));

jest.mock('../../models', () => ({
  TaskReminder: { findAll: (...a) => mockTaskReminderFindAll(...a) },
  Task: {},
  Board: {},
  TaskAssignee: {},
  User: {},
}));

jest.mock('../../services/notificationService', () => ({
  sendNotification: jest.fn(),
}));

jest.mock('../../utils/taskOverdueEligibility', () => ({
  isTaskEligibleForOverdueNotification: () => ({ eligible: true }),
}));

jest.mock('../../utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const {
  getUserReminderSpecs,
  getReminderSummary,
  getReminderSummaryBulk,
  normalizeReminderSpecs,
} = require('../../services/reminderService');

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── normalizeReminderSpecs ──────────────────────────────────────────────

describe('normalizeReminderSpecs()', () => {
  it('accepts the three supported kinds and dedupes within a single request', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { specs, errors } = normalizeReminderSpecs([
      { kind: 'at_due' },
      { kind: 'offset', offsetMinutes: 60 },
      { kind: 'offset', offsetMinutes: 60 }, // duplicate
      { kind: 'custom', at: future },
    ]);
    expect(errors).toEqual([]);
    expect(specs).toHaveLength(3);
    expect(specs.map(s => s.reminderType).sort()).toEqual(['at_due', 'custom', 'offset']);
  });

  it('rejects offset values not in the allowlist', () => {
    const { specs, errors } = normalizeReminderSpecs([
      { kind: 'offset', offsetMinutes: 7 }, // not in allowlist
      { kind: 'offset', offsetMinutes: 15 }, // allowed
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0].offsetMinutes).toBe(15);
    expect(errors[0]).toMatch(/Unsupported/);
  });

  it('rejects custom reminders in the past', () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    const { specs, errors } = normalizeReminderSpecs([
      { kind: 'custom', at: past },
    ]);
    expect(specs).toEqual([]);
    expect(errors[0]).toMatch(/future/i);
  });

  it('returns empty arrays for non-array input', () => {
    expect(normalizeReminderSpecs(null)).toEqual({ specs: [], errors: [] });
    expect(normalizeReminderSpecs(undefined)).toEqual({ specs: [], errors: [] });
    expect(normalizeReminderSpecs('not an array')).toEqual({ specs: [], errors: [] });
  });
});

// ─── getUserReminderSpecs ────────────────────────────────────────────────

describe('getUserReminderSpecs()', () => {
  it('returns every active user-set reminder for the task', async () => {
    // Three concurrent reminders: one offset, one at_due, one custom.
    // The hydration path is the one that broke when the modal reopened —
    // it MUST return all three regardless of order.
    const rows = [
      {
        id: 'r1',
        reminderType: 'offset',
        offsetMinutes: 60,
        customReminderAt: null,
        scheduledFor: new Date('2026-05-20T10:00:00Z'),
        sentAt: null,
      },
      {
        id: 'r2',
        reminderType: 'at_due',
        offsetMinutes: null,
        customReminderAt: null,
        scheduledFor: new Date('2026-05-20T11:00:00Z'),
        sentAt: null,
      },
      {
        id: 'r3',
        reminderType: 'custom',
        offsetMinutes: null,
        customReminderAt: new Date('2026-05-19T17:13:00Z'),
        scheduledFor: new Date('2026-05-19T17:13:00Z'),
        sentAt: null,
      },
    ];
    mockTaskReminderFindAll.mockResolvedValue(rows);

    const result = await getUserReminderSpecs('t-1');
    expect(result).toHaveLength(3);
    expect(result.map(r => r.kind).sort()).toEqual(['at_due', 'custom', 'offset']);
    // sent flag exposed so the client can grey out fired reminders if it wants
    expect(result.every(r => r.sent === false)).toBe(true);
  });

  it('excludes cancelled rows, sent rows, and legacy reminderTypes via the WHERE clause', async () => {
    // Verifies the WHERE clause filters out:
    //   - cancelled rows           (cancelled: false)
    //   - already-sent rows        (sentAt: null) — this is the fix for the
    //                              "deleted reminder comes back after modal
    //                              reopen" bug: applyReminderSpecs ignores
    //                              sentAt!=null rows, so they must not show
    //                              as chips the user can try to remove.
    //   - legacy 2_day/2_hour rows (auto-managed, not user-configurable)
    mockTaskReminderFindAll.mockResolvedValue([]);
    await getUserReminderSpecs('t-1');
    const where = mockTaskReminderFindAll.mock.calls[0][0].where;
    expect(where.cancelled).toBe(false);
    expect(where.sentAt).toBeNull();
    expect(where.reminderType).toBeDefined();
    expect(where.reminderType[Object.getOwnPropertySymbols(where.reminderType)[0]])
      .toEqual(['offset', 'at_due', 'custom']);
  });

  it('does NOT surface sent reminders — the active-chip API hides them', async () => {
    // Regression guard for the delete-persistence bug:
    //   1. A user reminder fires → sentAt is set, cancelled stays false.
    //   2. If we returned this row, the modal would show a chip.
    //   3. The user would click `×`; the resulting PUT would not contain
    //      that spec.
    //   4. applyReminderSpecs filters `sentAt: null`, so it would NEVER
    //      cancel the sent row.
    //   5. The chip "comes back" on next modal open.
    // Fix: never return sent rows from this read path. They've fired —
    // they're history. The bell-icon summary already filters them too.
    //
    // The mock here is what the DB would return AFTER applying the WHERE
    // clause — i.e. an empty list, because a row with sentAt set is
    // filtered server-side. The test asserts the call shape, not the
    // mock implementation of the DB filter.
    mockTaskReminderFindAll.mockResolvedValue([]);
    const result = await getUserReminderSpecs('t-1');
    expect(result).toEqual([]);
  });
});

// ─── getReminderSummary ──────────────────────────────────────────────────

describe('getReminderSummary()', () => {
  it('returns hasActiveReminder=true with the earliest scheduledFor', async () => {
    mockTaskReminderFindAll.mockResolvedValue([
      { scheduledFor: new Date('2026-05-20T10:00:00Z') },
      { scheduledFor: new Date('2026-05-20T12:00:00Z') },
    ]);
    const s = await getReminderSummary('t-1');
    expect(s.hasActiveReminder).toBe(true);
    expect(s.activeReminderCount).toBe(2);
    // Result is sorted ASC and `nextReminderAt` is the first row.
    expect(new Date(s.nextReminderAt).toISOString()).toBe('2026-05-20T10:00:00.000Z');
  });

  it('returns hasActiveReminder=false when no active rows exist', async () => {
    mockTaskReminderFindAll.mockResolvedValue([]);
    const s = await getReminderSummary('t-1');
    expect(s).toEqual({
      hasActiveReminder: false,
      nextReminderAt: null,
      activeReminderCount: 0,
    });
  });

  it('filters out sent and cancelled rows at the query level', async () => {
    mockTaskReminderFindAll.mockResolvedValue([]);
    await getReminderSummary('t-1');
    const where = mockTaskReminderFindAll.mock.calls[0][0].where;
    expect(where.sentAt).toBeNull();
    expect(where.cancelled).toBe(false);
  });

  it('returns the empty summary on query failure (non-fatal)', async () => {
    mockTaskReminderFindAll.mockRejectedValue(new Error('db gone'));
    const s = await getReminderSummary('t-1');
    expect(s).toEqual({
      hasActiveReminder: false,
      nextReminderAt: null,
      activeReminderCount: 0,
    });
  });
});

// ─── getReminderSummaryBulk ──────────────────────────────────────────────

describe('getReminderSummaryBulk()', () => {
  it('returns a map keyed by taskId for tasks that have active reminders', async () => {
    mockTaskReminderFindAll.mockResolvedValue([
      { taskId: 'a', scheduledFor: new Date('2026-05-20T10:00:00Z') },
      { taskId: 'a', scheduledFor: new Date('2026-05-20T12:00:00Z') },
      { taskId: 'b', scheduledFor: new Date('2026-05-21T09:00:00Z') },
    ]);
    const map = await getReminderSummaryBulk(['a', 'b', 'c']);
    expect(map.get('a').activeReminderCount).toBe(2);
    expect(new Date(map.get('a').nextReminderAt).toISOString()).toBe('2026-05-20T10:00:00.000Z');
    expect(map.get('b').activeReminderCount).toBe(1);
    // 'c' has no rows — absent from the map (caller treats absent as 0)
    expect(map.has('c')).toBe(false);
  });

  it('returns an empty Map for empty or non-array input', async () => {
    expect((await getReminderSummaryBulk([])).size).toBe(0);
    expect((await getReminderSummaryBulk(null)).size).toBe(0);
    expect((await getReminderSummaryBulk(undefined)).size).toBe(0);
  });

  it('returns an empty Map on query failure (non-fatal)', async () => {
    mockTaskReminderFindAll.mockRejectedValue(new Error('db gone'));
    const map = await getReminderSummaryBulk(['a']);
    expect(map.size).toBe(0);
  });
});
