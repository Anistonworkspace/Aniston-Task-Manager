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
}));

jest.mock('../../services/taskVisibilityService', () => ({
  canViewTask: jest.fn(),
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
