'use strict';

/**
 * Regression test: assistant_manager calling GET /api/boards must apply the
 * boardVisibilityService filter so the SQL where clause carries the [Op.or]
 * subquery. The previous fix had a bug where the merge was guarded by
 * `Object.keys(visWhere).length > 0` — but Op.or is a Symbol, so the guard
 * was always false and the filter was silently dropped, returning every
 * board.
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

const { Op } = require('sequelize');

jest.mock('../../models', () => ({
  Board: {
    findAll: jest.fn(),
    findAndCountAll: jest.fn(),
    findByPk: jest.fn(),
    create: jest.fn(),
  },
  User: { findByPk: jest.fn() },
  Task: { findAll: jest.fn(), max: jest.fn(), create: jest.fn() },
  Workspace: {},
  TaskOwner: {},
  TaskAssignee: { count: jest.fn() },
  sequelize: {
    fn: jest.fn(),
    col: jest.fn(),
    query: jest.fn(),
    literal: jest.fn((sql) => ({ val: sql })),
  },
}));

jest.mock('../../services/socketService', () => ({
  emitToBoard: jest.fn(),
  emitToUser: jest.fn(),
  forceUserLeaveBoard: jest.fn(),
  getIO: jest.fn(() => ({ emit: jest.fn() })),
}));
jest.mock('../../services/activityService', () => ({ logActivity: jest.fn() }));
jest.mock('../../services/boardMembershipService', () => ({
  autoAddMember: jest.fn(),
  explicitAddMember: jest.fn(),
}));
jest.mock('../../services/taskVisibilityService', () => ({
  filterVisibleTasks: jest.fn(async (_user, tasks) => tasks),
}));
jest.mock('../../utils/sanitize', () => ({ sanitizeInput: (v) => v }));
jest.mock('../../utils/archiveHelpers', () => ({
  canPermanentlyDelete: () => ({ allowed: true, daysRemaining: 0 }),
}));

// boardVisibilityService is the unit under integration — let it run for real.

// Mock hierarchy so getDescendantIds is deterministic (no DB).
jest.mock('../../services/hierarchyService', () => ({
  getDescendantIds: jest.fn(async () => []),
}));

// safeSql is used by the service — keep real impl.

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { Board, User, Task, sequelize } = require('../../models');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/boards', require('../../routes/boards'));
  return app;
}

const SUNNY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';

function token(role = 'assistant_manager', id = SUNNY_ID) {
  return jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function userRecord(overrides = {}) {
  return {
    id: SUNNY_ID,
    name: 'Sunny',
    email: 'sunny@aniston.com',
    role: 'assistant_manager',
    isActive: true,
    isSuperAdmin: false,
    ...overrides,
  };
}

describe('GET /api/boards — assistant_manager visibility filter is applied', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => {
    jest.clearAllMocks();
    // Service queries `SELECT 1 FROM ... LIMIT 0` to detect tables/columns.
    // Resolve every probe positively so the OR-block includes every source.
    sequelize.query.mockResolvedValue([[]]);
  });

  it('passes a where clause that contains [Op.or] (visibility merged)', async () => {
    User.findByPk.mockResolvedValue(userRecord());
    Board.findAndCountAll.mockResolvedValue({ count: 0, rows: [] });
    Task.findAll.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/boards')
      .set('Authorization', `Bearer ${token('assistant_manager')}`);

    expect(res.status).toBe(200);
    expect(Board.findAndCountAll).toHaveBeenCalled();

    const callArg = Board.findAndCountAll.mock.calls[0][0];
    const where = callArg.where;
    // The filter MUST be present. Previously this silently dropped because
    // Object.keys(visWhere).length === 0 for { [Op.or]: ... }.
    expect(where).toBeDefined();
    expect(where[Op.or]).toBeDefined();
    expect(Array.isArray(where[Op.or])).toBe(true);
    // Must include at least: createdBy, explicit BoardMembers, tasks-by-assignee,
    // tasks-by-creator. Junction tables are conditional on existence.
    expect(where[Op.or].length).toBeGreaterThanOrEqual(4);
  });

  it('does NOT pass a visibility filter for an admin (unrestricted)', async () => {
    User.findByPk.mockResolvedValue(userRecord({ role: 'admin' }));
    Board.findAndCountAll.mockResolvedValue({ count: 0, rows: [] });
    Task.findAll.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/boards')
      .set('Authorization', `Bearer ${token('admin')}`);

    expect(res.status).toBe(200);
    const where = Board.findAndCountAll.mock.calls[0][0].where;
    // Admin → unrestricted → no Op.or merged in
    expect(where[Op.or]).toBeUndefined();
  });

  it('does NOT pass a visibility filter for a manager (unrestricted)', async () => {
    User.findByPk.mockResolvedValue(userRecord({ role: 'manager' }));
    Board.findAndCountAll.mockResolvedValue({ count: 0, rows: [] });
    Task.findAll.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/boards')
      .set('Authorization', `Bearer ${token('manager')}`);

    expect(res.status).toBe(200);
    const where = Board.findAndCountAll.mock.calls[0][0].where;
    expect(where[Op.or]).toBeUndefined();
  });

  it('passes a visibility filter for a member', async () => {
    User.findByPk.mockResolvedValue(userRecord({ role: 'member' }));
    Board.findAndCountAll.mockResolvedValue({ count: 0, rows: [] });
    Task.findAll.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/boards')
      .set('Authorization', `Bearer ${token('member')}`);

    expect(res.status).toBe(200);
    const where = Board.findAndCountAll.mock.calls[0][0].where;
    expect(where[Op.or]).toBeDefined();
  });
});
