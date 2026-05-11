'use strict';

/**
 * Tests for assignmentNotificationService idempotency.
 *
 * Verifies every public method passes a stable idempotency key shaped
 * around (taskId, userId, optional newRole, calendar day). The day
 * suffix is deliberate: retries within a day dedupe; a deliberate next-day
 * re-add of the same user produces a fresh notification.
 */

process.env.LOG_LEVEL = 'error';

const mockTaskFindByPk = jest.fn();
const mockUserFindByPk = jest.fn();
const mockCreateNotification = jest.fn();

jest.mock('../../models', () => ({
  Task: { findByPk: (...a) => mockTaskFindByPk(...a) },
  Board: {},
  User: { findByPk: (...a) => mockUserFindByPk(...a) },
}));

jest.mock('../../services/notificationService', () => {
  const actual = jest.requireActual('../../services/notificationService');
  return {
    buildIdempotencyKey: actual.buildIdempotencyKey,
    createNotification: (...a) => mockCreateNotification(...a),
  };
});

const {
  notifyNewAssignments,
  notifyRemovals,
  notifyRoleChange,
} = require('../../services/assignmentNotificationService');
const { buildIdempotencyKey } = require('../../services/notificationService');

function todayISO() { return new Date().toISOString().slice(0, 10); }

beforeEach(() => {
  mockTaskFindByPk.mockReset();
  mockUserFindByPk.mockReset();
  mockCreateNotification.mockReset();

  mockTaskFindByPk.mockResolvedValue({
    id: 't-1',
    title: 'Test task',
    dueDate: '2099-12-31',
    board: { id: 'b-1', name: 'Board' },
  });
  mockUserFindByPk.mockImplementation((id) =>
    Promise.resolve({ id, name: 'User ' + id, email: id + '@x' })
  );
  mockCreateNotification.mockResolvedValue({ id: 'n-1' });
});

describe('notifyNewAssignments — assignee idempotency', () => {
  it('passes task-assigned:<taskId>:<userId>:<day> key', async () => {
    await notifyNewAssignments('t-1', ['u-1'], 'assignee', 'u-assigner');
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    const call = mockCreateNotification.mock.calls[0][0];
    expect(call.type).toBe('task_assigned');
    expect(call.userId).toBe('u-1');
    expect(call.idempotencyKey).toBe(
      buildIdempotencyKey('task-assigned', 't-1', 'u-1', todayISO())
    );
  });

  it('repeating the same call same-day uses the same idempotency key', async () => {
    await notifyNewAssignments('t-1', ['u-1'], 'assignee', 'u-assigner');
    await notifyNewAssignments('t-1', ['u-1'], 'assignee', 'u-assigner');
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
    const k1 = mockCreateNotification.mock.calls[0][0].idempotencyKey;
    const k2 = mockCreateNotification.mock.calls[1][0].idempotencyKey;
    expect(k1).toBe(k2);
  });

  it('different users on same task get different keys', async () => {
    await notifyNewAssignments('t-1', ['u-1', 'u-2'], 'assignee', 'u-assigner');
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
    const k1 = mockCreateNotification.mock.calls[0][0].idempotencyKey;
    const k2 = mockCreateNotification.mock.calls[1][0].idempotencyKey;
    expect(k1).not.toBe(k2);
  });
});

describe('notifyNewAssignments — supervisor idempotency', () => {
  it('passes task-supervisor-added:<taskId>:<userId>:<day> key', async () => {
    await notifyNewAssignments('t-1', ['u-1'], 'supervisor', 'u-assigner');
    const call = mockCreateNotification.mock.calls[0][0];
    expect(call.type).toBe('task_supervisor_added');
    expect(call.idempotencyKey).toBe(
      buildIdempotencyKey('task-supervisor-added', 't-1', 'u-1', todayISO())
    );
  });

  it('assignee and supervisor on the same (task, user, day) get DIFFERENT keys', async () => {
    // This is the key correctness check: a user added as supervisor today
    // and re-added as assignee later the same day must produce two distinct
    // notifications, not collapse into one.
    await notifyNewAssignments('t-1', ['u-1'], 'supervisor', 'u-assigner');
    await notifyNewAssignments('t-1', ['u-1'], 'assignee', 'u-assigner');
    const k1 = mockCreateNotification.mock.calls[0][0].idempotencyKey;
    const k2 = mockCreateNotification.mock.calls[1][0].idempotencyKey;
    expect(k1).not.toBe(k2);
  });
});

describe('notifyRoleChange — idempotency includes newRole', () => {
  it('passes task-role-changed:<taskId>:<userId>:<newRole>:<day> key', async () => {
    await notifyRoleChange('t-1', 'u-1', 'assignee', 'supervisor');
    const call = mockCreateNotification.mock.calls[0][0];
    expect(call.type).toBe('task_role_changed');
    expect(call.idempotencyKey).toBe(
      buildIdempotencyKey('task-role-changed', 't-1', 'u-1', 'supervisor', todayISO())
    );
  });

  it('A→S and S→A flips on the same day get DIFFERENT keys', async () => {
    // newRole is part of the key, so flipping back and forth on the same
    // day still fires fresh notifications for each transition.
    await notifyRoleChange('t-1', 'u-1', 'assignee', 'supervisor');
    await notifyRoleChange('t-1', 'u-1', 'supervisor', 'assignee');
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
    const k1 = mockCreateNotification.mock.calls[0][0].idempotencyKey;
    const k2 = mockCreateNotification.mock.calls[1][0].idempotencyKey;
    expect(k1).not.toBe(k2);
  });

  it('same transition called twice same day uses the same key (retry dedup)', async () => {
    await notifyRoleChange('t-1', 'u-1', 'assignee', 'supervisor');
    await notifyRoleChange('t-1', 'u-1', 'assignee', 'supervisor');
    const k1 = mockCreateNotification.mock.calls[0][0].idempotencyKey;
    const k2 = mockCreateNotification.mock.calls[1][0].idempotencyKey;
    expect(k1).toBe(k2);
  });
});

describe('notifyRemovals — idempotency', () => {
  it('passes task-removed:<taskId>:<userId>:<day> key', async () => {
    await notifyRemovals('t-1', ['u-1']);
    const call = mockCreateNotification.mock.calls[0][0];
    expect(call.type).toBe('task_removed');
    expect(call.idempotencyKey).toBe(
      buildIdempotencyKey('task-removed', 't-1', 'u-1', todayISO())
    );
  });

  it('removed and re-removed same day uses same key (retry dedup)', async () => {
    await notifyRemovals('t-1', ['u-1']);
    await notifyRemovals('t-1', ['u-1']);
    const k1 = mockCreateNotification.mock.calls[0][0].idempotencyKey;
    const k2 = mockCreateNotification.mock.calls[1][0].idempotencyKey;
    expect(k1).toBe(k2);
  });

  it('removed user re-assigned later: different prefix → different key (legitimate fires)', async () => {
    // The removal key is `task-removed:...` and the new-assignment key is
    // `task-assigned:...`. These cannot collide even on the same day for
    // the same (task, user). A remove-then-re-add flow always produces a
    // fresh notification at each end of the round-trip.
    await notifyRemovals('t-1', ['u-1']);
    await notifyNewAssignments('t-1', ['u-1'], 'assignee', 'u-2');
    const k1 = mockCreateNotification.mock.calls[0][0].idempotencyKey;
    const k2 = mockCreateNotification.mock.calls[1][0].idempotencyKey;
    expect(k1).not.toBe(k2);
  });
});

describe('notifyNewAssignments — silently no-ops on empty input', () => {
  it('returns immediately for empty userIds', async () => {
    await notifyNewAssignments('t-1', [], 'assignee', 'u-assigner');
    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockTaskFindByPk).not.toHaveBeenCalled();
  });

  it('returns immediately for null userIds', async () => {
    await notifyNewAssignments('t-1', null, 'assignee', 'u-assigner');
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('returns gracefully when task is not found', async () => {
    mockTaskFindByPk.mockResolvedValueOnce(null);
    await notifyNewAssignments('t-missing', ['u-1'], 'assignee', 'u-assigner');
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});
