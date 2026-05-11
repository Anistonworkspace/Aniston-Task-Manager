'use strict';

/**
 * Tier 2 edit-parity tests for `taskController.updateTask`.
 *
 * Background: even after the first round of tier-based fixes (the Tier 1/2
 * short-circuit in checkTaskAction, the due-date lock, the canEditAllFields
 * tightening), Tier 2 still couldn't edit two specific surfaces:
 *
 *   1. TITLE — the title-lock gate was hard-coded to "Tier 1 only".
 *   2. ARCHIVE on cross-team tasks — the `isAdminLike` scope check used
 *      `req.user.role === 'admin'`, so a Tier 2 with role='manager' fell
 *      through to the subtree fallback and 403'd on tasks outside their
 *      org subtree.
 *
 * These tests pin the corrected behaviour so we can't regress to the
 * asymmetric state where Tier 2 admin and Tier 2 manager behaved
 * differently.
 *
 * Test approach: mirrors the mock surface used by
 * `taskController.selfAssignDueDate.test.js` and
 * `taskController.dueDateLock.test.js` — mocks the heavy services so the
 * gate logic runs without a real DB.
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
  // The Tier 2 short-circuit is itself one of the things we want to lean
  // on — but to focus this test on the OTHER gates (title-lock,
  // archive-scope), we stub the middleware to "allowed: full edit". The
  // assertions below then exercise the controller-level gates that ran
  // AFTER the middleware decision.
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
const OTHER_ID = '99999999-9999-4999-8999-999999999999';

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
    assignedTo: OTHER_ID,
    createdBy: OTHER_ID,
    isArchived: false,
    completedAt: null,
    statusConfig: null,
    customFields: null,
    tags: [],
    approvalStatus: null,
    board: { id: BOARD_ID, name: 'B', columns: [], groups: [] },
    creator: { id: OTHER_ID, role: 'member' },
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

describe('updateTask — Tier 2 may rename a task (title-lock loosened from Tier 1 to Tier 1+2)', () => {
  it('Tier 2 manager (role=manager) CAN rename a task they did not create', async () => {
    configureTask({ title: 'Old title', createdBy: OTHER_ID, assignedTo: OTHER_ID });

    const req = {
      params: { id: TASK_ID },
      user: { id: USER_ID, role: 'manager', isSuperAdmin: false, tier: 2 },
      body: { title: 'New title' },
    };
    const res = buildRes();

    await taskController.updateTask(req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('Tier 2 admin (role=admin) CAN rename — same behavior as manager (parity)', async () => {
    configureTask({ title: 'Old title', createdBy: OTHER_ID, assignedTo: OTHER_ID });

    const req = {
      params: { id: TASK_ID },
      user: { id: USER_ID, role: 'admin', isSuperAdmin: false, tier: 2 },
      body: { title: 'New title' },
    };
    const res = buildRes();

    await taskController.updateTask(req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('Tier 1 (Super Admin) CAN rename — unchanged', async () => {
    configureTask({ title: 'Old title', createdBy: OTHER_ID, assignedTo: OTHER_ID });

    const req = {
      params: { id: TASK_ID },
      user: { id: USER_ID, role: 'admin', isSuperAdmin: true, tier: 1 },
      body: { title: 'New title' },
    };
    const res = buildRes();

    await taskController.updateTask(req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('Tier 3 (assistant_manager) is BLOCKED with 403 + title_locked', async () => {
    configureTask({ title: 'Old title', createdBy: USER_ID, assignedTo: USER_ID });

    const req = {
      params: { id: TASK_ID },
      user: { id: USER_ID, role: 'assistant_manager', isSuperAdmin: false, tier: 3 },
      body: { title: 'New title' },
    };
    const res = buildRes();

    await taskController.updateTask(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'title_locked' }),
    );
  });

  it('Tier 4 (member) is BLOCKED with 403 + title_locked', async () => {
    configureTask({ title: 'Old title', createdBy: USER_ID, assignedTo: USER_ID });

    const req = {
      params: { id: TASK_ID },
      user: { id: USER_ID, role: 'member', isSuperAdmin: false, tier: 4 },
      body: { title: 'New title' },
    };
    const res = buildRes();

    await taskController.updateTask(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'title_locked' }),
    );
  });

  it('Tier 4 no-op title resend (same as existing) does NOT 403', async () => {
    // Optimistic clients that echo title back in PATCH-style payloads must
    // not 403 spuriously.
    configureTask({ title: 'Same title', createdBy: USER_ID, assignedTo: USER_ID });

    const req = {
      params: { id: TASK_ID },
      user: { id: USER_ID, role: 'member', isSuperAdmin: false, tier: 4 },
      body: { title: 'Same title' },
    };
    const res = buildRes();

    await taskController.updateTask(req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
  });
});

describe('updateTask — Tier 2 manager archive scope (parity with Tier 2 admin)', () => {
  // The archive gate previously used `req.user.role === 'admin'` as the
  // "unrestricted scope" check, which excluded role='manager'. That meant
  // a Tier 2 manager attempting to archive a cross-team task (outside
  // their subtree, not their own) got 403, while a Tier 2 admin in the
  // same position got 200. Both must now resolve to 200 for parity.

  it('Tier 2 manager CAN archive a task created and assigned to someone else (cross-team)', async () => {
    configureTask({
      isArchived: false,
      createdBy: OTHER_ID,
      assignedTo: OTHER_ID,
      taskAssignees: [],
    });

    const req = {
      params: { id: TASK_ID },
      // Crucially: NOT in subtree (req._taskInSubtree falsy) AND NOT the
      // assignee/creator AND NOT in task_assignees — relies entirely on the
      // tier-based "isAdminLike" branch.
      user: { id: USER_ID, role: 'manager', isSuperAdmin: false, tier: 2 },
      body: { isArchived: true },
    };
    const res = buildRes();

    await taskController.updateTask(req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('Tier 2 admin gets the same archive-scope answer (sanity)', async () => {
    configureTask({
      isArchived: false,
      createdBy: OTHER_ID,
      assignedTo: OTHER_ID,
      taskAssignees: [],
    });

    const req = {
      params: { id: TASK_ID },
      user: { id: USER_ID, role: 'admin', isSuperAdmin: false, tier: 2 },
      body: { isArchived: true },
    };
    const res = buildRes();

    await taskController.updateTask(req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('Tier 4 (member) still cannot archive a task they have no link to', async () => {
    configureTask({
      isArchived: false,
      createdBy: OTHER_ID,
      assignedTo: OTHER_ID,
      taskAssignees: [],
    });

    const req = {
      params: { id: TASK_ID },
      user: { id: USER_ID, role: 'member', isSuperAdmin: false, tier: 4 },
      body: { isArchived: true },
    };
    const res = buildRes();

    await taskController.updateTask(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});
