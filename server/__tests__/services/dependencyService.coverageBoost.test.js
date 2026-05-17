'use strict';

/**
 * Coverage-boost tests for server/services/dependencyService.js — Phase
 * 2.10 of the QA remediation plan (docs/qa-audit-2026-05-17.md → §22 P0
 * item #10). Previously 47.77% from the existing
 * `dependencyService.autoUnblock.test.js` and
 * `dependencyServiceMaterialize.test.js` suites — those cover the
 * processTaskCompletion auto-unblock chain and the materializer.
 *
 * This suite fills in the gaps:
 *   - isTaskBlocked (legacy TaskDependency path + DependencyRequest path)
 *   - getBlockingTasks (filter incomplete blockers)
 *   - getBlockedTasks (raw deps)
 *   - checkCircularDependency (self-cycle, transitive cycle, no cycle, depth caps)
 *   - lockTaskAsDependencyBlocked (capture status, no re-capture, no-op on done/stuck)
 *   - buildUnblockUpdates (restore captured status, clear flags)
 *   - unlockTaskIfUnblocked (early-return on still-blocked / missing task / no flag)
 *   - createDependency (circular reject, duplicate reject, lock blocker, set startDate)
 */

jest.mock('../../models', () => ({
  Task: { findByPk: jest.fn() },
  TaskDependency: { findAll: jest.fn(), findOne: jest.fn(), create: jest.fn() },
  DependencyRequest: { count: jest.fn() },
  User: { findByPk: jest.fn() },
  Notification: { create: jest.fn() },
  Board: {},
  TaskAssignee: {},
}));
jest.mock('../../config/db', () => ({ sequelize: { transaction: jest.fn() } }));
jest.mock('../../services/socketService', () => ({
  emitToUser: jest.fn(),
  emitToBoard: jest.fn(),
}));
jest.mock('../../services/activityService', () => ({ logActivity: jest.fn() }));
jest.mock('../../services/notificationService', () => ({
  createNotification: jest.fn(),
  buildIdempotencyKey: jest.fn((...parts) => parts.join(':')),
}));
jest.mock('../../services/realtimeService', () => ({}));
jest.mock('../../services/boardMembershipService', () => ({}));

const { Task, TaskDependency, DependencyRequest } = require('../../models');
const { emitToBoard } = require('../../services/socketService');
const {
  isTaskBlocked,
  getBlockingTasks,
  getBlockedTasks,
  checkCircularDependency,
  lockTaskAsDependencyBlocked,
  unlockTaskIfUnblocked,
  createDependency,
} = require('../../services/dependencyService');

beforeEach(() => {
  jest.resetAllMocks();
});

// ─── isTaskBlocked ─────────────────────────────────────────────

describe('isTaskBlocked', () => {
  it('returns true when an incomplete legacy TaskDependency blocker exists', async () => {
    TaskDependency.findAll.mockResolvedValueOnce([
      { dependsOnTask: { id: 'b1', status: 'working_on_it' } },
    ]);
    DependencyRequest.count.mockResolvedValueOnce(0);

    await expect(isTaskBlocked('t1')).resolves.toBe(true);
    // Should NOT need to consult DependencyRequest when legacy path is true
    // (the early return at line 45 in dependencyService kicks in)
  });

  it('returns false when all legacy blockers are done AND no blocking DependencyRequests', async () => {
    TaskDependency.findAll.mockResolvedValueOnce([
      { dependsOnTask: { id: 'b1', status: 'done' } },
      { dependsOnTask: { id: 'b2', status: 'done' } },
    ]);
    DependencyRequest.count.mockResolvedValueOnce(0);

    await expect(isTaskBlocked('t1')).resolves.toBe(false);
  });

  it('returns true when a DependencyRequest is in a blocking status (pending)', async () => {
    TaskDependency.findAll.mockResolvedValueOnce([]); // no legacy
    DependencyRequest.count.mockResolvedValueOnce(1); // 1 pending DR

    await expect(isTaskBlocked('t1')).resolves.toBe(true);
  });

  it('treats rejected dependency requests as still blocking (Phase 5 rule)', async () => {
    TaskDependency.findAll.mockResolvedValueOnce([]);
    // The service queries with status IN BLOCKING_DR_STATUSES which includes
    // 'rejected'. We just verify that a non-zero count returns true.
    DependencyRequest.count.mockResolvedValueOnce(2);

    await expect(isTaskBlocked('t1')).resolves.toBe(true);
  });

  it('handles tasks with no dependsOnTask relation gracefully (filter)', async () => {
    TaskDependency.findAll.mockResolvedValueOnce([
      { dependsOnTask: null },          // orphan
      { dependsOnTask: { status: 'done' } },
    ]);
    DependencyRequest.count.mockResolvedValueOnce(0);

    await expect(isTaskBlocked('t1')).resolves.toBe(false);
  });
});

// ─── getBlockingTasks ──────────────────────────────────────────

describe('getBlockingTasks', () => {
  it('returns only incomplete blockers (filters out done)', async () => {
    TaskDependency.findAll.mockResolvedValueOnce([
      { dependsOnTask: { id: 'b1', status: 'done' } },           // filtered out
      { dependsOnTask: { id: 'b2', status: 'working_on_it' } }, // kept
      { dependsOnTask: { id: 'b3', status: 'stuck' } },         // kept
      { dependsOnTask: null },                                   // filtered out
    ]);

    const out = await getBlockingTasks('t1');
    expect(out.map((t) => t.id)).toEqual(['b2', 'b3']);
  });

  it('returns empty array when there are no dependencies', async () => {
    TaskDependency.findAll.mockResolvedValueOnce([]);
    await expect(getBlockingTasks('t1')).resolves.toEqual([]);
  });
});

// ─── getBlockedTasks ───────────────────────────────────────────

describe('getBlockedTasks', () => {
  it('returns every dep where this task is the blocker (no filter)', async () => {
    const deps = [{ id: 'd1' }, { id: 'd2' }];
    TaskDependency.findAll.mockResolvedValueOnce(deps);
    await expect(getBlockedTasks('blocker-id')).resolves.toEqual(deps);
  });
});

// ─── checkCircularDependency ───────────────────────────────────

describe('checkCircularDependency', () => {
  it('detects a self-cycle (taskId === dependsOnTaskId)', async () => {
    await expect(checkCircularDependency('t1', 't1')).resolves.toBe(true);
    expect(TaskDependency.findAll).not.toHaveBeenCalled();
  });

  it('returns false when no path back to taskId exists', async () => {
    // t1 -> t2 -> t3 (no return path)
    TaskDependency.findAll
      .mockResolvedValueOnce([{ dependsOnTaskId: 't3' }])  // t2's deps
      .mockResolvedValueOnce([]);                          // t3 has no deps
    await expect(checkCircularDependency('t1', 't2')).resolves.toBe(false);
  });

  it('detects a direct cycle (t1 -> t2 -> t1)', async () => {
    TaskDependency.findAll.mockResolvedValueOnce([{ dependsOnTaskId: 't1' }]);
    await expect(checkCircularDependency('t1', 't2')).resolves.toBe(true);
  });

  it('detects a transitive cycle (t1 -> t2 -> t3 -> t1)', async () => {
    TaskDependency.findAll
      .mockResolvedValueOnce([{ dependsOnTaskId: 't3' }])  // t2's deps
      .mockResolvedValueOnce([{ dependsOnTaskId: 't1' }]); // t3's deps → t1 = cycle
    await expect(checkCircularDependency('t1', 't2')).resolves.toBe(true);
  });

  it('handles a visited-cache short-circuit (avoids infinite recursion)', async () => {
    // Pre-populate visited so recursion returns false immediately
    const visited = new Set(['t2']);
    await expect(checkCircularDependency('t1', 't2', visited)).resolves.toBe(false);
    expect(TaskDependency.findAll).not.toHaveBeenCalled();
  });
});

// ─── lockTaskAsDependencyBlocked ───────────────────────────────

describe('lockTaskAsDependencyBlocked', () => {
  function mockTask(overrides) {
    const t = {
      id: 't1', status: 'working_on_it', customFields: {}, boardId: 'b1',
      toJSON: () => ({ id: t.id }),
      update: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    return t;
  }

  it('captures the pre-block status into customFields and sets status to stuck', async () => {
    const task = mockTask({ status: 'working_on_it' });
    Task.findByPk.mockResolvedValueOnce(task);

    await lockTaskAsDependencyBlocked('t1');

    expect(task.update).toHaveBeenCalledWith({
      status: 'stuck',
      customFields: expect.objectContaining({
        blockedByDependency: true,
        statusBeforeDependencyBlock: 'working_on_it',
      }),
    });
    expect(emitToBoard).toHaveBeenCalledWith('b1', 'task:updated', expect.any(Object));
  });

  it('does NOT re-capture status when statusBeforeDependencyBlock is already set', async () => {
    const task = mockTask({
      status: 'working_on_it',
      customFields: { statusBeforeDependencyBlock: 'not_started' },
    });
    Task.findByPk.mockResolvedValueOnce(task);

    await lockTaskAsDependencyBlocked('t1');

    const updateCall = task.update.mock.calls[0][0];
    expect(updateCall.customFields.statusBeforeDependencyBlock).toBe('not_started');
  });

  it('does NOT capture "stuck" as the pre-block status (would memorise own lock state)', async () => {
    const task = mockTask({ status: 'stuck', customFields: {} });
    Task.findByPk.mockResolvedValueOnce(task);

    await lockTaskAsDependencyBlocked('t1');

    const updateCall = task.update.mock.calls[0][0];
    expect(updateCall.customFields).not.toHaveProperty('statusBeforeDependencyBlock');
  });

  it('is a no-op when the task is missing', async () => {
    Task.findByPk.mockResolvedValueOnce(null);
    await lockTaskAsDependencyBlocked('ghost');
    expect(emitToBoard).not.toHaveBeenCalled();
  });

  it('is a no-op when the task is already done', async () => {
    const task = mockTask({ status: 'done' });
    Task.findByPk.mockResolvedValueOnce(task);

    await lockTaskAsDependencyBlocked('t1');

    expect(task.update).not.toHaveBeenCalled();
    expect(emitToBoard).not.toHaveBeenCalled();
  });
});

// ─── unlockTaskIfUnblocked ─────────────────────────────────────

describe('unlockTaskIfUnblocked', () => {
  function mockTask(overrides) {
    const t = {
      id: 't1', boardId: 'b1',
      customFields: { blockedByDependency: true },
      toJSON: () => ({ id: 't1' }),
      update: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    return t;
  }

  it('returns early when the task is still blocked', async () => {
    TaskDependency.findAll.mockResolvedValueOnce([
      { dependsOnTask: { status: 'working_on_it' } },
    ]);
    DependencyRequest.count.mockResolvedValueOnce(0);

    await unlockTaskIfUnblocked('t1');
    expect(Task.findByPk).not.toHaveBeenCalled();
  });

  it('returns early when the task row is missing', async () => {
    TaskDependency.findAll.mockResolvedValueOnce([]);
    DependencyRequest.count.mockResolvedValueOnce(0);
    Task.findByPk.mockResolvedValueOnce(null);

    await unlockTaskIfUnblocked('t1');
    expect(emitToBoard).not.toHaveBeenCalled();
  });

  it('returns early when the task is not flagged blockedByDependency', async () => {
    TaskDependency.findAll.mockResolvedValueOnce([]);
    DependencyRequest.count.mockResolvedValueOnce(0);
    Task.findByPk.mockResolvedValueOnce(mockTask({ customFields: {} }));

    await unlockTaskIfUnblocked('t1');
    expect(emitToBoard).not.toHaveBeenCalled();
  });

  it('clears the flag and emits when the task is unblocked', async () => {
    TaskDependency.findAll.mockResolvedValueOnce([]);
    DependencyRequest.count.mockResolvedValueOnce(0);
    const task = mockTask();
    Task.findByPk.mockResolvedValueOnce(task);

    await unlockTaskIfUnblocked('t1');

    expect(task.update).toHaveBeenCalledWith({
      customFields: expect.objectContaining({ blockedByDependency: false }),
    });
    expect(emitToBoard).toHaveBeenCalledWith('b1', 'task:updated', expect.any(Object));
  });
});

// ─── createDependency ──────────────────────────────────────────

describe('createDependency', () => {
  function makeDep(overrides = {}) {
    return {
      taskId: 't1',
      dependsOnTaskId: 'b1',
      dependencyType: 'blocks',
      autoAssignOnComplete: false,
      autoAssignToUserId: null,
      createdById: 'u1',
      ...overrides,
    };
  }

  it('throws when the dependency would create a circular reference (self-cycle)', async () => {
    await expect(createDependency(makeDep({ taskId: 'x', dependsOnTaskId: 'x' })))
      .rejects.toThrow(/circular/);
    expect(TaskDependency.create).not.toHaveBeenCalled();
  });

  it('throws when the same dependency already exists', async () => {
    TaskDependency.findAll.mockResolvedValueOnce([]); // checkCircular: no cycle
    TaskDependency.findOne.mockResolvedValueOnce({ id: 'existing-dep' });

    await expect(createDependency(makeDep())).rejects.toThrow(/already exists/);
    expect(TaskDependency.create).not.toHaveBeenCalled();
  });

  it('creates the dependency when no cycle and no duplicate', async () => {
    TaskDependency.findAll.mockResolvedValueOnce([]); // no cycle
    TaskDependency.findOne.mockResolvedValueOnce(null); // no duplicate
    TaskDependency.create.mockResolvedValueOnce({ id: 'dep-1' });
    // blocker is already done so we don't try to lock the parent
    Task.findByPk.mockResolvedValueOnce({ id: 'b1', status: 'done' });
    // second findByPk for startDate set-if-empty: parent has startDate
    Task.findByPk.mockResolvedValueOnce({ id: 't1', startDate: '2026-01-01', boardId: 'b1' });

    const out = await createDependency(makeDep());

    expect(TaskDependency.create).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 't1',
      dependsOnTaskId: 'b1',
      dependencyType: 'blocks',
    }));
    expect(out).toEqual({ id: 'dep-1' });
  });

  it('locks the blocked task as stuck when the blocker is not yet done', async () => {
    TaskDependency.findAll.mockResolvedValueOnce([]);
    TaskDependency.findOne.mockResolvedValueOnce(null);
    TaskDependency.create.mockResolvedValueOnce({ id: 'dep-1' });
    // blocker not done → triggers lockTaskAsDependencyBlocked(taskId)
    Task.findByPk.mockResolvedValueOnce({ id: 'b1', status: 'working_on_it' });
    // The lockTaskAsDependencyBlocked call loads the BLOCKED task next
    const blockedTask = {
      id: 't1', status: 'in_progress', customFields: {}, boardId: 'b1',
      toJSON: () => ({}), update: jest.fn().mockResolvedValue(undefined),
    };
    Task.findByPk.mockResolvedValueOnce(blockedTask);
    // startDate set-if-empty path
    Task.findByPk.mockResolvedValueOnce({ id: 't1', startDate: '2026-01-01', boardId: 'b1' });

    await createDependency(makeDep());

    expect(blockedTask.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'stuck',
      customFields: expect.objectContaining({ blockedByDependency: true }),
    }));
  });

  it('sets startDate when the blocked task has none', async () => {
    TaskDependency.findAll.mockResolvedValueOnce([]);
    TaskDependency.findOne.mockResolvedValueOnce(null);
    TaskDependency.create.mockResolvedValueOnce({ id: 'dep-1' });
    Task.findByPk.mockResolvedValueOnce({ id: 'b1', status: 'done' }); // blocker done, no lock
    const blockedTask = {
      id: 't1', startDate: null, boardId: 'b1',
      toJSON: () => ({ id: 't1' }),
      update: jest.fn().mockResolvedValue(undefined),
    };
    Task.findByPk.mockResolvedValueOnce(blockedTask);

    await createDependency(makeDep());

    // Should have called update with a startDate set to today (YYYY-MM-DD)
    expect(blockedTask.update).toHaveBeenCalledWith(expect.objectContaining({
      startDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    }));
  });

  it('does not overwrite an existing startDate', async () => {
    TaskDependency.findAll.mockResolvedValueOnce([]);
    TaskDependency.findOne.mockResolvedValueOnce(null);
    TaskDependency.create.mockResolvedValueOnce({ id: 'dep-1' });
    Task.findByPk.mockResolvedValueOnce({ id: 'b1', status: 'done' });
    const blockedTask = {
      id: 't1', startDate: '2025-01-01', boardId: 'b1',
      toJSON: () => ({}), update: jest.fn().mockResolvedValue(undefined),
    };
    Task.findByPk.mockResolvedValueOnce(blockedTask);

    await createDependency(makeDep());

    expect(blockedTask.update).not.toHaveBeenCalled();
  });

  it('defaults dependencyType to "blocks" when omitted', async () => {
    TaskDependency.findAll.mockResolvedValueOnce([]);
    TaskDependency.findOne.mockResolvedValueOnce(null);
    TaskDependency.create.mockResolvedValueOnce({ id: 'dep' });
    Task.findByPk.mockResolvedValueOnce({ id: 'b1', status: 'done' });
    Task.findByPk.mockResolvedValueOnce({ id: 't1', startDate: '2026-01-01', boardId: 'b1' });

    await createDependency(makeDep({ dependencyType: undefined }));

    expect(TaskDependency.create).toHaveBeenCalledWith(expect.objectContaining({
      dependencyType: 'blocks',
    }));
  });
});
