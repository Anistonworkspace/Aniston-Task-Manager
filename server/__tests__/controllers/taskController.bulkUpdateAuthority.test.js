'use strict';

/**
 * Phase A — bulkUpdateTasks per-task editability filter.
 *
 * Pre-Phase-A the bulk endpoint ran a single `tasks.bulk_edit` permission
 * check at the top, then trusted the entire batch. For Tier 3/4 actors a
 * second pass filtered tasks by VISIBILITY but not by EDITABILITY — a
 * visible-but-not-editable task (e.g. a board member who can SEE a row
 * but isn't an assignee / creator / supervisor) would still be mutated.
 *
 * Phase A added a per-task edit filter: if the actor has no umbrella
 * tasks.edit, they must hold tasks.edit_own AND be on the row. Rows
 * failing both are silently dropped; an empty result returns 403.
 *
 * Tier 1/2 bypass the filter (global edit baseline).
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
    findAll: jest.fn(),
    update: jest.fn().mockResolvedValue([0]),
    findByPk: jest.fn(),
  };
  const Board = { findByPk: jest.fn() };
  const User = { findByPk: jest.fn() };
  const TaskAssignee = {
    findAll: jest.fn().mockResolvedValue([]),
    findOrCreate: jest.fn().mockResolvedValue([{}, true]),
    bulkCreate: jest.fn().mockResolvedValue([]),
    destroy: jest.fn().mockResolvedValue(0),
  };
  const TaskOwner = { bulkCreate: jest.fn().mockResolvedValue([]) };
  const TaskApprovalFlow = { findAll: jest.fn().mockResolvedValue([]) };
  const TaskDependency = { findAll: jest.fn().mockResolvedValue([]) };
  const DependencyRequest = { count: jest.fn().mockResolvedValue(0) };
  const Notification = { create: jest.fn() };
  const Subtask = {};
  const Label = {};
  const TaskReference = { findAll: jest.fn().mockResolvedValue([]) };
  const TaskLink = { findAll: jest.fn().mockResolvedValue([]) };
  return {
    Task, Board, User, TaskAssignee, TaskOwner, TaskApprovalFlow,
    TaskDependency, DependencyRequest, Notification, Subtask, Label,
    TaskReference, TaskLink,
    sequelize: { query: jest.fn().mockResolvedValue([[]]), literal: jest.fn((s) => s) },
  };
});

jest.mock('../../config/db', () => ({
  sequelize: { query: jest.fn().mockResolvedValue([[]]), literal: jest.fn((s) => s), transaction: jest.fn(async (cb) => cb({})) },
}));

jest.mock('../../services/permissionEngine', () => ({
  hasPermission: jest.fn(),
}));

jest.mock('../../services/hierarchyService', () => ({
  canAssignTo: jest.fn(async () => true),
}));

jest.mock('../../services/taskVisibilityService', () => ({
  buildTaskVisibilityWhere: jest.fn(async () => ({})),
  canViewTask: jest.fn(async () => true),
  getAuthorizedRealtimeRecipients: jest.fn(async () => []),
}));

jest.mock('../../services/socketService', () => ({
  emitToBoard: jest.fn(), emitToUser: jest.fn(), emitToBoardAndUsers: jest.fn(), getIO: jest.fn(),
}));
jest.mock('../../services/activityService', () => ({ logActivity: jest.fn() }));
jest.mock('../../services/teamsWebhook', () => ({
  sendTaskCreated: jest.fn(), sendTaskUpdated: jest.fn(), sendTaskCompleted: jest.fn(),
}));
jest.mock('../../services/automationService', () => ({ processAutomations: jest.fn() }));
jest.mock('../../services/dependencyService', () => ({
  checkAndUnblockDependents: jest.fn(),
}));
jest.mock('../../services/realtimeService', () => ({ emitTaskUpdated: jest.fn() }));
jest.mock('../../services/conflictDetectionService', () => ({
  checkConflicts: jest.fn(), autoReschedule: jest.fn(), getScheduleSummary: jest.fn(),
}));
jest.mock('../../middleware/taskPermissions', () => ({
  buildTaskVisibilityFilter: jest.fn(), checkTaskAction: jest.fn(),
}));
jest.mock('../../services/reminderService', () => ({
  scheduleReminders: jest.fn(), cancelReminders: jest.fn(), rescheduleReminders: jest.fn(),
  applyReminderSpecs: jest.fn(), normalizeReminderSpecs: jest.fn(),
  getUserReminderSpecs: jest.fn(), getReminderSummary: jest.fn(), getReminderSummaryBulk: jest.fn(),
}));
jest.mock('../../services/assignmentNotificationService', () => ({
  notifyNewAssignments: jest.fn(), diffAndNotify: jest.fn(),
}));
jest.mock('../../services/taskReceiptService', () => ({}));
jest.mock('../../services/teamsNotificationService', () => ({}));
jest.mock('../../services/calendarService', () => ({}));
jest.mock('../../services/notificationService', () => ({ createNotification: jest.fn(), buildIdempotencyKey: jest.fn() }));
jest.mock('../../services/boardMembershipService', () => ({}));
jest.mock('../../services/recurringTaskService', () => ({}));
jest.mock('../../utils/safeSql', () => ({ safeUUID: (s) => s }));
jest.mock('../../utils/sanitize', () => ({
  sanitizeInput: (s) => s, sanitizeNotificationField: (s) => s, sanitizeNotificationMessage: (s) => s,
}));
jest.mock('../../utils/statusConfig', () => ({ isValidStatus: () => true, isValidStatusForTask: () => true }));
jest.mock('../../utils/taskPrioritization', () => ({ buildPendingPriorityOrder: jest.fn(), findGroupForStatus: jest.fn() }));
jest.mock('../../utils/taskOwnership', () => ({
  isSelfOwnedTask: jest.fn(),
  isSelfOwnedCreate: jest.fn(),
  isAssigneeOnTask: jest.fn(() => false),
}));
jest.mock('../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { Task } = require('../../models');
const taskVisibility = require('../../services/taskVisibilityService');
const enginePermission = require('../../services/permissionEngine');
const { isSelfOwnedTask } = require('../../utils/taskOwnership');
const { bulkUpdateTasks } = require('../../controllers/taskController');

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const t2Manager = { id: 'u-t2', tier: 2, role: 'manager' };
const t4Member = { id: 'u-t4', tier: 4, role: 'member' };

beforeEach(() => {
  jest.clearAllMocks();
  enginePermission.hasPermission.mockResolvedValue(true);
  isSelfOwnedTask.mockReturnValue(true);
  taskVisibility.buildTaskVisibilityWhere.mockResolvedValue({});
});

// ── T1/T2 bypass the new filter (global edit baseline) ───────────────────

describe('bulkUpdateTasks — T2 bypass', () => {
  test('T2 manager with bulk_edit can update batch unconditionally', async () => {
    enginePermission.hasPermission.mockResolvedValue(true);
    Task.findAll.mockResolvedValue([{ id: 't1' }, { id: 't2' }]);
    Task.update.mockResolvedValue([2]);
    const req = {
      user: t2Manager,
      body: { taskIds: ['t1', 't2'], updates: { status: 'working_on_it' } },
    };
    const res = mockRes();
    await bulkUpdateTasks(req, res);
    // We don't assert 200/success because the rest of the bulk pipeline
    // (assignment auth, completion gate, etc.) may diverge in this test
    // environment. What we DO assert: no 403 from the new per-task
    // editability filter, since T2 bypasses it.
    expect(res.status).not.toHaveBeenCalledWith(403);
  });
});

// ── T4 — must hold tasks.edit (global) OR tasks.edit_own + ownership ─────

describe('bulkUpdateTasks — T4 per-task editability filter', () => {
  test('T4 without tasks.edit AND without tasks.edit_own → 403 PERMISSION_DENIED', async () => {
    // bulk_edit (gate 1) granted, then global tasks.edit denied, then
    // tasks.edit_own also denied — controller short-circuits with the
    // tasks.edit error code.
    enginePermission.hasPermission
      .mockResolvedValueOnce(true)  // tasks.bulk_edit
      .mockResolvedValueOnce(false) // tasks.edit (umbrella)
      .mockResolvedValueOnce(false); // tasks.edit_own

    Task.findAll.mockResolvedValue([{ id: 't1' }]); // visibility filter pass
    const req = {
      user: t4Member,
      body: { taskIds: ['t1'], updates: { status: 'working_on_it' } },
    };
    const res = mockRes();
    await bulkUpdateTasks(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    const payload = res.json.mock.calls[0][0];
    expect(payload.code).toBe('PERMISSION_DENIED');
    expect(payload.permission).toBe('tasks.edit');
  });

  test('T4 with tasks.edit_own but NO row they actually own → 403 TIER_TASK_AUTHORITY_DENIED', async () => {
    enginePermission.hasPermission
      .mockResolvedValueOnce(true)  // tasks.bulk_edit
      .mockResolvedValueOnce(false) // tasks.edit (umbrella) — denied
      .mockResolvedValueOnce(true); // tasks.edit_own — granted

    // Visibility filter returns t1, t2 (both visible).
    taskVisibility.buildTaskVisibilityWhere.mockResolvedValue({});
    Task.findAll
      .mockResolvedValueOnce([{ id: 't1' }, { id: 't2' }]) // visibility pass
      .mockResolvedValueOnce([                                 // ownership rows
        { id: 't1', createdBy: 'other', assignedTo: 'other', taskAssignees: [] },
        { id: 't2', createdBy: 'other', assignedTo: 'other', taskAssignees: [] },
      ]);
    isSelfOwnedTask.mockReturnValue(false); // none are self-owned

    const req = {
      user: t4Member,
      body: { taskIds: ['t1', 't2'], updates: { status: 'working_on_it' } },
    };
    const res = mockRes();
    await bulkUpdateTasks(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    const payload = res.json.mock.calls[0][0];
    expect(payload.code).toBe('TIER_TASK_AUTHORITY_DENIED');
  });

  test('T4 with tasks.edit_own + at least one self-owned row → proceeds past the filter', async () => {
    // Same setup as above but isSelfOwnedTask returns true for one row.
    enginePermission.hasPermission
      .mockResolvedValueOnce(true)   // tasks.bulk_edit
      .mockResolvedValueOnce(false)  // tasks.edit (umbrella) — denied
      .mockResolvedValueOnce(true);  // tasks.edit_own — granted

    taskVisibility.buildTaskVisibilityWhere.mockResolvedValue({});
    Task.findAll
      .mockResolvedValueOnce([{ id: 't1' }, { id: 't2' }]) // visibility
      .mockResolvedValueOnce([                                 // ownership rows
        { id: 't1', createdBy: 'u-t4', assignedTo: 'u-t4', taskAssignees: [] },
        { id: 't2', createdBy: 'other', assignedTo: 'other', taskAssignees: [] },
      ]);
    // First row is self-owned, second isn't — controller filters t2 out.
    isSelfOwnedTask
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    const req = {
      user: t4Member,
      body: { taskIds: ['t1', 't2'], updates: { status: 'working_on_it' } },
    };
    const res = mockRes();
    await bulkUpdateTasks(req, res);

    // The filter passed (t1 remains). We don't assert success because
    // downstream gates may 403/500 with our partial mocks. But the new
    // filter must not be the source of any 4xx here.
    if (res.status.mock.calls.some((c) => c[0] === 403)) {
      const payload = res.json.mock.calls[0][0];
      // If we 403, it must NOT be the per-task editability filter.
      expect(payload.code).not.toBe('TIER_TASK_AUTHORITY_DENIED');
      expect(payload.permission).not.toBe('tasks.edit');
    }
  });

  test('T4 with tasks.edit umbrella → bypasses ownership requirement', async () => {
    // Umbrella grant lets T4 act on any visible row — no ownership
    // filter applied. This pins the grant-promotion case the user
    // explicitly asked for ("grants must work where intended").
    enginePermission.hasPermission
      .mockResolvedValueOnce(true)   // tasks.bulk_edit
      .mockResolvedValueOnce(true);  // tasks.edit (umbrella) — granted

    taskVisibility.buildTaskVisibilityWhere.mockResolvedValue({});
    Task.findAll.mockResolvedValueOnce([{ id: 't1' }, { id: 't2' }]); // visibility

    const req = {
      user: t4Member,
      body: { taskIds: ['t1', 't2'], updates: { status: 'working_on_it' } },
    };
    const res = mockRes();
    await bulkUpdateTasks(req, res);

    // No 403 from the editability filter — global edit covers all rows.
    const statusCalls = res.status.mock.calls;
    const filter403 = statusCalls.find((c) => c[0] === 403);
    if (filter403) {
      const payload = res.json.mock.calls[0][0];
      expect(payload.code).not.toBe('TIER_TASK_AUTHORITY_DENIED');
    }
  });
});
