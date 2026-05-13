'use strict';

/**
 * Authorization expansion tests for processApprovalAction.
 *
 * Specifically covers the new behaviors added to fix the
 * "You are not a current approver for this task" 403 + missing Reject button:
 *
 *   1. Higher-stage actor can REJECT (terminal) and REQUEST CHANGES (terminal)
 *   2. Super Admin override (not in chain) gets a synthesized row + can act
 *   3. Non-current, non-higher, non-SA user is still 403
 *
 * Mocks the entire models layer the same way approvalController.selfApproval
 * test does, so jest doesn't need a real Postgres.
 */

jest.mock('xss', () => (s) => s);

// Phase B — approve/rejectTask now have granular tasks.approve_completion /
// tasks.reject_completion gates. These tests cover authorization expansion
// (higher-stage approvers etc.), not the new granular permission. Mock
// permissionGate to allow.
jest.mock('../../utils/permissionGate', () => ({
  denyIfNoPermission: jest.fn(async () => false),
  checkPermission: jest.fn(async () => true),
}));

const fakeTransaction = {
  LOCK: { UPDATE: 'UPDATE' },
  commit: jest.fn().mockResolvedValue(),
  rollback: jest.fn().mockResolvedValue(),
  finished: false,
};

jest.mock('../../models', () => ({
  sequelize: {
    transaction: jest.fn(),
    literal: jest.fn((s) => s),
    where: jest.fn((a, b) => ({ a, b })),
  },
  Task: { findByPk: jest.fn() },
  User: { findByPk: jest.fn() },
  TaskApprovalFlow: {
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
    count: jest.fn(),
  },
  DueDateExtension: {},
  HelpRequest: {},
  // Board is now consulted by processApprovalAction for lifecycle group
  // movement. Default mock returns null (no board found) — lifecycle helpers
  // handle that gracefully by skipping the group move; status/progress still
  // get patched.
  Board: { findByPk: jest.fn().mockResolvedValue(null) },
  Activity: {},
}));

jest.mock('../../services/activityService', () => ({ logActivity: jest.fn() }));
jest.mock('../../services/realtimeService', () => ({ emitApprovalChanged: jest.fn() }));
jest.mock('../../services/approvalChainService', () => ({
  deriveApprovalChain: jest.fn(),
  previewNextApprover: jest.fn(),
}));
jest.mock('../../services/approvalNotificationService', () => ({
  notifySubmitted: jest.fn().mockResolvedValue(),
  notifyAdvanced: jest.fn().mockResolvedValue(),
  notifyCompleted: jest.fn().mockResolvedValue(),
  notifyRejected: jest.fn().mockResolvedValue(),
  notifyChangesRequested: jest.fn().mockResolvedValue(),
  notifyAutoApproved: jest.fn().mockResolvedValue(),
  notifyWatchers: jest.fn().mockResolvedValue(),
}));

const { sequelize, Task, TaskApprovalFlow } = require('../../models');
const approvalController = require('../../controllers/approvalController');

beforeEach(() => {
  jest.clearAllMocks();
  fakeTransaction.finished = false;
  sequelize.transaction.mockResolvedValue(fakeTransaction);
});

function buildRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

// Make a mutable row that captures .update() so assertions can read state.
function makeFlowRow(overrides) {
  const row = {
    id: overrides.id,
    level: overrides.level ?? 0,
    stage: overrides.stage ?? overrides.level ?? 0,
    userId: overrides.userId,
    userName: overrides.userName || `User ${overrides.userId}`,
    status: overrides.status || 'pending',
    update: jest.fn(function (patch) {
      Object.assign(this, patch);
      return Promise.resolve(this);
    }),
  };
  return row;
}

// Default chain: submitter, asst-mgr (current), mgr (higher), admin (higher).
function defaultChain() {
  return [
    makeFlowRow({ id: 'r0', level: 0, stage: 0, userId: 'sub', status: 'submitted' }),
    makeFlowRow({ id: 'r1', level: 1, stage: 1, userId: 'asst-mgr', status: 'pending' }),
    makeFlowRow({ id: 'r2', level: 2, stage: 2, userId: 'mgr', status: 'pending' }),
    makeFlowRow({ id: 'r3', level: 3, stage: 2, userId: 'admin', status: 'pending' }),
  ];
}

// Wires up the model mocks for a given chain. After this, calling any of
// approveTask/rejectTask/requestChanges on the controller will be deterministic.
function wireMocks({ chain, taskOverrides = {} }) {
  const task = {
    id: 'task-1',
    boardId: 'board-1',
    title: 'Test',
    approvalStatus: 'pending_approval',
    approvalChain: [],
    update: jest.fn(function (patch) { Object.assign(this, patch); return Promise.resolve(this); }),
    ...taskOverrides,
  };
  Task.findByPk.mockResolvedValue(task);

  // findCurrentStageRows uses findOne to find the lowest pending row, then
  // findAll to lock the whole stage. Then findAll is also used for capability
  // calc and "all other pending" peer cancellation queries.
  const lowestPending = chain
    .filter((r) => r.status === 'pending')
    .sort((a, b) => (a.stage || 0) - (b.stage || 0) || a.level - b.level)[0] || null;
  const stageOf = (r) => (r.stage != null ? r.stage : r.level);

  TaskApprovalFlow.findOne.mockImplementation(async ({ where = {}, order } = {}) => {
    // Self-approval guard: { taskId, level: 0 }
    if (where.level === 0) {
      return chain.find((r) => r.level === 0) || null;
    }
    // Higher-stage actor lookup: { taskId, status: 'pending', userId }
    if (where.status === 'pending' && where.userId) {
      return (
        chain.find(
          (r) => r.userId === where.userId && r.status === 'pending'
        ) || null
      );
    }
    // Max level lookup for SA override row synthesis
    if (Array.isArray(order) && order[0] && order[0][0] === 'level' && order[0][1] === 'DESC') {
      return chain.slice().sort((a, b) => b.level - a.level)[0] || null;
    }
    // Default lowest-pending lookup (findCurrentStageRows step 1)
    if (where.status === 'pending') {
      return lowestPending;
    }
    return null;
  });

  TaskApprovalFlow.findAll.mockImplementation(async ({ where = {} } = {}) => {
    // findCurrentStageRows step 2 — lock the whole stage.
    if (where[Symbol.for('and')] || where.taskId) {
      // Capability snapshot — { taskId } only, returns full chain.
      if (Object.keys(where).length === 1 && where.taskId) {
        return chain;
      }
      // "All other pending peers" cancellation query
      if (where.status === 'pending' && where.id) {
        return chain.filter((r) => r.status === 'pending' && r.id !== where.id[Symbol.for('ne')]);
      }
      // Stage rows (mocked: just return current-stage rows)
      if (where.status === 'pending') {
        return chain.filter((r) => r.status === 'pending');
      }
      return chain;
    }
    return chain;
  });

  TaskApprovalFlow.update.mockImplementation(async (patch, { where = {} } = {}) => {
    // Apply the patch in-memory so subsequent count/findAll calls reflect it.
    const { Op } = require('sequelize');
    const matches = chain.filter((r) => {
      if (where.id?.[Op.in]) return where.id[Op.in].includes(r.id);
      if (where.id?.[Op.ne]) return r.id !== where.id[Op.ne];
      if (where.id) return r.id === where.id;
      if (where.status === 'pending' && r.status === 'pending') return true;
      return false;
    });
    matches.forEach((r) => Object.assign(r, patch));
    return [matches.length];
  });

  TaskApprovalFlow.create.mockImplementation(async (data) => {
    const row = makeFlowRow(data);
    chain.push(row);
    return row;
  });

  TaskApprovalFlow.count.mockImplementation(async ({ where = {} } = {}) => {
    if (where.status === 'pending') {
      return chain.filter((r) => r.status === 'pending').length;
    }
    return chain.length;
  });

  return { task, chain };
}

describe('approvalController authorization expansion', () => {
  describe('higher-stage approver actions', () => {
    it('allows a higher-stage approver (mgr at stage 2) to REJECT terminally', async () => {
      const chain = defaultChain();
      const { task } = wireMocks({ chain });
      const req = {
        params: { id: 'task-1' },
        user: { id: 'mgr', name: 'Manager', isSuperAdmin: false },
        body: { comment: 'not acceptable' },
      };
      const res = buildRes();

      await approvalController.rejectTask(req, res);

      // The action should NOT be a 403.
      const sendCalls = res.json.mock.calls.map((c) => c[0]);
      const has403 = res.status.mock.calls.some(([code]) => code === 403);
      expect(has403).toBe(false);
      // Task should be marked rejected (terminal — higher stage actor).
      expect(task.update).toHaveBeenCalledWith(
        expect.objectContaining({ approvalStatus: 'rejected' }),
        expect.anything()
      );
      // No bounce-back: no row should have been reset back to 'pending'.
      const updates = TaskApprovalFlow.update.mock.calls.map((c) => c[0]);
      expect(updates.some((u) => u.status === 'pending' && u.actionAt === null)).toBe(false);
      // Final response is 200 success.
      expect(sendCalls.some((p) => p && p.success)).toBe(true);
    });

    it('allows a higher-stage approver to REQUEST CHANGES terminally', async () => {
      const chain = defaultChain();
      const { task } = wireMocks({ chain });
      const req = {
        params: { id: 'task-1' },
        user: { id: 'mgr', name: 'Manager', isSuperAdmin: false },
        body: { comment: 'please rework section 2' },
      };
      const res = buildRes();

      await approvalController.requestChanges(req, res);

      const has403 = res.status.mock.calls.some(([code]) => code === 403);
      expect(has403).toBe(false);
      expect(task.update).toHaveBeenCalledWith(
        expect.objectContaining({ approvalStatus: 'changes_requested' }),
        expect.anything()
      );
    });
  });

  describe('Super Admin override (not in chain)', () => {
    it('synthesizes a flow row at the current stage and approves', async () => {
      // Chain WITHOUT a Super Admin in it.
      const chain = [
        makeFlowRow({ id: 'r0', level: 0, stage: 0, userId: 'sub', status: 'submitted' }),
        makeFlowRow({ id: 'r1', level: 1, stage: 1, userId: 'asst-mgr', status: 'pending' }),
      ];
      const { task } = wireMocks({ chain });
      const req = {
        params: { id: 'task-1' },
        user: { id: 'sa-1', name: 'Super Admin', isSuperAdmin: true },
        body: { comment: 'override approve' },
      };
      const res = buildRes();

      await approvalController.approveTask(req, res);

      // No 403.
      expect(res.status.mock.calls.some(([code]) => code === 403)).toBe(false);
      // A new flow row was created (the synthesis).
      expect(TaskApprovalFlow.create).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-1',
          userId: 'sa-1',
          role: 'super_admin_override',
          stage: 1,
        }),
        expect.anything()
      );
      // Task should be marked approved + status 'done' since SA override
      // collapses any remaining higher-stage pending.
      expect(task.update).toHaveBeenCalledWith(
        expect.objectContaining({ approvalStatus: 'approved', status: 'done' }),
        expect.anything()
      );
    });

    it('rejects via SA override and marks task rejected (terminal)', async () => {
      const chain = [
        makeFlowRow({ id: 'r0', level: 0, stage: 0, userId: 'sub', status: 'submitted' }),
        makeFlowRow({ id: 'r1', level: 1, stage: 1, userId: 'asst-mgr', status: 'pending' }),
      ];
      const { task } = wireMocks({ chain });
      const req = {
        params: { id: 'task-1' },
        user: { id: 'sa-1', name: 'Super Admin', isSuperAdmin: true },
        body: { comment: 'override reject' },
      };
      const res = buildRes();

      await approvalController.rejectTask(req, res);

      expect(res.status.mock.calls.some(([code]) => code === 403)).toBe(false);
      expect(TaskApprovalFlow.create).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'super_admin_override' }),
        expect.anything()
      );
      expect(task.update).toHaveBeenCalledWith(
        expect.objectContaining({ approvalStatus: 'rejected' }),
        expect.anything()
      );
    });

    it('requests changes via SA override and marks task changes_requested', async () => {
      const chain = [
        makeFlowRow({ id: 'r0', level: 0, stage: 0, userId: 'sub', status: 'submitted' }),
        makeFlowRow({ id: 'r1', level: 1, stage: 1, userId: 'asst-mgr', status: 'pending' }),
      ];
      const { task } = wireMocks({ chain });
      const req = {
        params: { id: 'task-1' },
        user: { id: 'sa-1', name: 'Super Admin', isSuperAdmin: true },
        body: { comment: 'fix this' },
      };
      const res = buildRes();

      await approvalController.requestChanges(req, res);

      expect(res.status.mock.calls.some(([code]) => code === 403)).toBe(false);
      expect(TaskApprovalFlow.create).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'super_admin_override' }),
        expect.anything()
      );
      expect(task.update).toHaveBeenCalledWith(
        expect.objectContaining({ approvalStatus: 'changes_requested' }),
        expect.anything()
      );
    });
  });

  describe('non-approver still blocked', () => {
    it('returns 403 when a random user tries to approve and they have no chain row', async () => {
      const chain = defaultChain();
      wireMocks({ chain });
      const req = {
        params: { id: 'task-1' },
        user: { id: 'random-member', name: 'Random', isSuperAdmin: false },
        body: { comment: '' },
      };
      const res = buildRes();

      await approvalController.approveTask(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(TaskApprovalFlow.create).not.toHaveBeenCalled();
    });

    it('returns 403 when a random user tries to reject', async () => {
      const chain = defaultChain();
      wireMocks({ chain });
      const req = {
        params: { id: 'task-1' },
        user: { id: 'random-member', name: 'Random', isSuperAdmin: false },
        body: { comment: 'no' },
      };
      const res = buildRes();

      await approvalController.rejectTask(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
    });
  });
});
