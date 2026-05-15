'use strict';

/**
 * Security regression tests for labelController.
 *
 * Covers the P0 IDOR fixes (P0-1, P0-2, P0-3, P0-6) and the P1-3 color
 * validation. Models, sockets, and visibility services are mocked so the
 * tests run without a database or socket server.
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

jest.mock('../../models', () => ({
  Label: {
    create: jest.fn(),
    findByPk: jest.fn(),
    findAll: jest.fn(),
    destroy: jest.fn(),
  },
  TaskLabel: {
    findOrCreate: jest.fn(),
    destroy: jest.fn(),
    create: jest.fn(),
  },
  Task: {
    findByPk: jest.fn(),
  },
  User: {},
  Board: {
    findByPk: jest.fn(),
  },
}));

jest.mock('../../config/db', () => ({
  sequelize: {
    transaction: jest.fn(async (cb) => cb({})),
  },
}));

jest.mock('../../services/socketService', () => ({
  emitToBoard: jest.fn(),
  emitToBoardAndUsers: jest.fn(),
}));

jest.mock('../../services/taskVisibilityService', () => ({
  canViewTask: jest.fn(),
  getAuthorizedRealtimeRecipients: jest.fn(async () => []),
}));

jest.mock('../../services/boardVisibilityService', () => ({
  canUserSeeBoard: jest.fn(),
}));

jest.mock('../../services/tierEnforcement', () => ({
  assertCanDelete: jest.fn(() => true),
}));

jest.mock('../../utils/tierResponseHelpers', () => ({
  sendIfTierError: jest.fn(() => false),
}));

// Phase 7 — these tests cover IDOR protections (P0-1..6), not Phase-7
// granular permission gating. Mock the engine so the new
// labels.add_to_task / labels.remove_from_task gates never deny in this
// suite; dedicated grantability tests live in
// permissionEngine.grantability.test.js.
jest.mock('../../utils/permissionGate', () => ({
  denyIfNoPermission: jest.fn(async () => false),
  checkPermission: jest.fn(async () => true),
}));
jest.mock('../../services/permissionEngine', () => ({
  hasPermission: jest.fn(async () => true),
  canGrantPermission: jest.fn(async () => ({ allowed: true })),
  computeEffectivePermissions: jest.fn(async () => ({ permissions: {}, basePermissions: {}, overrides: [], denials: [], grants: [] })),
}));

jest.mock('../../utils/sanitize', () => ({
  sanitizeInput: jest.fn((v) => v),
}));

const { Label, TaskLabel, Task, Board } = require('../../models');
const taskVisibility = require('../../services/taskVisibilityService');
const boardVisibility = require('../../services/boardVisibilityService');
const labelCtrl = require('../../controllers/labelController');

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── P0-1: assignLabel — IDOR + cross-board ──────────────────────────────
describe('assignLabel — IDOR protection (P0-1)', () => {
  test('returns 400 when taskId is missing', async () => {
    const req = { user: { id: 'u1' }, body: { labelId: 'l1' } };
    const res = mockRes();
    await labelCtrl.assignLabel(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 404 when task does not exist', async () => {
    Task.findByPk.mockResolvedValue(null);
    Label.findByPk.mockResolvedValue({ id: 'l1', boardId: 'b1' });
    const req = { user: { id: 'u1' }, body: { taskId: 't-bogus', labelId: 'l1' } };
    const res = mockRes();
    await labelCtrl.assignLabel(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('returns 400 when label.boardId differs from task.boardId (cross-board IDOR)', async () => {
    Task.findByPk.mockResolvedValue({ id: 't1', boardId: 'board-A' });
    Label.findByPk.mockResolvedValue({ id: 'l1', boardId: 'board-B' });
    taskVisibility.canViewTask.mockResolvedValue(true);
    const req = { user: { id: 'u1' }, body: { taskId: 't1', labelId: 'l1' } };
    const res = mockRes();
    await labelCtrl.assignLabel(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(TaskLabel.findOrCreate).not.toHaveBeenCalled();
  });

  test('returns 403 when user cannot view the task (IDOR)', async () => {
    Task.findByPk.mockResolvedValue({ id: 't1', boardId: 'b1' });
    Label.findByPk.mockResolvedValue({ id: 'l1', boardId: 'b1' });
    taskVisibility.canViewTask.mockResolvedValue(false);
    const req = { user: { id: 'attacker' }, body: { taskId: 't1', labelId: 'l1' } };
    const res = mockRes();
    await labelCtrl.assignLabel(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(TaskLabel.findOrCreate).not.toHaveBeenCalled();
  });

  test('happy path: same-board label, viewable task — assignment succeeds', async () => {
    Task.findByPk.mockResolvedValue({ id: 't1', boardId: 'b1' });
    Label.findByPk.mockResolvedValue({ id: 'l1', boardId: 'b1' });
    taskVisibility.canViewTask.mockResolvedValue(true);
    TaskLabel.findOrCreate.mockResolvedValue([{ id: 'tl1' }, true]);
    const req = { user: { id: 'u1' }, body: { taskId: 't1', labelId: 'l1' } };
    const res = mockRes();
    await labelCtrl.assignLabel(req, res);
    expect(res.json).toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
  });

  test('global label (boardId=null) bypasses cross-board check', async () => {
    Task.findByPk.mockResolvedValue({ id: 't1', boardId: 'b1' });
    Label.findByPk.mockResolvedValue({ id: 'l-global', boardId: null });
    taskVisibility.canViewTask.mockResolvedValue(true);
    TaskLabel.findOrCreate.mockResolvedValue([{ id: 'tl1' }, true]);
    const req = { user: { id: 'u1' }, body: { taskId: 't1', labelId: 'l-global' } };
    const res = mockRes();
    await labelCtrl.assignLabel(req, res);
    expect(res.json).toHaveBeenCalled();
  });
});

// ── P0-2: unassignLabel — IDOR ────────────────────────────────────────
describe('unassignLabel — IDOR protection (P0-2)', () => {
  test('returns 403 when user cannot view task', async () => {
    Task.findByPk.mockResolvedValue({ id: 't1', boardId: 'b1' });
    taskVisibility.canViewTask.mockResolvedValue(false);
    const req = { user: { id: 'attacker' }, body: { taskId: 't1', labelId: 'l1' } };
    const res = mockRes();
    await labelCtrl.unassignLabel(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(TaskLabel.destroy).not.toHaveBeenCalled();
  });

  test('happy path destroys the junction row', async () => {
    Task.findByPk.mockResolvedValue({ id: 't1', boardId: 'b1' });
    taskVisibility.canViewTask.mockResolvedValue(true);
    TaskLabel.destroy.mockResolvedValue(1);
    const req = { user: { id: 'u1' }, body: { taskId: 't1', labelId: 'l1' } };
    const res = mockRes();
    await labelCtrl.unassignLabel(req, res);
    expect(TaskLabel.destroy).toHaveBeenCalledWith({ where: { taskId: 't1', labelId: 'l1' } });
  });
});

// ── P0-3: getTaskLabels — IDOR ────────────────────────────────────────
describe('getTaskLabels — IDOR protection (P0-3)', () => {
  test('returns 403 when user cannot view the task', async () => {
    Task.findByPk.mockResolvedValue({ id: 't1', boardId: 'b1', labels: [{ id: 'l1' }] });
    taskVisibility.canViewTask.mockResolvedValue(false);
    const req = { user: { id: 'attacker' }, params: { taskId: 't1' } };
    const res = mockRes();
    await labelCtrl.getTaskLabels(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('returns 404 when task does not exist', async () => {
    Task.findByPk.mockResolvedValue(null);
    const req = { user: { id: 'u1' }, params: { taskId: 'bogus' } };
    const res = mockRes();
    await labelCtrl.getTaskLabels(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

// ── P0-6: getLabels — board visibility ────────────────────────────────
describe('getLabels — board visibility (P0-6)', () => {
  test('returns 403 for board the user cannot see', async () => {
    boardVisibility.canUserSeeBoard.mockResolvedValue(false);
    const req = { user: { id: 'attacker' }, query: { boardId: 'private-board' } };
    const res = mockRes();
    await labelCtrl.getLabels(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(Label.findAll).not.toHaveBeenCalled();
  });

  test('returns only global labels (boardId=null) when no boardId is specified', async () => {
    Label.findAll.mockResolvedValue([{ id: 'l-global', boardId: null }]);
    const req = { user: { id: 'u1' }, query: {} };
    const res = mockRes();
    await labelCtrl.getLabels(req, res);
    const args = Label.findAll.mock.calls[0][0];
    expect(args.where).toEqual({ boardId: null });
  });
});

// ── createLabel — happy path + tier gate + realtime fan-out ────────────
//
// Regression for the May 12 bug where every Create-label click from a
// Super Admin (Tier 1) returned 500 "Failed to create label." The fix
// included:
//   1. `canManageBoard` now admits any Tier 1/2 (not just role='admin').
//   2. The catch block logs the SQL/Sequelize error so future occurrences
//      surface in error.log instead of being swallowed.
//   3. The success path fans out to the authorised realtime recipients
//      (board room + non-room assignees) rather than the board room only.
describe('createLabel — happy path + tier gate + fan-out', () => {
  const socketService = require('../../services/socketService');
  const taskVisibility = require('../../services/taskVisibilityService');

  test('Tier 1 super admin: board-scoped + auto-assign succeeds and broadcasts to assignees', async () => {
    Board.findByPk.mockResolvedValue({ id: 'b1', createdBy: 'someone-else' });
    Task.findByPk.mockResolvedValue({ id: 't1', boardId: 'b1' });
    Label.create.mockResolvedValue({ id: 'l-new', name: 'important', color: '#579bfc', boardId: 'b1', createdBy: 'u-super' });
    TaskLabel.create.mockResolvedValue({ taskId: 't1', labelId: 'l-new' });
    taskVisibility.canViewTask.mockResolvedValue(true);
    taskVisibility.getAuthorizedRealtimeRecipients.mockResolvedValue(['u-super', 'u-assignee']);

    const req = {
      user: { id: 'u-super', isSuperAdmin: true, role: 'admin', tier: 1 },
      body: { name: 'important', color: '#579bfc', boardId: 'b1', assignToTaskId: 't1' },
    };
    const res = mockRes();
    await labelCtrl.createLabel(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(Label.create).toHaveBeenCalled();
    expect(TaskLabel.create).toHaveBeenCalledWith(
      { taskId: 't1', labelId: 'l-new' },
      expect.objectContaining({ transaction: expect.anything() })
    );
    // P3-12 — fan-out should hit emitToBoardAndUsers (board + assignee user
    // rooms), not emitToBoard. Wait one microtask so the fire-and-forget
    // emitLabelsUpdated has a chance to resolve.
    await new Promise((r) => setImmediate(r));
    expect(socketService.emitToBoardAndUsers).toHaveBeenCalledWith(
      'b1', 'task:labels_updated', expect.objectContaining({ taskId: 't1' }), expect.arrayContaining(['u-super', 'u-assignee'])
    );
  });

  test('role=admin user who is NOT the board creator: passes (admins manage any board)', async () => {
    Board.findByPk.mockResolvedValue({ id: 'b1', createdBy: 'someone-else' });
    Label.create.mockResolvedValue({ id: 'l-new', name: 'adm-label', color: '#579bfc', boardId: 'b1', createdBy: 'u-adm' });

    const req = {
      user: { id: 'u-adm', isSuperAdmin: false, role: 'admin', tier: 2 },
      body: { name: 'adm-label', color: '#579bfc', boardId: 'b1' }, // no assignToTaskId — pure create path
    };
    const res = mockRes();
    await labelCtrl.createLabel(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  test('role=manager who is the board creator: passes', async () => {
    Board.findByPk.mockResolvedValue({ id: 'b1', createdBy: 'u-mgr' });
    Label.create.mockResolvedValue({ id: 'l-new', name: 'mgr-label', color: '#579bfc', boardId: 'b1', createdBy: 'u-mgr' });

    const req = {
      user: { id: 'u-mgr', isSuperAdmin: false, role: 'manager', tier: 2 },
      body: { name: 'mgr-label', color: '#579bfc', boardId: 'b1' },
    };
    const res = mockRes();
    await labelCtrl.createLabel(req, res);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('role=manager who is NOT the board creator: passes (T1+T2 manage labels on any board, May 2026 policy widening)', async () => {
    // Previously asserted 403 — the original S-H6 boundary scoped managers
    // to boards they personally created. Product feedback (May 2026)
    // widened canManageBoard so any T1/T2 actor can curate the label
    // library on any board they can see. Tier 3/4 still hit 403 on this
    // path (see "Tier 4 member" test below).
    Board.findByPk.mockResolvedValue({ id: 'b1', createdBy: 'someone-else' });
    Label.create.mockResolvedValue({ id: 'l-new', name: 'mgr-label', color: '#579bfc', boardId: 'b1', createdBy: 'u-mgr' });
    const req = {
      user: { id: 'u-mgr', isSuperAdmin: false, role: 'manager', tier: 2 },
      body: { name: 'mgr-label', color: '#579bfc', boardId: 'b1' },
    };
    const res = mockRes();
    await labelCtrl.createLabel(req, res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(Label.create).toHaveBeenCalled();
  });

  test('Tier 4 member: BOARD-LIBRARY create (no assignToTaskId) is blocked by canManageBoard', async () => {
    // Post-May-12 widening: T4 CAN create labels on a task they own (see
    // task-scoped tests below). What they CANNOT do is mint a stand-alone
    // library label that affects every task on a board they don't manage —
    // that path still hits canManageBoard and 403s, matching the audit's
    // S-H6 boundary. Same expectation applies to T3.
    Board.findByPk.mockResolvedValue({ id: 'b1', createdBy: 'someone-else' });
    const req = {
      user: { id: 'u-member', isSuperAdmin: false, role: 'member', tier: 4 },
      body: { name: 'sneaky', color: '#579bfc', boardId: 'b1' }, // no assignToTaskId — library path
    };
    const res = mockRes();
    await labelCtrl.createLabel(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(Label.create).not.toHaveBeenCalled();
  });

  // ── Task-scoped path: every tier passes when they can see the task ─────
  //
  // The May-12 RBAC ticket: T3/T4 users couldn't add labels to tasks they
  // owned. Root cause was a route-level `managerOrAdmin` plus a controller
  // `canManageBoard` check that both ran before the task-visibility gate
  // had a chance. Fixed by:
  //   - dropping `managerOrAdmin` from POST /api/labels routes,
  //   - restructuring createLabel so `canManageBoard` only gates the
  //     library path (no assignToTaskId), and
  //   - leaving the task-scoped path to be authorised by canViewTask
  //     alone — same gate that decides whether the row renders for them.
  //
  // These tests pin that contract for every tier.
  test.each([
    ['Tier 1 super admin', { id: 'u-t1', isSuperAdmin: true, role: 'admin', tier: 1 }],
    ['Tier 2 admin',       { id: 'u-t2a', isSuperAdmin: false, role: 'admin', tier: 2 }],
    ['Tier 2 manager (non-creator)', { id: 'u-t2m', isSuperAdmin: false, role: 'manager', tier: 2 }],
    ['Tier 3 assistant manager', { id: 'u-t3', isSuperAdmin: false, role: 'assistant_manager', tier: 3 }],
    ['Tier 4 member',      { id: 'u-t4', isSuperAdmin: false, role: 'member', tier: 4 }],
  ])('%s: task-scoped create (assignToTaskId on a visible task) succeeds', async (_label, user) => {
    Board.findByPk.mockResolvedValue({ id: 'b1', createdBy: 'someone-else' });
    Task.findByPk.mockResolvedValue({ id: 't1', boardId: 'b1' });
    taskVisibility.canViewTask.mockResolvedValue(true);
    Label.create.mockResolvedValue({ id: 'l-new', name: 'mine', color: '#579bfc', boardId: 'b1', createdBy: user.id });
    TaskLabel.create.mockResolvedValue({ taskId: 't1', labelId: 'l-new' });

    const req = { user, body: { name: 'mine', color: '#579bfc', boardId: 'b1', assignToTaskId: 't1' } };
    const res = mockRes();
    await labelCtrl.createLabel(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(Label.create).toHaveBeenCalled();
    expect(TaskLabel.create).toHaveBeenCalledWith(
      { taskId: 't1', labelId: 'l-new' },
      expect.objectContaining({ transaction: expect.anything() })
    );
  });

  test('Tier 4 member: task-scoped create on a task they CANNOT view → 403 (negative path)', async () => {
    Board.findByPk.mockResolvedValue({ id: 'b1', createdBy: 'someone-else' });
    Task.findByPk.mockResolvedValue({ id: 't1', boardId: 'b1' });
    // Per-row visibility says no — the row would not render in the user's
    // UI, so a direct API call attempting to bypass the UI must 403.
    taskVisibility.canViewTask.mockResolvedValue(false);

    const req = {
      user: { id: 'u-attacker', isSuperAdmin: false, role: 'member', tier: 4 },
      body: { name: 'sneak-attach', color: '#579bfc', boardId: 'b1', assignToTaskId: 't1' },
    };
    const res = mockRes();
    await labelCtrl.createLabel(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(Label.create).not.toHaveBeenCalled();
    expect(TaskLabel.create).not.toHaveBeenCalled();
  });

  test('task-scoped create: 404 when the task does not exist (no info leak about visibility)', async () => {
    Board.findByPk.mockResolvedValue({ id: 'b1', createdBy: 'someone-else' });
    Task.findByPk.mockResolvedValue(null);
    const req = {
      user: { id: 'u-t4', isSuperAdmin: false, role: 'member', tier: 4 },
      body: { name: 'x', color: '#579bfc', boardId: 'b1', assignToTaskId: 't-bogus' },
    };
    const res = mockRes();
    await labelCtrl.createLabel(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('returns 400 when name is missing', async () => {
    const req = { user: { id: 'u-super', isSuperAdmin: true, role: 'admin', tier: 1 }, body: { color: '#579bfc', boardId: 'b1' } };
    const res = mockRes();
    await labelCtrl.createLabel(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 404 when boardId references a missing board', async () => {
    Board.findByPk.mockResolvedValue(null);
    const req = { user: { id: 'u-super', isSuperAdmin: true, role: 'admin', tier: 1 }, body: { name: 'x', boardId: 'b-missing' } };
    const res = mockRes();
    await labelCtrl.createLabel(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('500 envelope includes `detail` outside of production (so the cell shows the SQL/Sequelize cause)', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      Board.findByPk.mockResolvedValue({ id: 'b1', createdBy: 'someone-else' });
      const err = new Error('null value in column "createdBy" violates not-null constraint');
      err.name = 'SequelizeDatabaseError';
      Label.create.mockRejectedValue(err);

      const req = {
        user: { id: 'u-super', isSuperAdmin: true, role: 'admin', tier: 1 },
        body: { name: 'oops', color: '#579bfc', boardId: 'b1' },
      };
      const res = mockRes();
      await labelCtrl.createLabel(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(false);
      expect(body.message).toBe('Failed to create label.');
      // The actual cause is included so the user / dev can act on it.
      expect(body.detail).toMatch(/createdBy/);
      expect(body.errorName).toBe('SequelizeDatabaseError');
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  test('500 envelope omits `detail` in production', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      Board.findByPk.mockResolvedValue({ id: 'b1', createdBy: 'someone-else' });
      Label.create.mockRejectedValue(new Error('boom'));
      const req = {
        user: { id: 'u-super', isSuperAdmin: true, role: 'admin', tier: 1 },
        body: { name: 'x', color: '#579bfc', boardId: 'b1' },
      };
      const res = mockRes();
      await labelCtrl.createLabel(req, res);
      const body = res.json.mock.calls[0][0];
      expect(body.detail).toBeUndefined();
      expect(body.errorName).toBeUndefined();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
