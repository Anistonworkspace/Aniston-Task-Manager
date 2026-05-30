'use strict';

/**
 * Meeting controller — meeting/reminder creation across tiers + type rules.
 *
 * Covers the fixes from the May 2026 "all tiers can create meetings + real
 * Reminder type + Follow-up removed" change:
 *   - No tier gate on create (Tier 1-4 all reach 201; the old isTier4 403 is gone).
 *   - type must be meeting | reminder; follow_up (and anything else) -> 400.
 *   - Meeting requires endTime and start < end.
 *   - Reminder: no end/location/participants; schedule 'once' -> 1 row,
 *     'repeat' -> N rows (buildReminderOccurrences).
 *
 * No DB — models/services are mocked, matching the repo's controller-test convention.
 */

const mockBulkCreate = jest.fn();
const mockFindByPk = jest.fn();
const mockUserFindAll = jest.fn();

jest.mock('../../models', () => ({
  Meeting: { bulkCreate: (...a) => mockBulkCreate(...a), findByPk: (...a) => mockFindByPk(...a) },
  User: { findAll: (...a) => mockUserFindAll(...a) },
  Task: {},
  Board: {},
  Notification: {},
}));

jest.mock('../../config/db', () => ({
  sequelize: { transaction: async (fn) => fn({ /* fake tx */ }) },
}));

jest.mock('../../services/socketService', () => ({ emitToUser: jest.fn() }));
jest.mock('../../services/realtimeService', () => ({ emitMeetingChanged: jest.fn() }));
jest.mock('../../services/activityService', () => ({ logActivity: jest.fn() }));
jest.mock('../../utils/sanitize', () => ({ sanitizeInput: (s) => s }));
jest.mock('../../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue(true),
  buildIdempotencyKey: (...parts) => parts.join(':'),
}));
jest.mock('../../config/userAttributes', () => ({ PILL_ATTRIBUTES: ['id', 'name'] }));

const {
  createMeeting,
  updateMeeting,
  buildReminderOccurrences,
} = require('../../controllers/meetingController');

function mockRes() {
  const res = {};
  res.statusCode = 200;
  res.body = null;
  res.status = jest.fn((c) => { res.statusCode = c; return res; });
  res.json = jest.fn((b) => { res.body = b; return res; });
  return res;
}

const userFor = (tier) => ({ id: `u-${tier}`, name: `User T${tier}`, tier, role: tier <= 2 ? 'admin' : 'member', isSuperAdmin: tier === 1 });

beforeEach(() => {
  jest.clearAllMocks();
  // bulkCreate echoes one {id} per row it was asked to create.
  mockBulkCreate.mockImplementation(async (rows) => rows.map((r, i) => ({ id: `m-${i}`, ...r })));
  mockFindByPk.mockResolvedValue({ id: 'm-0', toJSON: () => ({ id: 'm-0' }) });
  mockUserFindAll.mockResolvedValue([]);
});

describe('createMeeting — tier access (all tiers 1-4 may create)', () => {
  it.each([1, 2, 3, 4])('Tier %i can create a meeting (201, no 403)', async (tier) => {
    const req = { user: userFor(tier), body: { title: 'M', date: '2026-06-01', startTime: '09:00', endTime: '10:00', type: 'meeting' } };
    const res = mockRes();
    await createMeeting(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.count).toBe(1);
  });

  it.each([1, 2, 3, 4])('Tier %i can create a reminder (201)', async (tier) => {
    const req = { user: userFor(tier), body: { title: 'R', date: '2026-06-01', startTime: '09:00', type: 'reminder', reminder: { schedule: 'once' } } };
    const res = mockRes();
    await createMeeting(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.message).toMatch(/reminder/i);
  });
});

describe('createMeeting — type validation', () => {
  it('rejects follow_up with 400', async () => {
    const req = { user: userFor(4), body: { title: 'F', date: '2026-06-01', startTime: '09:00', endTime: '10:00', type: 'follow_up' } };
    const res = mockRes();
    await createMeeting(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/meeting.*reminder/i);
    expect(mockBulkCreate).not.toHaveBeenCalled();
  });

  it('rejects an unknown type with 400', async () => {
    const req = { user: userFor(1), body: { title: 'X', date: '2026-06-01', startTime: '09:00', endTime: '10:00', type: 'webinar' } };
    const res = mockRes();
    await createMeeting(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('defaults missing type to meeting', async () => {
    const req = { user: userFor(4), body: { title: 'M', date: '2026-06-01', startTime: '09:00', endTime: '10:00' } };
    const res = mockRes();
    await createMeeting(req, res);
    expect(res.statusCode).toBe(201);
    expect(mockBulkCreate.mock.calls[0][0][0].type).toBe('meeting');
  });
});

describe('createMeeting — meeting field rules', () => {
  it('requires endTime for meetings', async () => {
    const req = { user: userFor(2), body: { title: 'M', date: '2026-06-01', startTime: '09:00', type: 'meeting' } };
    const res = mockRes();
    await createMeeting(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/end time/i);
  });

  it('rejects end <= start', async () => {
    const req = { user: userFor(2), body: { title: 'M', date: '2026-06-01', startTime: '10:00', endTime: '09:00', type: 'meeting' } };
    const res = mockRes();
    await createMeeting(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('keeps location + persists a single row for a meeting', async () => {
    const req = { user: userFor(1), body: { title: 'M', date: '2026-06-01', startTime: '09:00', endTime: '10:00', location: 'Room A', type: 'meeting' } };
    const res = mockRes();
    await createMeeting(req, res);
    const rows = mockBulkCreate.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0].location).toBe('Room A');
  });
});

describe('createMeeting — reminder behavior', () => {
  it('reminder "once" creates exactly 1 row, endTime mirrors startTime, no location/participants', async () => {
    const req = { user: userFor(4), body: { title: 'R', date: '2026-06-01', startTime: '09:15', location: 'ignored', participants: ['x'], type: 'reminder', reminder: { schedule: 'once' } } };
    const res = mockRes();
    await createMeeting(req, res);
    expect(res.statusCode).toBe(201);
    const rows = mockBulkCreate.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('reminder');
    expect(rows[0].endTime).toBe('09:15');
    expect(rows[0].location).toBeNull();
    expect(rows[0].participants).toEqual([]);
    // Reminders never look up participants.
    expect(mockUserFindAll).not.toHaveBeenCalled();
  });

  it('reminder "repeat" every 1 day x3 creates 3 rows on consecutive days', async () => {
    const req = { user: userFor(3), body: { title: 'R', date: '2026-06-01', startTime: '09:00', type: 'reminder', reminder: { schedule: 'repeat', repeatEvery: 1, repeatUnit: 'days', repeatCount: 3 } } };
    const res = mockRes();
    await createMeeting(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.data.count).toBe(3);
    const rows = mockBulkCreate.mock.calls[0][0];
    expect(rows.map(r => r.date)).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
  });
});

describe('updateMeeting — rejects follow_up type', () => {
  it('returns 400 when updating a meeting to type follow_up', async () => {
    mockFindByPk.mockResolvedValueOnce({ id: 'm-0', createdBy: 'u-1', type: 'meeting', update: jest.fn() });
    const req = { params: { id: 'm-0' }, user: { id: 'u-1', role: 'admin' }, body: { type: 'follow_up' } };
    const res = mockRes();
    await updateMeeting(req, res);
    expect(res.statusCode).toBe(400);
  });
});

describe('buildReminderOccurrences (unit)', () => {
  it('once -> single occurrence', () => {
    expect(buildReminderOccurrences({ date: '2026-06-01', startTime: '08:00', reminder: { schedule: 'once' } }))
      .toEqual([{ date: '2026-06-01', startTime: '08:00' }]);
  });

  it('repeat every 30 minutes x3', () => {
    const out = buildReminderOccurrences({ date: '2026-06-01', startTime: '08:00', reminder: { schedule: 'repeat', repeatEvery: 30, repeatUnit: 'minutes', repeatCount: 3 } });
    expect(out).toEqual([
      { date: '2026-06-01', startTime: '08:00' },
      { date: '2026-06-01', startTime: '08:30' },
      { date: '2026-06-01', startTime: '09:00' },
    ]);
  });

  it('caps occurrences at 50', () => {
    const out = buildReminderOccurrences({ date: '2026-06-01', startTime: '08:00', reminder: { schedule: 'repeat', repeatEvery: 1, repeatUnit: 'days', repeatCount: 999 } });
    expect(out).toHaveLength(50);
  });

  it('invalid date -> empty array (controller turns this into a 400)', () => {
    expect(buildReminderOccurrences({ date: 'not-a-date', startTime: '99:99', reminder: { schedule: 'repeat', repeatEvery: 1, repeatUnit: 'days', repeatCount: 3 } }))
      .toEqual([]);
  });
});
