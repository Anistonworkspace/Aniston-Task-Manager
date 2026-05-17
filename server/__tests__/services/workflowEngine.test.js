'use strict';

/**
 * Unit tests for the Workflow Canvas Phase W1 engine.
 *
 * Surfaces under test:
 *   - processWorkflows: early-exit, board scoping, trigger matching
 *   - matchesTriggerNode: config-based filtering (status, userId)
 *   - executeWorkflow: linear walk, action dispatch, error survival,
 *     unknown-kind tolerance, WorkflowRun + lastRun* persistence,
 *     condition-edge / condition-node skip semantics
 *
 * All Sequelize models are mocked; notificationService is mocked. No
 * real DB or socket connection.
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

jest.mock('../../models', () => ({
  Workflow: { findAll: jest.fn(), update: jest.fn() },
  WorkflowNode: { findAll: jest.fn() },
  WorkflowEdge: { findAll: jest.fn() },
  WorkflowRun: { create: jest.fn() },
  Task: { update: jest.fn() },
}));

jest.mock('../../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
  buildIdempotencyKey: (...parts) => parts.filter(Boolean).join(':'),
}));

jest.mock('../../utils/safeLogger', () => ({
  error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(),
}));

const { Workflow, WorkflowNode, WorkflowEdge, WorkflowRun, Task } = require('../../models');
const notificationService = require('../../services/notificationService');
const safeLogger = require('../../utils/safeLogger');
const engine = require('../../services/workflowEngine');

// ─── helpers ───────────────────────────────────────────────────────────

function makeNode(overrides = {}) {
  return {
    id: 'n-' + Math.random().toString(36).slice(2, 8),
    workflowId: 'wf-1',
    type: 'action',
    kind: 'notify_user',
    config: {},
    position: { x: 0, y: 0 },
    ...overrides,
  };
}

function makeEdge(source, target, condition = null) {
  return {
    id: 'e-' + Math.random().toString(36).slice(2, 8),
    workflowId: 'wf-1',
    sourceNodeId: source,
    targetNodeId: target,
    condition,
  };
}

function makeWorkflow(overrides = {}) {
  return {
    id: 'wf-1',
    name: 'Test WF',
    boardId: 'b-1',
    workspaceId: 'w-1',
    isActive: true,
    update: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeTask(overrides = {}) {
  return {
    id: 't-1',
    title: 'Demo task',
    boardId: 'b-1',
    assignedTo: 'u-assignee',
    status: 'working_on_it',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── processWorkflows ──────────────────────────────────────────────────

describe('processWorkflows', () => {
  test('returns early when no active workflows exist', async () => {
    Workflow.findAll.mockResolvedValue([]);
    await engine.processWorkflows('task_created', { task: makeTask(), userId: 'u-1' });
    expect(WorkflowEdge.findAll).not.toHaveBeenCalled();
    expect(WorkflowRun.create).not.toHaveBeenCalled();
  });

  test('filters by boardId — workflows on other boards are not fetched', async () => {
    Workflow.findAll.mockResolvedValue([]);
    await engine.processWorkflows('task_created', { task: makeTask({ boardId: 'b-XYZ' }), userId: 'u-1' });
    // The where clause must include the task's boardId in the OR branch.
    const whereArg = Workflow.findAll.mock.calls[0][0].where;
    expect(whereArg.isActive).toBe(true);
    // Either boardId IS NULL OR boardId === 'b-XYZ'
    const orBranches = whereArg[require('sequelize').Op.or];
    expect(orBranches).toEqual(expect.arrayContaining([
      { boardId: null },
      { boardId: 'b-XYZ' },
    ]));
  });

  test('matches trigger.kind only — non-matching trigger nodes are skipped', async () => {
    const triggerNode = makeNode({ type: 'trigger', kind: 'task_assigned' });
    const wf = makeWorkflow({ nodes: [triggerNode] });
    Workflow.findAll.mockResolvedValue([wf]);
    WorkflowEdge.findAll.mockResolvedValue([]);
    WorkflowNode.findAll.mockResolvedValue([triggerNode]);

    // Different trigger event — should NOT execute.
    await engine.processWorkflows('task_created', { task: makeTask(), userId: 'u-1' });
    // No WorkflowRun is written because no trigger matched.
    expect(WorkflowRun.create).not.toHaveBeenCalled();
  });
});

// ─── matchesTriggerNode ────────────────────────────────────────────────

describe('matchesTriggerNode', () => {
  test('status_changed: config.status filter only matches when newStatus equals', () => {
    const node = { type: 'trigger', kind: 'status_changed', config: { status: 'done' } };
    expect(engine.matchesTriggerNode(node, 'status_changed', { newStatus: 'done' })).toBe(true);
    expect(engine.matchesTriggerNode(node, 'status_changed', { newStatus: 'stuck' })).toBe(false);
  });

  test('status_changed: empty config matches every newStatus', () => {
    const node = { type: 'trigger', kind: 'status_changed', config: {} };
    expect(engine.matchesTriggerNode(node, 'status_changed', { newStatus: 'anything' })).toBe(true);
  });

  test('rejects non-trigger nodes and mismatched kinds', () => {
    expect(engine.matchesTriggerNode({ type: 'action', kind: 'task_created' }, 'task_created', {})).toBe(false);
    expect(engine.matchesTriggerNode({ type: 'trigger', kind: 'task_created' }, 'task_assigned', {})).toBe(false);
  });
});

// ─── executeWorkflow ───────────────────────────────────────────────────

describe('executeWorkflow', () => {
  test('walks linear edges in order, dispatching every action node', async () => {
    const trigger = makeNode({ id: 'n-trig', type: 'trigger', kind: 'task_created' });
    const a1 = makeNode({ id: 'n-a1', type: 'action', kind: 'change_status', config: { to: 'done' } });
    const a2 = makeNode({ id: 'n-a2', type: 'action', kind: 'change_priority', config: { to: 'high' } });
    const wf = makeWorkflow();

    WorkflowEdge.findAll.mockResolvedValue([
      makeEdge('n-trig', 'n-a1'),
      makeEdge('n-a1', 'n-a2'),
    ]);
    WorkflowNode.findAll.mockResolvedValue([trigger, a1, a2]);

    const result = await engine.executeWorkflow(wf, trigger, { task: makeTask() });
    expect(Task.update).toHaveBeenCalledWith({ status: 'done' }, { where: { id: 't-1' } });
    expect(Task.update).toHaveBeenCalledWith({ priority: 'high' }, { where: { id: 't-1' } });
    expect(result.nodesRun).toBe(2);
    expect(result.status).toBe('ok');
  });

  test("notify_user resolves the 'assignee' sentinel to task.assignedTo", async () => {
    const trigger = makeNode({ id: 'n-trig', type: 'trigger', kind: 'task_assigned' });
    const action = makeNode({
      id: 'n-notif',
      type: 'action',
      kind: 'notify_user',
      config: { userId: 'assignee', message: 'You got it' },
    });
    const wf = makeWorkflow();

    WorkflowEdge.findAll.mockResolvedValue([makeEdge('n-trig', 'n-notif')]);
    WorkflowNode.findAll.mockResolvedValue([trigger, action]);

    await engine.executeWorkflow(wf, trigger, { task: makeTask({ assignedTo: 'u-jane' }) });
    expect(notificationService.createNotification).toHaveBeenCalledTimes(1);
    const args = notificationService.createNotification.mock.calls[0][0];
    expect(args.userId).toBe('u-jane');
    expect(args.message).toBe('You got it');
    expect(args.type).toBe('task_updated');
    expect(args.entityType).toBe('task');
    expect(args.entityId).toBe('t-1');
  });

  test('change_status dispatch calls Task.update with the configured target', async () => {
    const trigger = makeNode({ id: 'n-trig', type: 'trigger', kind: 'status_changed' });
    const action = makeNode({
      id: 'n-cs',
      type: 'action',
      kind: 'change_status',
      config: { to: 'review' },
    });
    const wf = makeWorkflow();

    WorkflowEdge.findAll.mockResolvedValue([makeEdge('n-trig', 'n-cs')]);
    WorkflowNode.findAll.mockResolvedValue([trigger, action]);

    await engine.executeWorkflow(wf, trigger, { task: makeTask() });
    expect(Task.update).toHaveBeenCalledWith({ status: 'review' }, { where: { id: 't-1' } });
  });

  test('survives a single-node failure and records error status', async () => {
    const trigger = makeNode({ id: 'n-trig', type: 'trigger', kind: 'task_created' });
    const a1 = makeNode({ id: 'n-bad', type: 'action', kind: 'change_status', config: { to: 'done' } });
    const a2 = makeNode({ id: 'n-ok', type: 'action', kind: 'change_priority', config: { to: 'low' } });
    const wf = makeWorkflow();

    Task.update
      .mockRejectedValueOnce(new Error('boom on first call'))
      .mockResolvedValueOnce(undefined);

    WorkflowEdge.findAll.mockResolvedValue([
      makeEdge('n-trig', 'n-bad'),
      makeEdge('n-bad', 'n-ok'),
    ]);
    WorkflowNode.findAll.mockResolvedValue([trigger, a1, a2]);

    const result = await engine.executeWorkflow(wf, trigger, { task: makeTask() });
    // Walker continues past the failure — the second action still runs.
    expect(Task.update).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('error');
    expect(safeLogger.error).toHaveBeenCalled();
  });

  test('writes a WorkflowRun row at the end with nodesRun + status', async () => {
    const trigger = makeNode({ id: 'n-trig', type: 'trigger', kind: 'task_created' });
    const action = makeNode({ id: 'n-a', type: 'action', kind: 'change_status', config: { to: 'done' } });
    const wf = makeWorkflow();

    WorkflowEdge.findAll.mockResolvedValue([makeEdge('n-trig', 'n-a')]);
    WorkflowNode.findAll.mockResolvedValue([trigger, action]);

    await engine.executeWorkflow(wf, trigger, { task: makeTask() });
    expect(WorkflowRun.create).toHaveBeenCalledTimes(1);
    const row = WorkflowRun.create.mock.calls[0][0];
    expect(row.workflowId).toBe('wf-1');
    expect(row.trigger).toBe('task_created');
    expect(row.status).toBe('ok');
    expect(row.nodesRun).toBe(1);
    // Context is sanitized to IDs only — no full task body persisted.
    expect(row.context).toEqual(expect.objectContaining({ taskId: 't-1', boardId: 'b-1' }));
    expect(row.context.title).toBeUndefined();
  });

  test('updates workflow.lastRunAt + lastRunStatus on completion', async () => {
    const trigger = makeNode({ id: 'n-trig', type: 'trigger', kind: 'task_created' });
    const wf = makeWorkflow();

    WorkflowEdge.findAll.mockResolvedValue([]);
    WorkflowNode.findAll.mockResolvedValue([trigger]);

    await engine.executeWorkflow(wf, trigger, { task: makeTask() });
    expect(wf.update).toHaveBeenCalledTimes(1);
    const upd = wf.update.mock.calls[0][0];
    expect(upd.lastRunAt).toBeInstanceOf(Date);
    expect(upd.lastRunStatus).toBe('ok');
  });

  test('unknown action kind logs a warning and does not throw', async () => {
    const trigger = makeNode({ id: 'n-trig', type: 'trigger', kind: 'task_created' });
    const weird = makeNode({ id: 'n-weird', type: 'action', kind: 'launch_rockets', config: {} });
    const wf = makeWorkflow();

    WorkflowEdge.findAll.mockResolvedValue([makeEdge('n-trig', 'n-weird')]);
    WorkflowNode.findAll.mockResolvedValue([trigger, weird]);

    const result = await engine.executeWorkflow(wf, trigger, { task: makeTask() });
    expect(safeLogger.warn).toHaveBeenCalledWith(
      '[Workflow] unknown action kind',
      expect.objectContaining({ kind: 'launch_rockets' })
    );
    // Unknown kinds don't crash the walker — status is still ok because no
    // node threw. The warning is the audit trail.
    expect(result.status).toBe('ok');
  });

  test('condition edge / condition node is skipped with a log (v1 scaffold)', async () => {
    const trigger = makeNode({ id: 'n-trig', type: 'trigger', kind: 'task_created' });
    const condEdgeTarget = makeNode({ id: 'n-after-cond-edge', type: 'action', kind: 'change_status', config: { to: 'done' } });
    const condNode = makeNode({ id: 'n-cond', type: 'condition', kind: 'if', config: {} });
    const afterCondNode = makeNode({ id: 'n-after-cond', type: 'action', kind: 'change_priority', config: { to: 'low' } });
    const wf = makeWorkflow();

    // Edge with non-null condition → skipped (target action should NOT run).
    // Condition NODE in the path → skipped but walker continues to its children.
    WorkflowEdge.findAll.mockResolvedValue([
      makeEdge('n-trig', 'n-after-cond-edge', { eq: 'high' }), // conditional edge — skipped
      makeEdge('n-trig', 'n-cond'),                            // unconditional → reach condition node
      makeEdge('n-cond', 'n-after-cond'),                      // condition node forwards to next
    ]);
    WorkflowNode.findAll.mockResolvedValue([trigger, condEdgeTarget, condNode, afterCondNode]);

    const result = await engine.executeWorkflow(wf, trigger, { task: makeTask() });
    // The conditional-edge target should NOT have executed.
    expect(Task.update).not.toHaveBeenCalledWith({ status: 'done' }, { where: { id: 't-1' } });
    // The action after the condition node SHOULD have executed.
    expect(Task.update).toHaveBeenCalledWith({ priority: 'low' }, { where: { id: 't-1' } });
    // Skip events emit info-level logs.
    expect(safeLogger.info).toHaveBeenCalled();
    // Because we skipped at least one branch, status should be 'partial'.
    expect(result.status).toBe('partial');
  });
});
