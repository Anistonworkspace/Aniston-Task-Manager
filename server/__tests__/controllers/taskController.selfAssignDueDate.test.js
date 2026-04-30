'use strict';

/**
 * Tests for taskController.createTask — self-assignment due-date gate.
 *
 * Background: the previous implementation rejected member self-task creation
 * with "Please set a due date before assigning this task" because the
 * controller auto-assigns members to themselves and then ran the same
 * due-date gate that protects assignments to *other* users.
 *
 * The new behavior:
 *   - Members get auto-self-assigned when they don't pick an assignee.
 *   - Self-only assignment is exempt from the due-date gate.
 *   - Assigning another user without a due date still 400s.
 *   - Members are still 403'd if they try to assign someone else.
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
  const TaskDependency = {};
  const Notification = { create: jest.fn() };
  const Subtask = {};
  const Label = {};

  return {
    Task, Board, User, TaskAssignee, TaskOwner, TaskApprovalFlow,
    TaskDependency, Notification, Subtask, Label,
    sequelize: { query: jest.fn(), literal: jest.fn((s) => s) },
  };
});

jest.mock('../../config/db', () => ({
  sequelize: { query: jest.fn().mockResolvedValue([[]]), literal: jest.fn((s) => s) },
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
  cleanupMultiple: jest.fn().mockResolvedValue(null),
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

describe('createTask — self-assignment due-date gate', () => {
  it('Scenario A: member with no assignee + no due date → auto-self-assigns and creates', async () => {
    configurePermissions({ canAssignOthers: false });
    configureBoardAndCreate();

    const req = makeMemberReq({ /* no assignedTo, no dueDate */ });
    const res = buildRes();

    await taskController.createTask(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(Task.create).toHaveBeenCalledWith(
      expect.objectContaining({ assignedTo: MEMBER_ID, dueDate: null }),
    );
    expect(TaskAssignee.bulkCreate).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ userId: MEMBER_ID, role: 'assignee' }),
      ]),
      expect.any(Object),
    );
  });

  it('Scenario B: member explicitly self-assigns + no due date → allowed', async () => {
    configurePermissions({ canAssignOthers: false });
    configureBoardAndCreate();

    const req = makeMemberReq({ assignedTo: [MEMBER_ID] });
    const res = buildRes();

    await taskController.createTask(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(Task.create).toHaveBeenCalled();
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

  it('Scenario D: manager assigns OTHER user without due date → 400 with the (refined) message', async () => {
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
    expect(Task.create).toHaveBeenCalledWith(
      expect.objectContaining({ assignedTo: OTHER_ID }),
    );
  });

  it('manager self-assigning without due date is also exempt from the gate', async () => {
    // Manager creating their own personal task — same self-only exemption applies
    // because the gate exists to protect *other* people from undated work.
    configurePermissions({ canAssignOthers: true });
    configureBoardAndCreate({ taskOverrides: { assignedTo: MEMBER_ID } });

    const req = makeManagerReq({ assignedTo: [MEMBER_ID] /* no dueDate */ });
    const res = buildRes();

    await taskController.createTask(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
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
