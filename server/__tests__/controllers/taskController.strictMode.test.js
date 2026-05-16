'use strict';

/**
 * Tests for taskController.createTask — Phase 1 strict-mode required-field
 * enforcement.
 *
 * Background:
 *   - The new Create Task modal sends `strict: true` along with the full
 *     required field set (title, groupId, status, priority, dueDate, owner).
 *   - The server enforces those required fields whenever `strict: true` is
 *     set, returning HTTP 400 with `code: 'strict_missing_required'` and a
 *     `missing` array listing the bad fields.
 *   - When `strict` is absent / false, the controller keeps its prior
 *     lenient behaviour (status defaults to 'not_started', priority defaults
 *     to 'medium', optional assignee, etc.) so the inline-create path,
 *     recurring task generator, automation actions, webhooks and CSV import
 *     continue to work unchanged.
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
  sequelize: {
    query: jest.fn().mockResolvedValue([[]]),
    literal: jest.fn((s) => s),
    transaction: jest.fn(async (cb) => cb({})),
  },
}));

jest.mock('../../services/permissionEngine', () => ({
  hasPermission: jest.fn(async () => true),
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
jest.mock('../../services/boardVisibilityService', () => ({
  canUserSeeBoard: jest.fn().mockResolvedValue(true),
  buildBoardVisibilityWhere: jest.fn(async () => ({})),
  filterVisibleBoardIds: jest.fn(async (_user, ids) => ids),
  buildVisibleBoardIds: jest.fn(async (_user, ids) => ids),
}));
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
}));
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

const { Task, Board } = require('../../models');
const taskController = require('../../controllers/taskController');

const BOARD_ID  = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const USER_ID   = 'c2a0de11-1e2d-4ef0-dd8f-8dd1df502c33';
const NEW_TASK  = 'b1efcd88-0d1c-4ea9-bc7e-7ac0ce491b22';

function buildRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

function adminReq(body) {
  return {
    user: { id: USER_ID, role: 'admin', name: 'Admin', isSuperAdmin: true },
    body: { boardId: BOARD_ID, ...body },
  };
}

function configureBoard() {
  Board.findByPk.mockResolvedValue({
    id: BOARD_ID, name: 'Board', groups: [{ id: 'g1', title: 'To-Do' }], columns: [],
  });
  Task.create.mockResolvedValue({ id: NEW_TASK });
  Task.findByPk.mockResolvedValue({ id: NEW_TASK, toJSON: () => ({ id: NEW_TASK }) });
}

beforeEach(() => {
  jest.clearAllMocks();
  Task.max.mockResolvedValue(0);
});

describe('createTask — strict mode (Phase 1)', () => {
  // The set of full required fields the modal always sends. Individual tests
  // omit one field at a time to assert each rejection path.
  const fullBody = {
    title: 'Modal task',
    groupId: 'g1',
    status: 'not_started',
    priority: 'medium',
    dueDate: '2026-12-31',
    assignedTo: USER_ID,
    strict: true,
  };

  it('rejects when title is missing', async () => {
    configureBoard();
    const { title: _omitted, ...rest } = fullBody;
    const res = buildRes();
    await taskController.createTask(adminReq(rest), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      code: 'strict_missing_required',
      missing: expect.arrayContaining(['title']),
    }));
    expect(Task.create).not.toHaveBeenCalled();
  });

  it('rejects when groupId is missing', async () => {
    configureBoard();
    const { groupId: _omitted, ...rest } = fullBody;
    const res = buildRes();
    await taskController.createTask(adminReq(rest), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'strict_missing_required',
      missing: expect.arrayContaining(['group']),
    }));
  });

  it('rejects when status is missing', async () => {
    configureBoard();
    const { status: _omitted, ...rest } = fullBody;
    const res = buildRes();
    await taskController.createTask(adminReq(rest), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'strict_missing_required',
      missing: expect.arrayContaining(['status']),
    }));
  });

  it('rejects when priority is missing', async () => {
    configureBoard();
    const { priority: _omitted, ...rest } = fullBody;
    const res = buildRes();
    await taskController.createTask(adminReq(rest), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'strict_missing_required',
      missing: expect.arrayContaining(['priority']),
    }));
  });

  it('rejects when dueDate is missing', async () => {
    configureBoard();
    const { dueDate: _omitted, ...rest } = fullBody;
    const res = buildRes();
    await taskController.createTask(adminReq(rest), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'strict_missing_required',
      missing: expect.arrayContaining(['dueDate']),
    }));
  });

  it('rejects when owner (assignedTo) is missing', async () => {
    configureBoard();
    const { assignedTo: _omitted, ...rest } = fullBody;
    const res = buildRes();
    await taskController.createTask(adminReq(rest), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'strict_missing_required',
      missing: expect.arrayContaining(['owner']),
    }));
  });

  it('returns multiple missing fields in one response', async () => {
    configureBoard();
    const res = buildRes();
    await taskController.createTask(adminReq({ strict: true, title: '' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    const payload = res.json.mock.calls[0][0];
    expect(payload.code).toBe('strict_missing_required');
    expect(payload.missing).toEqual(
      expect.arrayContaining(['title', 'group', 'status', 'priority', 'dueDate', 'owner']),
    );
  });

  it('accepts a full strict-mode payload', async () => {
    configureBoard();
    const res = buildRes();
    await taskController.createTask(adminReq(fullBody), res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(Task.create).toHaveBeenCalled();
  });

  it('is a no-op when strict is not set (lenient inline path still works)', async () => {
    // The inline quick-create flow sends only { title, boardId, groupId,
    // position } — no status/priority/dueDate/assignee. Without `strict: true`
    // the controller must keep accepting that shape so existing callers
    // (KanbanView, recurring task generator, automations, webhooks, CSV
    // import) continue to function.
    configureBoard();
    const res = buildRes();
    await taskController.createTask(
      adminReq({ title: 'Inline task', groupId: 'g1' /* no strict */ }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('whitespace-only required string is rejected as missing', async () => {
    configureBoard();
    const res = buildRes();
    await taskController.createTask(
      adminReq({ ...fullBody, title: '   ' }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'strict_missing_required',
      missing: expect.arrayContaining(['title']),
    }));
  });
});
