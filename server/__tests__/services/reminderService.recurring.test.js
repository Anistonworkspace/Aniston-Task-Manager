/**
 * Unit tests for the recurring-reminder surface of reminderService:
 *
 *   normalizeReminderSpecs   — validation of `interval` + `daily_times`
 *   processReminders         — re-arm logic after a successful fire
 *
 * Both new reminderType values fire UNTIL the task is marked done or
 * archived. The interesting behaviours under test:
 *
 *   - `interval`: bounds (15–10080), first-fire = now + intervalMinutes,
 *     re-arm advances scheduledFor by intervalMinutes and clears sentAt.
 *   - `daily_times`: HH:MM validation, dedup + sort, 1–12 entries cap,
 *     re-arm advances to the next clock slot in the configured timezone.
 *   - Stop conditions: task done OR isArchived → cancel instead of re-arm.
 *
 * Like the sibling `reminderService.userSpecs.test.js`, the Sequelize models
 * layer is fully mocked — these are pure unit tests.
 */

'use strict';

process.env.LOG_LEVEL = 'error';

const mockTaskReminderFindAll = jest.fn();
const mockTaskReminderUpdate = jest.fn();
const mockTaskFindByPk = jest.fn();
const mockTaskAssigneeFindAll = jest.fn();
const mockUserFindByPk = jest.fn();
const mockSendNotification = jest.fn();

jest.mock('../../config/db', () => ({ sequelize: {} }));

jest.mock('../../models', () => ({
  TaskReminder: {
    findAll: (...a) => mockTaskReminderFindAll(...a),
    update: (...a) => mockTaskReminderUpdate(...a),
  },
  Task: {
    findByPk: (...a) => mockTaskFindByPk(...a),
  },
  Board: {},
  TaskAssignee: {
    findAll: (...a) => mockTaskAssigneeFindAll(...a),
  },
  User: {
    findByPk: (...a) => mockUserFindByPk(...a),
  },
}));

jest.mock('../../services/notificationService', () => ({
  sendNotification: (...a) => mockSendNotification(...a),
  buildIdempotencyKey: (...parts) => parts.join(':'),
}));

jest.mock('../../utils/taskOverdueEligibility', () => ({
  isTaskEligibleForOverdueNotification: () => ({ eligible: true }),
}));

jest.mock('../../utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const {
  normalizeReminderSpecs,
  processReminders,
  MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
  MAX_DAILY_TIMES,
} = require('../../services/reminderService');

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── normalizeReminderSpecs: interval ─────────────────────────────────────

describe('normalizeReminderSpecs() — interval', () => {
  it('accepts valid intervalMinutes within bounds', () => {
    const { specs, errors } = normalizeReminderSpecs([
      { kind: 'interval', intervalMinutes: 60 },
    ]);
    expect(errors).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(specs[0].reminderType).toBe('interval');
    expect(specs[0].intervalMinutes).toBe(60);
    // Other discriminator columns must be null for interval rows.
    expect(specs[0].offsetMinutes).toBeNull();
    expect(specs[0].customReminderAt).toBeNull();
    expect(specs[0].timesOfDay).toBeNull();
  });

  it('rejects intervalMinutes below MIN_INTERVAL_MINUTES', () => {
    const { specs, errors } = normalizeReminderSpecs([
      { kind: 'interval', intervalMinutes: MIN_INTERVAL_MINUTES - 1 },
    ]);
    expect(specs).toEqual([]);
    expect(errors[0]).toMatch(/intervalMinutes/);
  });

  it('rejects intervalMinutes above MAX_INTERVAL_MINUTES', () => {
    const { specs, errors } = normalizeReminderSpecs([
      { kind: 'interval', intervalMinutes: MAX_INTERVAL_MINUTES + 1 },
    ]);
    expect(specs).toEqual([]);
    expect(errors[0]).toMatch(/intervalMinutes/);
  });

  it('rejects non-integer intervalMinutes', () => {
    const { specs, errors } = normalizeReminderSpecs([
      { kind: 'interval', intervalMinutes: 60.5 },
    ]);
    expect(specs).toEqual([]);
    expect(errors[0]).toMatch(/intervalMinutes/);
  });

  it('dedupes duplicate interval specs within one request (singleton per task)', () => {
    const { specs } = normalizeReminderSpecs([
      { kind: 'interval', intervalMinutes: 60 },
      { kind: 'interval', intervalMinutes: 120 }, // ignored — already seen
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0].intervalMinutes).toBe(60);
  });
});

// ─── normalizeReminderSpecs: daily_times ──────────────────────────────────

describe('normalizeReminderSpecs() — daily_times', () => {
  it('accepts a valid HH:MM list and sorts + dedupes the times', () => {
    const { specs, errors } = normalizeReminderSpecs([
      { kind: 'daily_times', times: ['18:00', '09:00', '09:00'] },
    ]);
    expect(errors).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(specs[0].reminderType).toBe('daily_times');
    expect(specs[0].timesOfDay).toEqual(['09:00', '18:00']);
    // Default timezone should be applied when client omits one.
    expect(typeof specs[0].timezone).toBe('string');
    expect(specs[0].timezone.length).toBeGreaterThan(0);
  });

  it('rejects non-HH:MM strings', () => {
    const { specs, errors } = normalizeReminderSpecs([
      { kind: 'daily_times', times: ['09:00', '25:00'] }, // 25:00 invalid
    ]);
    expect(specs).toEqual([]);
    expect(errors[0]).toMatch(/Invalid time-of-day/);
  });

  it('rejects empty times arrays', () => {
    const { specs, errors } = normalizeReminderSpecs([
      { kind: 'daily_times', times: [] },
    ]);
    expect(specs).toEqual([]);
    expect(errors[0]).toMatch(/at least one|requires `times`/i);
  });

  it('rejects more than MAX_DAILY_TIMES entries', () => {
    const tooMany = Array.from({ length: MAX_DAILY_TIMES + 1 }, (_, i) => {
      const h = String(i % 24).padStart(2, '0');
      return `${h}:00`;
    });
    const { specs, errors } = normalizeReminderSpecs([
      { kind: 'daily_times', times: tooMany },
    ]);
    expect(specs).toEqual([]);
    expect(errors[0]).toMatch(/at most/);
  });

  it('accepts an explicit IANA timezone', () => {
    const { specs } = normalizeReminderSpecs([
      { kind: 'daily_times', times: ['08:00'], timezone: 'America/New_York' },
    ]);
    expect(specs[0].timezone).toBe('America/New_York');
  });

  it('falls back to default timezone when the provided one is invalid', () => {
    const { specs } = normalizeReminderSpecs([
      { kind: 'daily_times', times: ['08:00'], timezone: 'Not/A_Real_Zone' },
    ]);
    // normalizeTimezone collapses bad input to the default; we don't assert
    // the exact string here so changing the default doesn't break the test.
    expect(typeof specs[0].timezone).toBe('string');
    expect(specs[0].timezone).not.toBe('Not/A_Real_Zone');
  });

  it('dedupes duplicate daily_times specs within one request', () => {
    const { specs } = normalizeReminderSpecs([
      { kind: 'daily_times', times: ['09:00'] },
      { kind: 'daily_times', times: ['18:00'] }, // ignored — singleton per task
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0].timesOfDay).toEqual(['09:00']);
  });
});

// ─── processReminders re-arm semantics ────────────────────────────────────
//
// Building a realistic processReminders fixture: one pending interval row,
// one assignee, and a per-test Task.findByPk mock that returns the
// task state we want to assert against.

function makeInstance(initial) {
  const row = { ...initial };
  row.update = jest.fn(async (patch) => {
    Object.assign(row, patch);
    return row;
  });
  return row;
}

const TASK_ID = 't-recur-1';
const USER_ID = 'u-1';
const REMINDER_ID = 'r-recur-1';

function setupOnePendingReminder(reminderOverrides) {
  const reminder = makeInstance({
    id: REMINDER_ID,
    taskId: TASK_ID,
    reminderType: 'interval',
    intervalMinutes: 60,
    timesOfDay: null,
    timezone: null,
    scheduledFor: new Date(Date.now() - 60_000), // due 1 min ago
    sentAt: null,
    lastFiredAt: null,
    cancelled: false,
    ...reminderOverrides,
  });
  mockTaskReminderFindAll.mockResolvedValue([reminder]);
  // The conditional CLAIM update: returns [affectedCount].
  mockTaskReminderUpdate.mockResolvedValue([1]);
  mockTaskAssigneeFindAll.mockResolvedValue([
    { user: { id: USER_ID, name: 'Alice', email: 'a@x.test' } },
  ]);
  mockUserFindByPk.mockResolvedValue(null); // assignedTo path: not needed
  mockSendNotification.mockResolvedValue(undefined);
  return reminder;
}

describe('processReminders() — interval re-arm', () => {
  it('after a successful fire, advances scheduledFor by intervalMinutes and clears sentAt', async () => {
    const reminder = setupOnePendingReminder();
    const fireMoment = Date.now();
    mockTaskFindByPk.mockResolvedValue({
      id: TASK_ID,
      title: 'Repeating thing',
      status: 'in_progress',
      isArchived: false,
      assignedTo: null,
      dueDate: null,
      board: { id: 'b-1', name: 'Board' },
    });

    await processReminders();

    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    // The first row.update call is the CLAIM. The last update call is the
    // re-arm. We assert on the re-arm payload.
    const lastUpdate = reminder.update.mock.calls.at(-1)[0];
    expect(lastUpdate.sentAt).toBeNull();
    expect(lastUpdate.lastFiredAt).toBeInstanceOf(Date);
    expect(lastUpdate.scheduledFor).toBeInstanceOf(Date);
    // scheduledFor should be roughly fireMoment + 60 min. We allow a ~5s
    // skew because `now` inside processReminders is captured before the
    // test reads Date.now() here.
    const diffMs = lastUpdate.scheduledFor.getTime() - fireMoment;
    const expectedMs = 60 * 60_000;
    expect(Math.abs(diffMs - expectedMs)).toBeLessThan(5000);
    expect(lastUpdate.cancelled).toBeUndefined(); // re-arm doesn't cancel
  });

  it('cancels instead of re-arming when the task has been marked done', async () => {
    const reminder = setupOnePendingReminder();
    mockTaskFindByPk
      // First findByPk = top of the loop, before the claim. Task is still
      // in_progress at that point (otherwise we'd skip + cancel earlier).
      .mockResolvedValueOnce({
        id: TASK_ID, title: 'Repeating thing',
        status: 'in_progress', isArchived: false,
        assignedTo: null, dueDate: null,
        board: { id: 'b-1', name: 'Board' },
      })
      // Second findByPk = the defensive re-check before re-arming. Task
      // got marked done in the interim.
      .mockResolvedValueOnce({
        id: TASK_ID, status: 'done', isArchived: false,
      });

    await processReminders();

    // Re-arm step should set cancelled=true rather than clear sentAt.
    const lastUpdate = reminder.update.mock.calls.at(-1)[0];
    expect(lastUpdate.cancelled).toBe(true);
    expect(lastUpdate.lastFiredAt).toBeInstanceOf(Date);
    expect(lastUpdate.sentAt).toBeUndefined();
  });

  it('cancels instead of re-arming when the task is archived', async () => {
    const reminder = setupOnePendingReminder();
    mockTaskFindByPk
      .mockResolvedValueOnce({
        id: TASK_ID, title: 'Repeating thing',
        status: 'in_progress', isArchived: false,
        assignedTo: null, dueDate: null,
        board: { id: 'b-1', name: 'Board' },
      })
      .mockResolvedValueOnce({
        id: TASK_ID, status: 'in_progress', isArchived: true,
      });

    await processReminders();

    const lastUpdate = reminder.update.mock.calls.at(-1)[0];
    expect(lastUpdate.cancelled).toBe(true);
  });
});

describe('processReminders() — daily_times re-arm', () => {
  it('after a fire, advances scheduledFor to the next HH:MM slot', async () => {
    const reminder = setupOnePendingReminder({
      reminderType: 'daily_times',
      intervalMinutes: null,
      timesOfDay: ['09:00', '18:00'],
      timezone: 'Asia/Kolkata',
    });
    mockTaskFindByPk.mockResolvedValue({
      id: TASK_ID, title: 'Daily standup',
      status: 'in_progress', isArchived: false,
      assignedTo: null, dueDate: null,
      board: { id: 'b-1', name: 'Board' },
    });

    await processReminders();

    const lastUpdate = reminder.update.mock.calls.at(-1)[0];
    expect(lastUpdate.sentAt).toBeNull();
    expect(lastUpdate.scheduledFor).toBeInstanceOf(Date);
    // We don't assert the exact Date because that depends on the current
    // wall-clock vs. the configured TZ. But scheduledFor must be in the
    // future (strictly after now).
    expect(lastUpdate.scheduledFor.getTime()).toBeGreaterThan(Date.now());
  });
});
