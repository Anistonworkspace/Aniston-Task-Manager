'use strict';

/**
 * Unit tests for the Workflow Canvas Phase W1 REST controller.
 *
 * All Sequelize models are mocked; no real DB.
 *
 * Coverage: workspace-membership 403, list happy path, create validation +
 * default isActive=false, get returns nested nodes + edges, patch updates
 * name/description, publish gate (only admin/manager/creator), delete
 * cascade contract, node create/delete round-trip, edge self-reference
 * rejected.
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

jest.mock('../../models', () => ({
  Workflow: { findAll: jest.fn(), findByPk: jest.fn(), create: jest.fn() },
  // findAll added in May-19 audit — publish validation reads the full
  // graph before flipping isActive=true. Default empty array keeps every
  // test that doesn't publish a happy no-op.
  WorkflowNode: { findByPk: jest.fn(), create: jest.fn(), findAll: jest.fn().mockResolvedValue([]) },
  WorkflowEdge: { findByPk: jest.fn(), create: jest.fn(), findAll: jest.fn().mockResolvedValue([]) },
  WorkflowRun: { findAll: jest.fn() },
  Workspace: { findByPk: jest.fn() },
  User: {},
}));

jest.mock('../../utils/safeLogger', () => ({
  error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(),
}));

jest.mock('../../utils/sanitize', () => ({
  sanitizeInput: (s) => (typeof s === 'string' ? s.replace(/<[^>]+>/g, '') : s),
}));

const {
  Workflow,
  WorkflowNode,
  WorkflowEdge,
  WorkflowRun,
  Workspace,
} = require('../../models');
const ctrl = require('../../controllers/workflowController');

// ─── shared helpers ────────────────────────────────────────────────────

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

const ADMIN = { id: 'u-admin', name: 'Admin', role: 'admin', isSuperAdmin: false };
const MANAGER = { id: 'u-manager', name: 'Mgr', role: 'manager', isSuperAdmin: false };
const SUPER = { id: 'u-super', name: 'Super', role: 'admin', isSuperAdmin: true };
const MEMBER = { id: 'u-member', name: 'Mem', role: 'member', isSuperAdmin: false };
const OUTSIDER = { id: 'u-out', name: 'Out', role: 'member', isSuperAdmin: false };

function makeWorkspace(overrides = {}) {
  return {
    id: 'w-1',
    createdBy: ADMIN.id,
    workspaceMembers: [{ id: MEMBER.id }],
    ...overrides,
  };
}

function makeWorkflow(overrides = {}) {
  const row = {
    id: 'wf-1',
    name: 'Test',
    description: null,
    boardId: 'b-1',
    workspaceId: 'w-1',
    createdBy: ADMIN.id,
    isActive: false,
    update: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  row.toJSON = function () {
    const out = {};
    for (const k of Object.keys(this)) {
      if (typeof this[k] !== 'function') out[k] = this[k];
    }
    return out;
  };
  return row;
}

function makeNode(overrides = {}) {
  const row = {
    id: 'n-1',
    workflowId: 'wf-1',
    type: 'action',
    kind: 'notify_user',
    config: {},
    position: { x: 0, y: 0 },
    update: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  row.toJSON = function () {
    const out = {};
    for (const k of Object.keys(this)) {
      if (typeof this[k] !== 'function') out[k] = this[k];
    }
    return out;
  };
  return row;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── workspace membership 403 ─────────────────────────────────────────

describe('access control', () => {
  test('403 when caller is not a workspace member', async () => {
    Workspace.findByPk.mockResolvedValue(makeWorkspace({
      createdBy: 'u-other-admin',
      workspaceMembers: [],
    }));

    const req = { user: OUTSIDER, query: { workspaceId: 'w-1' } };
    const res = mockRes();
    await ctrl.listWorkflows(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(Workflow.findAll).not.toHaveBeenCalled();
  });
});

// ─── list ──────────────────────────────────────────────────────────────

describe('listWorkflows', () => {
  test('returns workflows for the workspace (happy path)', async () => {
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    Workflow.findAll.mockResolvedValue([makeWorkflow({ id: 'wf-A' }), makeWorkflow({ id: 'wf-B' })]);

    const req = { user: MEMBER, query: { workspaceId: 'w-1' } };
    const res = mockRes();
    await ctrl.listWorkflows(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data.workflows).toHaveLength(2);
    expect(Workflow.findAll).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: 'w-1' },
    }));
  });
});

// ─── create ────────────────────────────────────────────────────────────

describe('createWorkflow', () => {
  test('400 when workspaceId is missing', async () => {
    const req = { user: MEMBER, body: { name: 'X' } };
    const res = mockRes();
    await ctrl.createWorkflow(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(Workflow.create).not.toHaveBeenCalled();
  });

  test('201 with default isActive=false', async () => {
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    const created = makeWorkflow({ id: 'wf-new', name: 'New WF', isActive: false });
    Workflow.create.mockResolvedValue(created);

    const req = {
      user: MEMBER,
      body: { name: 'New WF', workspaceId: 'w-1', boardId: 'b-1' },
    };
    const res = mockRes();
    await ctrl.createWorkflow(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const insertArgs = Workflow.create.mock.calls[0][0];
    expect(insertArgs.workspaceId).toBe('w-1');
    expect(insertArgs.boardId).toBe('b-1');
    expect(insertArgs.createdBy).toBe(MEMBER.id);
    expect(insertArgs.isActive).toBe(false);
    const payload = res.json.mock.calls[0][0];
    expect(payload.data.workflow.isActive).toBe(false);
  });
});

// ─── get ───────────────────────────────────────────────────────────────

describe('getWorkflow', () => {
  test('returns workflow with nested nodes + edges in one payload', async () => {
    const wf = makeWorkflow();
    // The controller calls Workflow.findByPk with `include: nodes + edges`.
    // Our mock simulates the loaded shape by attaching arrays.
    wf.nodes = [{ id: 'n-1', type: 'trigger', kind: 'task_created' }];
    wf.edges = [{ id: 'e-1', sourceNodeId: 'n-1', targetNodeId: 'n-2' }];
    Workflow.findByPk.mockResolvedValue(wf);
    Workspace.findByPk.mockResolvedValue(makeWorkspace());

    const req = { user: MEMBER, params: { id: 'wf-1' } };
    const res = mockRes();
    await ctrl.getWorkflow(req, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data.workflow.nodes).toHaveLength(1);
    expect(payload.data.workflow.edges).toHaveLength(1);
    // Verify the include shape was requested.
    const findCall = Workflow.findByPk.mock.calls[0];
    expect(findCall[1].include).toEqual(expect.arrayContaining([
      expect.objectContaining({ as: 'nodes' }),
      expect.objectContaining({ as: 'edges' }),
    ]));
  });
});

// ─── patch ─────────────────────────────────────────────────────────────

describe('updateWorkflow', () => {
  test('updates name and description', async () => {
    const wf = makeWorkflow();
    Workflow.findByPk.mockResolvedValue(wf);
    Workspace.findByPk.mockResolvedValue(makeWorkspace());

    const req = {
      user: MEMBER,
      params: { id: 'wf-1' },
      body: { name: 'New Name', description: 'updated desc' },
    };
    const res = mockRes();
    await ctrl.updateWorkflow(req, res);

    expect(wf.update).toHaveBeenCalledWith(expect.objectContaining({
      name: 'New Name',
      description: 'updated desc',
    }));
    expect(res.json).toHaveBeenCalled();
  });

  test('publish (isActive=true) — 403 for a member who is NOT the creator', async () => {
    const wf = makeWorkflow({ createdBy: ADMIN.id });
    Workflow.findByPk.mockResolvedValue(wf);
    Workspace.findByPk.mockResolvedValue(makeWorkspace());

    const req = {
      user: MEMBER, // member, not creator, not admin/manager
      params: { id: 'wf-1' },
      body: { isActive: true },
    };
    const res = mockRes();
    await ctrl.updateWorkflow(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(wf.update).not.toHaveBeenCalled();
  });

  test('publish (isActive=true) — admin / manager / creator can flip', async () => {
    const wf = makeWorkflow({ createdBy: 'someone-else' });
    Workflow.findByPk.mockResolvedValue(wf);
    Workspace.findByPk.mockResolvedValue(makeWorkspace());

    // May-19 audit — provide a valid graph so workflowValidationService
    // doesn't reject the publish. Simple linear chain: 1 trigger → 1 action.
    WorkflowNode.findAll.mockResolvedValue([
      { id: 't1', workflowId: 'wf-1', type: 'trigger', kind: 'task_created', config: {} },
      { id: 'a1', workflowId: 'wf-1', type: 'action',  kind: 'change_status', config: { to: 'done' } },
    ]);
    WorkflowEdge.findAll.mockResolvedValue([
      { id: 'e1', workflowId: 'wf-1', sourceNodeId: 't1', targetNodeId: 'a1', branch: null },
    ]);

    const req = {
      user: MANAGER,
      params: { id: 'wf-1' },
      body: { isActive: true },
    };
    const res = mockRes();
    await ctrl.updateWorkflow(req, res);

    expect(wf.update).toHaveBeenCalledWith(expect.objectContaining({ isActive: true }));
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  test('publish (isActive=true) — 400 when graph is invalid (no trigger)', async () => {
    const wf = makeWorkflow({ createdBy: 'someone-else' });
    Workflow.findByPk.mockResolvedValue(wf);
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    // Empty graph → NO_TRIGGER from validator.
    WorkflowNode.findAll.mockResolvedValue([]);
    WorkflowEdge.findAll.mockResolvedValue([]);

    const req = { user: MANAGER, params: { id: 'wf-1' }, body: { isActive: true } };
    const res = mockRes();
    await ctrl.updateWorkflow(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(wf.update).not.toHaveBeenCalled();
    const payload = res.json.mock.calls[0][0];
    expect(payload.code).toBe('WORKFLOW_PUBLISH_INVALID');
    expect(Array.isArray(payload.errors)).toBe(true);
  });
});

// ─── delete ────────────────────────────────────────────────────────────

describe('deleteWorkflow', () => {
  test('admin can destroy a workflow — FK cascade handles nodes + edges + runs', async () => {
    const wf = makeWorkflow({ createdBy: ADMIN.id });
    Workflow.findByPk.mockResolvedValue(wf);
    Workspace.findByPk.mockResolvedValue(makeWorkspace());

    const req = { user: SUPER, params: { id: 'wf-1' } };
    const res = mockRes();
    await ctrl.deleteWorkflow(req, res);

    expect(wf.destroy).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});

// ─── node create / delete round-trip ──────────────────────────────────

describe('node create / delete', () => {
  test('createNode + deleteNode round-trip', async () => {
    const wf = makeWorkflow({ createdBy: MEMBER.id });
    Workflow.findByPk.mockResolvedValue(wf);
    Workspace.findByPk.mockResolvedValue(makeWorkspace());

    // create
    const created = makeNode({ id: 'n-new' });
    WorkflowNode.create.mockResolvedValue(created);

    const reqCreate = {
      user: MEMBER, // creator, so canManageWorkflow passes
      params: { id: 'wf-1' },
      body: { type: 'action', kind: 'change_status', config: { to: 'done' } },
    };
    const resCreate = mockRes();
    await ctrl.createNode(reqCreate, resCreate);
    expect(resCreate.status).toHaveBeenCalledWith(201);
    expect(WorkflowNode.create).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: 'wf-1',
      type: 'action',
      kind: 'change_status',
    }));

    // delete
    Workflow.findByPk.mockResolvedValue(wf);
    WorkflowNode.findByPk.mockResolvedValue(created);

    const reqDel = {
      user: MEMBER,
      params: { id: 'wf-1', nodeId: 'n-new' },
    };
    const resDel = mockRes();
    await ctrl.deleteNode(reqDel, resDel);
    expect(created.destroy).toHaveBeenCalledTimes(1);
    expect(resDel.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});

// ─── edge self-reference rejection ────────────────────────────────────

describe('createEdge', () => {
  test('rejects an edge whose source equals its target', async () => {
    const wf = makeWorkflow({ createdBy: MEMBER.id });
    Workflow.findByPk.mockResolvedValue(wf);
    Workspace.findByPk.mockResolvedValue(makeWorkspace());

    const req = {
      user: MEMBER,
      params: { id: 'wf-1' },
      body: { sourceNodeId: 'n-a', targetNodeId: 'n-a' },
    };
    const res = mockRes();
    await ctrl.createEdge(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(WorkflowEdge.create).not.toHaveBeenCalled();
  });
});
