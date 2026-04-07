'use strict';

/**
 * Integration tests for the board API endpoints.
 *
 * Real routes + controllers are loaded.  All DB models, socket events
 * and external services are mocked.
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

// ─── Mocks ───────────────────────────────────────────────────────────────────

jest.mock('../../models', () => {
  return {
    Board: {
      findAll: jest.fn(),
      findAndCountAll: jest.fn(),
      findByPk: jest.fn(),
      create: jest.fn(),
    },
    User: {
      findByPk: jest.fn(),
    },
    Task: {
      findAll: jest.fn(),
      max: jest.fn(),
      create: jest.fn(),
    },
    Workspace: {},
    sequelize: {
      fn: jest.fn(),
      col: jest.fn(),
      query: jest.fn(),
      literal: jest.fn((sql) => ({ val: sql })),
    },
  };
});

jest.mock('../../services/socketService', () => ({
  emitToBoard: jest.fn(),
  emitToUser: jest.fn(),
  getIO: jest.fn(() => ({ emit: jest.fn() })),
}));

jest.mock('../../utils/archiveHelpers', () => ({
  canPermanentlyDelete: jest.fn(() => ({ allowed: true, daysRemaining: 0 })),
}));

jest.mock('../../services/activityService', () => ({
  logActivity: jest.fn(),
}));

jest.mock('../../utils/sanitize', () => ({
  sanitizeInput: jest.fn((val) => val),
  sanitizeRichText: jest.fn((val) => val),
}));

// ─── Build test app ──────────────────────────────────────────────────────────

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { Board, User, Task } = require('../../models');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/boards', require('../../routes/boards'));
  return app;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BOARD_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_ID  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MEMBER_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function generateToken(userId, role = 'manager') {
  return jwt.sign({ id: userId, role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function makeUserRecord(overrides = {}) {
  return {
    id: USER_ID,
    name: 'Test Manager',
    email: 'manager@aniston.com',
    role: 'manager',
    isActive: true,
    accountStatus: 'approved',
    authProvider: 'local',
    ...overrides,
  };
}

function makeBoardRecord(overrides = {}) {
  return {
    id: BOARD_ID,
    name: 'Test Board',
    description: '',
    color: '#0073ea',
    isArchived: false,
    createdBy: USER_ID,
    members: [{ id: USER_ID }],
    toJSON: jest.fn().mockReturnThis(),
    update: jest.fn().mockResolvedValue(true),
    destroy: jest.fn().mockResolvedValue(true),
    addMember: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

// ─── GET /api/boards ──────────────────────────────────────────────────────────

describe('GET /api/boards', () => {
  let app;

  beforeAll(() => { app = buildApp(); });
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/boards');
    expect(res.status).toBe(401);
  });

  it('returns 200 with boards array for a manager', async () => {
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'manager' }));
    const boards = [makeBoardRecord(), makeBoardRecord({ id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', name: 'Board 2' })];
    Board.findAndCountAll.mockResolvedValue({ count: 2, rows: boards });
    Task.findAll.mockResolvedValue([]);  // task counts

    const token = generateToken(USER_ID, 'manager');

    const res = await request(app)
      .get('/api/boards')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.boards)).toBe(true);
    expect(res.body.data.boards).toHaveLength(2);
  });

  it('returns only boards the member belongs to', async () => {
    const memberUser = makeUserRecord({ role: 'member', id: MEMBER_ID });
    User.findByPk.mockResolvedValue(memberUser);

    const memberBoard = makeBoardRecord({ members: [{ id: MEMBER_ID }] });
    Board.findAndCountAll.mockResolvedValue({ count: 1, rows: [memberBoard] });
    Task.findAll.mockResolvedValue([]);

    const token = generateToken(MEMBER_ID, 'member');

    const res = await request(app)
      .get('/api/boards')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    // Only the board that includes MEMBER_ID should be returned
    expect(res.body.data.boards).toHaveLength(1);
  });

  it('returns an empty array when no boards exist', async () => {
    User.findByPk.mockResolvedValue(makeUserRecord());
    Board.findAndCountAll.mockResolvedValue({ count: 0, rows: [] });
    Task.findAll.mockResolvedValue([]);

    const token = generateToken(USER_ID, 'manager');

    const res = await request(app)
      .get('/api/boards')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.boards).toHaveLength(0);
  });
});

// ─── GET /api/boards/:id ──────────────────────────────────────────────────────

describe('GET /api/boards/:id', () => {
  let app;

  beforeAll(() => { app = buildApp(); });
  beforeEach(() => jest.clearAllMocks());

  it('returns 404 when the board does not exist', async () => {
    User.findByPk.mockResolvedValue(makeUserRecord());
    Board.findByPk.mockResolvedValue(null);

    const token = generateToken(USER_ID, 'manager');

    const res = await request(app)
      .get(`/api/boards/${BOARD_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/Board not found/i);
  });

  it('returns 403 when a member requests a board they do not belong to', async () => {
    const memberUser = makeUserRecord({ role: 'member', id: MEMBER_ID });
    User.findByPk.mockResolvedValue(memberUser);

    // Board with different members, no tasks for this member
    Board.findByPk.mockResolvedValue(
      makeBoardRecord({
        members: [{ id: USER_ID }],   // MEMBER_ID not in here
        tasks: [],
      })
    );

    const token = generateToken(MEMBER_ID, 'member');

    const res = await request(app)
      .get(`/api/boards/${BOARD_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it('returns 200 for a manager requesting any board', async () => {
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'manager' }));
    Board.findByPk.mockResolvedValue(
      makeBoardRecord({ members: [], tasks: [] })
    );

    const token = generateToken(USER_ID, 'manager');

    const res = await request(app)
      .get(`/api/boards/${BOARD_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('board');
  });
});

// ─── POST /api/boards ─────────────────────────────────────────────────────────

describe('POST /api/boards', () => {
  let app;

  beforeAll(() => { app = buildApp(); });
  beforeEach(() => jest.clearAllMocks());

  it('returns 403 when a member tries to create a board', async () => {
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'member' }));
    const token = generateToken(USER_ID, 'member');

    const res = await request(app)
      .post('/api/boards')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Board' });

    expect(res.status).toBe(403);
  });

  it('returns 400 when board name is missing', async () => {
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'manager' }));
    const token = generateToken(USER_ID, 'manager');

    const res = await request(app)
      .post('/api/boards')
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'No name here' });

    expect(res.status).toBe(400);
    expect(res.body.errors).toBeDefined();
  });

  it('returns 400 when color is not a valid hex code', async () => {
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'manager' }));
    const token = generateToken(USER_ID, 'manager');

    const res = await request(app)
      .post('/api/boards')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Board', color: 'not-a-hex' });

    expect(res.status).toBe(400);
  });

  it('returns 201 when a manager creates a board with valid data', async () => {
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'manager' }));
    const newBoard = makeBoardRecord({ name: 'New Board' });
    Board.create.mockResolvedValue(newBoard);
    Board.findByPk.mockResolvedValue(newBoard);

    const token = generateToken(USER_ID, 'manager');

    const res = await request(app)
      .post('/api/boards')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Board', description: 'A test board', color: '#ff0000' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('board');
  });

  it('returns 201 when an admin creates a board', async () => {
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'admin' }));
    const newBoard = makeBoardRecord({ name: 'Admin Board' });
    Board.create.mockResolvedValue(newBoard);
    Board.findByPk.mockResolvedValue(newBoard);

    const token = generateToken(USER_ID, 'admin');

    const res = await request(app)
      .post('/api/boards')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Admin Board' });

    expect(res.status).toBe(201);
  });
});

// ─── PUT /api/boards/:id ──────────────────────────────────────────────────────

describe('PUT /api/boards/:id', () => {
  let app;

  beforeAll(() => { app = buildApp(); });
  beforeEach(() => jest.clearAllMocks());

  it('returns 403 when a member tries to update a board', async () => {
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'member' }));
    const token = generateToken(USER_ID, 'member');

    const res = await request(app)
      .put(`/api/boards/${BOARD_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'New Name' });

    expect(res.status).toBe(403);
  });

  it('returns 404 when the board does not exist', async () => {
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'manager' }));
    Board.findByPk.mockResolvedValue(null);
    const token = generateToken(USER_ID, 'manager');

    const res = await request(app)
      .put(`/api/boards/${BOARD_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Updated Name' });

    expect(res.status).toBe(404);
  });

  it('returns 200 with updated board data on success', async () => {
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'manager' }));
    const existingBoard = makeBoardRecord();
    const updatedBoard = makeBoardRecord({ name: 'Updated Name' });

    Board.findByPk
      .mockResolvedValueOnce(existingBoard)  // load for update
      .mockResolvedValueOnce(updatedBoard);  // reload after update

    const token = generateToken(USER_ID, 'manager');

    const res = await request(app)
      .put(`/api/boards/${BOARD_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Updated Name' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(existingBoard.update).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Updated Name' })
    );
  });
});

// ─── DELETE /api/boards/:id ───────────────────────────────────────────────────

describe('DELETE /api/boards/:id', () => {
  let app;

  beforeAll(() => { app = buildApp(); });
  beforeEach(() => jest.clearAllMocks());

  it('returns 403 when a member tries to delete a board', async () => {
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'member' }));
    const token = generateToken(USER_ID, 'member');

    const res = await request(app)
      .delete(`/api/boards/${BOARD_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it('returns 404 when the board does not exist', async () => {
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'admin' }));
    Board.findByPk.mockResolvedValue(null);
    const token = generateToken(USER_ID, 'admin');

    const res = await request(app)
      .delete(`/api/boards/${BOARD_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it('returns 403 when a manager tries to delete a board they did not create', async () => {
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'manager' }));
    // Board was created by a different user
    Board.findByPk.mockResolvedValue(makeBoardRecord({ createdBy: MEMBER_ID }));
    const token = generateToken(USER_ID, 'manager');

    const res = await request(app)
      .delete(`/api/boards/${BOARD_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/creator or an admin/i);
  });

  it('returns 200 when the admin deletes any board', async () => {
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'admin' }));
    const board = makeBoardRecord({ createdBy: MEMBER_ID });
    Board.findByPk.mockResolvedValue(board);
    const token = generateToken(USER_ID, 'admin');

    const res = await request(app)
      .delete(`/api/boards/${BOARD_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(board.destroy).toHaveBeenCalledTimes(1);
  });

  it('returns 200 when the creator (manager) deletes their own board', async () => {
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'manager', id: USER_ID }));
    const board = makeBoardRecord({ createdBy: USER_ID });
    Board.findByPk.mockResolvedValue(board);
    const token = generateToken(USER_ID, 'manager');

    const res = await request(app)
      .delete(`/api/boards/${BOARD_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(board.destroy).toHaveBeenCalledTimes(1);
  });
});

// ─── POST /api/boards/:id/members ─────────────────────────────────────────────

describe('POST /api/boards/:id/members', () => {
  let app;

  beforeAll(() => { app = buildApp(); });
  beforeEach(() => jest.clearAllMocks());

  it('returns 403 when a member tries to add board members', async () => {
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'member' }));
    const token = generateToken(USER_ID, 'member');

    const res = await request(app)
      .post(`/api/boards/${BOARD_ID}/members`)
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: MEMBER_ID });

    expect(res.status).toBe(403);
  });

  it('returns 400 when userId field is entirely absent', async () => {
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'manager' }));
    Board.findByPk.mockResolvedValue(makeBoardRecord());
    const token = generateToken(USER_ID, 'manager');

    const res = await request(app)
      .post(`/api/boards/${BOARD_ID}/members`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    // The express-validator rule requires userId — missing → 400
    expect(res.status).toBe(400);
  });
});
