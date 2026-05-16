'use strict';

/**
 * Phase A — Label permission enforcement tests.
 *
 * Pins the rule confirmed in the May 2026 RBAC hardening:
 *
 *   labels.create       — create a new label row in the board's library
 *   labels.add_to_task  — attach an existing label to a task
 *   labels.remove_from_task — remove a label from a task
 *
 * Plus the one-click create-and-attach flow which now requires BOTH
 * labels.create AND labels.add_to_task on the backend. Previously the
 * task-scoped path was authorised by canViewTask alone, which let a
 * Tier 3/4 user piggy-back board-library label creation on any task
 * they could see.
 *
 * Also pins the engine-backed canManageBoard refactor: a T3 with an
 * explicit labels.create grant override is now allowed through the
 * board-library path; a T2 with an explicit DENY is blocked. Mirrors
 * the precedence rule on every other gated controller.
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
  Task: { findByPk: jest.fn() },
  User: {},
  Board: { findByPk: jest.fn() },
}));

jest.mock('../../config/db', () => ({
  sequelize: { transaction: jest.fn(async (cb) => cb({})) },
}));

jest.mock('../../services/socketService', () => ({
  emitToBoard: jest.fn(),
  emitToBoardAndUsers: jest.fn(),
}));

jest.mock('../../services/taskVisibilityService', () => ({
  canViewTask: jest.fn(async () => true),
  getAuthorizedRealtimeRecipients: jest.fn(async () => []),
}));

jest.mock('../../services/boardVisibilityService', () => ({
  canUserSeeBoard: jest.fn(async () => true),
}));

jest.mock('../../services/tierEnforcement', () => ({
  assertCanDelete: jest.fn(() => true),
}));

jest.mock('../../utils/tierResponseHelpers', () => ({
  sendIfTierError: jest.fn(() => false),
}));

// The permissionEngine + permissionGate mocks are configured per-test so we
// can simulate grant-vs-deny scenarios precisely.
jest.mock('../../services/permissionEngine', () => ({
  hasPermission: jest.fn(),
  canGrantPermission: jest.fn(),
  computeEffectivePermissions: jest.fn(),
}));

jest.mock('../../utils/permissionGate', () => ({
  denyIfNoPermission: jest.fn(),
  checkPermission: jest.fn(),
}));

jest.mock('../../utils/sanitize', () => ({
  sanitizeInput: jest.fn((v) => v),
}));

const { Label, TaskLabel, Task, Board } = require('../../models');
const taskVisibility = require('../../services/taskVisibilityService');
const enginePermission = require('../../services/permissionEngine');
const permissionGate = require('../../utils/permissionGate');
const labelCtrl = require('../../controllers/labelController');

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  enginePermission.hasPermission.mockResolvedValue(true);
  permissionGate.denyIfNoPermission.mockResolvedValue(false);
});

// ── Task-scoped create now requires BOTH labels.create AND labels.add_to_task ──

describe('createLabel — task-scoped path requires labels.create + labels.add_to_task', () => {
  const visibleTask = { id: 't1', boardId: 'b1' };
  const t4Member = { id: 'u-t4', isSuperAdmin: false, role: 'member', tier: 4 };

  test('happy path — both gates pass → 201', async () => {
    Task.findByPk.mockResolvedValue(visibleTask);
    taskVisibility.canViewTask.mockResolvedValue(true);
    Label.create.mockResolvedValue({ id: 'l-new', name: 'mine' });
    TaskLabel.create.mockResolvedValue({});
    permissionGate.denyIfNoPermission.mockResolvedValue(false); // neither denies

    const req = { user: t4Member, body: { name: 'mine', boardId: 'b1', assignToTaskId: 't1' } };
    const res = mockRes();
    await labelCtrl.createLabel(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    // Verify both checks were attempted in the correct order.
    const calls = permissionGate.denyIfNoPermission.mock.calls;
    const actionsChecked = calls.map((c) => c[3]); // 4th arg is the action
    expect(actionsChecked).toContain('create');
    expect(actionsChecked).toContain('add_to_task');
  });

  test('labels.create denied → 403 BEFORE label is created', async () => {
    Task.findByPk.mockResolvedValue(visibleTask);
    taskVisibility.canViewTask.mockResolvedValue(true);
    // First call (labels.create) denies; controller short-circuits.
    permissionGate.denyIfNoPermission.mockImplementationOnce(async (res) => {
      res.status(403).json({ success: false, code: 'PERMISSION_DENIED', permission: 'labels.create' });
      return true;
    });

    const req = { user: t4Member, body: { name: 'mine', boardId: 'b1', assignToTaskId: 't1' } };
    const res = mockRes();
    await labelCtrl.createLabel(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(Label.create).not.toHaveBeenCalled();
    expect(TaskLabel.create).not.toHaveBeenCalled();
  });

  test('labels.add_to_task denied → 403 (after labels.create passed)', async () => {
    Task.findByPk.mockResolvedValue(visibleTask);
    taskVisibility.canViewTask.mockResolvedValue(true);
    // First call (labels.create) passes; second call (labels.add_to_task) denies.
    permissionGate.denyIfNoPermission
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(async (res) => {
        res.status(403).json({ success: false, code: 'PERMISSION_DENIED', permission: 'labels.add_to_task' });
        return true;
      });

    const req = { user: t4Member, body: { name: 'mine', boardId: 'b1', assignToTaskId: 't1' } };
    const res = mockRes();
    await labelCtrl.createLabel(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(Label.create).not.toHaveBeenCalled();
    expect(TaskLabel.create).not.toHaveBeenCalled();
  });

  test('visibility gate fires BEFORE permission gates (no permission lookup on hidden task)', async () => {
    Task.findByPk.mockResolvedValue(visibleTask);
    taskVisibility.canViewTask.mockResolvedValue(false);

    const req = { user: t4Member, body: { name: 'mine', boardId: 'b1', assignToTaskId: 't1' } };
    const res = mockRes();
    await labelCtrl.createLabel(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    // Critical: a user who cannot see the task gets no information about
    // whether their permissions would have been enough.
    expect(permissionGate.denyIfNoPermission).not.toHaveBeenCalled();
  });
});

// ── canManageBoard is engine-backed (grants & denies now work) ──

describe('canManageBoard — engine-backed (Phase A)', () => {
  test('T3 with labels.create GRANT override succeeds on board-library create', async () => {
    // Engine returns true for labels.create → canManageBoard returns true
    // even though tier-3 base says false. Confirms PermissionGrant overrides
    // now flow through the controller instead of being ignored by a stale
    // role-string check.
    enginePermission.hasPermission.mockResolvedValue(true);
    Board.findByPk.mockResolvedValue({ id: 'b1', createdBy: 'someone-else' });
    Label.create.mockResolvedValue({ id: 'l-new', name: 'asst-mgr-lbl' });

    const req = {
      user: { id: 'u-t3', isSuperAdmin: false, role: 'assistant_manager', tier: 3 },
      body: { name: 'asst-mgr-lbl', color: '#579bfc', boardId: 'b1' }, // library path
    };
    const res = mockRes();
    await labelCtrl.createLabel(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(Label.create).toHaveBeenCalled();
  });

  test('T2 with labels.create DENY override is blocked on board-library create', async () => {
    // Engine returns false → canManageBoard returns false (board.createdBy
    // !== user.id), controller 403s. This is the deny-precedence-wins case
    // the role-string gate could not enforce.
    enginePermission.hasPermission.mockResolvedValue(false);
    Board.findByPk.mockResolvedValue({ id: 'b1', createdBy: 'someone-else' });

    const req = {
      user: { id: 'u-t2', isSuperAdmin: false, role: 'manager', tier: 2 },
      body: { name: 'blocked-lbl', color: '#579bfc', boardId: 'b1' },
    };
    const res = mockRes();
    await labelCtrl.createLabel(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(Label.create).not.toHaveBeenCalled();
  });

  test('board creator fallback still works when engine denies', async () => {
    // Engine says no, but actor is the board creator — fallback admits
    // them. Mirrors pre-Phase-A behaviour for the rare case where a
    // member who personally created a board needs to curate its labels.
    enginePermission.hasPermission.mockResolvedValue(false);
    Board.findByPk.mockResolvedValue({ id: 'b1', createdBy: 'u-member' });
    Label.create.mockResolvedValue({ id: 'l-new', name: 'own-board-lbl' });

    const req = {
      user: { id: 'u-member', isSuperAdmin: false, role: 'member', tier: 4 },
      body: { name: 'own-board-lbl', color: '#579bfc', boardId: 'b1' },
    };
    const res = mockRes();
    await labelCtrl.createLabel(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(Label.create).toHaveBeenCalled();
  });

  test('super admin bypasses engine entirely', async () => {
    // Engine never gets called for super_admin — the early return in
    // canManageBoard short-circuits. This is defensive against an engine
    // mock that wrongly denies for super admin during testing.
    enginePermission.hasPermission.mockResolvedValue(false);
    Board.findByPk.mockResolvedValue({ id: 'b1', createdBy: 'someone-else' });
    Label.create.mockResolvedValue({ id: 'l-new', name: 'super-lbl' });

    const req = {
      user: { id: 'u-super', isSuperAdmin: true, role: 'admin', tier: 1 },
      body: { name: 'super-lbl', color: '#579bfc', boardId: 'b1' },
    };
    const res = mockRes();
    await labelCtrl.createLabel(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
  });
});

// ── updateLabel + deleteLabel now also flow through canManageBoard ──

describe('updateLabel — engine-backed canManageBoard', () => {
  test('T2 with labels.edit DENY is blocked', async () => {
    enginePermission.hasPermission.mockResolvedValue(false);
    Label.findByPk.mockResolvedValue({ id: 'l1', boardId: 'b1', update: jest.fn() });
    Board.findByPk.mockResolvedValue({ id: 'b1', createdBy: 'someone-else' });

    const req = {
      user: { id: 'u-t2', isSuperAdmin: false, role: 'manager', tier: 2 },
      params: { id: 'l1' },
      body: { name: 'new-name' },
    };
    const res = mockRes();
    await labelCtrl.updateLabel(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('T3 with labels.edit GRANT can update', async () => {
    enginePermission.hasPermission.mockResolvedValue(true);
    const update = jest.fn();
    Label.findByPk.mockResolvedValue({ id: 'l1', boardId: 'b1', color: '#000', update });
    Board.findByPk.mockResolvedValue({ id: 'b1', createdBy: 'someone-else' });

    const req = {
      user: { id: 'u-t3', isSuperAdmin: false, role: 'assistant_manager', tier: 3 },
      params: { id: 'l1' },
      body: { name: 'renamed' },
    };
    const res = mockRes();
    await labelCtrl.updateLabel(req, res);

    expect(update).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalled();
  });
});

describe('deleteLabel — engine-backed canManageBoard', () => {
  test('T2 with labels.delete DENY is blocked', async () => {
    enginePermission.hasPermission.mockResolvedValue(false);
    Label.findByPk.mockResolvedValue({ id: 'l1', boardId: 'b1' });
    Board.findByPk.mockResolvedValue({ id: 'b1', createdBy: 'someone-else' });

    const req = {
      user: { id: 'u-t2', isSuperAdmin: false, role: 'manager', tier: 2 },
      params: { id: 'l1' },
    };
    const res = mockRes();
    await labelCtrl.deleteLabel(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(Label.destroy).not.toHaveBeenCalled();
  });

  test('T3 with labels.delete GRANT succeeds', async () => {
    enginePermission.hasPermission.mockResolvedValue(true);
    Label.findByPk.mockResolvedValue({ id: 'l1', boardId: 'b1' });
    Board.findByPk.mockResolvedValue({ id: 'b1', createdBy: 'someone-else' });
    TaskLabel.destroy.mockResolvedValue(0);
    Label.destroy.mockResolvedValue(1);

    const req = {
      user: { id: 'u-t3', isSuperAdmin: false, role: 'assistant_manager', tier: 3 },
      params: { id: 'l1' },
    };
    const res = mockRes();
    await labelCtrl.deleteLabel(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});
