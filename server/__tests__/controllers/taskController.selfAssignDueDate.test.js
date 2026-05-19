'use strict';

/**
 * Tests for taskController.createTask — assignment due-date gate.
 *
 * Background (post-fix):
 *   - The product rule is now "no assignment without a due date" — including
 *     self-assignment. The earlier carve-out for self-only assignment was a
 *     bypass vector and has been removed.
 *   - The "+ Add task" quick-create flow still works because the auto-self-
 *     assign branch for members is now gated on `dueDate`: if no due date is
 *     supplied, the task is created UNASSIGNED instead of auto-self-assigned.
 *   - Explicit self-assignment (a member POSTing { assignedTo: [me] } with no
 *     due date) is now a 400.
 *   - Members still 403 if they try to assign anyone other than themselves.
 *   - Manager assigning a non-member without a due date still 400s.
 */

jest.mock('xss', () => (s) => s);

jest.mock('express-validator', () => ({
  body: () => ({
    trim: () => ({ notEmpty: () => ({ withMessage: () => ({}) }) }),
    isUUID: () => ({}),
    isIn: () => ({}),
    optional: () => ({
      isISO8601: () => ({}),
      isString: () => ({}),
      isInt: () => ({}),
      isArray: () => ({}),
      isUUID: () => ({}),
      nullable: true,
    }),
  }),
  validationResult: jest.fn(() => ({ isEmpty: () => true, array: () => [] })),
}));

jest.mock('../../models', () => {
  const Task = {
    create: jest.fn(),
    findByPk: jest.fn(),
    max: jest.fn().mockResolvedValue(0),
    update: jest.fn(),
    findAll: jest.fn().mockResolvedValue([]),
  };
  const Board = { findByPk: jest.fn() };
  const User = { findByPk: jest.fn() };
  const TaskAssignee = {
    bulkCreate: jest.fn().mockResolvedValue([]),
    destroy: jest.fn().mockResolvedValue(0),
    findOrCreate: jest.fn().mockResolvedValue([{}, true]),
    findAll: jest.fn().mockResolvedValue([]),
  };
  const TaskOwner = { bulkCreate: jest.fn().mockResolvedValue([]) };
  const TaskApprovalFlow = { findAll: jest.fn().mockResolvedValue([]) };
  const TaskDependency = { findAll: jest.fn().mockResolvedValue([]) };
  const Notification = { create: jest.fn() };
  const Subtask = {};
  const Label = {};
  // taskController destructures these from `../models`; create benign stubs so
  // the destructure doesn't yield undefined values that crash later helpers.
  const TaskReference = { findAll: jest.fn().mockResolvedValue([]) };
  const TaskLink = { findAll: jest.fn().mockResolvedValue([]) };
  const DependencyRequest = { findAll: jest.fn().mockResolvedValue([]) };

  return {
    Task, Board, User, TaskAssignee, TaskOwner, TaskApprovalFlow,
    TaskDependency, Notification, Subtask, Label,
    TaskReference, TaskLink, DependencyRequest,
    sequelize: { query: jest.fn().mockResolvedValue([[]]), literal: jest.fn((s) => s) },
  };
});

jest.mock('../../config/db', () => ({
  // createTask now wraps Task.create + TaskAssignee.bulkCreate + TaskOwner.bulkCreate
  // in a managed transaction (sequelize.transaction(async (t) => { ... })).
  // The fake transaction just invokes the callback with a stub tx object so the
  // controller's atomic-create block runs without a real DB.
  sequelize: {
    query: jest.fn().mockResolvedValue([[]]),
    literal: jest.fn((s) => s),
    transaction: jest.fn(async (cb) => cb({ /* fake tx */ })),
  },
}));

jest.mock('../../services/permissionEngine', () => ({
  hasPermission: jest.fn(),
}));

jest.mock('../../services/hierarchyService', () => ({
  canAssignTo: jest.fn().mockResolvedValue(true),
  removePrimaryManager: jest.fn(),
  setPrimaryManager: jest.fn(),
}));

jest.mock('../../services/socketService', () => ({
  emitToBoard: jest.fn(), emitToUser: jest.fn(), getIO: jest.fn(),
}));
jest.mock('../../services/activityService', () => ({ logActivity: jest.fn() }));
jest.mock('../../services/teamsWebhook', () => ({
  sendTaskCreated: jest.fn(), sendTaskUpdated: jest.fn(), sendTaskCompleted: jest.fn(),
}));
jest.mock('../../services/automationService', () => ({
  processAutomations: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../services/dependencyService', () => ({
  checkAndUnblockDependents: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../services/calendarService', () => ({
  createTaskEvent: jest.fn().mockResolvedValue(null),
  updateTaskEvent: jest.fn().mockResolvedValue(null),
  deleteTaskEvent: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../services/conflictDetectionService', () => ({
  checkConflicts: jest.fn().mockResolvedValue({ hasConflicts: false, conflicts: [] }),
  autoReschedule: jest.fn(),
  getScheduleSummary: jest.fn(),
}));
jest.mock('../../services/reminderService', () => ({
  scheduleReminders: jest.fn().mockResolvedValue(null),
  cancelReminders: jest.fn().mockResolvedValue(null),
  rescheduleReminders: jest.fn().mockResolvedValue(null),
  // Phase 5 user-reminder spec helpers — createTask now AWAITS applyReminderSpecs
  // and threads normalizeReminderSpecs output into the response.
  applyReminderSpecs: jest.fn().mockResolvedValue(null),
  normalizeReminderSpecs: jest.fn(() => ({ specs: [], errors: [] })),
  getUserReminderSpecs: jest.fn().mockResolvedValue([]),
  getReminderSummary: jest.fn().mockResolvedValue(null),
  getReminderSummaryBulk: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../services/assignmentNotificationService', () => ({
  notifyNewAssignments: jest.fn().mockResolvedValue(null),
  diffAndNotify: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../services/taskReceiptService', () => ({
  buildSummary: jest.fn(() => null),
}));
jest.mock('../../services/teamsNotificationService', () => ({
  notifyTaskAssigned: jest.fn().mockResolvedValue(null),
  notifyMemberRemoved: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../services/boardMembershipService', () => ({
  autoAddMember: jest.fn().mockResolvedValue(null),
  explicitAddMember: jest.fn().mockResolvedValue(null),
  cleanupMultiple: jest.fn().mockResolvedValue(null),
  cleanupIfNoTasksRemain: jest.fn().mockResolvedValue(null),
}));
// Tier 3/4 actors (members, assistant managers) now go through the board
// visibility gate before they can plant a task — mock it as "always allowed"
// so the test can focus on the assignment / due-date semantics.
jest.mock('../../services/boardVisibilityService', () => ({
  canUserSeeBoard: jest.fn().mockResolvedValue(true),
  buildBoardVisibilityWhere: jest.fn(async () => ({})),
  filterVisibleBoardIds: jest.fn(async (_user, ids) => ids),
  buildVisibleBoardIds: jest.fn(async (_user, ids) => ids),
}));
// createTask now fans out a realtime task:created event after persistence.
// We swallow it so the test doesn't require a Socket.io stub.
jest.mock('../../services/realtimeService', () => ({
  emitTaskCreated: jest.fn(),
  emitTaskUpdated: jest.fn(),
  emitTaskDeleted: jest.fn(),
  emitTaskArchived: jest.fn(),
}));
jest.mock('../../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue(null),
  buildIdempotencyKey: jest.fn(() => 'idempotency-key'),
}));
jest.mock('../../utils/taskOwnership', () => ({
  isSelfOwnedTask: jest.fn(() => true),
  isSelfOwnedCreate: jest.fn(() => true),
  isAssigneeOnTask: jest.fn(() => false),
}));
// taskController also imports recurringTaskService as a module ref; we don't
// invoke its members in createTask but the require() must succeed.
jest.mock('../../services/recurringTaskService', () => ({
  spawnDueInstances: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../middleware/taskPermissions', () => ({
  buildTaskVisibilityFilter: jest.fn(() => ({})),
  checkTaskAction: jest.fn(() => ({ allowed: true })),
}));
jest.mock('../../utils/safeSql', () => ({ safeUUID: (s) => s }));
jest.mock('../../utils/sanitize', () => ({ sanitizeInput: (s) => s }));
jest.mock('../../utils/statusConfig', () => ({
  isValidStatus: () => true,
  isValidStatusForTask: () => true,
}));
jest.mock('../../utils/taskPrioritization', () => ({
  buildPendingPriorityOrder: () => [],
  findGroupForStatus: () => null,
}));
jest.mock('../../utils/logger', () => ({
  error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(),
}));

const { Task, Board, TaskAssignee } = require('../../models');
const permissionEngine = require('../../services/permissionEngine');
const taskOwnership = require('../../utils/taskOwnership');
const taskController = require('../../controllers/taskController');

const BOARD_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const MEMBER_ID = 'c2a0de11-1e2d-4ef0-dd8f-8dd1df502c33';
const OTHER_ID  = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const NEW_TASK_ID = 'b1efcd88-0d1c-4ea9-bc7e-7ac0ce491b22';

function buildRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

function makeMemberReq(body = {}) {
  return {
    user: { id: MEMBER_ID, role: 'member', name: 'Sunny', isSuperAdmin: false },
    body: { title: 'My personal task', boardId: BOARD_ID, ...body },
  };
}

function makeManagerReq(body = {}) {
  return {
    user: { id: MEMBER_ID, role: 'manager', name: 'Mgr', isSuperAdmin: false },
    body: { title: 'Team task', boardId: BOARD_ID, ...body },
  };
}

function configurePermissions({ canCreate = true, canAssignOthers = false } = {}) {
  permissionEngine.hasPermission.mockImplementation(async (_user, resource, action) => {
    if (resource === 'tasks' && action === 'create') return canCreate;
    if (resource === 'tasks' && action === 'assign') return true;
    if (resource === 'tasks' && action === 'assign_others') return canAssignOthers;
    return false;
  });
}

function configureBoardAndCreate({ taskOverrides = {} } = {}) {
  Board.findByPk.mockResolvedValue({
    id: BOARD_ID, name: 'Test Board', groups: [], columns: [],
  });
  const created = { id: NEW_TASK_ID, ...taskOverrides };
  Task.create.mockResolvedValue(created);
  Task.findByPk.mockResolvedValue({
    ...created,
    toJSON: () => ({ id: NEW_TASK_ID, ...taskOverrides }),
  });
  return created;
}

beforeEach(() => {
  jest.clearAllMocks();
  Task.max.mockResolvedValue(0);
});

describe('createTask — assignment due-date gate (no self-exemption)', () => {
  it('Scenario A: member with no assignee + no due date → creates UNASSIGNED (no auto-self-assign)', async () => {
    configurePermissions({ canAssignOthers: false });
    configureBoardAndCreate();

    const req = makeMemberReq({ /* no assignedTo, no dueDate */ });
    const res = buildRes();

    await taskController.createTask(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    // The "+ Add task" quick-create still succeeds, but the auto-self-assign
    // is suppressed when there's no due date. The task row is created with
    // assignedTo: null so the user can set a due date and self-assign as a
    // follow-up edit.
    // Task.create is now invoked with `(values, { transaction: t })` inside
    // the atomic-create block, so we match only the first arg.
    expect(Task.create.mock.calls[0][0]).toEqual(
      expect.objectContaining({ assignedTo: null, dueDate: null }),
    );
    expect(TaskAssignee.bulkCreate).not.toHaveBeenCalled();
  });

  it('Scenario A2: member with no assignee + due date → auto-self-assigns', async () => {
    // The auto-self-assign convenience still kicks in when a due date IS set
    // — the gate is satisfied so we can default the assignee to the actor.
    configurePermissions({ canAssignOthers: false });
    configureBoardAndCreate();

    const req = makeMemberReq({ dueDate: '2026-12-31' });
    const res = buildRes();

    await taskController.createTask(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(Task.create.mock.calls[0][0]).toEqual(
      expect.objectContaining({ assignedTo: MEMBER_ID, dueDate: '2026-12-31' }),
    );
  });

  it('Scenario B: member explicitly self-assigns + no due date → 400 (new rule)', async () => {
    configurePermissions({ canAssignOthers: false });
    Board.findByPk.mockResolvedValue({ id: BOARD_ID, name: 'Test Board', groups: [], columns: [] });

    const req = makeMemberReq({ assignedTo: [MEMBER_ID] });
    const res = buildRes();

    await taskController.createTask(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: expect.stringMatching(/due date before assigning this task/i),
      }),
    );
    expect(Task.create).not.toHaveBeenCalled();
  });

  it('Scenario C: member tries to assign another user → 403, no task written', async () => {
    configurePermissions({ canAssignOthers: false });
    Board.findByPk.mockResolvedValue({ id: BOARD_ID, name: 'Test Board', groups: [], columns: [] });

    const req = makeMemberReq({ assignedTo: [OTHER_ID], dueDate: '2026-12-31' });
    const res = buildRes();

    await taskController.createTask(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: expect.stringMatching(/permission to assign tasks to other users/i),
      }),
    );
    expect(Task.create).not.toHaveBeenCalled();
  });

  it('Scenario D: manager assigns OTHER user without due date → 400 with the "another user" message', async () => {
    configurePermissions({ canAssignOthers: true });
    Board.findByPk.mockResolvedValue({ id: BOARD_ID, name: 'Test Board', groups: [], columns: [] });

    const req = makeManagerReq({ assignedTo: [OTHER_ID] /* no dueDate */ });
    const res = buildRes();

    await taskController.createTask(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: expect.stringMatching(/due date before assigning this task to another user/i),
      }),
    );
    expect(Task.create).not.toHaveBeenCalled();
  });

  it('Scenario D2: manager assigns OTHER user WITH due date → 201', async () => {
    configurePermissions({ canAssignOthers: true });
    configureBoardAndCreate({ taskOverrides: { assignedTo: OTHER_ID, dueDate: '2026-12-31' } });

    const req = makeManagerReq({ assignedTo: [OTHER_ID], dueDate: '2026-12-31' });
    const res = buildRes();

    await taskController.createTask(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(Task.create.mock.calls[0][0]).toEqual(
      expect.objectContaining({ assignedTo: OTHER_ID }),
    );
  });

  it('Scenario E: manager self-assigning without due date is also blocked (no self-exemption)', async () => {
    configurePermissions({ canAssignOthers: true });
    Board.findByPk.mockResolvedValue({ id: BOARD_ID, name: 'Test Board', groups: [], columns: [] });

    const req = makeManagerReq({ assignedTo: [MEMBER_ID] /* no dueDate */ });
    const res = buildRes();

    await taskController.createTask(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: expect.stringMatching(/due date before assigning this task/i),
      }),
    );
    expect(Task.create).not.toHaveBeenCalled();
  });

  it('member without create permission is rejected with 403', async () => {
    configurePermissions({ canCreate: false });
    Board.findByPk.mockResolvedValue({ id: BOARD_ID, name: 'Test Board', groups: [], columns: [] });

    const req = makeMemberReq();
    const res = buildRes();

    await taskController.createTask(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(Task.create).not.toHaveBeenCalled();
  });
});

describe('createTask — set_priority permission gate', () => {
  // Member explicitly setting NON-DEFAULT priority → blocked by the gate
  // (members default to set_priority=false in the permission matrix).
  it('member providing non-default priority is rejected with 403 when set_priority=false', async () => {
    permissionEngine.hasPermission.mockImplementation(async (_user, resource, action) => {
      if (resource === 'tasks' && action === 'create') return true;
      if (resource === 'tasks' && action === 'assign') return true;
      if (resource === 'tasks' && action === 'assign_others') return false;
      if (resource === 'tasks' && action === 'set_priority') return false;
      return false;
    });
    // Override the file-level `isSelfOwnedCreate: () => true` so the
    // self-owned exemption inside the priority gate doesn't short-circuit
    // this assertion. The product rule: a non-self-owned create with a
    // non-default priority must 403 when set_priority=false.
    taskOwnership.isSelfOwnedCreate.mockReturnValueOnce(false);
    Board.findByPk.mockResolvedValue({ id: BOARD_ID, name: 'Test Board', groups: [], columns: [] });

    const req = makeMemberReq({ priority: 'high', dueDate: '2026-12-31' });
    const res = buildRes();

    await taskController.createTask(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: expect.stringMatching(/permission to set task priority/i),
      }),
    );
    expect(Task.create).not.toHaveBeenCalled();
  });

  // Regression: a member who quick-creates a task with the DEFAULT priority
  // ('medium') in the request body must NOT be rejected. Some clients
  // serialize the default into the POST payload; treating that as a
  // forbidden priority mutation broke the quick-add flow on the board.
  it('member providing the DEFAULT priority value is allowed (no 403)', async () => {
    permissionEngine.hasPermission.mockImplementation(async (_user, resource, action) => {
      if (resource === 'tasks' && action === 'create') return true;
      if (resource === 'tasks' && action === 'assign') return true;
      if (resource === 'tasks' && action === 'assign_others') return false;
      if (resource === 'tasks' && action === 'set_priority') return false;
      return false;
    });
    configureBoardAndCreate();

    const req = makeMemberReq({ priority: 'medium' /* no dueDate */ });
    const res = buildRes();

    await taskController.createTask(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    // No assignee set: dueDate omitted → auto-self-assign suppressed (per
    // earlier rule), task is created unassigned with the default priority.
    expect(Task.create.mock.calls[0][0]).toEqual(
      expect.objectContaining({ priority: 'medium', assignedTo: null }),
    );
  });

  // Same as above but no priority field at all — also allowed.
  it('member quick-create with NO priority field is allowed', async () => {
    permissionEngine.hasPermission.mockImplementation(async (_user, resource, action) => {
      if (resource === 'tasks' && action === 'create') return true;
      if (resource === 'tasks' && action === 'assign') return true;
      if (resource === 'tasks' && action === 'assign_others') return false;
      if (resource === 'tasks' && action === 'set_priority') return false;
      return false;
    });
    configureBoardAndCreate();

    const req = makeMemberReq({ /* no priority, no dueDate */ });
    const res = buildRes();

    await taskController.createTask(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(Task.create.mock.calls[0][0]).toEqual(
      expect.objectContaining({ priority: 'medium' }),
    );
  });

  // Manager / admin path — set_priority=true → priority change goes through.
  it('manager with set_priority=true can supply explicit priority', async () => {
    permissionEngine.hasPermission.mockImplementation(async (_user, resource, action) => {
      if (resource === 'tasks' && action === 'create') return true;
      if (resource === 'tasks' && action === 'assign') return true;
      if (resource === 'tasks' && action === 'assign_others') return true;
      if (resource === 'tasks' && action === 'set_priority') return true;
      return false;
    });
    configureBoardAndCreate({ taskOverrides: { priority: 'critical' } });

    const req = makeManagerReq({ priority: 'critical', assignedTo: [OTHER_ID], dueDate: '2026-12-31' });
    const res = buildRes();

    await taskController.createTask(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(Task.create.mock.calls[0][0]).toEqual(
      expect.objectContaining({ priority: 'critical' }),
    );
  });
});
