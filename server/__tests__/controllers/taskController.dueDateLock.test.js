'use strict';

/**
 * Regression tests for the Tier-aware due-date lock in
 * taskController.updateTask (the DUE_DATE_LOCKED branch).
 *
 * Rule:
 *   - Tier 1 / Tier 2 may always change a task's due date.
 *   - Tier 3 / Tier 4 may set the INITIAL due date (existing == null) but
 *     may not change a date that is already set, regardless of whether the
 *     task is self-assigned or was delegated by a manager.
 *   - No-op resends (incoming === existing) are allowed for everyone so
 *     optimistic clients that always include dueDate in PATCH payloads
 *     don't 403 on harmless replays.
 *
 * Mock surface mirrors taskController.selfAssignDueDate.test.js: mock the
 * heavy-weight services (db, sockets, notifications, calendar, etc.) so
 * the test exercises the gate logic without booting Postgres.
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
    findByPk: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findAll: jest.fn().mockResolvedValue([]),
    max: jest.fn().mockResolvedValue(0),
  };
  const Board = { findByPk: jest.fn() };
  const User = { findByPk: jest.fn() };
  const TaskAssignee = {
    findAll: jest.fn().mockResolvedValue([]),
    bulkCreate: jest.fn().mockResolvedValue([]),
    destroy: jest.fn().mockResolvedValue(0),
    findOne: jest.fn().mockResolvedValue(null),
  };
  const TaskOwner = { bulkCreate: jest.fn().mockResolvedValue([]) };
  const TaskApprovalFlow = { findAll: jest.fn().mockResolvedValue([]) };
  const TaskDependency = { findOne: jest.fn().mockResolvedValue(null) };
  const DependencyRequest = { count: jest.fn().mockResolvedValue(0) };
  const Notification = { create: jest.fn() };
  const Subtask = {};
  const Label = {};
  return {
    Task, Board, User, TaskAssignee, TaskOwner, TaskApprovalFlow,
    TaskDependency, DependencyRequest, Notification, Subtask, Label,
    sequelize: { query: jest.fn(), literal: jest.fn((s) => s) },
  };
});

jest.mock('../../config/db', () => ({
  sequelize: { query: jest.fn().mockResolvedValue([[]]), literal: jest.fn((s) => s) },
}));

jest.mock('../../services/permissionEngine', () => ({
  hasPermission: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../services/hierarchyService', () => ({
  canAssignTo: jest.fn().mockResolvedValue(true),
  removePrimaryManager: jest.fn(),
  setPrimaryManager: jest.fn(),
  getDescendantIds: jest.fn().mockResolvedValue([]),
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
  isTaskBlocked: jest.fn().mockResolvedValue(false),
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
  notifyDeadlineChanged: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../services/boardMembershipService', () => ({
  autoAddMember: jest.fn().mockResolvedValue(null),
  cleanupMultiple: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../services/realtimeEvents', () => ({
  emitTaskUpdated: jest.fn(),
}), { virtual: true });
jest.mock('../../middleware/taskPermissions', () => ({
  buildTaskVisibilityFilter: jest.fn(() => ({})),
  // The gate under test runs BEFORE the field-merge in updateTask. We allow
  // the edit at the middleware layer so tests focus on the controller-level
  // due-date lock specifically.
  checkTaskAction: jest.fn(async () => ({ allowed: true, allowedFields: null })),
}));
jest.mock('../../utils/safeSql', () => ({ safeUUID: (s) => s }));
jest.mock('../../utils/sanitize', () => ({ sanitizeInput: (s) => s }));
jest.mock('../../utils/statusConfig', () => ({
  isValidStatus: () => true,
  isValidStatusForTask: () => true,
  getAllowedStatusesForTask: () => ['not_started', 'working_on_it', 'done'],
}));
jest.mock('../../utils/taskPrioritization', () => ({
  buildPendingPriorityOrder: () => [],
  findGroupForStatus: () => null,
}));
jest.mock('../../utils/logger', () => ({
  error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(),
}));

const { Task } = require('../../models');
const taskController = require('../../controllers/taskController');

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const BOARD_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID  = '33333333-3333-4333-8333-333333333333';

function buildRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

function makeTaskInstance(overrides = {}) {
  const base = {
    id: TASK_ID,
    boardId: BOARD_ID,
    title: 'Existing task',
    description: '',
    status: 'working_on_it',
    progress: 0,
    dueDate: null,
    startDate: null,
    assignedTo: USER_ID,
    createdBy: USER_ID,
    isArchived: false,
    completedAt: null,
    statusConfig: null,
    customFields: null,
    tags: [],
    approvalStatus: null,
    board: { id: BOARD_ID, name: 'B', columns: [], groups: [] },
    creator: { id: USER_ID, role: 'member' },
    taskAssignees: [],
    ...overrides,
  };
  return {
    ...base,
    update: jest.fn(async function (patch) {
      Object.assign(this, patch);
      return this;
    }),
    toJSON() { return base; },
  };
}

function configureTask(overrides = {}) {
  const inst = makeTaskInstance(overrides);
  Task.findByPk.mockResolvedValue(inst);
  return inst;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('updateTask — due-date lock for Tier 3 / Tier 4', () => {
  it('Tier 4 (member) CAN set the INITIAL due date on a self-assigned task (existing dueDate is null)', async () => {
    configureTask({ dueDate: null, assignedTo: USER_ID, createdBy: USER_ID });

    const req = {
      params: { id: TASK_ID },
      user: { id: USER_ID, role: 'member', isSuperAdmin: false },
      body: { dueDate: '2026-12-31' },
    };
    const res = buildRes();

    await taskController.updateTask(req, res);

    // Not 403 on the lock — initial set is allowed.
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('Tier 4 (member) is BLOCKED with 403 + DUE_DATE_LOCKED when changing an already-set due date', async () => {
    configureTask({ dueDate: '2026-05-13', assignedTo: USER_ID, createdBy: USER_ID });

    const req = {
      params: { id: TASK_ID },
      user: { id: USER_ID, role: 'member', isSuperAdmin: false },
      body: { dueDate: '2026-06-15' },
    };
    const res = buildRes();

    await taskController.updateTask(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        code: 'DUE_DATE_LOCKED',
        message: expect.stringMatching(/Tier 1 or Tier 2/i),
      }),
    );
  });

  it('Tier 4 (member) is BLOCKED on a task DELEGATED by a manager (assignee but not creator)', async () => {
    // Assignee but a different user created the task.
    configureTask({
      dueDate: '2026-05-13',
      assignedTo: USER_ID,
      createdBy: '99999999-9999-4999-8999-999999999999',
    });

    const req = {
      params: { id: TASK_ID },
      user: { id: USER_ID, role: 'member', isSuperAdmin: false },
      body: { dueDate: '2026-06-15' },
    };
    const res = buildRes();

    await taskController.updateTask(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'DUE_DATE_LOCKED' }),
    );
  });

  it('Tier 3 (assistant_manager) is BLOCKED with 403 when changing an already-set due date', async () => {
    configureTask({ dueDate: '2026-05-13' });

    const req = {
      params: { id: TASK_ID },
      user: { id: USER_ID, role: 'assistant_manager', isSuperAdmin: false },
      body: { dueDate: '2026-06-15' },
    };
    const res = buildRes();

    await taskController.updateTask(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'DUE_DATE_LOCKED' }),
    );
  });

  it('Tier 2 (manager) CAN change an already-set due date', async () => {
    configureTask({ dueDate: '2026-05-13' });

    const req = {
      params: { id: TASK_ID },
      user: { id: USER_ID, role: 'manager', isSuperAdmin: false },
      body: { dueDate: '2026-06-15' },
    };
    const res = buildRes();

    await taskController.updateTask(req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('Tier 2 (admin) CAN change an already-set due date', async () => {
    configureTask({ dueDate: '2026-05-13' });

    const req = {
      params: { id: TASK_ID },
      user: { id: USER_ID, role: 'admin', isSuperAdmin: false },
      body: { dueDate: '2026-06-15' },
    };
    const res = buildRes();

    await taskController.updateTask(req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('Tier 1 (Super Admin) CAN change an already-set due date', async () => {
    configureTask({ dueDate: '2026-05-13' });

    const req = {
      params: { id: TASK_ID },
      user: { id: USER_ID, role: 'admin', isSuperAdmin: true, tier: 1 },
      body: { dueDate: '2026-06-15' },
    };
    const res = buildRes();

    await taskController.updateTask(req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('No-op resend (same dueDate as existing) does NOT 403 — even for Tier 4', async () => {
    // Optimistic clients sometimes echo the existing dueDate back in PATCH-
    // style payloads. That should be a harmless write, not a 403.
    configureTask({ dueDate: '2026-05-13' });

    const req = {
      params: { id: TASK_ID },
      user: { id: USER_ID, role: 'member', isSuperAdmin: false },
      body: { dueDate: '2026-05-13' },
    };
    const res = buildRes();

    await taskController.updateTask(req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('Full ISO timestamp incoming compared correctly against DATEONLY existing (no false 403)', async () => {
    // Some clients ship `2026-05-13T00:00:00.000Z` even though the column
    // is DATEONLY. Normalization should treat this as a no-op against an
    // existing '2026-05-13'.
    configureTask({ dueDate: '2026-05-13' });

    const req = {
      params: { id: TASK_ID },
      user: { id: USER_ID, role: 'member', isSuperAdmin: false },
      body: { dueDate: '2026-05-13T00:00:00.000Z' },
    };
    const res = buildRes();

    await taskController.updateTask(req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
  });
});
