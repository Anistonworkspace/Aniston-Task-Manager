'use strict';

/**
 * Tests for the auto-unblock + auto-assign behaviour of
 * dependencyService.processTaskCompletion.
 *
 * Specifically:
 *   - When a blocker completes and the dependent has no other blockers, the
 *     dependent is unblocked (customFields.blockedByDependency cleared, status
 *     restored) and a notification is fired.
 *   - When the dependent still has other open blockers (legacy TaskDependency
 *     OR a blocking DependencyRequest), it stays blocked — NO notification.
 *   - When autoAssignOnComplete + autoAssignToUserId are set, the dependent's
 *     assignedTo is rewritten and the notification goes to the NEW assignee.
 *   - REJECTED dependency requests still count as blocking (per
 *     BLOCKING_DR_STATUSES) — the rejected status is intentional in this app.
 */

process.env.LOG_LEVEL = 'error';

const mockTaskFindByPk = jest.fn();
const mockTaskDepFindAll = jest.fn();
const mockDepReqCount = jest.fn();
const mockCreateNotification = jest.fn();
const mockEmitToUser = jest.fn();
const mockEmitToBoard = jest.fn();
const mockLogActivity = jest.fn();

jest.mock('../../models', () => ({
  Task: { findByPk: (...a) => mockTaskFindByPk(...a) },
  TaskDependency: { findAll: (...a) => mockTaskDepFindAll(...a) },
  DependencyRequest: { count: (...a) => mockDepReqCount(...a) },
  User: {},
  Notification: {},
  Board: {},
  TaskAssignee: {},
}));

jest.mock('../../config/db', () => ({ sequelize: {} }));

jest.mock('../../services/socketService', () => ({
  emitToUser: (...a) => mockEmitToUser(...a),
  emitToBoard: (...a) => mockEmitToBoard(...a),
}));

jest.mock('../../services/activityService', () => ({
  logActivity: (...a) => mockLogActivity(...a),
}));

jest.mock('../../services/notificationService', () => {
  const actual = jest.requireActual('../../services/notificationService');
  return {
    buildIdempotencyKey: actual.buildIdempotencyKey,
    createNotification: (...a) => mockCreateNotification(...a),
  };
});

const { processTaskCompletion } = require('../../services/dependencyService');

function makeDependentTask(overrides = {}) {
  const update = overrides.update || jest.fn().mockResolvedValue(true);
  const base = {
    id: 'task-B',
    title: 'Dependent task',
    status: 'stuck',
    assignedTo: 'u-old-assignee',
    boardId: 'board-1',
    autoAssigned: false,
    customFields: {
      blockedByDependency: true,
      statusBeforeDependencyBlock: 'working_on_it',
    },
    toJSON() { return { ...this }; },
  };
  return { ...base, ...overrides, update };
}

beforeEach(() => {
  mockTaskFindByPk.mockReset();
  mockTaskDepFindAll.mockReset();
  mockDepReqCount.mockReset();
  mockCreateNotification.mockReset();
  mockEmitToUser.mockReset();
  mockEmitToBoard.mockReset();
  mockLogActivity.mockReset();
  // Default: no blocking dependency requests
  mockDepReqCount.mockResolvedValue(0);
  mockCreateNotification.mockResolvedValue({ id: 'n-1' });
});

// ─── Single-blocker unblock ──────────────────────────────────────────────

describe('processTaskCompletion — single blocker completes', () => {
  it('unblocks the dependent task and fires a notification to the assignee', async () => {
    const dependent = makeDependentTask();

    mockTaskFindByPk.mockResolvedValueOnce({  // the completed task
      id: 'task-A', title: 'Blocker', status: 'done', assignee: { id: 'u-completer', name: 'Z' },
    });

    // First findAll: dependents of completed task
    mockTaskDepFindAll.mockResolvedValueOnce([
      {
        id: 'dep-1',
        taskId: dependent.id,
        dependsOnTaskId: 'task-A',
        autoAssignOnComplete: false,
        autoAssignToUserId: null,
        task: dependent,
        autoAssignTo: null,
      },
    ]);
    // Second findAll inside isTaskBlocked: no other legacy blockers
    mockTaskDepFindAll.mockResolvedValueOnce([]);

    await processTaskCompletion('task-A', 'u-completer');

    // status restored, blockedByDependency cleared
    expect(dependent.update).toHaveBeenCalledTimes(1);
    const updateArgs = dependent.update.mock.calls[0][0];
    expect(updateArgs.customFields.blockedByDependency).toBe(false);
    expect(updateArgs.customFields.statusBeforeDependencyBlock).toBeUndefined();
    expect(updateArgs.status).toBe('working_on_it');

    // notify assignee
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification.mock.calls[0][0]).toMatchObject({
      userId: 'u-old-assignee',
      entityType: 'task',
      entityId: dependent.id,
    });

    // socket events fired
    expect(mockEmitToUser).toHaveBeenCalledWith('u-old-assignee', 'task:unblocked', expect.any(Object));
    expect(mockEmitToBoard).toHaveBeenCalledWith('board-1', 'task:updated', expect.any(Object));

    // activity logged
    expect(mockLogActivity).toHaveBeenCalled();
  });
});

// ─── Still-blocked branch ────────────────────────────────────────────────

describe('processTaskCompletion — dependent still has another open blocker', () => {
  it('does NOT unblock or notify when another legacy blocker is still incomplete', async () => {
    const dependent = makeDependentTask();
    mockTaskFindByPk.mockResolvedValueOnce({ id: 'task-A', title: 'A', status: 'done' });
    mockTaskDepFindAll.mockResolvedValueOnce([
      {
        id: 'dep-1',
        taskId: dependent.id,
        dependsOnTaskId: 'task-A',
        autoAssignOnComplete: false,
        autoAssignToUserId: null,
        task: dependent,
      },
    ]);
    // isTaskBlocked legacy lookup: ANOTHER blocker still not 'done'
    mockTaskDepFindAll.mockResolvedValueOnce([
      { id: 'dep-other', dependsOnTask: { id: 'task-C', status: 'working_on_it' } },
    ]);

    await processTaskCompletion('task-A', 'u-x');

    expect(dependent.update).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockEmitToUser).not.toHaveBeenCalled();
  });

  it('treats a REJECTED DependencyRequest as still blocking (BLOCKING_DR_STATUSES)', async () => {
    const dependent = makeDependentTask();
    mockTaskFindByPk.mockResolvedValueOnce({ id: 'task-A', title: 'A', status: 'done' });
    mockTaskDepFindAll.mockResolvedValueOnce([
      {
        id: 'dep-1', taskId: dependent.id, dependsOnTaskId: 'task-A',
        autoAssignOnComplete: false, autoAssignToUserId: null, task: dependent,
      },
    ]);
    // No legacy blockers...
    mockTaskDepFindAll.mockResolvedValueOnce([]);
    // ...but a rejected dependency request exists. The service counts rejected
    // as blocking (intentional — see BLOCKING_DR_STATUSES in dependencyService).
    mockDepReqCount.mockResolvedValueOnce(1);

    await processTaskCompletion('task-A', 'u-x');

    expect(dependent.update).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});

// ─── Auto-assignment ─────────────────────────────────────────────────────

describe('processTaskCompletion — auto-assign on completion', () => {
  it('reassigns the dependent and notifies the NEW assignee, not the old one', async () => {
    const dependent = makeDependentTask({ assignedTo: 'u-old-assignee' });
    mockTaskFindByPk.mockResolvedValueOnce({ id: 'task-A', title: 'Blocker', status: 'done' });
    mockTaskDepFindAll.mockResolvedValueOnce([
      {
        id: 'dep-1',
        taskId: dependent.id,
        dependsOnTaskId: 'task-A',
        autoAssignOnComplete: true,
        autoAssignToUserId: 'u-new-assignee',
        task: dependent,
        autoAssignTo: { id: 'u-new-assignee', name: 'New' },
      },
    ]);
    // No other blockers
    mockTaskDepFindAll.mockResolvedValueOnce([]);

    await processTaskCompletion('task-A', 'u-completer');

    // The task update writes the new assignee
    const updateArgs = dependent.update.mock.calls[0][0];
    expect(updateArgs.assignedTo).toBe('u-new-assignee');
    expect(updateArgs.autoAssigned).toBe(true);

    // The notification goes to the NEW assignee
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification.mock.calls[0][0].userId).toBe('u-new-assignee');
    expect(mockCreateNotification.mock.calls[0][0].message).toMatch(/auto-assigned/i);

    // Socket targeted at the new assignee
    expect(mockEmitToUser).toHaveBeenCalledWith('u-new-assignee', 'task:unblocked', expect.any(Object));
  });

  it('does NOT auto-assign when autoAssignOnComplete is false even if a target user is set', async () => {
    const dependent = makeDependentTask({ assignedTo: 'u-old' });
    mockTaskFindByPk.mockResolvedValueOnce({ id: 'task-A', status: 'done' });
    mockTaskDepFindAll.mockResolvedValueOnce([
      {
        id: 'dep-1', taskId: dependent.id, dependsOnTaskId: 'task-A',
        autoAssignOnComplete: false,
        autoAssignToUserId: 'u-new',
        task: dependent,
      },
    ]);
    mockTaskDepFindAll.mockResolvedValueOnce([]);

    await processTaskCompletion('task-A', 'u-completer');

    const updateArgs = dependent.update.mock.calls[0][0];
    expect(updateArgs.assignedTo).toBeUndefined();
    expect(updateArgs.autoAssigned).toBeUndefined();
    // Notification goes to the legacy assignee on the dependent
    expect(mockCreateNotification.mock.calls[0][0].userId).toBe('u-old');
  });
});

// ─── Defensive guards ────────────────────────────────────────────────────

describe('processTaskCompletion — defensive guards', () => {
  it('returns silently when the completed task no longer exists', async () => {
    mockTaskFindByPk.mockResolvedValueOnce(null);
    await processTaskCompletion('task-missing', 'u-x');
    expect(mockTaskDepFindAll).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('skips dependents that are already done', async () => {
    const doneDependent = makeDependentTask({ status: 'done' });
    mockTaskFindByPk.mockResolvedValueOnce({ id: 'task-A', status: 'done' });
    mockTaskDepFindAll.mockResolvedValueOnce([
      {
        id: 'dep-1', taskId: doneDependent.id, dependsOnTaskId: 'task-A',
        autoAssignOnComplete: false, autoAssignToUserId: null, task: doneDependent,
      },
    ]);

    await processTaskCompletion('task-A', 'u-x');

    expect(doneDependent.update).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});
