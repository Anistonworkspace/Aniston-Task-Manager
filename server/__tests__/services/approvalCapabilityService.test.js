'use strict';

// Pure-function tests for the capability service. No mocks needed — the service
// has no DB dependencies. Covers the four authorization paths the controller
// relies on for action button rendering and 403 enforcement.

const { computeApprovalCapabilities } = require('../../services/approvalCapabilityService');

const TASK_PENDING = { approvalStatus: 'pending_approval' };

function flow(overrides) {
  return {
    id: overrides.id,
    level: overrides.level ?? 0,
    stage: overrides.stage ?? overrides.level ?? 0,
    userId: overrides.userId,
    userName: overrides.userName || `User ${overrides.userId}`,
    status: overrides.status || 'pending',
  };
}

describe('computeApprovalCapabilities', () => {
  describe('current-stage approver', () => {
    it('grants approve / reject / request_changes', () => {
      const flows = [
        flow({ id: '0', level: 0, stage: 0, userId: 'sub', status: 'submitted' }),
        flow({ id: '1', level: 1, stage: 1, userId: 'asst-mgr', status: 'pending' }),
        flow({ id: '2', level: 2, stage: 2, userId: 'mgr', status: 'pending' }),
      ];
      const caps = computeApprovalCapabilities({
        task: TASK_PENDING,
        flows,
        user: { id: 'asst-mgr', isSuperAdmin: false },
      });
      expect(caps).toMatchObject({
        canApprove: true,
        canReject: true,
        canRequestChanges: true,
        canApproveEarly: false,
        isCurrentApprover: true,
        isOverrideApprover: false,
        currentStage: 1,
      });
      expect(caps.reasonIfCannotAct).toBeNull();
    });
  });

  describe('higher-stage approver (early action)', () => {
    it('grants all three actions and flags canApproveEarly', () => {
      const flows = [
        flow({ id: '0', level: 0, stage: 0, userId: 'sub', status: 'submitted' }),
        flow({ id: '1', level: 1, stage: 1, userId: 'asst-mgr', status: 'pending' }),
        flow({ id: '2', level: 2, stage: 2, userId: 'mgr', status: 'pending' }),
        flow({ id: '3', level: 3, stage: 2, userId: 'admin', status: 'pending' }),
      ];
      const caps = computeApprovalCapabilities({
        task: TASK_PENDING,
        flows,
        user: { id: 'mgr', isSuperAdmin: false },
      });
      // mgr is at stage 2, current pending stage is 1 — so they're a higher-
      // stage actor. Spec: same action set as current-stage actor.
      expect(caps).toMatchObject({
        canApprove: true,
        canReject: true,
        canRequestChanges: true,
        canApproveEarly: true,
        isCurrentApprover: false,
        isOverrideApprover: false,
        currentStage: 1,
      });
    });
  });

  describe('Super Admin not in chain (override)', () => {
    it('grants all three actions and flags isOverrideApprover', () => {
      const flows = [
        flow({ id: '0', level: 0, stage: 0, userId: 'sub', status: 'submitted' }),
        flow({ id: '1', level: 1, stage: 1, userId: 'asst-mgr', status: 'pending' }),
      ];
      const caps = computeApprovalCapabilities({
        task: TASK_PENDING,
        flows,
        user: { id: 'sa-not-in-chain', isSuperAdmin: true },
      });
      expect(caps).toMatchObject({
        canApprove: true,
        canReject: true,
        canRequestChanges: true,
        canApproveEarly: false,
        isCurrentApprover: false,
        isOverrideApprover: true,
        currentStage: 1,
      });
    });
  });

  describe('Super Admin in chain at higher stage', () => {
    it('takes the higher-stage path (canApproveEarly=true), not the override path', () => {
      const flows = [
        flow({ id: '0', level: 0, stage: 0, userId: 'sub', status: 'submitted' }),
        flow({ id: '1', level: 1, stage: 1, userId: 'asst-mgr', status: 'pending' }),
        flow({ id: '2', level: 2, stage: 2, userId: 'sa', status: 'pending' }),
      ];
      const caps = computeApprovalCapabilities({
        task: TASK_PENDING,
        flows,
        user: { id: 'sa', isSuperAdmin: true },
      });
      // SA is in chain → matched as higher-stage approver, not as override.
      expect(caps.isOverrideApprover).toBe(false);
      expect(caps.canApproveEarly).toBe(true);
      expect(caps.canApprove).toBe(true);
      expect(caps.canReject).toBe(true);
      expect(caps.canRequestChanges).toBe(true);
    });
  });

  describe('user not in chain and not Super Admin', () => {
    it('grants no actions, returns reason', () => {
      const flows = [
        flow({ id: '0', level: 0, stage: 0, userId: 'sub', status: 'submitted' }),
        flow({ id: '1', level: 1, stage: 1, userId: 'asst-mgr', status: 'pending' }),
      ];
      const caps = computeApprovalCapabilities({
        task: TASK_PENDING,
        flows,
        user: { id: 'random-member', isSuperAdmin: false },
      });
      expect(caps.canApprove).toBe(false);
      expect(caps.canReject).toBe(false);
      expect(caps.canRequestChanges).toBe(false);
      expect(caps.reasonIfCannotAct).toMatch(/not in this approval chain/i);
    });
  });

  describe('submitter (level 0) self-approval guard', () => {
    it('blocks the submitter from acting even if they are also Super Admin', () => {
      const flows = [
        flow({ id: '0', level: 0, stage: 0, userId: 'sa-submitter', status: 'submitted' }),
        flow({ id: '1', level: 1, stage: 1, userId: 'asst-mgr', status: 'pending' }),
      ];
      const caps = computeApprovalCapabilities({
        task: TASK_PENDING,
        flows,
        user: { id: 'sa-submitter', isSuperAdmin: true },
      });
      expect(caps.canApprove).toBe(false);
      expect(caps.canReject).toBe(false);
      expect(caps.canRequestChanges).toBe(false);
      expect(caps.reasonIfCannotAct).toMatch(/you submitted this task/i);
    });
  });

  describe('terminal approval states', () => {
    it.each(['approved', 'rejected', 'changes_requested', null])(
      'returns no actions when task.approvalStatus = %s',
      (status) => {
        const caps = computeApprovalCapabilities({
          task: { approvalStatus: status },
          flows: [],
          user: { id: 'anyone', isSuperAdmin: true },
        });
        expect(caps.canApprove).toBe(false);
        expect(caps.canReject).toBe(false);
        expect(caps.canRequestChanges).toBe(false);
      }
    );
  });

  describe('parallel any-of stage', () => {
    it('every member of the lowest pending stage is a current-stage approver', () => {
      const flows = [
        flow({ id: '0', level: 0, stage: 0, userId: 'sub', status: 'submitted' }),
        flow({ id: '1', level: 1, stage: 1, userId: 'mgr', status: 'pending' }),
        flow({ id: '2', level: 2, stage: 1, userId: 'admin', status: 'pending' }),
        flow({ id: '3', level: 3, stage: 1, userId: 'sa', status: 'pending' }),
      ];
      for (const userId of ['mgr', 'admin', 'sa']) {
        const caps = computeApprovalCapabilities({
          task: TASK_PENDING,
          flows,
          user: { id: userId, isSuperAdmin: userId === 'sa' },
        });
        expect(caps.isCurrentApprover).toBe(true);
        expect(caps.canApprove && caps.canReject && caps.canRequestChanges).toBe(true);
      }
    });
  });

  describe('unauthenticated', () => {
    it('returns empty capabilities with reason', () => {
      const caps = computeApprovalCapabilities({
        task: TASK_PENDING,
        flows: [],
        user: null,
      });
      expect(caps.canApprove).toBe(false);
      expect(caps.reasonIfCannotAct).toMatch(/not authenticated/i);
    });
  });
});
