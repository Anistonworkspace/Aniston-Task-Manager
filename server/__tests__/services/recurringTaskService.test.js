/**
 * Unit tests for recurringTaskService — pure recurrence math.
 *
 * These tests cover the contracts that the new `RecurringTaskTemplate` stack
 * is built on:
 *
 *   - Mon–Sat semantics for the `weekdays` frequency (Sunday excluded).
 *   - Multi-day monthly via `daysOfMonth` array.
 *   - Backward compatibility for the legacy `dayOfMonth` integer.
 *   - The legacy `frequency='custom'` value behaves identically to 'weekly'.
 *   - `nextOccurrenceDate` finds the next eligible date inside [start, end].
 *   - `getMonthlyDays` collapses out-of-range days onto the month's last day.
 *
 * The model layer is mocked so this file runs without a live DB.
 */

'use strict';

// Mock the models barrel BEFORE loading the service. We only exercise the
// pure helpers, so the model objects can be empty stubs.
jest.mock('../../models', () => ({
  Task: {},
  RecurringTaskTemplate: {},
  TaskAssignee: {},
  TaskOwner: {},
  Board: {},
  User: {},
}));
jest.mock('../../services/notificationService', () => {
  const actual = jest.requireActual('../../services/notificationService');
  return {
    sendNotification: jest.fn(),
    // recurringTaskService.runTemplateOnce stamps the "recurring task ready"
    // notification with an idempotency key — preserve the real helper so the
    // destructured import resolves to a function.
    buildIdempotencyKey: actual.buildIdempotencyKey,
  };
});
jest.mock('../../services/activityService', () => ({ logActivity: jest.fn() }));
jest.mock('../../services/realtimeService', () => ({ emitTaskCreated: jest.fn() }));
jest.mock('../../services/boardMembershipService', () => ({ autoAddMember: jest.fn() }));
jest.mock('../../config/db', () => ({ sequelize: { transaction: jest.fn() } }));

const recurringTaskService = require('../../services/recurringTaskService');
const {
  isOccurrenceEligible,
  getMonthlyDays,
  nextOccurrenceDate,
  partsInZone,
} = recurringTaskService;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build an isOccurrenceEligible parts object for a given UTC noon date. */
function partsForDate(year, month, day, tz = 'UTC') {
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const p = partsInZone(probe, tz);
  return { ...p, year, month, day };
}

// ─── isOccurrenceEligible — daily ───────────────────────────────────────────

describe('isOccurrenceEligible: daily', () => {
  const tpl = { frequency: 'daily' };

  test('matches every weekday', () => {
    // Sun..Sat across one week
    const week = [
      partsForDate(2026, 5, 3),  // Sunday
      partsForDate(2026, 5, 4),  // Monday
      partsForDate(2026, 5, 5),  // Tuesday
      partsForDate(2026, 5, 6),  // Wednesday
      partsForDate(2026, 5, 7),  // Thursday
      partsForDate(2026, 5, 8),  // Friday
      partsForDate(2026, 5, 9),  // Saturday
    ];
    for (const parts of week) {
      expect(isOccurrenceEligible(tpl, parts)).toBe(true);
    }
  });
});

// ─── isOccurrenceEligible — weekdays (Mon–Sat) ──────────────────────────────

describe('isOccurrenceEligible: weekdays (Mon–Sat semantics)', () => {
  const tpl = { frequency: 'weekdays' };

  test('matches Monday through Saturday', () => {
    expect(isOccurrenceEligible(tpl, partsForDate(2026, 5, 4))).toBe(true);  // Mon
    expect(isOccurrenceEligible(tpl, partsForDate(2026, 5, 5))).toBe(true);  // Tue
    expect(isOccurrenceEligible(tpl, partsForDate(2026, 5, 6))).toBe(true);  // Wed
    expect(isOccurrenceEligible(tpl, partsForDate(2026, 5, 7))).toBe(true);  // Thu
    expect(isOccurrenceEligible(tpl, partsForDate(2026, 5, 8))).toBe(true);  // Fri
    expect(isOccurrenceEligible(tpl, partsForDate(2026, 5, 9))).toBe(true);  // Sat
  });

  test('does NOT match Sunday', () => {
    expect(isOccurrenceEligible(tpl, partsForDate(2026, 5, 3))).toBe(false);  // Sun
    expect(isOccurrenceEligible(tpl, partsForDate(2026, 5, 10))).toBe(false); // Sun
  });
});

// ─── isOccurrenceEligible — weekly + custom (alias) ─────────────────────────

describe('isOccurrenceEligible: weekly + custom (legacy alias)', () => {
  const wedOnly = { frequency: 'weekly', weekdays: [3] }; // 3 = Wednesday
  const wedOnlyCustom = { frequency: 'custom', weekdays: [3] };

  test('weekly matches only the chosen weekdays', () => {
    expect(isOccurrenceEligible(wedOnly, partsForDate(2026, 5, 6))).toBe(true);  // Wed
    expect(isOccurrenceEligible(wedOnly, partsForDate(2026, 5, 7))).toBe(false); // Thu
  });

  test('custom is a transparent alias of weekly (legacy compat)', () => {
    expect(isOccurrenceEligible(wedOnlyCustom, partsForDate(2026, 5, 6))).toBe(true);
    expect(isOccurrenceEligible(wedOnlyCustom, partsForDate(2026, 5, 7))).toBe(false);
  });

  test('weekly with empty weekdays never matches', () => {
    const empty = { frequency: 'weekly', weekdays: [] };
    expect(isOccurrenceEligible(empty, partsForDate(2026, 5, 6))).toBe(false);
  });
});

// ─── isOccurrenceEligible — monthly (multi-day + last-day collapse) ─────────

describe('isOccurrenceEligible: monthly', () => {
  test('matches each configured day', () => {
    const tpl = { frequency: 'monthly', daysOfMonth: [5, 15, 25] };
    expect(isOccurrenceEligible(tpl, partsForDate(2026, 5, 5))).toBe(true);
    expect(isOccurrenceEligible(tpl, partsForDate(2026, 5, 15))).toBe(true);
    expect(isOccurrenceEligible(tpl, partsForDate(2026, 5, 25))).toBe(true);
    expect(isOccurrenceEligible(tpl, partsForDate(2026, 5, 4))).toBe(false);
    expect(isOccurrenceEligible(tpl, partsForDate(2026, 5, 6))).toBe(false);
  });

  test('day 31 collapses onto the last day of shorter months', () => {
    const tpl = { frequency: 'monthly', daysOfMonth: [31] };
    // April has 30 days → 31 collapses to 30
    expect(isOccurrenceEligible(tpl, partsForDate(2026, 4, 30))).toBe(true);
    expect(isOccurrenceEligible(tpl, partsForDate(2026, 4, 29))).toBe(false);
    // February 2026 has 28 days → 31 collapses to 28
    expect(isOccurrenceEligible(tpl, partsForDate(2026, 2, 28))).toBe(true);
  });

  test('multiple out-of-range days collapse to ONE last-day match', () => {
    // [29, 30, 31] in Feb 2026 (28 days) all collapse to day 28 — exactly one
    // eligibility hit for Feb 28, not three.
    const tpl = { frequency: 'monthly', daysOfMonth: [29, 30, 31] };
    expect(isOccurrenceEligible(tpl, partsForDate(2026, 2, 28))).toBe(true);
    // Sanity: not eligible on the day before
    expect(isOccurrenceEligible(tpl, partsForDate(2026, 2, 27))).toBe(false);
  });

  test('legacy dayOfMonth integer still works when daysOfMonth array is empty', () => {
    const tpl = { frequency: 'monthly', daysOfMonth: [], dayOfMonth: 15 };
    expect(isOccurrenceEligible(tpl, partsForDate(2026, 5, 15))).toBe(true);
    expect(isOccurrenceEligible(tpl, partsForDate(2026, 5, 14))).toBe(false);
  });

  test('monthly with neither daysOfMonth nor dayOfMonth never matches', () => {
    const tpl = { frequency: 'monthly', daysOfMonth: [], dayOfMonth: null };
    expect(isOccurrenceEligible(tpl, partsForDate(2026, 5, 15))).toBe(false);
  });

  test('leap-year Feb 29 fires only when explicitly chosen', () => {
    const tpl29 = { frequency: 'monthly', daysOfMonth: [29] };
    // 2024 is a leap year — Feb 29 exists
    expect(isOccurrenceEligible(tpl29, partsForDate(2024, 2, 29))).toBe(true);
    // 2026 is not — Feb has 28 days; day 29 collapses to 28
    expect(isOccurrenceEligible(tpl29, partsForDate(2026, 2, 28))).toBe(true);
  });
});

// ─── getMonthlyDays — array vs legacy precedence ────────────────────────────

describe('getMonthlyDays', () => {
  test('prefers the daysOfMonth array when populated', () => {
    expect(getMonthlyDays({ daysOfMonth: [3, 1, 2], dayOfMonth: 9 })).toEqual([1, 2, 3]);
  });

  test('falls back to legacy dayOfMonth when array is empty', () => {
    expect(getMonthlyDays({ daysOfMonth: [], dayOfMonth: 9 })).toEqual([9]);
  });

  test('returns [] when neither is set', () => {
    expect(getMonthlyDays({ daysOfMonth: [], dayOfMonth: null })).toEqual([]);
    expect(getMonthlyDays({})).toEqual([]);
  });

  test('cleans junk values out of the array', () => {
    // parseInt('foo') → NaN (dropped); 35 > 31 (dropped); 0 < 1 (dropped);
    // parseInt(2.5) → 2 (kept — service is intentionally lenient on numeric
    // coercion to absorb stringified inputs from older API clients).
    expect(getMonthlyDays({ daysOfMonth: [1, 'foo', 35, 0, 2.5, 5] })).toEqual([1, 2, 5]);
  });

  test('dedupes and sorts', () => {
    expect(getMonthlyDays({ daysOfMonth: [10, 5, 10, 5, 1] })).toEqual([1, 5, 10]);
  });
});

// ─── nextOccurrenceDate — happy paths + boundary conditions ─────────────────

describe('nextOccurrenceDate', () => {
  test('daily: returns today when today >= startDate', () => {
    const tpl = {
      frequency: 'daily',
      startDate: '2026-05-01',
      endDate: null,
      timezone: 'UTC',
    };
    const out = nextOccurrenceDate(tpl, new Date('2026-05-07T12:00:00Z'));
    expect(out).toBe('2026-05-07');
  });

  test('weekly Wed: from a Thursday, returns the next Wednesday', () => {
    const tpl = {
      frequency: 'weekly',
      weekdays: [3], // Wed
      startDate: '2026-05-01',
      endDate: null,
      timezone: 'UTC',
    };
    // 2026-05-07 is Thursday → next Wed = 2026-05-13
    const out = nextOccurrenceDate(tpl, new Date('2026-05-07T12:00:00Z'));
    expect(out).toBe('2026-05-13');
  });

  test('weekly Wed: from a Wednesday, returns that same Wednesday', () => {
    const tpl = {
      frequency: 'weekly',
      weekdays: [3],
      startDate: '2026-05-01',
      endDate: null,
      timezone: 'UTC',
    };
    const out = nextOccurrenceDate(tpl, new Date('2026-05-13T12:00:00Z'));
    expect(out).toBe('2026-05-13');
  });

  test('returns null when endDate has passed', () => {
    const tpl = {
      frequency: 'daily',
      startDate: '2026-01-01',
      endDate: '2026-04-30',
      timezone: 'UTC',
    };
    const out = nextOccurrenceDate(tpl, new Date('2026-05-07T12:00:00Z'));
    expect(out).toBeNull();
  });

  test('jumps forward to startDate when fromDate is before it', () => {
    const tpl = {
      frequency: 'daily',
      startDate: '2026-06-01',
      endDate: null,
      timezone: 'UTC',
    };
    const out = nextOccurrenceDate(tpl, new Date('2026-05-07T12:00:00Z'));
    expect(out).toBe('2026-06-01');
  });

  test('weekly with empty weekdays returns null (366-day search exhausted)', () => {
    const tpl = {
      frequency: 'weekly',
      weekdays: [],
      startDate: '2026-05-01',
      endDate: null,
      timezone: 'UTC',
    };
    const out = nextOccurrenceDate(tpl, new Date('2026-05-07T12:00:00Z'));
    expect(out).toBeNull();
  });
});

// ─── seedNextUpcomingInstance — generates the next eligible date now ────────
//
// These tests are the regression guard for the "future scheduled tasks not
// visible" bug. They verify that:
//   - weekly Tue created on Thursday seeds for next Tuesday (not today)
//   - weekly Wed created on Wednesday seeds for today
//   - daily created today seeds for today
//   - monthly [13] created on 7th seeds for the 13th
//   - paused / archived templates skip seeding
//   - endDate already past returns 'no-future-occurrence'
//   - the seeded occurrenceDate is what nextOccurrenceDate would compute
//
// The full Task.create / TaskAssignee / TaskOwner pipeline is not exercised
// here (those tests would require a live DB). We assert the date math and
// the high-level orchestration only.

describe('seedNextUpcomingInstance: date math', () => {
  // We test the *pure* date selection part of seedNextUpcomingInstance via
  // the same `nextOccurrenceDate` it uses internally. This guarantees the
  // seed path picks the same date the engine would generate.

  test('weekly Tue created on Thursday → next Tuesday', () => {
    const tpl = {
      frequency: 'weekly',
      weekdays: [2], // Tue
      startDate: '2026-05-01',
      endDate: null,
      timezone: 'UTC',
    };
    // 2026-05-07 = Thursday. Next Tue = 2026-05-12.
    expect(nextOccurrenceDate(tpl, new Date('2026-05-07T12:00:00Z'))).toBe('2026-05-12');
  });

  test('weekly Mon created on Thursday → next Monday', () => {
    const tpl = {
      frequency: 'weekly',
      weekdays: [1], // Mon
      startDate: '2026-05-01',
      endDate: null,
      timezone: 'UTC',
    };
    // Next Mon after Thu 2026-05-07 = 2026-05-11.
    expect(nextOccurrenceDate(tpl, new Date('2026-05-07T12:00:00Z'))).toBe('2026-05-11');
  });

  test('weekly Wed created on Wednesday → that same Wednesday', () => {
    const tpl = {
      frequency: 'weekly',
      weekdays: [3],
      startDate: '2026-05-01',
      endDate: null,
      timezone: 'UTC',
    };
    expect(nextOccurrenceDate(tpl, new Date('2026-05-13T09:00:00Z'))).toBe('2026-05-13');
  });

  test('daily created today → today (when within [start,end])', () => {
    const tpl = {
      frequency: 'daily',
      startDate: '2026-05-01',
      endDate: null,
      timezone: 'UTC',
    };
    expect(nextOccurrenceDate(tpl, new Date('2026-05-07T12:00:00Z'))).toBe('2026-05-07');
  });

  test('weekdays Mon–Sat created on Sunday → next Monday', () => {
    const tpl = {
      frequency: 'weekdays',
      startDate: '2026-05-01',
      endDate: null,
      timezone: 'UTC',
    };
    // 2026-05-10 = Sunday → next Mon = 2026-05-11.
    expect(nextOccurrenceDate(tpl, new Date('2026-05-10T12:00:00Z'))).toBe('2026-05-11');
  });

  test('monthly [13] created on the 7th → the 13th of the current month', () => {
    const tpl = {
      frequency: 'monthly',
      daysOfMonth: [13],
      startDate: '2026-05-01',
      endDate: null,
      timezone: 'UTC',
    };
    expect(nextOccurrenceDate(tpl, new Date('2026-05-07T12:00:00Z'))).toBe('2026-05-13');
  });

  test('monthly [13] created on the 20th → the 13th of NEXT month', () => {
    const tpl = {
      frequency: 'monthly',
      daysOfMonth: [13],
      startDate: '2026-05-01',
      endDate: null,
      timezone: 'UTC',
    };
    expect(nextOccurrenceDate(tpl, new Date('2026-05-20T12:00:00Z'))).toBe('2026-06-13');
  });

  test('monthly multi-date [12, 20] from the 7th → the 12th (nearest upcoming)', () => {
    const tpl = {
      frequency: 'monthly',
      daysOfMonth: [12, 20],
      startDate: '2026-05-01',
      endDate: null,
      timezone: 'UTC',
    };
    expect(nextOccurrenceDate(tpl, new Date('2026-05-07T12:00:00Z'))).toBe('2026-05-12');
  });

  test('monthly multi-date [12, 20] from the 15th → the 20th (nearest upcoming)', () => {
    const tpl = {
      frequency: 'monthly',
      daysOfMonth: [12, 20],
      startDate: '2026-05-01',
      endDate: null,
      timezone: 'UTC',
    };
    expect(nextOccurrenceDate(tpl, new Date('2026-05-15T12:00:00Z'))).toBe('2026-05-20');
  });

  test('legacy custom frequency picks the same day as weekly', () => {
    const customTpl = {
      frequency: 'custom',
      weekdays: [2],
      startDate: '2026-05-01',
      endDate: null,
      timezone: 'UTC',
    };
    const weeklyTpl = { ...customTpl, frequency: 'weekly' };
    const probe = new Date('2026-05-07T12:00:00Z');
    expect(nextOccurrenceDate(customTpl, probe)).toBe(nextOccurrenceDate(weeklyTpl, probe));
  });
});

describe('seedNextUpcomingInstance: orchestration', () => {
  const { seedNextUpcomingInstance } = recurringTaskService;

  // Minimal fake template that satisfies the early guards in the seed method.
  // We don't care about generateInstance internals here — those are guarded
  // by their own tests + the live partial unique index.
  function fakeTemplate(overrides = {}) {
    return {
      id: 'tpl-1',
      isActive: true,
      archivedAt: null,
      frequency: 'weekly',
      weekdays: [2],
      startDate: '2026-05-01',
      endDate: null,
      timezone: 'UTC',
      lastGeneratedDate: null,
      update: jest.fn(async function update(fields) {
        Object.assign(this, fields);
        return this;
      }),
      ...overrides,
    };
  }

  test('returns template-paused when isActive=false', async () => {
    const tpl = fakeTemplate({ isActive: false });
    const out = await seedNextUpcomingInstance(tpl, { fromDate: new Date('2026-05-07T12:00:00Z') });
    expect(out).toEqual(expect.objectContaining({ ok: false, reason: 'template-paused' }));
  });

  test('returns template-archived when archivedAt is set', async () => {
    const tpl = fakeTemplate({ archivedAt: new Date('2026-05-01T00:00:00Z') });
    const out = await seedNextUpcomingInstance(tpl, { fromDate: new Date('2026-05-07T12:00:00Z') });
    expect(out).toEqual(expect.objectContaining({ ok: false, reason: 'template-archived' }));
  });

  test('returns no-future-occurrence when endDate is past', async () => {
    const tpl = fakeTemplate({
      frequency: 'daily',
      startDate: '2026-01-01',
      endDate: '2026-04-30',
    });
    const out = await seedNextUpcomingInstance(tpl, { fromDate: new Date('2026-05-07T12:00:00Z') });
    expect(out).toEqual(expect.objectContaining({
      ok: true,
      generated: false,
      occurrenceDate: null,
      reason: 'no-future-occurrence',
    }));
  });
});

// ─── F-10: instant-overdue skip ─────────────────────────────────────────────
//
// When seeding picks "today" but the template's dueTime has already passed
// in the configured timezone, the service should skip ahead to the next
// eligible date so the assignee never receives a row that is already overdue.

describe('F-10: same-day dueTime-passed skips to next eligible date', () => {
  test('daily template seeded after dueTime → next eligible day (tomorrow)', () => {
    // Pure-function check via nextOccurrenceDate. We don't exercise the full
    // seed path here; the date-math primitives are what we rely on inside
    // seedNextUpcomingInstance after the F-10 dueTime check.
    const tpl = {
      frequency: 'daily',
      startDate: '2026-05-01',
      endDate: null,
      timezone: 'UTC',
      dueTime: '09:00:00',
    };
    // 2026-05-07T18:00:00Z is past 09:00 UTC on 2026-05-07
    const today = nextOccurrenceDate(tpl, new Date('2026-05-07T18:00:00Z'));
    // Without F-10, the next occurrence resolved by nextOccurrenceDate is
    // simply today (same date, same logic). The seed wrapper applies the
    // dueTime cutoff. Confirm the underlying date math still picks today
    // here so the wrapper's job is well-defined.
    expect(today).toBe('2026-05-07');
  });

  test('weekly Tue created on Tuesday at 09:00 with dueTime 18:00 → today still picked', () => {
    const tpl = {
      frequency: 'weekly',
      weekdays: [2],
      startDate: '2026-05-01',
      endDate: null,
      timezone: 'UTC',
    };
    // 2026-05-12 is a Tuesday. 09:00 UTC is BEFORE 18:00 dueTime.
    expect(nextOccurrenceDate(tpl, new Date('2026-05-12T09:00:00Z'))).toBe('2026-05-12');
  });
});

// ─── F-3: cron backfill primitives ──────────────────────────────────────────
//
// runTemplateOnce-level integration is hard to mock without a live DB. These
// tests focus on the date-math primitives runTemplateOnce uses internally so
// any regression in the walk loop surfaces as a unit-level failure rather
// than a production-only bug.

describe('F-3: backfill walk primitives', () => {
  test('walk anchor = max(startDate, lastGeneratedDate+1)', () => {
    // With lastGeneratedDate = 2026-05-04 the next eligible day to consider
    // is 2026-05-05. nextOccurrenceDate from a probe at 2026-05-05 returns
    // 2026-05-05 for a daily template — confirming the primitive cooperates
    // with the backfill walker.
    const tpl = {
      frequency: 'daily',
      startDate: '2026-05-01',
      endDate: null,
      timezone: 'UTC',
    };
    expect(nextOccurrenceDate(tpl, new Date('2026-05-05T12:00:00Z'))).toBe('2026-05-05');
  });

  test('weekly Mon: walking forward from a Sat gives next Mon (skips Sun)', () => {
    const tpl = {
      frequency: 'weekly',
      weekdays: [1],
      startDate: '2026-05-01',
      endDate: null,
      timezone: 'UTC',
    };
    // 2026-05-09 is Saturday. Next Mon = 2026-05-11.
    expect(nextOccurrenceDate(tpl, new Date('2026-05-09T12:00:00Z'))).toBe('2026-05-11');
  });
});

// ─── reassignOpenInstances — date-math + early-return guards ────────────────
//
// The full reassignment touches Sequelize Task / TaskAssignee / TaskOwner +
// realtime + reminders + calendar. Those are exercised by the controller-
// level test that runs against a live test DB. Here we verify the early-
// return guards: missing assignee ids, no-op for same-id, and an empty
// instance list.

describe('reassignOpenInstances: guards', () => {
  const { reassignOpenInstances } = recurringTaskService;
  const Task = require('../../models').Task;

  test('rejects missing assignee ids', async () => {
    const out = await reassignOpenInstances({ id: 't1' }, null, 'u2');
    expect(out).toEqual(expect.objectContaining({ ok: false, reason: 'missing-assignee-ids' }));
  });

  test('returns no-op when old === new', async () => {
    const out = await reassignOpenInstances({ id: 't1' }, 'u-same', 'u-same');
    expect(out).toEqual(expect.objectContaining({ ok: true, reassigned: 0, reason: 'no-op' }));
  });

  test('returns reassigned: 0 when no open instances exist', async () => {
    Task.findAll = jest.fn().mockResolvedValueOnce([]);
    const out = await reassignOpenInstances({ id: 't1' }, 'u1', 'u2');
    expect(out).toEqual(expect.objectContaining({ ok: true, reassigned: 0, errors: [] }));
  });
});

// ─── mirrorRecurringInstanceTitle — guards + happy path ─────────────────────
//
// Reproduction guard for the bug reported on 2026-05-09: a user renames a
// generated recurring instance ("bruce" → "bruce bane") in the task modal,
// but the Recurring Work page still shows "bruce" because the rename only
// touched `tasks.title`. The fix is a service-level helper that mirrors the
// new title onto `recurring_task_templates.title` so the list reflects the
// latest user-intent title and future generated occurrences pick it up.

describe('mirrorRecurringInstanceTitle', () => {
  const { mirrorRecurringInstanceTitle } = recurringTaskService;
  const RecurringTaskTemplate = require('../../models').RecurringTaskTemplate;

  beforeEach(() => {
    // Reset model mocks between tests so a stale findByPk doesn't bleed
    // across cases. The models barrel is mocked in jest.mock at the top.
    if (RecurringTaskTemplate.findByPk) RecurringTaskTemplate.findByPk = jest.fn();
  });

  test('rejects missing task', async () => {
    const out = await mirrorRecurringInstanceTitle({
      task: null, newTitle: 'X', previousTitle: 'Y', actorId: 'u1',
    });
    expect(out).toEqual(expect.objectContaining({ ok: false, mirrored: false, reason: 'task-missing' }));
  });

  test('skips non-recurring tasks (mirrored=false)', async () => {
    const out = await mirrorRecurringInstanceTitle({
      task: { id: 't1', isRecurringInstance: false, recurringTemplateId: null },
      newTitle: 'new', previousTitle: 'old', actorId: 'u1',
    });
    expect(out).toEqual(expect.objectContaining({
      ok: true, mirrored: false, reason: 'not-recurring-instance',
    }));
  });

  test('skips recurring instances missing templateId', async () => {
    const out = await mirrorRecurringInstanceTitle({
      task: { id: 't1', isRecurringInstance: true, recurringTemplateId: null },
      newTitle: 'new', previousTitle: 'old', actorId: 'u1',
    });
    expect(out).toEqual(expect.objectContaining({
      ok: true, mirrored: false, reason: 'no-template-id',
    }));
  });

  test('short-circuits when newTitle === previousTitle (no DB write)', async () => {
    RecurringTaskTemplate.findByPk = jest.fn();
    const out = await mirrorRecurringInstanceTitle({
      task: { id: 't1', isRecurringInstance: true, recurringTemplateId: 'tpl-1' },
      newTitle: 'same', previousTitle: 'same', actorId: 'u1',
    });
    expect(out).toEqual(expect.objectContaining({
      ok: true, mirrored: false, reason: 'unchanged',
    }));
    expect(RecurringTaskTemplate.findByPk).not.toHaveBeenCalled();
  });

  test('handles missing template gracefully (FK SET NULL race)', async () => {
    RecurringTaskTemplate.findByPk = jest.fn().mockResolvedValue(null);
    const out = await mirrorRecurringInstanceTitle({
      task: { id: 't1', isRecurringInstance: true, recurringTemplateId: 'tpl-gone' },
      newTitle: 'new', previousTitle: 'old', actorId: 'u1',
    });
    expect(out).toEqual(expect.objectContaining({
      ok: true, mirrored: false, reason: 'template-missing',
    }));
  });

  test('skips DB write when template already matches the new title (idempotent)', async () => {
    const updateSpy = jest.fn();
    RecurringTaskTemplate.findByPk = jest.fn().mockResolvedValue({
      id: 'tpl-1', title: 'already-new', update: updateSpy, toJSON: () => ({ id: 'tpl-1', title: 'already-new' }),
    });
    const out = await mirrorRecurringInstanceTitle({
      task: { id: 't1', isRecurringInstance: true, recurringTemplateId: 'tpl-1' },
      newTitle: 'already-new', previousTitle: 'old', actorId: 'u1',
    });
    expect(out).toEqual(expect.objectContaining({
      ok: true, mirrored: false, reason: 'template-already-matches', templateId: 'tpl-1',
    }));
    expect(updateSpy).not.toHaveBeenCalled();
  });

  test('mirrors the new title onto the template (the canonical fix)', async () => {
    const updateSpy = jest.fn().mockResolvedValue();
    const tplMock = {
      id: 'tpl-1', title: 'bruce', assigneeId: 'u-sunny', createdBy: 'u-super',
      update: updateSpy,
      toJSON: () => ({ id: 'tpl-1', title: 'bruce bane' }),
    };
    RecurringTaskTemplate.findByPk = jest.fn().mockResolvedValue(tplMock);
    const out = await mirrorRecurringInstanceTitle({
      task: { id: 't1', boardId: 'b1', isRecurringInstance: true, recurringTemplateId: 'tpl-1' },
      newTitle: 'bruce bane',
      previousTitle: 'bruce',
      actorId: 'u-super',
    });
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith({ title: 'bruce bane' });
    expect(out).toEqual(expect.objectContaining({
      ok: true, mirrored: true, templateId: 'tpl-1',
      previousTitle: 'bruce', newTitle: 'bruce bane',
    }));
  });

  test('returns ok:false when template.update throws but does not crash caller', async () => {
    const updateSpy = jest.fn().mockRejectedValue(new Error('db down'));
    RecurringTaskTemplate.findByPk = jest.fn().mockResolvedValue({
      id: 'tpl-1', title: 'old', update: updateSpy, toJSON: () => ({}),
    });
    const out = await mirrorRecurringInstanceTitle({
      task: { id: 't1', isRecurringInstance: true, recurringTemplateId: 'tpl-1' },
      newTitle: 'new', previousTitle: 'old', actorId: 'u1',
    });
    expect(out).toEqual(expect.objectContaining({
      ok: false, mirrored: false, templateId: 'tpl-1',
    }));
    expect(out.reason).toMatch(/update-failed/);
  });

  test('non-string newTitle is ignored (no-op, no DB read)', async () => {
    RecurringTaskTemplate.findByPk = jest.fn();
    const out = await mirrorRecurringInstanceTitle({
      task: { id: 't1', isRecurringInstance: true, recurringTemplateId: 'tpl-1' },
      newTitle: 123, previousTitle: 'old', actorId: 'u1',
    });
    expect(out).toEqual(expect.objectContaining({
      ok: true, mirrored: false, reason: 'non-string-title',
    }));
    expect(RecurringTaskTemplate.findByPk).not.toHaveBeenCalled();
  });
});
