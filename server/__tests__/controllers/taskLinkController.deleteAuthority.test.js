'use strict';

/**
 * Phase A — taskLinkController.deleteLink destructive tier gate.
 *
 * Until Phase A, deleting a task link only required the "edit task links"
 * predicate (Tier 1/2 or any user linked to the task). That meant a Tier 2
 * manager — globally blocked from destructive operations by decision #4 —
 * could still delete shared task links. This suite pins the new
 * assertCanDelete gate that closes the gap.
 *
 * Tier semantics applied via the 'task_link' kind:
 *   Tier 1 → always allowed
 *   Tier 2 → never allowed (TIER_2_NO_DELETE)
 *   Tier 3 / 4 → only when isOwnResource (link.createdBy === user.id)
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

jest.mock('../../models', () => ({
  TaskLink: {
    findByPk: jest.fn(),
  },
  Task: { findByPk: jest.fn() },
  TaskAssignee: { findOne: jest.fn() },
}));

jest.mock('../../services/activityService', () => ({ logActivity: jest.fn() }));

jest.mock('../../services/socketService', () => ({
  emitToBoard: jest.fn(),
  emitToBoardAndUsers: jest.fn(),
}));

jest.mock('../../services/taskVisibilityService', () => ({
  canViewTask: jest.fn(async () => true),
  getAuthorizedRealtimeRecipients: jest.fn(async () => []),
}));

// NOTE: ../../config/tiers and ../../services/tierEnforcement are NOT
// mocked. We WANT the real TIER_1/TIER_2 resolution and the real
// assertCanDelete path so the gate (including the SHARED_KINDS entry for
// 'task_link') is exercised end-to-end.

const { TaskLink, Task } = require('../../models');
const taskCtrl = require('../../controllers/taskLinkController');
const realTier = require('../../services/tierEnforcement');

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  // A T1/T2 actor passes the canEditTaskLinks predicate by tier alone, so
  // the destructive gate is the only thing differentiating outcomes here.
  Task.findByPk.mockResolvedValue({ id: 't1', boardId: 'b1', assignedTo: 'u-other', createdBy: 'u-other' });
});

// ── Tier 1 super admin — always allowed ──────────────────────────────────

describe('deleteLink — Tier 1 super admin', () => {
  test('passes regardless of link ownership', async () => {
    const destroy = jest.fn().mockResolvedValue();
    TaskLink.findByPk.mockResolvedValue({ id: 'lk1', taskId: 't1', createdBy: 'someone-else', destroy });

    const req = {
      user: { id: 'u-t1', isSuperAdmin: true, role: 'admin', tier: 1 },
      params: { id: 'lk1' },
    };
    const res = mockRes();
    await taskCtrl.deleteLink(req, res);

    expect(destroy).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});

// ── Tier 2 — never allowed (decision #4 strict) ──────────────────────────

describe('deleteLink — Tier 2 destructive gate', () => {
  test('Tier 2 admin is blocked even if they created the link (own resource)', async () => {
    const destroy = jest.fn();
    TaskLink.findByPk.mockResolvedValue({ id: 'lk1', taskId: 't1', createdBy: 'u-t2', destroy });

    const req = {
      user: { id: 'u-t2', isSuperAdmin: false, role: 'admin', tier: 2 },
      params: { id: 'lk1' },
    };
    const res = mockRes();
    await taskCtrl.deleteLink(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(destroy).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0];
    expect(payload.code).toBe('TIER_2_NO_DELETE');
  });

  test('Tier 2 manager is blocked on a link they did NOT create', async () => {
    const destroy = jest.fn();
    TaskLink.findByPk.mockResolvedValue({ id: 'lk1', taskId: 't1', createdBy: 'someone-else', destroy });

    const req = {
      user: { id: 'u-t2', isSuperAdmin: false, role: 'manager', tier: 2 },
      params: { id: 'lk1' },
    };
    const res = mockRes();
    await taskCtrl.deleteLink(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(destroy).not.toHaveBeenCalled();
  });
});

// ── Tier 3 / Tier 4 — own resource only ──────────────────────────────────

describe('deleteLink — Tier 3/4 own-resource gate', () => {
  test('Tier 4 deleting their OWN link succeeds', async () => {
    const destroy = jest.fn().mockResolvedValue();
    // Make the task linked to T4 so canEditTaskLinks predicate passes.
    Task.findByPk.mockResolvedValue({ id: 't1', boardId: 'b1', assignedTo: 'u-t4', createdBy: 'u-t4' });
    TaskLink.findByPk.mockResolvedValue({ id: 'lk1', taskId: 't1', createdBy: 'u-t4', destroy });

    const req = {
      user: { id: 'u-t4', isSuperAdmin: false, role: 'member', tier: 4 },
      params: { id: 'lk1' },
    };
    const res = mockRes();
    await taskCtrl.deleteLink(req, res);

    expect(destroy).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  test("Tier 4 deleting someone else's link gets DELETE_FORBIDDEN", async () => {
    const destroy = jest.fn();
    // Task is linked to T4 (so canEditTaskLinks passes) but the link itself
    // was authored by another user. Without the assertCanDelete gate this
    // would have silently succeeded — the test pins the new rejection.
    Task.findByPk.mockResolvedValue({ id: 't1', boardId: 'b1', assignedTo: 'u-t4', createdBy: 'u-t4' });
    TaskLink.findByPk.mockResolvedValue({ id: 'lk1', taskId: 't1', createdBy: 'someone-else', destroy });

    const req = {
      user: { id: 'u-t4', isSuperAdmin: false, role: 'member', tier: 4 },
      params: { id: 'lk1' },
    };
    const res = mockRes();
    await taskCtrl.deleteLink(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(destroy).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0];
    expect(payload.code).toBe('DELETE_FORBIDDEN');
  });

  test('Tier 3 deleting their OWN link succeeds', async () => {
    const destroy = jest.fn().mockResolvedValue();
    Task.findByPk.mockResolvedValue({ id: 't1', boardId: 'b1', assignedTo: 'u-t3', createdBy: 'u-t3' });
    TaskLink.findByPk.mockResolvedValue({ id: 'lk1', taskId: 't1', createdBy: 'u-t3', destroy });

    const req = {
      user: { id: 'u-t3', isSuperAdmin: false, role: 'assistant_manager', tier: 3 },
      params: { id: 'lk1' },
    };
    const res = mockRes();
    await taskCtrl.deleteLink(req, res);

    expect(destroy).toHaveBeenCalled();
  });
});

// ── task_link kind is registered in tierEnforcement.SHARED_KINDS ─────────

describe('task_link kind registration', () => {
  test("'task_link' is a known SHARED_KIND in tierEnforcement", () => {
    const { SHARED_KINDS, KNOWN_KINDS } = realTier;
    expect(SHARED_KINDS.has('task_link')).toBe(true);
    expect(KNOWN_KINDS.has('task_link')).toBe(true);
  });
});
