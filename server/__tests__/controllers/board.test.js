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
      findAll: jest.fn().mockResolvedValue([]),
    },
    Task: {
      findAll: jest.fn().mockResolvedValue([]),
      max: jest.fn(),
      create: jest.fn(),
    },
    Workspace: {},
    // boardController + middleware now reference these directly; supply
    // benign stubs so any incidental query path succeeds without a real DB.
    TaskOwner: { findAll: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    TaskAssignee: { findAll: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    PermissionGrant: { findAll: jest.fn().mockResolvedValue([]) },
    sequelize: {
      fn: jest.fn(),
      col: jest.fn(),
      query: jest.fn().mockResolvedValue([[], {}]),
      literal: jest.fn((sql) => ({ val: sql })),
      // Some board-mutation paths use managed transactions now.
      transaction: jest.fn(async (cb) => cb({ /* fake tx */ })),
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
  // boardController also imports these from utils/sanitize; provide passthroughs.
  sanitizeNotificationField: jest.fn((val) => val),
  sanitizeNotificationMessage: jest.fn((val) => val),
}));

// boards routes now go through `requirePermission('boards', ...)` for POST/PUT.
// hasPermission is role-aware so the "member cannot create" assertion still
// fires from the route gate, while managers / admins pass through to the
// controller (where each test pins the actual assertion).
//
// getEffectiveBasePermission is used by auth middleware's Layer-3 fallback
// for `requireRole(...)` routes — it MUST also be role-aware, otherwise a
// `return true` blanket lets members through requireRole('manager','admin').
jest.mock('../../services/permissionEngine', () => {
  const isElevated = (user) => {
    if (!user) return false;
    if (user.isSuperAdmin) return true;
    return ['admin', 'manager', 'assistant_manager'].includes(user.role);
  };
  return {
    hasPermission: jest.fn(async (user, _resource, _action) => isElevated(user)),
    computeEffectivePermissions: jest.fn().mockResolvedValue([]),
    fetchActiveGrants: jest.fn().mockResolvedValue([]),
    getEffectiveBasePermission: jest.fn((user) => isElevated(user)),
  };
});

// boardController fan-outs realtime + notifications via the central helper.
jest.mock('../../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue(null),
  buildIdempotencyKey: jest.fn(() => 'idempotency-key'),
}));

jest.mock('../../services/boardMembershipService', () => ({
  autoAddMember: jest.fn().mockResolvedValue(null),
  explicitAddMember: jest.fn().mockResolvedValue(null),
  cleanupMultiple: jest.fn().mockResolvedValue(null),
  cleanupIfNoTasksRemain: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../services/taskVisibilityService', () => ({
  canViewTask: jest.fn().mockResolvedValue(true),
  buildTaskVisibilityWhere: jest.fn(async () => ({})),
  isUnrestrictedTaskViewer: jest.fn(() => true),
}));

jest.mock('../../services/boardVisibilityService', () => ({
  canUserSeeBoard: jest.fn().mockResolvedValue(true),
  filterVisibleBoardIds: jest.fn(async (_user, ids) => ids),
  buildBoardVisibilityWhere: jest.fn(async () => ({})),
  buildVisibleBoardIds: jest.fn(async (_user, ids) => ids),
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

    // Visibility gate now delegates to boardVisibilityService.canUserSeeBoard
    // — return false to simulate the member not being able to see this board.
    const boardVis = require('../../services/boardVisibilityService');
    boardVis.canUserSeeBoard.mockResolvedValueOnce(false);

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

  // Regression guard for the production failure we hit when migration 010 +
  // recurring-task columns were missing in prod: every Task.findAll inside
  // Board.findByPk's eager-load throws SequelizeDatabaseError, and the
  // controller's catch must return a clean JSON 500 (not crash, not leak
  // HTML), and the log must include `original.message` so prod logs name
  // the missing column.
  //
  // After the Phase 2 logger migration, the controller calls
  // `safeLogger.error('[Board] GetBoard error', { err })` instead of a
  // bespoke console.error structured object. The redactor in safeLogger
  // flattens `err.original.message` to a plain string on the logged err,
  // so the same diagnostic field is still present — we just spy on the
  // safeLogger module instead of console.
  it('returns a clean JSON 500 when the DB layer throws (e.g. missing column)', async () => {
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'manager' }));
    const dbErr = Object.assign(new Error('database error'), {
      name: 'SequelizeDatabaseError',
      original: { message: 'column tasks."syncStatus" does not exist' },
      sql: 'SELECT * FROM "boards" ...',
    });
    Board.findByPk.mockRejectedValue(dbErr);
    const safeLogger = require('../../utils/safeLogger');
    const errSpy = jest.spyOn(safeLogger, 'error').mockImplementation(() => {});

    const token = generateToken(USER_ID, 'manager');
    const res = await request(app)
      .get(`/api/boards/${BOARD_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, message: 'Server error fetching board.' });
    // safeLogger receives the raw error object — the redactor inside
    // safeLogger flattens `original.message` to a plain string downstream
    // when winston serializes. Asserting on the raw input is what proves
    // ops will see the missing-column detail when this fires in prod.
    expect(errSpy).toHaveBeenCalledWith(
      '[Board] GetBoard error',
      expect.objectContaining({
        err: expect.objectContaining({
          name: 'SequelizeDatabaseError',
          original: expect.objectContaining({
            message: 'column tasks."syncStatus" does not exist',
          }),
        }),
      })
    );
    errSpy.mockRestore();
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

  it('returns 403 when a member tries to update an admin-only board field', async () => {
    // Post-Phase-7 board field-level tiering: members may rename boards they
    // can see, but admin-only fields (color, groups, archivedGroups,
    // isArchived, workspaceId, columns) are gated. The test previously
    // pinned "members cannot update at all"; that assertion was correct
    // only for the old monolithic role gate. With field-level tiering, we
    // pin the admin-field gate (this is the actual RBAC the controller
    // enforces, and it must not regress).
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'member' }));
    Board.findByPk.mockResolvedValue(makeBoardRecord());
    const token = generateToken(USER_ID, 'member');

    const res = await request(app)
      .put(`/api/boards/${BOARD_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ color: '#ff0000' }); // admin-only field

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/managers or admins/i);
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

    // Tier 2 (manager) now hits the global destructive-action gate FIRST
    // (decision #4: T2 cannot delete anything). The earlier "creator or an
    // admin" message stays in the controller but is reached only when the
    // tier gate is irrelevant (T1). For the audit we just pin a 403; either
    // gate firing is acceptable.
    expect(res.status).toBe(403);
  });

  it('returns 200 when a super admin (Tier 1) deletes any board', async () => {
    // Phase 5d global destructive-action gate: only Tier 1 (super admin)
    // may permanently delete shared resources. The earlier "admin → 200"
    // assertion was widened too far — admin without super admin is Tier 2
    // and is blocked. The test now pins the legitimately-allowed actor.
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'admin', isSuperAdmin: true }));
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

  it('returns 403 when an admin (Tier 2, not super admin) tries to delete a board', async () => {
    // Defense for the inverse: Tier 2 is strictly blocked from board
    // deletion — even on a board they themselves created. They may still
    // ARCHIVE (PUT /:id with isArchived: true). DELETE returns 403 with
    // the TIER_2_NO_DELETE code from tierEnforcement.assertCanDelete.
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'admin', isSuperAdmin: false }));
    const board = makeBoardRecord({ createdBy: USER_ID });
    Board.findByPk.mockResolvedValue(board);
    const token = generateToken(USER_ID, 'admin');

    const res = await request(app)
      .delete(`/api/boards/${BOARD_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ success: false, code: 'TIER_2_NO_DELETE' });
    expect(board.destroy).not.toHaveBeenCalled();
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
