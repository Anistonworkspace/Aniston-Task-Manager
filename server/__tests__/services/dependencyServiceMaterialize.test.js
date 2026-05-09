'use strict';

/**
 * Phase 13 — shadow-task materializer unit tests.
 *
 * Covers `syncLinkedTaskFromDependency` behaviour at every dep status:
 *   - pending                                  → no-op
 *   - pending → rejected/cancelled, no shadow  → no-op
 *   - pending → accepted, no shadow            → materialize
 *   - working_on_it (with shadow already)      → sync status
 *   - done (with shadow already)               → sync to done + progress=100
 *   - rejected (with shadow already)           → archive shadow
 *   - cancelled (with shadow already)          → archive shadow
 *   - idempotency: second call with linkedTaskId set never creates a 2nd Task
 *
 * Models + realtime + boardMembership are mocked so the test runs without a
 * DB. Same pattern as the existing recurringTaskService tests.
 */

process.env.NODE_ENV = 'test';

// ─── Mocks ────────────────────────────────────────────────────────────────────
//
// Jest hoists jest.mock(...) calls above all `const`s, so any variable the
// factory references must be `mock`-prefixed (the only out-of-scope names
// the hoisting rule allows). Use a single `mockSpies` object for tests to
// introspect.

const mockSpies = {
  taskCreate: jest.fn(),
  taskFindByPk: jest.fn(),
  taskMax: jest.fn(),
  taskAssigneeBulkCreate: jest.fn(),
  emitTaskCreated: jest.fn(),
  emitTaskUpdated: jest.fn(),
  autoAddMember: jest.fn().mockResolvedValue(),
};

jest.mock('../../models', () => ({
  Task: {
    create:   (...a) => mockSpies.taskCreate(...a),
    findByPk: (...a) => mockSpies.taskFindByPk(...a),
    max:      (...a) => mockSpies.taskMax(...a),
  },
  TaskDependency:    { findAll: jest.fn().mockResolvedValue([]) },
  DependencyRequest: { count: jest.fn().mockResolvedValue(0) },
  User:              {},
  Notification:      {},
  Board:             {},
  TaskAssignee:      { bulkCreate: (...a) => mockSpies.taskAssigneeBulkCreate(...a) },
}));

// Transaction wrapper — just call the inner fn with a fake tx.
jest.mock('../../config/db', () => ({
  sequelize: {
    transaction: (fn) => fn({ id: 'tx-1' }),
  },
}));

jest.mock('../../services/realtimeService', () => ({
  emitTaskCreated: (...a) => mockSpies.emitTaskCreated(...a),
  emitTaskUpdated: (...a) => mockSpies.emitTaskUpdated(...a),
}));

jest.mock('../../services/boardMembershipService', () => ({
  autoAddMember: (...a) => mockSpies.autoAddMember(...a),
}));

jest.mock('../../services/socketService', () => ({
  emitToUser:  jest.fn(),
  emitToBoard: jest.fn(),
}));

jest.mock('../../services/activityService', () => ({ logActivity: jest.fn() }));
jest.mock('../../services/notificationService', () => ({
  createNotification: jest.fn(),
  buildIdempotencyKey: jest.fn(() => 'idem'),
}));

const { syncLinkedTaskFromDependency } = require('../../services/dependencyService');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDep(overrides = {}) {
  // Mimic a Sequelize instance — readable fields + a save() stub the
  // materializer can mutate-then-save inside the transaction.
  const dep = {
    id: 'dep-1',
    parentTaskId: 'task-parent-1',
    title: 'dependency test',
    blockingReason: 'need API ready',
    requestedByUserId: 'super-id',
    assignedToUserId: 'sunny-id',
    boardId: 'board-1',
    status: 'pending',
    priority: 'medium',
    dueDate: null,
    linkedTaskId: null,
    ...overrides,
  };
  dep.save = jest.fn().mockResolvedValue(dep);
  return dep;
}

function makeTaskInstance(overrides = {}) {
  // What Task.findByPk would return for a previously-materialized shadow.
  const t = {
    id: 'task-shadow-1',
    boardId: 'board-1',
    status: 'not_started',
    progress: 0,
    completedAt: null,
    isArchived: false,
    archivedAt: null,
    archivedBy: null,
    approvalStatus: null,
    toJSON: function () { return { ...this }; },
    ...overrides,
  };
  t.update = jest.fn(async (patch) => Object.assign(t, patch));
  return t;
}

const actor = { id: 'sunny-id', name: 'Sunny' };

beforeEach(() => {
  // Reset every spy. Object.values(...) is enough — the realtime / DB-call
  // mocks all live on mockSpies.
  for (const fn of Object.values(mockSpies)) fn.mockClear?.();
  // Default: parent task returns groupId 'new'. Tests override as needed.
  mockSpies.taskFindByPk.mockResolvedValue({
    id: 'task-parent-1',
    groupId: 'new',
    boardId: 'board-1',
    isArchived: false,
  });
  mockSpies.taskMax.mockResolvedValue(7);
  mockSpies.taskCreate.mockImplementation(async (fields) => ({
    id: 'task-shadow-1',
    ...fields,
    toJSON: function () { return { ...this }; },
  }));
  mockSpies.taskAssigneeBulkCreate.mockResolvedValue();
});

// ════════════════════════════════════════════════════════════════════════════
// pending — never creates a shadow
// ════════════════════════════════════════════════════════════════════════════

describe('pending status', () => {
  it('returns null and creates nothing', async () => {
    const dep = makeDep({ status: 'pending' });
    const result = await syncLinkedTaskFromDependency(dep, actor);
    expect(result).toBeNull();
    expect(mockSpies.taskCreate).not.toHaveBeenCalled();
    expect(mockSpies.emitTaskCreated).not.toHaveBeenCalled();
    expect(dep.save).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// pending → rejected/cancelled (no shadow ever existed)
// ════════════════════════════════════════════════════════════════════════════

describe('rejected/cancelled with no prior shadow', () => {
  it('rejected: returns null, creates nothing', async () => {
    const dep = makeDep({ status: 'rejected', linkedTaskId: null });
    const result = await syncLinkedTaskFromDependency(dep, actor);
    expect(result).toBeNull();
    expect(mockSpies.taskCreate).not.toHaveBeenCalled();
  });

  it('cancelled: returns null, creates nothing', async () => {
    const dep = makeDep({ status: 'cancelled', linkedTaskId: null });
    const result = await syncLinkedTaskFromDependency(dep, actor);
    expect(result).toBeNull();
    expect(mockSpies.taskCreate).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// pending → accepted — materialize a brand-new shadow
// ════════════════════════════════════════════════════════════════════════════

describe('accepted (first time)', () => {
  it('creates a Task on the parent board with the dep fields and assigns it to the dep assignee', async () => {
    const dep = makeDep({
      status: 'accepted',
      linkedTaskId: null,
      title: 'dependency test',
      priority: 'high',
      dueDate: '2026-05-15',
      blockingReason: 'need API ready',
    });

    const result = await syncLinkedTaskFromDependency(dep, actor);

    expect(mockSpies.taskCreate).toHaveBeenCalledTimes(1);
    const [taskFields, opts] = mockSpies.taskCreate.mock.calls[0];
    expect(taskFields).toMatchObject({
      title: 'dependency test',
      description: 'need API ready',
      status: 'not_started',
      priority: 'high',
      groupId: 'new',
      dueDate: '2026-05-15',
      progress: 0,
      boardId: 'board-1',
      assignedTo: 'sunny-id',
      createdBy: 'super-id',
      tags: ['dependency'],
    });
    // Back-pointer in customFields for the frontend / future affordances.
    expect(taskFields.customFields).toEqual({
      sourceDependencyRequestId: 'dep-1',
      sourceParentTaskId: 'task-parent-1',
    });
    // Position appended to end of group (max=7 → 8).
    expect(taskFields.position).toBe(8);
    // Inserted inside the transaction.
    expect(opts).toEqual(expect.objectContaining({ transaction: expect.any(Object) }));

    // TaskAssignee row created so visibility filters resolve.
    expect(mockSpies.taskAssigneeBulkCreate).toHaveBeenCalledTimes(1);
    expect(mockSpies.taskAssigneeBulkCreate.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        taskId: 'task-shadow-1',
        userId: 'sunny-id',
        role: 'assignee',
      }),
    ]);

    // Idempotency key persisted on the dep.
    expect(dep.linkedTaskId).toBe('task-shadow-1');
    expect(dep.save).toHaveBeenCalledTimes(1);

    // Auto-added the assignee as a board member (so the board appears in
    // their sidebar even if hierarchy didn't already grant access).
    expect(mockSpies.autoAddMember).toHaveBeenCalledWith('board-1', 'sunny-id');

    // Realtime fan-out — the eventRouter routes 'task:created' to
    // tasks.board.<id> + tasks.assignedTo.me, which drives the assignee's
    // Board page + MyWork to refresh without a manual reload.
    expect(mockSpies.emitTaskCreated).toHaveBeenCalledTimes(1);
    expect(mockSpies.emitTaskCreated.mock.calls[0][0]).toMatchObject({ id: 'task-shadow-1' });
    expect(mockSpies.emitTaskCreated.mock.calls[0][1]).toMatchObject({ actorId: 'sunny-id' });

    expect(result).toMatchObject({ id: 'task-shadow-1' });
  });

  it('skips materialization when the parent task no longer exists (orphan dep)', async () => {
    mockSpies.taskFindByPk.mockResolvedValueOnce(null);
    const dep = makeDep({ status: 'accepted', boardId: null });

    const result = await syncLinkedTaskFromDependency(dep, actor);

    expect(result).toBeNull();
    expect(mockSpies.taskCreate).not.toHaveBeenCalled();
  });

  it('IDEMPOTENT: a second call when linkedTaskId is already set never creates a 2nd Task', async () => {
    const dep = makeDep({ status: 'accepted', linkedTaskId: 'task-shadow-1' });
    // findByPk used by _syncExistingLinkedTask path — return an existing task.
    mockSpies.taskFindByPk.mockResolvedValueOnce(makeTaskInstance({ status: 'not_started' }));

    await syncLinkedTaskFromDependency(dep, actor);

    expect(mockSpies.taskCreate).not.toHaveBeenCalled();
    expect(mockSpies.emitTaskCreated).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// working_on_it — sync existing shadow forward
// ════════════════════════════════════════════════════════════════════════════

describe('working_on_it (shadow exists)', () => {
  it('updates the shadow status to working_on_it and emits task:updated', async () => {
    const shadow = makeTaskInstance({ status: 'not_started' });
    mockSpies.taskFindByPk.mockResolvedValueOnce(shadow);
    const dep = makeDep({ status: 'working_on_it', linkedTaskId: 'task-shadow-1' });

    await syncLinkedTaskFromDependency(dep, actor);

    expect(shadow.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'working_on_it' }),
    );
    expect(mockSpies.emitTaskUpdated).toHaveBeenCalledTimes(1);
    expect(mockSpies.emitTaskUpdated.mock.calls[0][0]).toBe(shadow);
  });

  it('does NOT create a 2nd Task', async () => {
    const shadow = makeTaskInstance({ status: 'not_started' });
    mockSpies.taskFindByPk.mockResolvedValueOnce(shadow);
    const dep = makeDep({ status: 'working_on_it', linkedTaskId: 'task-shadow-1' });

    await syncLinkedTaskFromDependency(dep, actor);

    expect(mockSpies.taskCreate).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// done — sync existing shadow to done + progress 100
// ════════════════════════════════════════════════════════════════════════════

describe('done (shadow exists)', () => {
  it('sets status=done, progress=100, completedAt, approvalStatus=approved', async () => {
    const shadow = makeTaskInstance({ status: 'working_on_it', progress: 50 });
    mockSpies.taskFindByPk.mockResolvedValueOnce(shadow);
    const dep = makeDep({ status: 'done', linkedTaskId: 'task-shadow-1' });

    await syncLinkedTaskFromDependency(dep, actor);

    expect(shadow.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'done',
      progress: 100,
      completedAt: expect.any(Date),
      approvalStatus: 'approved', // dep is the source of truth for completion
    }));
  });

  it('first-time materialization at status=done (admin override path) creates the task already-done', async () => {
    // Materializer lands at done directly when the dep itself is already
    // 'done' (e.g. an admin walked it through pending → working_on_it →
    // done in a single workflow before the assignee touched the board).
    const dep = makeDep({ status: 'done', linkedTaskId: null });

    await syncLinkedTaskFromDependency(dep, actor);

    expect(mockSpies.taskCreate).toHaveBeenCalledTimes(1);
    const [taskFields] = mockSpies.taskCreate.mock.calls[0];
    expect(taskFields).toMatchObject({
      status: 'done',
      progress: 100,
      completedAt: expect.any(Date),
      approvalStatus: 'approved',
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// rejected / cancelled with shadow → archive
// ════════════════════════════════════════════════════════════════════════════

describe('rejected/cancelled with prior shadow', () => {
  it('rejected: archives the shadow task (board excludes it via existing isArchived filter)', async () => {
    const shadow = makeTaskInstance({ status: 'working_on_it' });
    mockSpies.taskFindByPk.mockResolvedValueOnce(shadow);
    const dep = makeDep({ status: 'rejected', linkedTaskId: 'task-shadow-1' });

    await syncLinkedTaskFromDependency(dep, actor);

    expect(shadow.update).toHaveBeenCalledWith(expect.objectContaining({
      isArchived: true,
      archivedAt: expect.any(Date),
      archivedBy: 'sunny-id',
    }));
    // Frontend treats archive as a regular update — the next refetch
    // excludes the row because the GET /tasks query filters isArchived=false
    // by default. No separate task:deleted event needed.
    expect(mockSpies.emitTaskUpdated).toHaveBeenCalledTimes(1);
  });

  it('cancelled: archives the shadow task', async () => {
    const shadow = makeTaskInstance({ status: 'not_started' });
    mockSpies.taskFindByPk.mockResolvedValueOnce(shadow);
    const dep = makeDep({ status: 'cancelled', linkedTaskId: 'task-shadow-1' });

    await syncLinkedTaskFromDependency(dep, actor);

    expect(shadow.update).toHaveBeenCalledWith(expect.objectContaining({
      isArchived: true,
    }));
  });

  it('archive is idempotent: a second cancel/archive call on an already-archived shadow no-ops', async () => {
    const shadow = makeTaskInstance({ status: 'not_started', isArchived: true });
    mockSpies.taskFindByPk.mockResolvedValueOnce(shadow);
    const dep = makeDep({ status: 'cancelled', linkedTaskId: 'task-shadow-1' });

    await syncLinkedTaskFromDependency(dep, actor);

    expect(shadow.update).not.toHaveBeenCalled();
    expect(mockSpies.emitTaskUpdated).not.toHaveBeenCalled();
  });

  it('shadow was deleted independently → no-op (we do not resurrect)', async () => {
    mockSpies.taskFindByPk.mockResolvedValueOnce(null);
    const dep = makeDep({ status: 'rejected', linkedTaskId: 'task-shadow-1' });

    const result = await syncLinkedTaskFromDependency(dep, actor);

    expect(result).toBeNull();
    expect(mockSpies.taskCreate).not.toHaveBeenCalled();
  });
});
