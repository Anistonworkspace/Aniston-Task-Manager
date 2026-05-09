import { describe, it, expect } from 'vitest';
import {
  buildScheduleSummary,
  formatSchedule,
  normalizeFrequencyForUI,
  getMonthlyDaysFromTemplate,
  formatDueTime12h,
  WEEKDAY_LABELS,
} from '../recurringTasks';

// These tests cover the schedule-display contract used by RecurringTemplateModal
// and RecurringWorkPage. Pure functions — no React or network. The schedule
// summary is what the user sees in the modal header; a regression here means
// users can't tell what schedule is configured.

describe('buildScheduleSummary', () => {
  it('daily renders "Every day"', () => {
    const out = buildScheduleSummary({
      frequency: 'daily',
      dueTime: '09:30:00',
      timezone: 'UTC',
      startDate: '2026-05-01',
    });
    expect(out.kind).toBe('Daily');
    expect(out.summary).toBe('Every day');
    expect(out.dueTime).toBe('9:30 AM');
    expect(out.timezone).toBe('UTC');
  });

  it('weekdays renders the Mon–Sat hint and excludes Sunday', () => {
    const out = buildScheduleSummary({ frequency: 'weekdays', dueTime: '18:00:00', timezone: 'UTC' });
    expect(out.kind).toBe('Weekdays');
    expect(out.summary).toMatch(/Mon\s*[–-]\s*Sat/);
    expect(out.summary).toMatch(/Sunday/i);
  });

  it('weekly with [1,3,5] renders Mon, Wed, Fri', () => {
    const out = buildScheduleSummary({
      frequency: 'weekly',
      weekdays: [1, 3, 5],
      dueTime: '18:00:00',
      timezone: 'UTC',
    });
    expect(out.kind).toBe('Custom days');
    expect(out.summary).toBe('Mon, Wed, Fri');
    expect(out.days).toEqual(['Mon', 'Wed', 'Fri']);
  });

  it('legacy custom frequency aliases onto Custom days with same payload', () => {
    const out = buildScheduleSummary({
      frequency: 'custom',
      weekdays: [2],
      dueTime: '18:00:00',
      timezone: 'UTC',
    });
    expect(out.kind).toBe('Custom days');
    expect(out.summary).toBe('Tue');
  });

  it('weekly with empty weekdays renders the "no weekdays" guard', () => {
    const out = buildScheduleSummary({ frequency: 'weekly', weekdays: [], dueTime: '18:00:00' });
    expect(out.summary).toMatch(/no weekdays/i);
    expect(out.days).toEqual([]);
  });

  it('monthly with [5, 15, 28] renders "Day 5, Day 15, Day 28"', () => {
    const out = buildScheduleSummary({
      frequency: 'monthly',
      daysOfMonth: [28, 5, 15],
      dueTime: '09:00:00',
      timezone: 'Asia/Kolkata',
    });
    expect(out.kind).toBe('Monthly');
    // getMonthlyDaysFromTemplate sorts ascending — confirm display follows.
    expect(out.summary).toBe('Day 5, Day 15, Day 28');
    expect(out.timezone).toBe('Asia/Kolkata');
  });

  it('monthly with legacy dayOfMonth integer falls back gracefully', () => {
    const out = buildScheduleSummary({
      frequency: 'monthly',
      daysOfMonth: [],
      dayOfMonth: 15,
      dueTime: '09:00:00',
    });
    expect(out.kind).toBe('Monthly');
    expect(out.summary).toBe('Day 15');
  });

  it('monthly with no day configured renders the "no days" guard', () => {
    const out = buildScheduleSummary({ frequency: 'monthly', daysOfMonth: [], dueTime: '09:00:00' });
    expect(out.summary).toMatch(/no days/i);
  });

  it('preserves startDate / endDate window in the payload', () => {
    const out = buildScheduleSummary({
      frequency: 'daily',
      dueTime: '09:00:00',
      startDate: '2026-05-01',
      endDate: '2026-12-31',
    });
    expect(out.startDate).toBe('2026-05-01');
    expect(out.endDate).toBe('2026-12-31');
  });
});

describe('formatSchedule (one-line variant for rows)', () => {
  it('daily includes the dueTime + timezone parens', () => {
    expect(formatSchedule({ frequency: 'daily', dueTime: '18:00:00', timezone: 'Asia/Kolkata' }))
      .toMatch(/Daily at 6:00 PM \(Asia\/Kolkata\)/);
  });

  it('weekly with [1,3] joins days with a middle-dot separator', () => {
    const out = formatSchedule({ frequency: 'weekly', weekdays: [1, 3], dueTime: '09:00:00', timezone: 'UTC' });
    expect(out).toContain('Mon');
    expect(out).toContain('Wed');
    expect(out).toContain('·');
  });

  it('monthly single-day uses ordinal suffix', () => {
    expect(formatSchedule({ frequency: 'monthly', daysOfMonth: [21], dueTime: '09:00:00', timezone: 'UTC' }))
      .toMatch(/Monthly on day 21st/);
  });

  it('monthly multi-day lists the days', () => {
    expect(formatSchedule({ frequency: 'monthly', daysOfMonth: [5, 15], dueTime: '09:00:00', timezone: 'UTC' }))
      .toMatch(/Monthly on days 5, 15/);
  });
});

describe('normalizeFrequencyForUI', () => {
  it('aliases the legacy custom value onto weekly', () => {
    expect(normalizeFrequencyForUI('custom')).toBe('weekly');
  });

  it('passes other values through', () => {
    expect(normalizeFrequencyForUI('daily')).toBe('daily');
    expect(normalizeFrequencyForUI('monthly')).toBe('monthly');
  });

  it('falls back to daily on missing input', () => {
    expect(normalizeFrequencyForUI(undefined)).toBe('daily');
    expect(normalizeFrequencyForUI(null)).toBe('daily');
  });
});

describe('getMonthlyDaysFromTemplate', () => {
  it('prefers the array when populated', () => {
    expect(getMonthlyDaysFromTemplate({ daysOfMonth: [3, 1, 2], dayOfMonth: 9 })).toEqual([1, 2, 3]);
  });

  it('falls back to the legacy integer', () => {
    expect(getMonthlyDaysFromTemplate({ daysOfMonth: [], dayOfMonth: 9 })).toEqual([9]);
  });

  it('returns [] on missing input', () => {
    expect(getMonthlyDaysFromTemplate({})).toEqual([]);
    expect(getMonthlyDaysFromTemplate(null)).toEqual([]);
  });
});

describe('formatDueTime12h', () => {
  it('renders midnight as 12:00 AM', () => {
    expect(formatDueTime12h('00:00:00')).toBe('12:00 AM');
  });

  it('renders noon as 12:00 PM', () => {
    expect(formatDueTime12h('12:00:00')).toBe('12:00 PM');
  });

  it('renders 6:30 PM correctly', () => {
    expect(formatDueTime12h('18:30:00')).toBe('6:30 PM');
  });
});

describe('WEEKDAY_LABELS shape contract', () => {
  it('is 0=Sun … 6=Sat', () => {
    expect(WEEKDAY_LABELS[0]).toBe('Sun');
    expect(WEEKDAY_LABELS[6]).toBe('Sat');
    expect(WEEKDAY_LABELS).toHaveLength(7);
  });
});
