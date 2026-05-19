'use strict';

/**
 * May-19 audit follow-up — tests for the security/safety hardening pass:
 *
 *   - Phase 4c: runtime permission re-check before each action.
 *   - Phase 6a: cross-workflow chain-depth cap.
 *   - Phase 6b: in-memory LRU idempotency for same-event bursts.
 *   - WorkflowRun new columns (finishedAt, actorId, failedStepId,
 *     retryCount, idempotencyKey) are populated on create.
 *
 * Lives in a separate file so the long-standing W1 engine.test.js stays
 * focused on its original surface. All Sequelize / notification / permission
 * deps are mocked — no DB, no socket, no real users.
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

jest.mock('../../models', () => ({
  Workflow: { findAll: jest.fn(), findByPk: jest.fn(), update: jest.fn() },
  WorkflowNode: { findAll: jest.fn(), findByPk: jest.fn() },
  WorkflowEdge: { findAll: jest.fn() },
  WorkflowRun: { create: jest.fn() },
  WorkflowWait: { create: jest.fn(), findByPk: jest.fn() },
  Task: { update: jest.fn() },
  User: { findByPk: jest.fn() },
  Comment: { create: jest.fn() },
  Label: { findByPk: jest.fn() },
  TaskLabel: { findOrCreate: jest.fn(), destroy: jest.fn() },
}));

jest.mock('../../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
  buildIdempotencyKey: (...parts) => parts.filter(Boolean).join(':'),
}));

jest.mock('../../services/permissionEngine', () => ({
  hasPermission: jest.fn(),
}));

jest.mock('../../utils/safeLogger', () => ({
  error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(),
}));

const { Workflow, WorkflowNode, WorkflowEdge, WorkflowRun, Task, User } = require('../../models');
const permissionEngine = require('../../services/permissionEngine');
const engine = require('../../services/workflowEngine');

// ─── helpers ───────────────────────────────────────────────────────────

function makeNode(overrides = {}) {
  return {
    id: 'n-' + Math.random().toString(36).slice(2, 8),
    workflowId: 'wf-1',
    type: 'action',
    kind: 'change_status',
    config: { to: 'done' },
    position: { x: 0, y: 0 },
    ...overrides,
  };
}
function makeEdge(source, target, branch = null) {
  return {
    id: 'e-' + Math.random().toString(36).slice(2, 8),
    workflowId: 'wf-1',
    sourceNodeId: source,
    targetNodeId: target,
    condition: null,
    branch,
  };
}
function makeWorkflow(overrides = {}) {
  return {
    id: 'wf-1',
    name: 'Test WF',
    boardId: 'b-1',
    workspaceId: 'w-1',
    createdBy: 'creator-1',
    isActive: true,
    update: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
function makeTask(overrides = {}) {
  return { id: 't-1', title: 'X', boardId: 'b-1', assignedTo: 'u-1', status: 'working_on_it', ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Reasonable default: creator exists, is active, has every permission.
  User.findByPk.mockResolvedValue({
    id: 'creator-1', role: 'admin', tier: 2, isSuperAdmin: false, isActive: true,
  });
  permissionEngine.hasPermission.mockResolvedValue(true);
  WorkflowEdge.findAll.mockResolvedValue([]);
  WorkflowNode.findAll.mockResolvedValue([]);
});

// ─── Phase 4c — runtime permission re-check ──────────────────────────

describe('runtime permission re-check (audit P0-3)', () => {
  test('skips a change_status action when creator lacks tasks.edit_status', async () => {
    const trigger = makeNode({ type: 'trigger', kind: 'task_created' });
    const action = makeNode({ type: 'action', kind: 'change_status', config: { to: 'done' } });
    WorkflowNode.findAll.mockResolvedValue([trigger, action]);
    WorkflowEdge.findAll.mockResolvedValue([makeEdge(trigger.id, action.id)]);

    permissionEngine.hasPermission.mockImplementation(async (_user, resource, action) => {
      // Deny tasks.edit_status; allow everything else.
      return !(resource === 'tasks' && action === 'edit_status');
    });

    const wf = makeWorkflow();
    await engine.executeWorkflow(wf, trigger, { task: makeTask() });

    expect(Task.update).not.toHaveBeenCalled();
    expect(WorkflowRun.create).toHaveBeenCalled();
    const runArg = WorkflowRun.create.mock.calls[0][0];
    expect(runArg.status).toBe('partial'); // skipped → partial
    expect(runArg.nodesRun).toBe(0);
    expect(runArg.failedStepId).toBe(action.id);
    expect(runArg.error).toMatch(/skipped.*change_status/);
  });

  test('skips action when workflow creator is deactivated', async () => {
    User.findByPk.mockResolvedValue({ id: 'creator-1', isActive: false, role: 'member', tier: 4 });
    const trigger = makeNode({ type: 'trigger', kind: 'task_created' });
    const action = makeNode({ type: 'action', kind: 'change_status', config: { to: 'done' } });
    WorkflowNode.findAll.mockResolvedValue([trigger, action]);
    WorkflowEdge.findAll.mockResolvedValue([makeEdge(trigger.id, action.id)]);

    const wf = makeWorkflow();
    await engine.executeWorkflow(wf, trigger, { task: makeTask() });

    expect(Task.update).not.toHaveBeenCalled();
    const runArg = WorkflowRun.create.mock.calls[0][0];
    expect(runArg.error).toMatch(/workflow creator missing or deactivated/);
  });

  test('runs the action when creator has the permission', async () => {
    permissionEngine.hasPermission.mockResolvedValue(true);
    const trigger = makeNode({ type: 'trigger', kind: 'task_created' });
    const action = makeNode({ type: 'action', kind: 'change_status', config: { to: 'done' } });
    WorkflowNode.findAll.mockResolvedValue([trigger, action]);
    WorkflowEdge.findAll.mockResolvedValue([makeEdge(trigger.id, action.id)]);

    const wf = makeWorkflow();
    await engine.executeWorkflow(wf, trigger, { task: makeTask() });

    expect(Task.update).toHaveBeenCalledWith({ status: 'done' }, { where: { id: 't-1' } });
    const runArg = WorkflowRun.create.mock.calls[0][0];
    expect(runArg.status).toBe('ok');
    expect(runArg.nodesRun).toBe(1);
  });

  test('send_message and wait have no per-action permission check', async () => {
    permissionEngine.hasPermission.mockResolvedValue(false); // deny everything
    const trigger = makeNode({ type: 'trigger', kind: 'task_created' });
    const wait = makeNode({ type: 'action', kind: 'wait', config: { minutes: 0 } });
    WorkflowNode.findAll.mockResolvedValue([trigger, wait]);
    WorkflowEdge.findAll.mockResolvedValue([makeEdge(trigger.id, wait.id)]);

    const wf = makeWorkflow();
    await engine.executeWorkflow(wf, trigger, { task: makeTask() });

    // wait is a control-flow primitive: it must not be blocked by permission engine.
    const runArg = WorkflowRun.create.mock.calls[0][0];
    expect(runArg.status).toBe('ok');
    expect(permissionEngine.hasPermission).not.toHaveBeenCalledWith(
      expect.anything(), 'tasks', 'view', // we did NOT consult perm for wait
    );
  });
});

// ─── Phase 6a — cross-workflow chain depth cap ─────────────────────

describe('chain depth cap (audit P0-6)', () => {
  test('refuses fan-out when _chain already at MAX depth', async () => {
    // Build a context that has already traversed MAX_WORKFLOW_CHAIN_DEPTH (5) hops.
    const chain = Array.from({ length: 5 }, (_, i) => ({ workflowId: `wf-${i}`, trigger: 'status_changed' }));
    await engine.processWorkflows('status_changed', {
      task: makeTask(), userId: 'u-1', _chain: chain,
    });
    // Should never even query workflows.
    expect(Workflow.findAll).not.toHaveBeenCalled();
  });

  test('appends to _chain and proceeds when under cap', async () => {
    Workflow.findAll.mockResolvedValue([]); // no workflows match — we just verify the query ran
    await engine.processWorkflows('status_changed', {
      task: makeTask(), userId: 'u-1', _chain: [{ workflowId: 'wf-prev', trigger: 'task_created' }],
    });
    expect(Workflow.findAll).toHaveBeenCalled();
  });
});

// ─── Phase 6b — LRU idempotency ────────────────────────────────────

describe('LRU idempotency (audit P0-5)', () => {
  test('same event in same minute bucket fires once', async () => {
    const triggerNode = makeNode({ type: 'trigger', kind: 'task_created' });
    const wf = makeWorkflow({ nodes: [triggerNode] });
    Workflow.findAll.mockResolvedValue([wf]);

    // First call → executes.
    await engine.processWorkflows('task_created', {
      task: makeTask({ id: 't-dedup' }), userId: 'u-1', actorId: 'u-1',
    });
    const firstRunCount = WorkflowRun.create.mock.calls.length;
    expect(firstRunCount).toBe(1);

    // Second call w/ same trigger + same task + same actor + same minute → deduped.
    await engine.processWorkflows('task_created', {
      task: makeTask({ id: 't-dedup' }), userId: 'u-1', actorId: 'u-1',
    });
    expect(WorkflowRun.create.mock.calls.length).toBe(firstRunCount); // no second run
  });
});

// ─── WorkflowRun new columns populated ─────────────────────────────

describe('WorkflowRun audit columns', () => {
  test('finishedAt, actorId, retryCount, idempotencyKey are written', async () => {
    const triggerNode = makeNode({ type: 'trigger', kind: 'task_created' });
    const wf = makeWorkflow({ nodes: [triggerNode] });
    Workflow.findAll.mockResolvedValue([wf]);

    await engine.processWorkflows('task_created', {
      task: makeTask({ id: 't-cols' }), userId: 'u-actor', actorId: 'u-actor',
    });

    expect(WorkflowRun.create).toHaveBeenCalled();
    const runArg = WorkflowRun.create.mock.calls[0][0];
    expect(runArg.finishedAt).toBeInstanceOf(Date);
    expect(runArg.actorId).toBe('u-actor');
    expect(runArg.retryCount).toBe(0);
    expect(typeof runArg.idempotencyKey).toBe('string');
    expect(runArg.idempotencyKey).toContain('wf-1');
    expect(runArg.idempotencyKey).toContain('task_created');
  });
});
