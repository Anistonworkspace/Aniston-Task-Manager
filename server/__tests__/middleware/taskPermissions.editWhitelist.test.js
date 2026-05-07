'use strict';

/**
 * Regression tests for `checkTaskAction('edit', …)` field whitelists.
 *
 * Background: a member-creator was unable to self-assign their own task
 * because `assignedTo` was missing from the assignee/creator whitelist —
 * the field was silently dropped from the update payload. We added it
 * back, with the safety net of `checkAssignmentAuthority` and
 * `needsDueDateForAssignment` enforcing the actual rules downstream in
 * the controller.
 *
 * These tests pin the whitelist contents so a future refactor can't
 * regress this without also updating the test.
 */

jest.mock('../../utils/logger', () => ({
  warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('../../services/taskVisibilityService', () => ({
  // Default: not in subtree. Tests that need inSubtree=true mock
  // canViewTask explicitly.
  canViewTask: jest.fn().mockResolvedValue(false),
  buildVisibilityFilter: jest.fn(),
}));

const { checkTaskAction } = require('../../middleware/taskPermissions');
const visibility = require('../../services/taskVisibilityService');

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';

function makeTask(overrides = {}) {
  return {
    id: TASK_ID,
    assignedTo: null,
    createdBy: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  visibility.canViewTask.mockResolvedValue(false);
});

describe('checkTaskAction("edit") — assignee/creator whitelist', () => {
  it('member-creator gets allowedFields including assignedTo and dueDate, but NOT title', async () => {
    const user = { id: ME, role: 'member', isSuperAdmin: false };
    const task = makeTask({ createdBy: ME });
    const result = await checkTaskAction('edit', user, task, [], {});

    expect(result.allowed).toBe(true);
    expect(result.allowedFields).toEqual(expect.arrayContaining([
      'description', 'status', 'priority', 'progress',
      'dueDate', 'startDate', 'assignedTo',
    ]));
    // Title-lock: only Tier 1 may rename a task after creation. The
    // assignee/creator whitelist intentionally omits 'title' as the
    // defense-in-depth layer beneath the controller-level title gate.
    expect(result.allowedFields).not.toContain('title');
  });

  it('member-assignee (via task_assignees) gets the same whitelist with assignedTo', async () => {
    const user = { id: ME, role: 'member', isSuperAdmin: false };
    const task = makeTask({ createdBy: OTHER, assignedTo: null });
    const taskAssignees = [{ userId: ME, role: 'assignee' }];
    const result = await checkTaskAction('edit', user, task, taskAssignees, {});

    expect(result.allowed).toBe(true);
    expect(result.allowedFields).toEqual(expect.arrayContaining(['assignedTo', 'dueDate']));
  });

  it('member-assignee via legacy assignedTo field gets the whitelist', async () => {
    const user = { id: ME, role: 'member', isSuperAdmin: false };
    const task = makeTask({ createdBy: OTHER, assignedTo: ME });
    const result = await checkTaskAction('edit', user, task, [], {});

    expect(result.allowed).toBe(true);
    expect(result.allowedFields).toEqual(expect.arrayContaining(['assignedTo', 'dueDate']));
  });

  it('member with no link to the task is denied', async () => {
    const user = { id: ME, role: 'member', isSuperAdmin: false };
    const task = makeTask({ createdBy: OTHER, assignedTo: OTHER });
    const result = await checkTaskAction('edit', user, task, [], {});

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('no_edit_permission');
  });

  it('supervisor cannot edit fields (no whitelist entry)', async () => {
    const user = { id: ME, role: 'member', isSuperAdmin: false };
    const task = makeTask({ createdBy: OTHER, assignedTo: OTHER });
    const taskAssignees = [{ userId: ME, role: 'supervisor' }];
    const result = await checkTaskAction('edit', user, task, taskAssignees, {});

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('supervisor_read_only');
  });

  it('admin gets unrestricted edit (allowedFields = null)', async () => {
    const user = { id: ME, role: 'admin', isSuperAdmin: false };
    const task = makeTask({ createdBy: OTHER, assignedTo: OTHER });
    const result = await checkTaskAction('edit', user, task, [], {});

    expect(result.allowed).toBe(true);
    expect(result.allowedFields).toBeNull();
  });

  it('manager inside subtree gets unrestricted edit', async () => {
    visibility.canViewTask.mockResolvedValueOnce(true);
    const user = { id: ME, role: 'manager', isSuperAdmin: false };
    const task = makeTask({ createdBy: OTHER, assignedTo: OTHER });
    const result = await checkTaskAction('edit', user, task, [], {});

    expect(result.allowed).toBe(true);
    expect(result.allowedFields).toBeNull();
  });

  it('manager OUTSIDE subtree falls back to creator/assignee path (no edit if not linked)', async () => {
    visibility.canViewTask.mockResolvedValueOnce(false);
    const user = { id: ME, role: 'manager', isSuperAdmin: false };
    const task = makeTask({ createdBy: OTHER, assignedTo: OTHER });
    const result = await checkTaskAction('edit', user, task, [], {});

    expect(result.allowed).toBe(false);
  });
});
