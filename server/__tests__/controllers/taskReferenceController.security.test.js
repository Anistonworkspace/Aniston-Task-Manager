'use strict';

/**
 * Security + validation tests for taskReferenceController.
 *
 * Covers P0-4 (list endpoint IDOR) and the existing RBAC + xss + length
 * validation on the mutation endpoints.
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

jest.mock('../../models', () => ({
  TaskReference: {
    findAll: jest.fn(),
    findByPk: jest.fn(),
    create: jest.fn(),
    max: jest.fn(),
  },
  Task: { findByPk: jest.fn() },
  TaskAssignee: { findOne: jest.fn() },
}));

jest.mock('../../services/activityService', () => ({
  logActivity: jest.fn(),
}));

jest.mock('../../services/socketService', () => ({
  emitToBoard: jest.fn(),
}));

jest.mock('../../services/taskVisibilityService', () => ({
  canViewTask: jest.fn(),
}));

jest.mock('../../config/tiers', () => ({
  resolveTier: jest.fn(() => 4),
  TIER_1: 1,
  TIER_2: 2,
}));

const { TaskReference, Task, TaskAssignee } = require('../../models');
const taskVisibility = require('../../services/taskVisibilityService');
const { resolveTier } = require('../../config/tiers');
const refCtrl = require('../../controllers/taskReferenceController');

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── P0-4 ────────────────────────────────────────────────────────────
describe('listReferences — IDOR protection (P0-4)', () => {
  test('returns 403 when user cannot view the task', async () => {
    Task.findByPk.mockResolvedValue({ id: 't1', boardId: 'b1' });
    taskVisibility.canViewTask.mockResolvedValue(false);
    const req = { user: { id: 'attacker' }, params: { taskId: 't1' } };
    const res = mockRes();
    await refCtrl.listReferences(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(TaskReference.findAll).not.toHaveBeenCalled();
  });

  test('returns 404 when task does not exist', async () => {
    Task.findByPk.mockResolvedValue(null);
    const req = { user: { id: 'u1' }, params: { taskId: 'bogus' } };
    const res = mockRes();
    await refCtrl.listReferences(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('returns references sorted by position when viewable', async () => {
    Task.findByPk.mockResolvedValue({ id: 't1', boardId: 'b1' });
    taskVisibility.canViewTask.mockResolvedValue(true);
    TaskReference.findAll.mockResolvedValue([
      { id: 'r1', text: 'A', position: 0 },
      { id: 'r2', text: 'B', position: 1 },
    ]);
    const req = { user: { id: 'u1' }, params: { taskId: 't1' } };
    const res = mockRes();
    await refCtrl.listReferences(req, res);
    expect(TaskReference.findAll).toHaveBeenCalledWith({
      where: { taskId: 't1' },
      order: [['position', 'ASC'], ['createdAt', 'ASC']],
    });
  });
});

// ── createReference: validation + RBAC ──────────────────────────────
describe('createReference', () => {
  test('returns 400 when taskId is missing', async () => {
    const req = { user: { id: 'u1' }, body: { text: 'foo' } };
    const res = mockRes();
    await refCtrl.createReference(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 400 when text is empty after trim', async () => {
    const req = { user: { id: 'u1' }, body: { taskId: 't1', text: '   ' } };
    const res = mockRes();
    await refCtrl.createReference(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('returns 400 when text exceeds 500 characters', async () => {
    const req = { user: { id: 'u1' }, body: { taskId: 't1', text: 'x'.repeat(501) } };
    const res = mockRes();
    await refCtrl.createReference(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('strips script tags via xss (Tier 1/2 happy path)', async () => {
    resolveTier.mockReturnValue(1);
    Task.findByPk.mockResolvedValue({ id: 't1', boardId: 'b1', assignedTo: 'u2', createdBy: 'u2' });
    TaskReference.max.mockResolvedValue(0);
    TaskReference.create.mockResolvedValue({ id: 'r1', text: 'safe' });
    const req = { user: { id: 'u1' }, body: { taskId: 't1', text: '<script>alert(1)</script>safe' } };
    const res = mockRes();
    await refCtrl.createReference(req, res);
    const createArg = TaskReference.create.mock.calls[0][0];
    expect(createArg.text).not.toMatch(/<script>/);
    expect(createArg.text).toContain('safe');
  });

  test('Tier 4 non-assignee non-creator gets 403', async () => {
    resolveTier.mockReturnValue(4);
    Task.findByPk.mockResolvedValue({ id: 't1', boardId: 'b1', assignedTo: 'other', createdBy: 'other' });
    TaskAssignee.findOne.mockResolvedValue(null);
    const req = { user: { id: 'attacker' }, body: { taskId: 't1', text: 'hi' } };
    const res = mockRes();
    await refCtrl.createReference(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('Tier 4 assignee on own task succeeds', async () => {
    resolveTier.mockReturnValue(4);
    Task.findByPk.mockResolvedValue({ id: 't1', boardId: 'b1', assignedTo: 'u1', createdBy: 'other' });
    TaskReference.max.mockResolvedValue(null);
    TaskReference.create.mockResolvedValue({ id: 'r1' });
    const req = { user: { id: 'u1' }, body: { taskId: 't1', text: 'mine' } };
    const res = mockRes();
    await refCtrl.createReference(req, res);
    expect(res.status).toHaveBeenCalledWith(201);
  });
});
