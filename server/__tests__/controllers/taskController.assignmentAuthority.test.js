'use strict';

/**
 * Phase A — checkAssignmentAuthority task-object precheck.
 *
 * Background: pre-Phase-A, the helper only validated who the actor was
 * trying to assign tasks TO (target hierarchy + tasks.assign_self /
 * tasks.assign_others). It never asked whether the actor had edit
 * authority over the SOURCE task. That meant a Tier 3/4 user with a
 * granular `tasks.assign_others` grant could reassign tasks they had no
 * other right to mutate — the grant only covered the action verb, not
 * the object.
 *
 * Phase A added an `opts.task` parameter that injects the source-task
 * authority check:
 *   • T1 / T2 / super_admin → bypass (global edit baseline)
 *   • T3 / T4 → must have either tasks.edit (umbrella) OR be linked to
 *               the task (assignee / supervisor / owner / creator) AND
 *               hold tasks.edit_own.
 *
 * This suite hits the helper directly via module.exports._test so the
 * gate is pinned without dragging in the full updateTask handler.
 */

jest.mock('../../models', () => ({
  Task: {},
  Board: {},
  User: {},
  Notification: {},
  Subtask: {},
  Label: {},
  TaskOwner: {},
  TaskAssignee: {},
  TaskDependency: {},
  TaskApprovalFlow: {},
  DependencyRequest: {},
  TaskReference: {},
  TaskLink: {},
}));

jest.mock('../../config/db', () => ({
  sequelize: { query: jest.fn(), literal: jest.fn((s) => s), transaction: jest.fn(async (cb) => cb({})) },
}));

jest.mock('../../services/permissionEngine', () => ({
  hasPermission: jest.fn(),
}));

jest.mock('../../services/hierarchyService', () => ({
  canAssignTo: jest.fn(async () => true),
}));

jest.mock('../../services/socketService', () => ({
  emitToBoard: jest.fn(),
  emitToUser: jest.fn(),
  emitToBoardAndUsers: jest.fn(),
  getIO: jest.fn(),
}));
jest.mock('../../services/activityService', () => ({ logActivity: jest.fn() }));
jest.mock('../../services/teamsWebhook', () => ({
  sendTaskCreated: jest.fn(), sendTaskUpdated: jest.fn(), sendTaskCompleted: jest.fn(),
}));
jest.mock('../../services/automationService', () => ({ processAutomations: jest.fn() }));
jest.mock('../../services/dependencyService', () => ({}));
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
jest.mock('../../utils/taskOwnership', () => ({ isSelfOwnedTask: jest.fn(), isSelfOwnedCreate: jest.fn(), isAssigneeOnTask: jest.fn(() => false) }));
jest.mock('../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('express-validator', () => ({
  body: () => ({ trim: () => ({ notEmpty: () => ({ withMessage: () => ({}) }) }) }),
  validationResult: jest.fn(() => ({ isEmpty: () => true, array: () => [] })),
}));

const enginePermission = require('../../services/permissionEngine');
const hierarchyService = require('../../services/hierarchyService');
const { _test } = require('../../controllers/taskController');
const { checkAssignmentAuthority } = _test;

beforeEach(() => {
  jest.clearAllMocks();
  enginePermission.hasPermission.mockResolvedValue(true);
  hierarchyService.canAssignTo.mockResolvedValue(true);
});

const t1Super = { id: 'u-t1', tier: 1, isSuperAdmin: true, role: 'admin' };
const t2Manager = { id: 'u-t2', tier: 2, role: 'manager' };
const t3Asst = { id: 'u-t3', tier: 3, role: 'assistant_manager' };
const t4Member = { id: 'u-t4', tier: 4, role: 'member' };

// A task the T3/T4 actor is NOT linked to (no assignee/owner/creator match).
const strangerTask = (overrides = {}) => ({
  id: 't-stranger',
  assignedTo: 'someone-else',
  createdBy: 'someone-else',
  taskAssignees: [],
  taskOwners: [],
  ...overrides,
});

// A task the actor IS linked to.
const linkedTask = (userId, overrides = {}) => ({
  id: 't-own',
  assignedTo: userId,
  createdBy: 'someone-else',
  taskAssignees: [],
  taskOwners: [],
  ...overrides,
});

// ── No task supplied — gate is a no-op (pre-Phase-A backwards compat) ────

describe('checkAssignmentAuthority — no task supplied (pre-Phase-A behaviour)', () => {
  test('T4 self-assign passes when assign_self is allowed', async () => {
    enginePermission.hasPermission.mockResolvedValue(true);
    const result = await checkAssignmentAuthority(t4Member, [t4Member.id]);
    expect(result.allowed).toBe(true);
  });

  test('T4 cross-assign 403s when assign_others is denied', async () => {
    enginePermission.hasPermission.mockResolvedValue(false); // assign_others denied
    const result = await checkAssignmentAuthority(t4Member, ['some-other-user']);
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('PERMISSION_DENIED');
    expect(result.permission).toBe('tasks.assign_others');
  });
});

// ── Phase A object authority precheck — T1/T2 bypass ──────────────────────

describe('checkAssignmentAuthority — T1/T2 bypass object precheck', () => {
  test('super_admin can reassign a stranger task', async () => {
    enginePermission.hasPermission.mockResolvedValue(true);
    const result = await checkAssignmentAuthority(t1Super, ['target'], { task: strangerTask() });
    expect(result.allowed).toBe(true);
  });

  test('T2 manager can reassign a stranger task', async () => {
    enginePermission.hasPermission.mockResolvedValue(true);
    const result = await checkAssignmentAuthority(t2Manager, ['target'], { task: strangerTask() });
    expect(result.allowed).toBe(true);
  });
});

// ── Phase A — T3/T4 are blocked on stranger tasks even with assign grants ──

describe('checkAssignmentAuthority — Phase A object precheck blocks T3/T4 on stranger tasks', () => {
  test('T4 with tasks.assign_others grant but NOT linked to task → 403 (TASK_AUTHORITY_REQUIRED)', async () => {
    // hasPermission returns false for tasks.edit (no global edit) and
    // false for tasks.edit_own (so we'd fail even if linked). But the
    // first failure is the linkage check itself — strangerTask has no
    // match for u-t4.
    enginePermission.hasPermission
      .mockResolvedValueOnce(false) // tasks.edit (object precheck) — global edit denied
      // Linkage check fails before we even ask tasks.edit_own; if linkage
      // had passed, the next call would be tasks.edit_own — also denied.
      .mockResolvedValueOnce(false);

    const result = await checkAssignmentAuthority(t4Member, ['target'], { task: strangerTask() });
    expect(result.allowed).toBe(false);
    expect(result.status).toBe(403);
    expect(result.code).toBe('TASK_AUTHORITY_REQUIRED');
  });

  test('T3 with tasks.assign_others grant but NOT linked to task → 403', async () => {
    enginePermission.hasPermission.mockResolvedValue(false);
    const result = await checkAssignmentAuthority(t3Asst, ['target'], { task: strangerTask() });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('TASK_AUTHORITY_REQUIRED');
  });

  test('T4 with global tasks.edit grant → passes object precheck (proceeds to verb check)', async () => {
    // First hasPermission call (object precheck — tasks.edit) returns true,
    // skipping the linkage check. Then assign_self / assign_others is checked.
    enginePermission.hasPermission
      .mockResolvedValueOnce(true)  // tasks.edit (umbrella) — granted
      .mockResolvedValueOnce(true); // tasks.assign_self — granted

    const result = await checkAssignmentAuthority(t4Member, [t4Member.id], { task: strangerTask() });
    expect(result.allowed).toBe(true);
  });

  test('T4 LINKED to task (assignee) and holding tasks.edit_own → passes', async () => {
    // tasks.edit (umbrella) is denied, but linkage matches (assignedTo),
    // and tasks.edit_own is granted. Then assign_self is also granted.
    enginePermission.hasPermission
      .mockResolvedValueOnce(false) // tasks.edit — denied
      .mockResolvedValueOnce(true)  // tasks.edit_own — granted
      .mockResolvedValueOnce(true); // tasks.assign_self — granted

    const task = linkedTask(t4Member.id);
    const result = await checkAssignmentAuthority(t4Member, [t4Member.id], { task });
    expect(result.allowed).toBe(true);
  });

  test('T4 LINKED to task via taskAssignees junction → passes', async () => {
    enginePermission.hasPermission
      .mockResolvedValueOnce(false) // tasks.edit — denied
      .mockResolvedValueOnce(true)  // tasks.edit_own — granted
      .mockResolvedValueOnce(true); // assign_self

    const task = strangerTask({
      taskAssignees: [{ userId: t4Member.id, role: 'assignee' }],
    });
    const result = await checkAssignmentAuthority(t4Member, [t4Member.id], { task });
    expect(result.allowed).toBe(true);
  });

  test('T4 LINKED but tasks.edit_own denied → 403 (PERMISSION_DENIED on tasks.edit_own)', async () => {
    enginePermission.hasPermission
      .mockResolvedValueOnce(false) // tasks.edit — denied
      .mockResolvedValueOnce(false); // tasks.edit_own — denied too

    const task = linkedTask(t4Member.id);
    const result = await checkAssignmentAuthority(t4Member, [t4Member.id], { task });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('PERMISSION_DENIED');
    expect(result.permission).toBe('tasks.edit_own');
  });
});

// ── Object precheck precedes the action-verb check (precise error codes) ──

describe('checkAssignmentAuthority — error precedence', () => {
  test('object precheck fires BEFORE assign_self / assign_others check', async () => {
    // If the precheck didn't run, the next call would be the
    // assign_others/assign_self verb check. We assert the response code
    // is the object-precheck code, not the verb-permission code, so the
    // UI can route the user to a different remediation path
    // ("you need access to the task" vs "you need a grant").
    enginePermission.hasPermission.mockResolvedValue(false);

    const result = await checkAssignmentAuthority(t4Member, ['target'], { task: strangerTask() });
    expect(result.code).toBe('TASK_AUTHORITY_REQUIRED');
    // Not PERMISSION_DENIED for tasks.assign_others — that comes second.
  });
});
