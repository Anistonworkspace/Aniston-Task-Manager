'use strict';

/**
 * Unit tests for the task-ownership predicates used by the priority gate.
 *
 * The Tier 4 self-owned exemption (server/controllers/taskController.js
 * createTask + updateTask + bulkUpdateTasks) relies on these helpers to
 * decide whether a member-rank actor may set priority on a task without
 * holding the global `tasks.set_priority` permission. Pin the rules so
 * a future refactor can't silently re-tighten or over-permit.
 */

const { isSelfOwnedTask, isSelfOwnedCreate } = require('../../utils/taskOwnership');

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('isSelfOwnedTask', () => {
  it('returns true for a creator-and-sole-assignee row (the canonical case)', () => {
    const task = { createdBy: ME, assignedTo: ME, taskAssignees: [{ userId: ME, role: 'assignee' }] };
    expect(isSelfOwnedTask(ME, task)).toBe(true);
  });

  it('returns true when creator and no assignees (unassigned own task)', () => {
    const task = { createdBy: ME, assignedTo: null, taskAssignees: [] };
    expect(isSelfOwnedTask(ME, task)).toBe(true);
  });

  it('returns false when the creator is someone else (delegated to me)', () => {
    const task = { createdBy: OTHER, assignedTo: ME, taskAssignees: [{ userId: ME, role: 'assignee' }] };
    expect(isSelfOwnedTask(ME, task)).toBe(false);
  });

  it('returns false when assignedTo is someone else', () => {
    const task = { createdBy: ME, assignedTo: OTHER };
    expect(isSelfOwnedTask(ME, task)).toBe(false);
  });

  it('returns false when a foreign role=assignee row exists in taskAssignees', () => {
    const task = {
      createdBy: ME,
      assignedTo: ME,
      taskAssignees: [
        { userId: ME, role: 'assignee' },
        { userId: OTHER, role: 'assignee' },
      ],
    };
    expect(isSelfOwnedTask(ME, task)).toBe(false);
  });

  it('returns true when a foreign supervisor exists (supervisors are oversight, not ownership)', () => {
    const task = {
      createdBy: ME,
      assignedTo: ME,
      taskAssignees: [
        { userId: ME, role: 'assignee' },
        { userId: OTHER, role: 'supervisor' },
      ],
    };
    expect(isSelfOwnedTask(ME, task)).toBe(true);
  });

  it('uses the explicit taskAssignees argument over task.taskAssignees when both supplied', () => {
    const task = {
      createdBy: ME,
      assignedTo: ME,
      taskAssignees: [{ userId: OTHER, role: 'assignee' }], // would say no
    };
    // Explicit override says yes — the caller already has the freshest data.
    expect(isSelfOwnedTask(ME, task, [{ userId: ME, role: 'assignee' }])).toBe(true);
  });

  it('fails closed for missing arguments', () => {
    expect(isSelfOwnedTask(null, { createdBy: ME })).toBe(false);
    expect(isSelfOwnedTask(ME, null)).toBe(false);
    expect(isSelfOwnedTask(ME, {})).toBe(false); // no createdBy
  });

  it('handles assignedTo array shape (legacy multi-assignee carrier)', () => {
    expect(isSelfOwnedTask(ME, { createdBy: ME, assignedTo: [ME] })).toBe(true);
    expect(isSelfOwnedTask(ME, { createdBy: ME, assignedTo: [ME, OTHER] })).toBe(false);
    expect(isSelfOwnedTask(ME, { createdBy: ME, assignedTo: [] })).toBe(true);
  });
});

describe('isSelfOwnedCreate', () => {
  it('returns true when no assignees are supplied (quick-create / unassigned)', () => {
    expect(isSelfOwnedCreate(ME, [])).toBe(true);
    expect(isSelfOwnedCreate(ME, undefined)).toBe(true);
  });

  it('returns true when the only assignee is self', () => {
    expect(isSelfOwnedCreate(ME, [ME])).toBe(true);
  });

  it('returns false when any other user is in the assignee set', () => {
    expect(isSelfOwnedCreate(ME, [OTHER])).toBe(false);
    expect(isSelfOwnedCreate(ME, [ME, OTHER])).toBe(false);
  });

  it('fails closed when userId is missing', () => {
    expect(isSelfOwnedCreate(null, [])).toBe(false);
    expect(isSelfOwnedCreate(undefined, [ME])).toBe(false);
  });
});
