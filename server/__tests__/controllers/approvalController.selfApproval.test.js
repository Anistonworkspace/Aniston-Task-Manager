'use strict';

/**
 * Test for approvalController self-approval guard — CP-1.
 *
 * The submitter (recorded at level 0 of task_approval_flows) must never be
 * able to call approve / reject / request_changes on their own task. This is
 * already implicitly prevented by the chain builder excluding the submitter,
 * but CP-1 adds an explicit defense-in-depth check inside processApprovalAction.
 */

jest.mock('xss', () => (s) => s);

const fakeTransaction = {
  LOCK: { UPDATE: 'UPDATE' },
  commit: jest.fn().mockResolvedValue(),
  rollback: jest.fn().mockResolvedValue(),
};

jest.mock('../../models', () => ({
  sequelize: {
    transaction: jest.fn(),
    literal: jest.fn((s) => s),
    where: jest.fn(),
  },
  Task: { findByPk: jest.fn() },
  User: { findByPk: jest.fn() },
  TaskApprovalFlow: {
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
  },
  DueDateExtension: {},
  HelpRequest: {},
  Board: {},
  Activity: {},
}));

jest.mock('../../services/activityService', () => ({ logActivity: jest.fn() }));
jest.mock('../../services/socketService', () => ({ emitToBoard: jest.fn() }));
jest.mock('../../services/approvalChainService', () => ({
  deriveApprovalChain: jest.fn(),
  previewNextApprover: jest.fn(),
}));
jest.mock('../../services/approvalNotificationService', () => ({}));

const { sequelize, Task, TaskApprovalFlow } = require('../../models');
const approvalController = require('../../controllers/approvalController');

beforeEach(() => {
  jest.clearAllMocks();
  sequelize.transaction.mockResolvedValue(fakeTransaction);
});

function buildRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

// Helper: stub the two findOne queries inside processApprovalAction.
//
//   1. findCurrentStageRows()'s lowest-pending lookup uses
//        where: { taskId, status: 'pending' }
//   2. The new self-approval guard uses
//        where: { taskId: <id>, level: 0 }
//
// We dispatch on the presence of `status` vs `level` to return distinct rows.
function stubFindOneForChain({ pendingRow, submitterRow }) {
  TaskApprovalFlow.findOne.mockImplementation(async ({ where } = {}) => {
    if (!where) return null;
    if (where.status === 'pending' && !('level' in where)) return pendingRow || null;
    if (where.level === 0) return submitterRow || null;
    return null;
  });
}

describe('approvalController self-approval guard', () => {
  it('rejects the submitter trying to approve their own task with 403', async () => {
    const submitterId = 'submitter-1';
    Task.findByPk.mockResolvedValue({
      id: 'task-1',
      approvalStatus: 'pending_approval',
    });

    // A pending row exists for the actor (which itself is the submitter — the
    // misconfiguration we are guarding against).
    const actorRow = {
      id: 'row-1',
      userId: submitterId,
      status: 'pending',
      level: 1,
      stage: 1,
      update: jest.fn().mockResolvedValue(),
    };
    stubFindOneForChain({
      pendingRow: actorRow,
      submitterRow: { userId: submitterId },
    });
    TaskApprovalFlow.findAll.mockResolvedValue([actorRow]);

    const req = {
      params: { id: 'task-1' },
      user: { id: submitterId, name: 'Submitter' },
      body: { comment: 'looks fine to me' },
    };
    const res = buildRes();

    await approvalController.approveTask(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: expect.stringMatching(/cannot act on a task you submitted/i),
      }),
    );
    expect(fakeTransaction.rollback).toHaveBeenCalled();
    expect(fakeTransaction.commit).not.toHaveBeenCalled();
    expect(actorRow.update).not.toHaveBeenCalled(); // no approval write occurred
  });

  it('does not block a different user (the legitimate approver) from acting', async () => {
    const submitterId = 'submitter-1';
    const approverId = 'approver-2';

    Task.findByPk.mockResolvedValue({
      id: 'task-1',
      approvalStatus: 'pending_approval',
      update: jest.fn().mockResolvedValue(),
      approvalChain: [],
    });
    const actorRow = {
      id: 'row-1',
      userId: approverId,
      status: 'pending',
      level: 1,
      stage: 1,
      update: jest.fn().mockResolvedValue(),
    };
    stubFindOneForChain({
      pendingRow: actorRow,
      submitterRow: { userId: submitterId },
    });
    TaskApprovalFlow.findAll.mockResolvedValue([actorRow]);

    const req = {
      params: { id: 'task-1' },
      user: { id: approverId, name: 'Approver' },
      body: { comment: 'approved' },
    };
    const res = buildRes();

    await approvalController.approveTask(req, res);

    // The self-approval guard must NOT fire for a different actor. The
    // request may succeed or rollback for unrelated test-harness reasons,
    // but the specific 403 self-approval message must not appear.
    const messages = res.json.mock.calls
      .map((c) => (c[0] && c[0].message) || '')
      .join('||');
    expect(messages).not.toMatch(/cannot act on a task you submitted/i);
  });
});
