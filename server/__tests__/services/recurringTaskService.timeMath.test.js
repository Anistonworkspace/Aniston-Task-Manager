'use strict';

/**
 * Tests for the time-math layer of server/services/recurringTaskService.js
 * — Phase 2.9 of the QA remediation plan (docs/qa-audit-2026-05-17.md →
 * §22 P0 item #9). Previously 33.66% — the existing
 * recurringTaskService.test.js covers persistence paths but the pure
 * time-math helpers had no dedicated tests.
 *
 * Time-math correctness is critical: a single off-by-one here means a
 * daily template generates the wrong day's task, or a missed-escalation
 * job fires at the wrong UTC moment for users in non-UTC zones.
 *
 * All functions tested here are PURE (no DB, no I/O). No mocks needed.
 */

const {
  partsInZone,
  formatDateOnly,
  zonedTimeToUtc,
  parseDueTime,
  isOccurrenceEligible,
  getMonthlyDays,
  nextOccurrenceDate,
  generationRunAtUtc,
  dueAtUtc,
} = require('../../services/recurringTaskService');

// ─── partsInZone ───────────────────────────────────────────────

describe('partsInZone', () => {
  it('returns the wall-clock parts in the requested IANA timezone', () => {
    // 2026-03-15T05:30:00Z = 2026-03-15 11:00 in Asia/Kolkata (UTC+5:30)
    const parts = partsInZone(new Date('2026-03-15T05:30:00Z'), 'Asia/Kolkata');
    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(3);
    expect(parts.day).toBe(15);
    expect(parts.hour).toBe(11);
    expect(parts.minute).toBe(0);
    // 2026-03-15 was a Sunday
    expect(parts.weekday).toBe(0);
  });

  it('handles UTC (the default) correctly', () => {
    const parts = partsInZone(new Date('2026-03-15T05:30:00Z'), 'UTC');
    expect(parts.hour).toBe(5);
    expect(parts.minute).toBe(30);
  });

  it('returns UTC parts when the timezone is unparseable (defensive fallback)', () => {
    const parts = partsInZone(new Date('2026-03-15T05:30:00Z'), 'Not/A/Real/Zone');
    expect(parts.hour).toBe(5); // UTC hour
    expect(parts.day).toBe(15);
  });

  it('normalises hour=24 to 0 (some locales render midnight as 24)', () => {
    // 2026-01-01T00:00:00Z in UTC is exactly midnight
    const parts = partsInZone(new Date('2026-01-01T00:00:00Z'), 'UTC');
    expect(parts.hour).toBe(0);
  });

  it('handles a timezone offset that crosses a date boundary', () => {
    // 2026-03-15T23:00:00Z is 2026-03-16 04:30 in Asia/Kolkata
    const parts = partsInZone(new Date('2026-03-15T23:00:00Z'), 'Asia/Kolkata');
    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(3);
    expect(parts.day).toBe(16);
  });

  it('defaults to UTC when timezone is empty', () => {
    const parts = partsInZone(new Date('2026-03-15T05:30:00Z'), '');
    expect(parts.hour).toBe(5);
  });
});

// ─── formatDateOnly ────────────────────────────────────────────

describe('formatDateOnly', () => {
  it('pads month and day to 2 digits', () => {
    expect(formatDateOnly(2026, 3, 5)).toBe('2026-03-05');
  });

  it('does not pad year', () => {
    expect(formatDateOnly(2026, 12, 31)).toBe('2026-12-31');
  });

  it('preserves already-padded values', () => {
    expect(formatDateOnly(2026, 11, 25)).toBe('2026-11-25');
  });
});

// ─── parseDueTime ──────────────────────────────────────────────

describe('parseDueTime', () => {
  it('parses HH:mm format', () => {
    expect(parseDueTime('09:30')).toEqual({ hour: 9, minute: 30, second: 0 });
  });

  it('parses HH:mm:ss format (Postgres TIME column shape)', () => {
    expect(parseDueTime('18:45:12')).toEqual({ hour: 18, minute: 45, second: 12 });
  });

  it('returns 18:00 default when input is null', () => {
    expect(parseDueTime(null)).toEqual({ hour: 18, minute: 0, second: 0 });
  });

  it('returns 18:00 default when input is undefined', () => {
    expect(parseDueTime(undefined)).toEqual({ hour: 18, minute: 0, second: 0 });
  });

  it('returns 18:00 default when input is malformed', () => {
    expect(parseDueTime('not a time')).toEqual({ hour: 18, minute: 0, second: 0 });
  });

  it('clamps hour to 23', () => {
    expect(parseDueTime('99:99')).toEqual({ hour: 23, minute: 59, second: 0 });
  });

  it('clamps minute to 59', () => {
    expect(parseDueTime('10:75')).toEqual({ hour: 10, minute: 59, second: 0 });
  });

  it('clamps second to 59', () => {
    expect(parseDueTime('10:30:99')).toEqual({ hour: 10, minute: 30, second: 59 });
  });

  it('parses single-digit components', () => {
    expect(parseDueTime('9:5')).toEqual({ hour: 9, minute: 5, second: 0 });
  });
});

// ─── getMonthlyDays ────────────────────────────────────────────

describe('getMonthlyDays', () => {
  it('returns the daysOfMonth array sorted + deduped', () => {
    expect(getMonthlyDays({ daysOfMonth: [15, 1, 15, 28] })).toEqual([1, 15, 28]);
  });

  it('filters out non-integer values', () => {
    expect(getMonthlyDays({ daysOfMonth: [1, 'invalid', 15, null, 32, 0] }))
      .toEqual([1, 15]);
  });

  it('falls back to legacy dayOfMonth when daysOfMonth is empty', () => {
    expect(getMonthlyDays({ daysOfMonth: [], dayOfMonth: 7 })).toEqual([7]);
  });

  it('falls back to legacy dayOfMonth when daysOfMonth is missing', () => {
    expect(getMonthlyDays({ dayOfMonth: 28 })).toEqual([28]);
  });

  it('returns [] when neither daysOfMonth nor dayOfMonth is set', () => {
    expect(getMonthlyDays({})).toEqual([]);
  });

  it('rejects out-of-range legacy dayOfMonth (0, 32, negative)', () => {
    expect(getMonthlyDays({ dayOfMonth: 0 })).toEqual([]);
    expect(getMonthlyDays({ dayOfMonth: 32 })).toEqual([]);
    expect(getMonthlyDays({ dayOfMonth: -1 })).toEqual([]);
  });

  it('handles a non-array daysOfMonth gracefully (treats as empty)', () => {
    expect(getMonthlyDays({ daysOfMonth: 'not-an-array', dayOfMonth: 15 })).toEqual([15]);
  });
});

// ─── isOccurrenceEligible ──────────────────────────────────────

describe('isOccurrenceEligible', () => {
  const parts = (overrides) => ({ year: 2026, month: 5, day: 17, weekday: 0, ...overrides });

  it('daily → always true', () => {
    expect(isOccurrenceEligible({ frequency: 'daily' }, parts())).toBe(true);
  });

  it('weekdays → false on Sunday (weekday=0)', () => {
    expect(isOccurrenceEligible({ frequency: 'weekdays' }, parts({ weekday: 0 }))).toBe(false);
  });

  it('weekdays → true on Monday–Saturday', () => {
    for (let wd = 1; wd <= 6; wd += 1) {
      expect(isOccurrenceEligible({ frequency: 'weekdays' }, parts({ weekday: wd }))).toBe(true);
    }
  });

  it('weekly → true when weekday matches template.weekdays', () => {
    const tpl = { frequency: 'weekly', weekdays: [1, 3, 5] };
    expect(isOccurrenceEligible(tpl, parts({ weekday: 3 }))).toBe(true);
    expect(isOccurrenceEligible(tpl, parts({ weekday: 2 }))).toBe(false);
  });

  it('weekly → false when weekdays list is empty', () => {
    expect(isOccurrenceEligible({ frequency: 'weekly', weekdays: [] }, parts({ weekday: 1 })))
      .toBe(false);
  });

  it('weekly → false when weekdays is missing entirely', () => {
    expect(isOccurrenceEligible({ frequency: 'weekly' }, parts({ weekday: 1 }))).toBe(false);
  });

  it('custom → behaves like weekly (same code path)', () => {
    const tpl = { frequency: 'custom', weekdays: [2] };
    expect(isOccurrenceEligible(tpl, parts({ weekday: 2 }))).toBe(true);
    expect(isOccurrenceEligible(tpl, parts({ weekday: 3 }))).toBe(false);
  });

  it('monthly → true when day matches getMonthlyDays', () => {
    const tpl = { frequency: 'monthly', daysOfMonth: [15] };
    expect(isOccurrenceEligible(tpl, parts({ day: 15 }))).toBe(true);
    expect(isOccurrenceEligible(tpl, parts({ day: 14 }))).toBe(false);
  });

  it('monthly → day 31 collapses to last-day in months shorter than 31 days', () => {
    const tpl = { frequency: 'monthly', daysOfMonth: [31] };
    // Feb 2026: 28 days. So day=28 should be eligible (31 collapsed to 28).
    expect(isOccurrenceEligible(tpl, parts({ year: 2026, month: 2, day: 28 }))).toBe(true);
    // Feb 27 should NOT be eligible (it's not the last day)
    expect(isOccurrenceEligible(tpl, parts({ year: 2026, month: 2, day: 27 }))).toBe(false);
  });

  it('monthly → empty days list returns false', () => {
    expect(isOccurrenceEligible({ frequency: 'monthly', daysOfMonth: [] }, parts({ day: 15 })))
      .toBe(false);
  });

  it('monthly → multiple days collapsing onto same effective day (28+29+30+31 in Feb) all match Feb-28', () => {
    const tpl = { frequency: 'monthly', daysOfMonth: [28, 29, 30, 31] };
    expect(isOccurrenceEligible(tpl, parts({ year: 2026, month: 2, day: 28 }))).toBe(true);
  });

  it('unknown frequency → false (defensive default)', () => {
    expect(isOccurrenceEligible({ frequency: 'sporadic' }, parts())).toBe(false);
  });
});

// ─── zonedTimeToUtc ────────────────────────────────────────────

describe('zonedTimeToUtc', () => {
  it('round-trips through partsInZone for a known UTC moment', () => {
    // 2026-06-15 14:30 in UTC → 2026-06-15T14:30:00Z
    const out = zonedTimeToUtc(2026, 6, 15, 14, 30, 0, 'UTC');
    expect(out.toISOString()).toBe('2026-06-15T14:30:00.000Z');
  });

  it('converts wall-clock in Asia/Kolkata (UTC+5:30, no DST) to UTC', () => {
    // 2026-06-15 11:00 in Asia/Kolkata = 2026-06-15 05:30 UTC
    const out = zonedTimeToUtc(2026, 6, 15, 11, 0, 0, 'Asia/Kolkata');
    expect(out.toISOString()).toBe('2026-06-15T05:30:00.000Z');
  });

  it('round-trips through partsInZone for a DST-observing zone', () => {
    // Pick a date well clear of any DST flip — round-trip check is what we care about
    const expected = { year: 2026, month: 7, day: 15, hour: 14, minute: 30 };
    const out = zonedTimeToUtc(2026, 7, 15, 14, 30, 0, 'America/New_York');
    const back = partsInZone(out, 'America/New_York');
    expect(back.year).toBe(expected.year);
    expect(back.month).toBe(expected.month);
    expect(back.day).toBe(expected.day);
    expect(back.hour).toBe(expected.hour);
    expect(back.minute).toBe(expected.minute);
  });

  it('defaults timezone to UTC when not supplied', () => {
    const out = zonedTimeToUtc(2026, 6, 15, 14, 30, 0);
    expect(out.toISOString()).toBe('2026-06-15T14:30:00.000Z');
  });

  it('defaults second to 0 when not supplied', () => {
    const out = zonedTimeToUtc(2026, 6, 15, 14, 30, undefined, 'UTC');
    expect(out.getUTCSeconds()).toBe(0);
  });
});

// ─── nextOccurrenceDate ────────────────────────────────────────

describe('nextOccurrenceDate', () => {
  // Use a fixed "from" date so tests are deterministic.
  const FROM = new Date('2026-05-17T08:00:00Z'); // a Sunday

  it('daily → returns the same day when startDate is in the past', () => {
    expect(nextOccurrenceDate(
      { frequency: 'daily', startDate: '2026-01-01', timezone: 'UTC' },
      FROM,
    )).toBe('2026-05-17');
  });

  it('daily → returns startDate when it is in the future', () => {
    expect(nextOccurrenceDate(
      { frequency: 'daily', startDate: '2026-06-01', timezone: 'UTC' },
      FROM,
    )).toBe('2026-06-01');
  });

  it('returns null when endDate has already passed', () => {
    expect(nextOccurrenceDate(
      { frequency: 'daily', startDate: '2026-01-01', endDate: '2026-05-10', timezone: 'UTC' },
      FROM,
    )).toBeNull();
  });

  it('weekly → returns the next Monday from a Sunday anchor', () => {
    // FROM is Sunday 2026-05-17. Next Monday is 2026-05-18.
    expect(nextOccurrenceDate(
      { frequency: 'weekly', startDate: '2026-01-01', timezone: 'UTC', weekdays: [1] },
      FROM,
    )).toBe('2026-05-18');
  });

  it('weekdays → returns Mon 18 from Sun 17 anchor', () => {
    expect(nextOccurrenceDate(
      { frequency: 'weekdays', startDate: '2026-01-01', timezone: 'UTC' },
      FROM,
    )).toBe('2026-05-18');
  });

  it('weekly with no matching weekday returns null (safety bound at 366 days)', () => {
    expect(nextOccurrenceDate(
      { frequency: 'weekly', startDate: '2026-01-01', timezone: 'UTC', weekdays: [] },
      FROM,
    )).toBeNull();
  });

  it('monthly → returns the next matching day-of-month', () => {
    expect(nextOccurrenceDate(
      { frequency: 'monthly', startDate: '2026-01-01', timezone: 'UTC', daysOfMonth: [25] },
      FROM,
    )).toBe('2026-05-25');
  });

  it('monthly → if current month already past target day, returns next month\'s match', () => {
    // FROM is May 17. Target day is 10 → next match is June 10.
    expect(nextOccurrenceDate(
      { frequency: 'monthly', startDate: '2026-01-01', timezone: 'UTC', daysOfMonth: [10] },
      FROM,
    )).toBe('2026-06-10');
  });
});

// ─── generationRunAtUtc + dueAtUtc ─────────────────────────────

describe('generationRunAtUtc', () => {
  it('returns 00:05 in the template tz as a UTC Date', () => {
    // 00:05 in Asia/Kolkata on 2026-06-15 = 2026-06-14T18:35:00Z (UTC-5:30)
    const out = generationRunAtUtc('2026-06-15', 'Asia/Kolkata');
    expect(out.toISOString()).toBe('2026-06-14T18:35:00.000Z');
  });

  it('defaults timezone to UTC', () => {
    const out = generationRunAtUtc('2026-06-15');
    expect(out.toISOString()).toBe('2026-06-15T00:05:00.000Z');
  });
});

describe('dueAtUtc', () => {
  it('combines occurrenceDate + dueTime into UTC', () => {
    // 18:00 in UTC on 2026-06-15
    const out = dueAtUtc('2026-06-15', '18:00', 'UTC');
    expect(out.toISOString()).toBe('2026-06-15T18:00:00.000Z');
  });

  it('falls back to 18:00 when dueTime is null', () => {
    const out = dueAtUtc('2026-06-15', null, 'UTC');
    expect(out.toISOString()).toBe('2026-06-15T18:00:00.000Z');
  });

  it('respects the tz offset for non-UTC zones', () => {
    // 09:30 in Asia/Kolkata = 04:00 UTC on the same calendar day
    const out = dueAtUtc('2026-06-15', '09:30', 'Asia/Kolkata');
    expect(out.toISOString()).toBe('2026-06-15T04:00:00.000Z');
  });
});

// ─── validateTemplateForGeneration ──────────────────────────────
//
// Requires mocking models; do it inside a separate describe block so we
// don't pollute the pure-time-math tests above with model mocks.

describe('validateTemplateForGeneration', () => {
  // Lazy require + jest.doMock so the model layer can be mocked AFTER
  // the time-math suites above ran with the real (unmocked) module.
  let validateTemplateForGeneration;
  let Board;
  let User;

  beforeAll(() => {
    jest.doMock('../../models', () => ({
      Board: { findByPk: jest.fn() },
      User: { findOne: jest.fn(), findByPk: jest.fn() },
      Task: { findByPk: jest.fn(), findOne: jest.fn(), create: jest.fn(), findAll: jest.fn() },
      RecurringTaskTemplate: { findByPk: jest.fn() },
      TaskAssignee: { create: jest.fn(), findAll: jest.fn() },
      TaskOwner: { create: jest.fn(), findAll: jest.fn() },
    }));
    jest.isolateModules(() => {
      validateTemplateForGeneration = require('../../services/recurringTaskService').validateTemplateForGeneration;
      const models = require('../../models');
      Board = models.Board;
      User = models.User;
    });
  });

  afterAll(() => {
    jest.dontMock('../../models');
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function validTemplate() {
    return {
      id: 'tpl-1',
      isActive: true,
      archivedAt: null,
      boardId: 'board-1',
      groupId: 'group-1',
      assigneeId: 'user-1',
      createdBy: 'user-creator',
    };
  }

  it('returns { ok: true } when every gate passes', async () => {
    Board.findByPk.mockResolvedValueOnce({
      id: 'board-1', isArchived: false, groups: [{ id: 'group-1' }],
    });
    User.findOne.mockResolvedValueOnce({ id: 'user-1', isActive: true });
    await expect(validateTemplateForGeneration(validTemplate())).resolves.toEqual({ ok: true });
  });

  it('rejects a null template', async () => {
    await expect(validateTemplateForGeneration(null))
      .resolves.toEqual({ ok: false, reason: 'template-missing' });
  });

  it('rejects an inactive (paused) template', async () => {
    await expect(validateTemplateForGeneration({ ...validTemplate(), isActive: false }))
      .resolves.toEqual({ ok: false, reason: 'template-paused' });
  });

  it('rejects an archived template', async () => {
    await expect(validateTemplateForGeneration({ ...validTemplate(), archivedAt: new Date() }))
      .resolves.toEqual({ ok: false, reason: 'template-archived' });
  });

  it.each([
    ['boardId', 'template-missing-boardId'],
    ['assigneeId', 'template-missing-assigneeId'],
    ['createdBy', 'template-missing-createdBy'],
  ])('rejects when %s is missing', async (field, expectedReason) => {
    const tpl = validTemplate();
    tpl[field] = null;
    await expect(validateTemplateForGeneration(tpl))
      .resolves.toEqual({ ok: false, reason: expectedReason });
  });

  it('rejects when the board no longer exists', async () => {
    Board.findByPk.mockResolvedValueOnce(null);
    await expect(validateTemplateForGeneration(validTemplate()))
      .resolves.toEqual({ ok: false, reason: 'board-missing' });
  });

  it('rejects when the board is archived', async () => {
    Board.findByPk.mockResolvedValueOnce({ id: 'b', isArchived: true, groups: [] });
    await expect(validateTemplateForGeneration(validTemplate()))
      .resolves.toEqual({ ok: false, reason: 'board-archived' });
  });

  it('rejects when groupId references a non-existent group on the board', async () => {
    Board.findByPk.mockResolvedValueOnce({
      id: 'b', isArchived: false, groups: [{ id: 'different-group' }],
    });
    await expect(validateTemplateForGeneration(validTemplate()))
      .resolves.toEqual({ ok: false, reason: 'group-missing-on-board' });
  });

  it('allows groupId="new" even when board.groups does not list it (default fallback)', async () => {
    Board.findByPk.mockResolvedValueOnce({
      id: 'b', isArchived: false, groups: [{ id: 'other' }],
    });
    User.findOne.mockResolvedValueOnce({ id: 'user-1', isActive: true });
    await expect(validateTemplateForGeneration({ ...validTemplate(), groupId: 'new' }))
      .resolves.toEqual({ ok: true });
  });

  it('allows missing groupId (treated as "new")', async () => {
    Board.findByPk.mockResolvedValueOnce({
      id: 'b', isArchived: false, groups: [],
    });
    User.findOne.mockResolvedValueOnce({ id: 'user-1', isActive: true });
    const tpl = validTemplate();
    delete tpl.groupId;
    await expect(validateTemplateForGeneration(tpl)).resolves.toEqual({ ok: true });
  });

  it('rejects when assignee user is missing', async () => {
    Board.findByPk.mockResolvedValueOnce({
      id: 'b', isArchived: false, groups: [{ id: 'group-1' }],
    });
    User.findOne.mockResolvedValueOnce(null);
    await expect(validateTemplateForGeneration(validTemplate()))
      .resolves.toEqual({ ok: false, reason: 'assignee-missing' });
  });

  it('rejects when assignee user is inactive', async () => {
    Board.findByPk.mockResolvedValueOnce({
      id: 'b', isArchived: false, groups: [{ id: 'group-1' }],
    });
    User.findOne.mockResolvedValueOnce({ id: 'user-1', isActive: false });
    await expect(validateTemplateForGeneration(validTemplate()))
      .resolves.toEqual({ ok: false, reason: 'assignee-inactive' });
  });
});
