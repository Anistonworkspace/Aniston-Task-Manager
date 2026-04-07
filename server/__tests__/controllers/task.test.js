'use strict';

/**
 * Integration tests for the task API endpoints.
 *
 * The real task routes and controller are used.  All Sequelize models,
 * external services, and socket events are mocked so no database is needed.
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

// ─── Mocks ───────────────────────────────────────────────────────────────────

jest.mock('../../models', () => {
  const mockTask = {
    findAll: jest.fn(),
    findByPk: jest.fn(),
    create: jest.fn(),
    max: jest.fn(),
  };
  return {
    Task: mockTask,
    Board: { findByPk: jest.fn() },
    User: { findByPk: jest.fn() },
    Subtask: {},
    Notification: { create: jest.fn() },
    TaskOwner: { destroy: jest.fn(), bulkCreate: jest.fn(), findAll: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue(null), findOrCreate: jest.fn().mockResolvedValue([{}, true]) },
    Label: {},
    sequelize: { query: jest.fn(), literal: jest.fn((sql) => ({ val: sql })) },
  };
});

jest.mock('../../services/socketService', () => ({
  emitToBoard: jest.fn(),
  emitToUser: jest.fn(),
  getIO: jest.fn(() => ({ emit: jest.fn() })),
}));

jest.mock('../../services/activityService', () => ({
  logActivity: jest.fn(),
}));

jest.mock('../../services/teamsWebhook', () => ({
  sendTaskCreated: jest.fn(),
  sendTaskUpdated: jest.fn(),
  sendTaskCompleted: jest.fn(),
}));

jest.mock('../../services/automationService', () => ({
  processAutomations: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../services/dependencyService', () => ({
  checkAndUnblockDependents: jest.fn().mockResolvedValue(null),
  processTaskCompletion: jest.fn().mockResolvedValue(null),
  isTaskBlocked: jest.fn().mockResolvedValue(false),
}));

jest.mock('../../services/calendarService', () => ({
  createTaskEvent: jest.fn().mockResolvedValue(null),
  updateTaskEvent: jest.fn().mockResolvedValue(null),
  deleteTaskEvent: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../controllers/dependencyController', () => ({
  getCrossTeamDependencies: jest.fn((_req, res) => res.json({ success: true, data: [] })),
}));

jest.mock('../../utils/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
}));

jest.mock('../../utils/archiveHelpers', () => ({
  canPermanentlyDelete: jest.fn(() => ({ allowed: true, daysRemaining: 0 })),
}));

// ─── Build test app ──────────────────────────────────────────────────────────

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { Task, Board, User, Notification } = require('../../models');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', require('../../routes/tasks'));
  return app;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Use proper v4-style UUIDs (isUUID validator rejects all-same-char patterns)
const BOARD_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const TASK_ID  = 'b1efcd88-0d1c-4ea9-bc7e-7ac0ce491b22';
const USER_ID  = 'c2a0de11-1e2d-4ef0-dd8f-8dd1df502c33';
const OTHER_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

function generateToken(userId, role = 'member') {
  return jwt.sign({ id: userId, role }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function makeUserRecord(overrides = {}) {
  return {
    id: USER_ID,
    name: 'Test User',
    email: 'test@aniston.com',
    role: 'member',
    isActive: true,
    accountStatus: 'approved',
    authProvider: 'local',
    ...overrides,
  };
}

function makeBoardRecord(overrides = {}) {
  return {
    id: BOARD_ID,
    name: 'Test Board',
    addMember: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function makeTaskRecord(overrides = {}) {
  const base = {
    id: TASK_ID,
    title: 'Test Task',
    status: 'not_started',
    priority: 'medium',
    boardId: BOARD_ID,
    assignedTo: USER_ID,
    createdBy: USER_ID,
    groupId: 'group-1',
    position: 1,
    isArchived: false,
    teamsEventId: null,
    owners: [],
    board: { id: BOARD_ID, name: 'Test Board' },
    update: jest.fn().mockResolvedValue(true),
    reload: jest.fn().mockResolvedValue(true),
    destroy: jest.fn().mockResolvedValue(true),
  };
  const merged = { ...base, ...overrides };
  merged.toJSON = jest.fn().mockReturnValue({ ...merged });
  return merged;
}

// ─── GET /api/tasks ───────────────────────────────────────────────────────────

describe('GET /api/tasks', () => {
  let app;
  const token = generateToken(USER_ID, 'manager');

  beforeAll(() => { app = buildApp(); });
  beforeEach(() => {
    jest.clearAllMocks();
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'manager' }));
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(401);
  });

  it('returns 200 with tasks array for a valid boardId', async () => {
    const t1 = makeTaskRecord();
    const t2 = makeTaskRecord({ id: 'e4c2ff33-3g4f-4gh2-ff01-0ff3fh724e55', title: 'Task 2' });
    // getTasks calls toJSON + maps subtasks
    [t1, t2].forEach(t => {
      t.subtasks = [];
      t.toJSON = jest.fn().mockReturnValue({ ...t, subtasks: [] });
    });
    Task.findAll.mockResolvedValue([t1, t2]);

    const res = await request(app)
      .get(`/api/tasks?boardId=${BOARD_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.tasks)).toBe(true);
    expect(res.body.data.tasks).toHaveLength(2);
  });

  it('returns an empty array when there are no tasks for the board', async () => {
    Task.findAll.mockResolvedValue([]);

    const res = await request(app)
      .get(`/api/tasks?boardId=${BOARD_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.tasks).toHaveLength(0);
  });

  it('passes "me" shorthand as a filter for the current user', async () => {
    Task.findAll.mockResolvedValue([]);

    await request(app)
      .get('/api/tasks?assignedTo=me')
      .set('Authorization', `Bearer ${token}`);

    // The controller applies ownership visibility filtering via Op.and/Op.or (Symbols not serializable via JSON)
    expect(Task.findAll).toHaveBeenCalledTimes(1);
    const callArgs = Task.findAll.mock.calls[0][0];
    // Deep inspect: the where should have Op.and with Op.or containing assignedTo
    const andKey = Object.getOwnPropertySymbols(callArgs.where).find(s => s.toString().includes('and'));
    expect(andKey).toBeDefined();
    const andArr = callArgs.where[andKey];
    expect(andArr.length).toBeGreaterThan(0);
    // One of the Op.or entries should reference the user ID
    const orKey = Object.getOwnPropertySymbols(andArr[0]).find(s => s.toString().includes('or'));
    expect(orKey).toBeDefined();
    const orArr = andArr[0][orKey];
    expect(orArr[0]).toEqual({ assignedTo: USER_ID });
  });
});

// ─── POST /api/tasks ──────────────────────────────────────────────────────────

describe('POST /api/tasks', () => {
  let app;

  beforeAll(() => { app = buildApp(); });
  beforeEach(() => jest.clearAllMocks());

  function setupManagerUser() {
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'manager' }));
  }

  it('returns 401 without a token', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'New Task', boardId: BOARD_ID });

    expect(res.status).toBe(401);
  });

  it('returns 400 when title is missing', async () => {
    setupManagerUser();
    const token = generateToken(USER_ID, 'manager');

    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ boardId: BOARD_ID });

    expect(res.status).toBe(400);
    expect(res.body.errors).toBeDefined();
  });

  it('returns 400 when boardId is missing', async () => {
    setupManagerUser();
    const token = generateToken(USER_ID, 'manager');

    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'New Task' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when boardId is not a valid UUID', async () => {
    setupManagerUser();
    const token = generateToken(USER_ID, 'manager');

    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'New Task', boardId: 'not-a-uuid' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when status value is invalid', async () => {
    setupManagerUser();
    const token = generateToken(USER_ID, 'manager');

    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'New Task', boardId: BOARD_ID, status: 'bad_status' });

    expect(res.status).toBe(400);
  });

  it('returns 404 when the board does not exist', async () => {
    setupManagerUser();
    Board.findByPk.mockResolvedValue(null);
    Task.max.mockResolvedValue(0);
    const token = generateToken(USER_ID, 'manager');

    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'New Task', boardId: BOARD_ID });

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/Board not found/i);
  });

  it('returns 201 when a manager creates a valid task', async () => {
    setupManagerUser();
    Board.findByPk.mockResolvedValue(makeBoardRecord());
    Task.max.mockResolvedValue(5);
    const createdTask = makeTaskRecord({ title: 'New Task' });
    Task.create.mockResolvedValue(createdTask);
    Task.findByPk.mockResolvedValue({
      ...createdTask,
      assignee: { id: USER_ID, name: 'Test User' },
      creator: { id: USER_ID, name: 'Test User' },
      board: { id: BOARD_ID, name: 'Test Board' },
      toJSON: jest.fn().mockReturnValue({ id: TASK_ID, title: 'New Task' }),
    });

    const token = generateToken(USER_ID, 'manager');

    const res = await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'New Task', boardId: BOARD_ID, status: 'not_started', priority: 'high' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('task');
  });

  it('forces member role to assign the task to themselves only', async () => {
    // authenticate call (1), then no additional User.findByPk in createTask
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'member' }));
    Board.findByPk.mockResolvedValue(makeBoardRecord());
    Task.max.mockResolvedValue(0);

    const createdTask = makeTaskRecord({ assignedTo: USER_ID });
    Task.create.mockResolvedValue(createdTask);
    Task.findByPk.mockResolvedValue({
      ...createdTask,
      toJSON: jest.fn().mockReturnValue({ id: TASK_ID, assignedTo: USER_ID }),
    });

    const token = generateToken(USER_ID, 'member');

    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'My Task', boardId: BOARD_ID });

    // The controller must override assignedTo with the current user's id
    expect(Task.create).toHaveBeenCalledWith(
      expect.objectContaining({ assignedTo: USER_ID })
    );
  });

  it('creates a task notification for the assignee when assigned by someone else', async () => {
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'manager' }));
    Board.findByPk.mockResolvedValue(makeBoardRecord());
    Task.max.mockResolvedValue(0);

    const createdTask = makeTaskRecord({ assignedTo: OTHER_ID });
    Task.create.mockResolvedValue(createdTask);
    Task.findByPk.mockResolvedValue({
      ...createdTask,
      assignee: { id: OTHER_ID, name: 'Other User' },
      creator: { id: USER_ID, name: 'Test User' },
      board: { id: BOARD_ID, name: 'Test Board' },
      toJSON: jest.fn().mockReturnValue({ id: TASK_ID }),
    });

    const token = generateToken(USER_ID, 'manager');

    await request(app)
      .post('/api/tasks')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'New Task', boardId: BOARD_ID, assignedTo: OTHER_ID });

    expect(Notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'task_assigned', userId: OTHER_ID })
    );
  });
});

// ─── PUT /api/tasks/:id ───────────────────────────────────────────────────────

describe('PUT /api/tasks/:id', () => {
  let app;

  beforeAll(() => { app = buildApp(); });
  beforeEach(() => jest.clearAllMocks());

  it('returns 404 when the task does not exist', async () => {
    // authenticate (1), then updateTask loads task -> null
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'admin' }));
    Task.findByPk.mockResolvedValue(null);
    const token = generateToken(USER_ID, 'admin');

    const res = await request(app)
      .put(`/api/tasks/${TASK_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'done' });

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/Task not found/i);
  });

  it('returns 403 when a member tries to update a task assigned to someone else', async () => {
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'member', id: USER_ID }));
    Task.findByPk.mockResolvedValue(makeTaskRecord({ assignedTo: OTHER_ID }));

    const token = generateToken(USER_ID, 'member');

    const res = await request(app)
      .put(`/api/tasks/${TASK_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'done' });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/assigned to you/i);
  });

  it('returns 200 when a member updates the status on their own task', async () => {
    const memberUser = makeUserRecord({ role: 'member', id: USER_ID });
    // authenticate -> member user (User.findByPk call #1)
    User.findByPk.mockResolvedValueOnce(memberUser);

    const existingTask = makeTaskRecord({ assignedTo: USER_ID, createdBy: USER_ID });
    const updatedTaskJson = { id: TASK_ID, status: 'done' };

    // For member path: no creator lookup (no User.findByPk call from controller).
    // Task.findByPk calls: initial load + fullTask reload.
    Task.findByPk
      .mockResolvedValueOnce(existingTask)    // initial task load
      .mockResolvedValueOnce({               // fullTask after update
        ...existingTask,
        status: 'done',
        assignee: null,
        creator: null,
        board: { id: BOARD_ID, name: 'Test Board' },
        toJSON: jest.fn().mockReturnValue(updatedTaskJson),
      });

    const token = generateToken(USER_ID, 'member');

    const res = await request(app)
      .put(`/api/tasks/${TASK_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'done' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(existingTask.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'done' })
    );
  });

  it('returns 400 when status value is invalid', async () => {
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'admin' }));
    const token = generateToken(USER_ID, 'admin');

    const res = await request(app)
      .put(`/api/tasks/${TASK_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'invalid_status_value' });

    expect(res.status).toBe(400);
  });

  it('returns 200 when an admin updates any task field', async () => {
    const adminUser = makeUserRecord({ role: 'admin' });
    // authenticate
    User.findByPk.mockResolvedValueOnce(adminUser);

    const existingTask = makeTaskRecord({ assignedTo: OTHER_ID });
    const updatedTaskJson = { id: TASK_ID, priority: 'critical' };

    Task.findByPk
      .mockResolvedValueOnce(existingTask)  // initial task load
      .mockResolvedValueOnce({             // fullTask after update
        ...existingTask,
        priority: 'critical',
        toJSON: jest.fn().mockReturnValue(updatedTaskJson),
      });

    const token = generateToken(USER_ID, 'admin');

    const res = await request(app)
      .put(`/api/tasks/${TASK_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ priority: 'critical' });

    expect(res.status).toBe(200);
    expect(existingTask.update).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 'critical' })
    );
  });

  it('returns 200 when a manager updates a task they created', async () => {
    const managerUser = makeUserRecord({ role: 'manager', id: USER_ID });
    // authenticate
    User.findByPk
      .mockResolvedValueOnce(managerUser)                       // authenticate
      .mockResolvedValueOnce({ id: USER_ID, role: 'manager' }); // creator lookup

    const existingTask = makeTaskRecord({ assignedTo: OTHER_ID, createdBy: USER_ID });
    const updatedTaskJson = { id: TASK_ID, title: 'Renamed Task' };

    Task.findByPk
      .mockResolvedValueOnce(existingTask)
      .mockResolvedValueOnce({
        ...existingTask,
        title: 'Renamed Task',
        toJSON: jest.fn().mockReturnValue(updatedTaskJson),
      });

    const token = generateToken(USER_ID, 'manager');

    const res = await request(app)
      .put(`/api/tasks/${TASK_ID}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Renamed Task' });

    expect(res.status).toBe(200);
  });
});

// ─── DELETE /api/tasks/:id ────────────────────────────────────────────────────

describe('DELETE /api/tasks/:id', () => {
  let app;

  beforeAll(() => { app = buildApp(); });
  beforeEach(() => jest.clearAllMocks());

  it('returns 403 when a member tries to delete a task (route guard)', async () => {
    // The route applies managerOrAdmin middleware BEFORE the controller,
    // so a member gets 403 before the controller even runs.
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'member' }));
    const token = generateToken(USER_ID, 'member');

    const res = await request(app)
      .delete(`/api/tasks/${TASK_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it('returns 404 when the task does not exist (admin)', async () => {
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'admin' }));
    Task.findByPk.mockResolvedValue(null);
    const token = generateToken(USER_ID, 'admin');

    const res = await request(app)
      .delete(`/api/tasks/${TASK_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it('returns 200 when a manager deletes an existing task', async () => {
    User.findByPk.mockResolvedValue(makeUserRecord({ role: 'manager' }));
    const task = makeTaskRecord();
    Task.findByPk.mockResolvedValue(task);
    const token = generateToken(USER_ID, 'manager');

    const res = await request(app)
      .delete(`/api/tasks/${TASK_ID}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
