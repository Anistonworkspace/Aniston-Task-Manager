'use strict';

/**
 * Phase 12 — Dependency Request controller tests.
 *
 * Scenarios from the project spec:
 *   A. Main happy path        (create → accept → start → done → unblock)
 *   B. Permission boundary    (non-assignee can't transition; assignee can)
 *   C. Rejection flow         (reason required; parent stays blocked)
 *   D. Multiple dependencies  (parent blocked until all clear)
 *   E. Admin override         (elevated user transitions a row they're not a party to + audit log)
 *
 * The controller is exercised directly with mocked models / services / DB —
 * matches the project's existing controller-test pattern (no DB, fast).
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

// ─── Mocks ───────────────────────────────────────────────────────────────────

jest.mock('../../config/db', () => ({
  sequelize: { query: jest.fn(), define: jest.fn(() => ({})) },
}));

jest.mock('../../models', () => {
  const STATUSES = ['pending', 'accepted', 'working_on_it', 'done', 'rejected', 'cancelled'];
  const ACTIVE_STATUSES = ['pending', 'accepted', 'working_on_it'];
  const PRIORITIES = ['low', 'medium', 'high', 'critical'];
  const DependencyRequest = {
    create:   jest.fn(),
    findOne:  jest.fn(),
    findByPk: jest.fn(),
    findAll:  jest.fn(),
    count:    jest.fn(),
    STATUSES, ACTIVE_STATUSES, PRIORITIES,
  };
  return {
    DependencyRequest,
    Task: { findByPk: jest.fn() },
    Board: {},
    User: { findByPk: jest.fn() },
    TaskAssignee: {},
    TaskOwner: {},
  };
});

jest.mock('../../services/dependencyService', () => ({
  recomputeParentBlockState:      jest.fn(),
  dispatchDependencyEvent:        jest.fn(),
  isTaskBlocked:                  jest.fn(),
  // Phase 13 — shadow-task materializer. Tests that exercise accept /
  // start / done / cancel will assert it gets called with the right dep.
  syncLinkedTaskFromDependency:   jest.fn(),
}));

jest.mock('../../services/activityService', () => ({
  logActivity: jest.fn(),
}));

// Phase 7 — dependencyRequestController gained granular gates on
// dependencies.approve / dependencies.reject. These existing tests cover
// the state-machine + audit-log behavior, not the permission gating
// (which has its own dedicated suite in permissionEngine.grantability).
// Mock the engine so the new gates never deny in this suite.
jest.mock('../../services/permissionEngine', () => ({
  hasPermission: jest.fn(async () => true),
  canGrantPermission: jest.fn(async () => ({ allowed: true })),
  computeEffectivePermissions: jest.fn(async () => ({ permissions: {}, basePermissions: {}, overrides: [], denials: [], grants: [] })),
  fetchActiveGrants: jest.fn(async () => []),
  getPermissionCatalog: jest.fn(() => ({ meta: {}, resources: {}, actions: {}, resourceActions: {}, resourcesByCategory: {}, grantability: {}, tierPermissions: {}, umbrellaFallbacks: {}, tierPermissionsFlat: {} })),
  getPermissionMetadata: jest.fn(() => ({ resources: {}, resourceActions: {}, resourcesByCategory: {}, effects: ['grant', 'deny'] })),
  getEffectiveBasePermission: jest.fn(() => true),
  getEffectiveBasePermissions: jest.fn(() => ({})),
  mapLegacyLevelToActions: jest.fn(() => []),
  getGrantability: jest.fn(() => ({ grantableBy: [1, 2], deniableBy: [1, 2] })),
  isGrantableByTier: jest.fn(() => true),
  isDeniableByTier: jest.fn(() => true),
  VALID_EFFECTS: ['grant', 'deny'],
}));
jest.mock('../../utils/permissionGate', () => ({
  denyIfNoPermission: jest.fn(async () => false),
  checkPermission: jest.fn(async () => true),
}));

// xss is used to sanitise input — pass-through is fine for tests.
jest.mock('xss', () => (s) => s);

const { DependencyRequest, Task, User } = require('../../models');
const depService = require('../../services/dependencyService');
const activityService = require('../../services/activityService');
const ctrl = require('../../controllers/dependencyRequestController');
const perm = require('../../middleware/dependencyRequestPermissions');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json:   jest.fn().mockReturnThis(),
  };
}

function makeUser(overrides = {}) {
  return {
    id: 'sunny-id',
    name: 'Sunny Mehta',
    role: 'member',
    isSuperAdmin: false,
    ...overrides,
  };
}

function makeDep(overrides = {}) {
  // Object that mimics a Sequelize instance: properties readable + a save() stub.
  const dep = {
    id: 'dep-1',
    parentTaskId: 'task-1',
    title: 'dependency check',
    blockingReason: null,
    requestedByUserId: 'sunny-id',
    assignedToUserId: 'shub-id',
    originalAssignerUserId: 'super-id',
    boardId: 'board-1',
    status: 'pending',
    priority: 'medium',
    dueDate: null,
    acceptedAt: null,
    startedAt: null,
    completedAt: null,
    rejectedAt: null,
    cancelledAt: null,
    rejectionReason: null,
    cancellationReason: null,
    archivedAt: null,
    ...overrides,
  };
  dep.save = jest.fn().mockResolvedValue(dep);
  dep.update = jest.fn(async (patch) => Object.assign(dep, patch));
  return dep;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no duplicate dep, no parent task lookups. Tests override as needed.
  DependencyRequest.findOne.mockResolvedValue(null);
  DependencyRequest.findByPk.mockResolvedValue(null);
  Task.findByPk.mockResolvedValue(null);
});

// ════════════════════════════════════════════════════════════════════════════
// Scenario A — Main happy path
// ════════════════════════════════════════════════════════════════════════════

describe('Scenario A — main happy path', () => {
  it('creates a DependencyRequest, no Task is created, dispatches "requested"', async () => {
    Task.findByPk.mockResolvedValue({
      id: 'task-1', title: 'test case evening', boardId: 'board-1',
      status: 'working_on_it', isArchived: false,
      createdBy: 'super-id', assignedTo: 'sunny-id',
      board: { id: 'board-1', workspaceId: 'ws-1' },
    });
    User.findByPk.mockResolvedValue({ id: 'shub-id', name: 'Shubhanshu', isActive: true });
    const created = makeDep();
    DependencyRequest.create.mockResolvedValue(created);
    DependencyRequest.findByPk.mockResolvedValue(created);

    const req = {
      params: { taskId: 'task-1' },
      body: {
        title: 'dependency check',
        assignedToUserId: 'shub-id',
        priority: 'medium',
      },
      user: makeUser(),
    };
    const res = buildRes();

    await ctrl.createDependencyRequest(req, res);

    // Created with snapshotted originalAssignerUserId from parent.assignedTo
    expect(DependencyRequest.create).toHaveBeenCalledWith(expect.objectContaining({
      parentTaskId: 'task-1',
      requestedByUserId: 'sunny-id',
      assignedToUserId: 'shub-id',
      originalAssignerUserId: 'sunny-id', // parent.assignedTo (current owner) — snapshot
      status: 'pending',
    }));
    expect(depService.recomputeParentBlockState).toHaveBeenCalledWith('task-1');
    expect(depService.dispatchDependencyEvent).toHaveBeenCalledWith('requested', created, req.user);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('allows self-assignment (May 2026 v2 — self-blocker removed)', async () => {
    // Earlier contract returned 400 here. The self-assignment block was a UX
    // guard, not a security boundary, and product widened dependency creation
    // to every tier without self/other restrictions. The request now flows
    // through the normal create path; assignee lookup will 404 because the
    // test harness doesn't pre-seed a User for `sunny-id`, which is enough
    // evidence that the early self-reject is gone (anything besides 400 with
    // "to yourself" message means we no longer short-circuit).
    const req = {
      params: { taskId: 'task-1' },
      body: { title: 'self-loop', assignedToUserId: 'sunny-id' },
      user: makeUser(),
    };
    const res = buildRes();

    await ctrl.createDependencyRequest(req, res);

    // Whatever status we get, it must NOT be the old "cannot assign to
    // yourself" rejection. The downstream assignee lookup in this test
    // harness resolves to 404; the key invariant is no early 400 with the
    // self-blocker copy.
    const calls = res.json.mock.calls.map(([body]) => body?.message).filter(Boolean);
    expect(calls.some(m => /to yourself/i.test(String(m)))).toBe(false);
  });

  it('assignee transitions pending → accepted → working_on_it → done; recomputes block-state at every step', async () => {
    const dep = makeDep({ status: 'pending' });
    DependencyRequest.findByPk.mockResolvedValue(dep);

    const req = {
      params: { dependencyId: 'dep-1' },
      body: { status: 'accepted' },
      user: makeUser({ id: 'shub-id' }),
      dependencyRequest: dep,
    };
    let res = buildRes();
    await ctrl.updateStatus(req, res);
    expect(dep.status).toBe('accepted');
    expect(dep.acceptedAt).toBeInstanceOf(Date);
    expect(depService.recomputeParentBlockState).toHaveBeenCalledWith('task-1');
    expect(depService.dispatchDependencyEvent).toHaveBeenCalledWith('accepted', dep, req.user);

    // working_on_it
    req.body.status = 'working_on_it';
    res = buildRes();
    await ctrl.updateStatus(req, res);
    expect(dep.status).toBe('working_on_it');
    expect(dep.startedAt).toBeInstanceOf(Date);
    expect(depService.dispatchDependencyEvent).toHaveBeenCalledWith('started', dep, req.user);

    // done
    req.body.status = 'done';
    res = buildRes();
    await ctrl.updateStatus(req, res);
    expect(dep.status).toBe('done');
    expect(dep.completedAt).toBeInstanceOf(Date);
    expect(dep.completedByUserId).toBe('shub-id');
    expect(depService.dispatchDependencyEvent).toHaveBeenCalledWith('done', dep, req.user);
    // Block-state recomputed three times across this trip.
    expect(depService.recomputeParentBlockState).toHaveBeenCalledTimes(3);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Scenario B — Permission boundary
// ════════════════════════════════════════════════════════════════════════════

describe('Scenario B — permission boundary', () => {
  it('non-assignee non-elevated user cannot transition status (403)', async () => {
    // pending → accepted is a VALID state-machine edge — what we're testing
    // here is that the actor (random-other-id), being neither assignee nor
    // elevated, gets the 403 from the auth check rather than the 400
    // transition-validity check.
    const dep = makeDep({ status: 'pending' });
    const req = {
      params: { dependencyId: 'dep-1' },
      body: { status: 'accepted' },
      user: makeUser({ id: 'random-other-id' }),
      dependencyRequest: dep,
    };
    const res = buildRes();

    await ctrl.updateStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      message: 'You do not have permission to update this dependency.',
    }));
    expect(dep.save).not.toHaveBeenCalled();
  });

  it('non-requester non-elevated user cannot cancel (requireRequestManager rejects)', () => {
    const dep = makeDep({ status: 'pending' });
    const otherUser = makeUser({ id: 'random-other-id' });
    const req = { user: otherUser, dependencyRequest: dep };
    const res = buildRes();
    const next = jest.fn();

    perm.requireRequestManager(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: 'You do not have permission to update this dependency.',
    }));
  });

  it('assignee can transition (canTransitionRequest passes)', async () => {
    const dep = makeDep({ status: 'pending' });
    const req = {
      params: { dependencyId: 'dep-1' },
      body: { status: 'accepted' },
      user: makeUser({ id: 'shub-id' }),
      dependencyRequest: dep,
    };
    const res = buildRes();

    await ctrl.updateStatus(req, res);

    expect(dep.status).toBe('accepted');
    expect(res.status).not.toHaveBeenCalledWith(403);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Scenario C — Rejection
// ════════════════════════════════════════════════════════════════════════════

describe('Scenario C — rejection', () => {
  it('rejection requires a reason (400 when missing)', async () => {
    const dep = makeDep({ status: 'pending' });
    const req = {
      params: { dependencyId: 'dep-1' },
      body: { status: 'rejected' }, // no reason
      user: makeUser({ id: 'shub-id' }),
      dependencyRequest: dep,
    };
    const res = buildRes();

    await ctrl.updateStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: 'rejectionReason is required when rejecting.',
    }));
    expect(dep.save).not.toHaveBeenCalled();
  });

  it('rejection with reason sets rejectedAt + rejectionReason and dispatches "rejected"', async () => {
    const dep = makeDep({ status: 'working_on_it' });
    const req = {
      params: { dependencyId: 'dep-1' },
      body: { status: 'rejected', reason: 'No bandwidth this sprint' },
      user: makeUser({ id: 'shub-id' }),
      dependencyRequest: dep,
    };
    const res = buildRes();

    await ctrl.updateStatus(req, res);

    expect(dep.status).toBe('rejected');
    expect(dep.rejectionReason).toBe('No bandwidth this sprint');
    expect(dep.rejectedAt).toBeInstanceOf(Date);
    expect(depService.dispatchDependencyEvent).toHaveBeenCalledWith('rejected', dep, req.user);
    expect(depService.recomputeParentBlockState).toHaveBeenCalledWith('task-1');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Scenario D — Multiple dependencies (block until all clear)
// ════════════════════════════════════════════════════════════════════════════

describe('Scenario D — multiple deps', () => {
  it('rejected dep keeps parent considered "blocking" via Phase 5 status set', () => {
    // Sanity check on the spec contract: rejected is in the BLOCKING set.
    const real = jest.requireActual('../../services/dependencyService');
    expect(real.BLOCKING_DR_STATUSES).toEqual(
      expect.arrayContaining(['pending', 'accepted', 'working_on_it', 'rejected'])
    );
    expect(real.BLOCKING_DR_STATUSES).not.toContain('done');
    expect(real.BLOCKING_DR_STATUSES).not.toContain('cancelled');
  });

  it('marking one of two deps done still calls recomputeParentBlockState (parent decides)', async () => {
    // Controller hands off to recomputeParentBlockState; that function reads
    // the current count and decides. Here we just verify the call happens.
    const dep = makeDep({ status: 'working_on_it' });
    const req = {
      params: { dependencyId: 'dep-1' },
      body: { status: 'done' },
      user: makeUser({ id: 'shub-id' }),
      dependencyRequest: dep,
    };
    const res = buildRes();

    await ctrl.updateStatus(req, res);

    expect(depService.recomputeParentBlockState).toHaveBeenCalledWith('task-1');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Scenario E — Admin override
// ════════════════════════════════════════════════════════════════════════════

describe('Scenario E — admin override', () => {
  it('admin who is not a party can transition status (elevated check passes)', async () => {
    const dep = makeDep({ status: 'pending' });
    const adminReq = {
      params: { dependencyId: 'dep-1' },
      body: { status: 'done' },
      user: makeUser({ id: 'admin-1', role: 'admin' }),
      dependencyRequest: dep,
    };
    const res = buildRes();

    await ctrl.updateStatus(adminReq, res);

    // pending → done isn't a valid assignee transition (must go through
    // working_on_it), but admin can NOT skip the state-machine — both
    // assignee and admin obey STATUS_TRANSITIONS. Verify that.
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Cannot transition from pending to done'),
    }));
  });

  it('admin can transition through valid state-machine edges and audit log records adminOverride=true', async () => {
    const dep = makeDep({ status: 'working_on_it' });
    const adminReq = {
      params: { dependencyId: 'dep-1' },
      body: { status: 'done' },
      user: makeUser({ id: 'admin-1', role: 'admin' }),
      dependencyRequest: dep,
    };
    const res = buildRes();

    await ctrl.updateStatus(adminReq, res);

    expect(dep.status).toBe('done');
    expect(activityService.logActivity).toHaveBeenCalledWith(expect.objectContaining({
      action: 'dependency_request_done',
      meta: expect.objectContaining({
        from: 'working_on_it',
        to: 'done',
        adminOverride: true, // admin not a party to this dep → flagged
      }),
    }));
  });

  it('manager (also elevated) can cancel a row they did not create; audit logs adminOverride=true', async () => {
    const dep = makeDep({ status: 'pending' });
    const mgrReq = {
      params: { dependencyId: 'dep-1' },
      body: { reason: 'Stale request, closing' },
      user: makeUser({ id: 'mgr-1', role: 'manager' }),
      dependencyRequest: dep,
    };
    const res = buildRes();

    await ctrl.cancelDependency(mgrReq, res);

    expect(dep.status).toBe('cancelled');
    expect(dep.cancelledAt).toBeInstanceOf(Date);
    expect(dep.cancellationReason).toBe('Stale request, closing');
    expect(depService.dispatchDependencyEvent).toHaveBeenCalledWith('cancelled', dep, mgrReq.user);
    expect(activityService.logActivity).toHaveBeenCalledWith(expect.objectContaining({
      action: 'dependency_request_cancelled',
      meta: expect.objectContaining({ adminOverride: true }),
    }));
  });

  it('non-elevated requester cancels their own row — adminOverride is false', async () => {
    const dep = makeDep({ status: 'pending' });
    const reqUserReq = {
      params: { dependencyId: 'dep-1' },
      body: {},
      user: makeUser({ id: 'sunny-id' }), // sunny is the requester (see makeDep default)
      dependencyRequest: dep,
    };
    const res = buildRes();

    await ctrl.cancelDependency(reqUserReq, res);

    expect(dep.status).toBe('cancelled');
    expect(activityService.logActivity).toHaveBeenCalledWith(expect.objectContaining({
      action: 'dependency_request_cancelled',
      meta: expect.objectContaining({ adminOverride: false }),
    }));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Scenario F — Phase 13 shadow-task materialization
//
// The dep is the source of truth, but the assignee also needs the work to
// surface on their board. Verify the controller hands every status update
// + cancel path off to the materializer so it can decide whether to create,
// sync, or archive the shadow task.
// ════════════════════════════════════════════════════════════════════════════

describe('Scenario F — Phase 13 shadow-task materialization', () => {
  it('accept → calls syncLinkedTaskFromDependency with the post-update dep', async () => {
    const dep = makeDep({ status: 'pending' });
    const req = {
      params: { dependencyId: 'dep-1' },
      body: { status: 'accepted' },
      user: makeUser({ id: 'shub-id' }),
      dependencyRequest: dep,
    };
    const res = buildRes();

    await ctrl.updateStatus(req, res);

    expect(depService.syncLinkedTaskFromDependency).toHaveBeenCalledTimes(1);
    const [passedDep, passedActor] = depService.syncLinkedTaskFromDependency.mock.calls[0];
    // Sync runs AFTER the status mutation — important so the materializer
    // can branch on the new state ('pending' would no-op).
    expect(passedDep.status).toBe('accepted');
    expect(passedActor.id).toBe('shub-id');
  });

  it('working_on_it → calls syncLinkedTaskFromDependency', async () => {
    const dep = makeDep({ status: 'accepted' });
    const req = {
      params: { dependencyId: 'dep-1' },
      body: { status: 'working_on_it' },
      user: makeUser({ id: 'shub-id' }),
      dependencyRequest: dep,
    };
    const res = buildRes();

    await ctrl.updateStatus(req, res);

    expect(depService.syncLinkedTaskFromDependency).toHaveBeenCalledTimes(1);
    expect(depService.syncLinkedTaskFromDependency.mock.calls[0][0].status).toBe('working_on_it');
  });

  it('done → calls syncLinkedTaskFromDependency', async () => {
    const dep = makeDep({ status: 'working_on_it' });
    const req = {
      params: { dependencyId: 'dep-1' },
      body: { status: 'done' },
      user: makeUser({ id: 'shub-id' }),
      dependencyRequest: dep,
    };
    const res = buildRes();

    await ctrl.updateStatus(req, res);

    expect(depService.syncLinkedTaskFromDependency).toHaveBeenCalledTimes(1);
    expect(depService.syncLinkedTaskFromDependency.mock.calls[0][0].status).toBe('done');
  });

  it('reject → still calls syncLinkedTaskFromDependency so a previously-materialized shadow can be archived', async () => {
    // working_on_it → rejected: a shadow task was created on accept/start;
    // the helper is responsible for archiving it. The controller's job is
    // just to invoke the helper with the post-update dep.
    const dep = makeDep({ status: 'working_on_it', linkedTaskId: 'task-shadow-1' });
    const req = {
      params: { dependencyId: 'dep-1' },
      body: { status: 'rejected', reason: 'blocked elsewhere' },
      user: makeUser({ id: 'shub-id' }),
      dependencyRequest: dep,
    };
    const res = buildRes();

    await ctrl.updateStatus(req, res);

    expect(depService.syncLinkedTaskFromDependency).toHaveBeenCalledTimes(1);
    expect(depService.syncLinkedTaskFromDependency.mock.calls[0][0].status).toBe('rejected');
  });

  it('cancel → calls syncLinkedTaskFromDependency so any shadow task can be archived', async () => {
    const dep = makeDep({ status: 'accepted', linkedTaskId: 'task-shadow-1' });
    const req = {
      params: { dependencyId: 'dep-1' },
      body: { reason: 'no longer needed' },
      user: makeUser({ id: 'sunny-id' }), // requester
      dependencyRequest: dep,
    };
    const res = buildRes();

    await ctrl.cancelDependency(req, res);

    expect(depService.syncLinkedTaskFromDependency).toHaveBeenCalledTimes(1);
    expect(depService.syncLinkedTaskFromDependency.mock.calls[0][0].status).toBe('cancelled');
  });

  it('failed sync does NOT 500 the status update — controller swallows the error', async () => {
    // A flaky DB / boardMembership write must never break the dep-status
    // request itself. The dep is the source of truth; the shadow task is
    // a courtesy surface.
    depService.syncLinkedTaskFromDependency.mockRejectedValueOnce(new Error('boom'));

    const dep = makeDep({ status: 'pending' });
    const req = {
      params: { dependencyId: 'dep-1' },
      body: { status: 'accepted' },
      user: makeUser({ id: 'shub-id' }),
      dependencyRequest: dep,
    };
    const res = buildRes();

    await ctrl.updateStatus(req, res);

    // Status update still succeeded.
    expect(dep.status).toBe('accepted');
    expect(res.status).not.toHaveBeenCalledWith(500);
    // And the controller still went on to dispatch the lifecycle notification.
    expect(depService.dispatchDependencyEvent).toHaveBeenCalledWith('accepted', dep, req.user);
  });

  it('reject straight from pending — no shadow ever created — call still fires (helper no-ops internally)', async () => {
    // The controller doesn't know whether a shadow exists; it always calls
    // the helper. The helper is responsible for the "no-op when there's
    // nothing to archive" branch. We just verify the call happens.
    const dep = makeDep({ status: 'pending' }); // no linkedTaskId
    const req = {
      params: { dependencyId: 'dep-1' },
      body: { status: 'rejected', reason: 'wrong person' },
      user: makeUser({ id: 'shub-id' }),
      dependencyRequest: dep,
    };
    const res = buildRes();

    await ctrl.updateStatus(req, res);

    expect(depService.syncLinkedTaskFromDependency).toHaveBeenCalledTimes(1);
    expect(depService.syncLinkedTaskFromDependency.mock.calls[0][0].linkedTaskId).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Bonus — Phase 11 spec wording assertions
// (Catches future drift away from the canonical error strings.)
// ════════════════════════════════════════════════════════════════════════════

describe('Phase 11 — spec-aligned error wording', () => {
  it('inactive assignee on create returns spec-aligned message', async () => {
    Task.findByPk.mockResolvedValue({
      id: 'task-1', title: 't', boardId: 'b', status: 'not_started', isArchived: false,
      createdBy: 'super-id', assignedTo: 'sunny-id', board: {},
    });
    User.findByPk.mockResolvedValue({ id: 'shub-id', name: 'Shubhanshu', isActive: false });

    const req = {
      params: { taskId: 'task-1' },
      body: { title: 't', assignedToUserId: 'shub-id' },
      user: makeUser(),
    };
    const res = buildRes();

    await ctrl.createDependencyRequest(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Dependency assignee is inactive. Please choose another user.',
    }));
  });

  it('cancelling an already-completed dep returns spec-aligned message', async () => {
    const dep = makeDep({ status: 'done' });
    const req = {
      params: { dependencyId: 'dep-1' },
      body: {},
      user: makeUser({ id: 'sunny-id' }),
      dependencyRequest: dep,
    };
    const res = buildRes();

    await ctrl.cancelDependency(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: 'This dependency is already completed.',
    }));
  });
});
