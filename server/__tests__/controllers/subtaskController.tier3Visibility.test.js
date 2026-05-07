'use strict';

/**
 * Regression tests for the Tier 3 (assistant_manager) modal access bug.
 *
 * Symptom: Tier 3 user could see a descendant's task on the board (the list
 * filter is hierarchy-aware) but opening the modal triggered a "You do not
 * have access to this task" toast because /subtasks?taskId=... returned 403.
 *
 * Root cause: `subtaskController.userCanAccessParentTask` only matched
 * direct linkage (assignedTo/createdBy/TaskAssignee/TaskOwner) and ignored
 * the hierarchy subtree that the canonical `taskVisibilityService` uses.
 *
 * Fix: the helper now delegates to `taskVisibility.canViewTask`, so the
 * subtask read rule is identical to the rule used by the board list query
 * and the task detail middleware.
 *
 * These tests pin the new behaviour:
 *   - Tier 3 with subtree visibility (canViewTask=true) gets 200.
 *   - Tier 3 without subtree visibility AND without a DependencyRequest
 *     read path gets 403.
 *   - The dependency-owner read path remains intact (canViewTask=false but
 *     a DependencyRequest row exists → 200).
 *   - Tier 1 / Tier 2 still bypass the per-task check via canViewTask
 *     short-circuit (defended by `taskVisibilityService` itself, but
 *     covered here as integration insurance).
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

// ─── Mocks ───────────────────────────────────────────────────────────────────

jest.mock('../../models', () => ({
  Subtask: {
    findAll: jest.fn().mockResolvedValue([]),
  },
  Task: {
    findByPk: jest.fn(),
  },
  User: {
    findByPk: jest.fn(),
  },
  DependencyRequest: {
    count: jest.fn().mockResolvedValue(0),
  },
}));

jest.mock('../../services/taskVisibilityService', () => ({
  canViewTask: jest.fn(),
}));

jest.mock('../../services/activityService', () => ({
  logActivity: jest.fn(),
}));

jest.mock('../../services/realtimeService', () => ({
  emitSubtaskChanged: jest.fn(),
}));

jest.mock('../../services/hierarchyService', () => ({
  canAssignTo: jest.fn().mockResolvedValue(true),
}));

// ─── Test app ────────────────────────────────────────────────────────────────

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { Task, User, DependencyRequest } = require('../../models');
const taskVisibility = require('../../services/taskVisibilityService');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/subtasks', require('../../routes/subtasks'));
  return app;
}

// ─── Constants ───────────────────────────────────────────────────────────────

// "shubhanshu" — Tier 3 manager
const SHUB_ID  = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
// "muskan"   — direct report of shubhanshu (in subtree)
const MUSK_ID  = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
// "stranger" — not in any chain
const STRG_ID  = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TASK_ID  = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function tokenFor(id, role = 'assistant_manager') {
  return jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function userRecord(overrides = {}) {
  return {
    id: SHUB_ID,
    name: 'Shubhanshu',
    email: 'shubhanshu@aniston.com',
    role: 'assistant_manager',
    isActive: true,
    isSuperAdmin: false,
    tier: 3,
    ...overrides,
  };
}

function taskRecord(overrides = {}) {
  return {
    id: TASK_ID,
    title: 'Muskan owns this',
    isArchived: false,
    assignedTo: MUSK_ID,
    createdBy: MUSK_ID,
    boardId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /api/subtasks — Tier 3 hierarchy visibility', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => {
    jest.clearAllMocks();
    User.findByPk.mockResolvedValue(userRecord());
    Task.findByPk.mockResolvedValue(taskRecord());
    DependencyRequest.count.mockResolvedValue(0);
  });

  it('returns 200 when canViewTask resolves true (subtree match)', async () => {
    // Shubhanshu IS Muskan's manager → visibility service approves.
    taskVisibility.canViewTask.mockResolvedValue(true);

    const res = await request(app)
      .get(`/api/subtasks?taskId=${TASK_ID}`)
      .set('Authorization', `Bearer ${tokenFor(SHUB_ID)}`);

    expect(res.status).toBe(200);
    expect(taskVisibility.canViewTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: SHUB_ID, tier: 3 }),
      expect.objectContaining({ id: TASK_ID })
    );
    // Dependency fallback should NOT be consulted on the happy path.
    expect(DependencyRequest.count).not.toHaveBeenCalled();
  });

  it('returns 403 when canViewTask is false AND no dependency request links the user', async () => {
    // Stranger task with no dep relation.
    taskVisibility.canViewTask.mockResolvedValue(false);
    DependencyRequest.count.mockResolvedValue(0);
    Task.findByPk.mockResolvedValue(taskRecord({ assignedTo: STRG_ID, createdBy: STRG_ID }));

    const res = await request(app)
      .get(`/api/subtasks?taskId=${TASK_ID}`)
      .set('Authorization', `Bearer ${tokenFor(SHUB_ID)}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual(expect.objectContaining({
      success: false,
      message: 'You do not have access to this task.',
    }));
  });

  it('returns 200 via the dependency-owner read path when canViewTask is false but a DependencyRequest links the user', async () => {
    // Visibility says no, but the user is assigned to a child dependency on
    // this parent — opening "Parent" from the Dependencies page must work.
    taskVisibility.canViewTask.mockResolvedValue(false);
    DependencyRequest.count.mockResolvedValue(1);
    Task.findByPk.mockResolvedValue(taskRecord({ assignedTo: STRG_ID, createdBy: STRG_ID }));

    const res = await request(app)
      .get(`/api/subtasks?taskId=${TASK_ID}`)
      .set('Authorization', `Bearer ${tokenFor(SHUB_ID)}`);

    expect(res.status).toBe(200);
    expect(DependencyRequest.count).toHaveBeenCalledWith(expect.objectContaining({
      where: { parentTaskId: TASK_ID, assignedToUserId: SHUB_ID },
    }));
  });

  it('Tier 1 super-admin passes via canViewTask short-circuit', async () => {
    User.findByPk.mockResolvedValue(userRecord({
      role: 'admin', tier: 1, isSuperAdmin: true,
    }));
    // `canViewTask` itself short-circuits true for tier 1; the helper just
    // forwards the answer.
    taskVisibility.canViewTask.mockResolvedValue(true);

    const res = await request(app)
      .get(`/api/subtasks?taskId=${TASK_ID}`)
      .set('Authorization', `Bearer ${tokenFor(SHUB_ID, 'admin')}`);

    expect(res.status).toBe(200);
  });
});
