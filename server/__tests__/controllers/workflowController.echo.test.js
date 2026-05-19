'use strict';

/**
 * May-26 regression tests — verify the clientMutationId stamped by the
 * canvas client is round-tripped onto every `workflow:*` socket payload.
 *
 * Without this guarantee, the originating tab can't distinguish its own
 * save echoes from real remote edits, which surfaces the "Another editor
 * just saved changes" banner on every drag / config save.
 *
 * Mocks: socketService is replaced so we can observe emitToRoom calls;
 * Sequelize models are stubbed with the minimum shape each controller
 * method needs.
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

jest.mock('../../models', () => ({
  Workflow: { findAll: jest.fn(), findByPk: jest.fn(), create: jest.fn() },
  WorkflowNode: { findByPk: jest.fn(), create: jest.fn(), findAll: jest.fn().mockResolvedValue([]) },
  WorkflowEdge: { findByPk: jest.fn(), create: jest.fn(), findAll: jest.fn().mockResolvedValue([]) },
  WorkflowRun: { findAll: jest.fn() },
  Workspace: { findByPk: jest.fn() },
  User: {},
}));

jest.mock('../../services/socketService', () => ({
  emitToRoom: jest.fn(),
  emitToBoard: jest.fn(),
  emitToUser: jest.fn(),
  emitToUsers: jest.fn(),
}));

jest.mock('../../utils/safeLogger', () => ({
  error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(),
}));

jest.mock('../../utils/sanitize', () => ({
  sanitizeInput: (s) => s,
}));

const { Workflow, WorkflowNode, Workspace } = require('../../models');
const socketService = require('../../services/socketService');
const ctrl = require('../../controllers/workflowController');

const ADMIN = { id: 'u-admin', name: 'Admin', role: 'admin', isSuperAdmin: false };

function makeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function makeWorkspace() {
  return { id: 'w-1', createdBy: ADMIN.id, workspaceMembers: [] };
}

function makeWorkflowRow(overrides = {}) {
  const row = {
    id: 'wf-1', name: 'WF', boardId: null, workspaceId: 'w-1',
    createdBy: ADMIN.id, isActive: false,
    update: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn().mockResolvedValue(undefined),
    toJSON() { return { id: this.id, name: this.name }; },
    ...overrides,
  };
  return row;
}

beforeEach(() => jest.clearAllMocks());

describe('clientMutationId round-trip (May-26 audit follow-up)', () => {
  test('workflow:created carries clientMutationId from request body', async () => {
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    Workflow.create.mockResolvedValue(makeWorkflowRow());

    const req = {
      user: ADMIN,
      body: { name: 'Demo', workspaceId: 'w-1', _clientMutationId: 'cmid-abc' },
      get: () => null,
    };
    await ctrl.createWorkflow(req, makeRes());

    const wfRoomCall = socketService.emitToRoom.mock.calls.find(
      ([, evt]) => evt === 'workflow:created',
    );
    expect(wfRoomCall).toBeDefined();
    const payload = wfRoomCall[2];
    expect(payload.clientMutationId).toBe('cmid-abc');
    expect(payload.actorId).toBe(ADMIN.id);
  });

  test('workflow:node-updated carries clientMutationId from X-Client-Mutation-Id header', async () => {
    const wf = makeWorkflowRow();
    const node = {
      id: 'n-1', workflowId: 'wf-1', type: 'action', kind: 'notify_user',
      config: {}, position: { x: 0, y: 0 },
      update: jest.fn().mockResolvedValue(undefined),
      toJSON() { return { id: this.id }; },
    };
    Workflow.findByPk.mockResolvedValue(wf);
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    WorkflowNode.findByPk.mockResolvedValue(node);

    const req = {
      user: ADMIN,
      params: { id: 'wf-1', nodeId: 'n-1' },
      body: { config: { userId: 'u-2' } }, // no _clientMutationId in body
      get: (h) => (h === 'X-Client-Mutation-Id' ? 'cmid-from-header' : null),
    };
    await ctrl.updateNode(req, makeRes());

    const nodeUpdatedCall = socketService.emitToRoom.mock.calls.find(
      ([, evt]) => evt === 'workflow:node-updated',
    );
    expect(nodeUpdatedCall).toBeDefined();
    expect(nodeUpdatedCall[2].clientMutationId).toBe('cmid-from-header');
  });

  test('clientMutationId is null when neither body nor header carries one', async () => {
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    Workflow.create.mockResolvedValue(makeWorkflowRow());

    const req = {
      user: ADMIN,
      body: { name: 'Demo', workspaceId: 'w-1' },
      get: () => null,
    };
    await ctrl.createWorkflow(req, makeRes());

    const wfRoomCall = socketService.emitToRoom.mock.calls.find(
      ([, evt]) => evt === 'workflow:created',
    );
    expect(wfRoomCall).toBeDefined();
    expect(wfRoomCall[2].clientMutationId).toBeNull();
  });

  test('clientMutationId longer than 64 chars is truncated', async () => {
    Workspace.findByPk.mockResolvedValue(makeWorkspace());
    Workflow.create.mockResolvedValue(makeWorkflowRow());

    const long = 'x'.repeat(200);
    const req = {
      user: ADMIN,
      body: { name: 'Demo', workspaceId: 'w-1', _clientMutationId: long },
      get: () => null,
    };
    await ctrl.createWorkflow(req, makeRes());

    const wfRoomCall = socketService.emitToRoom.mock.calls.find(
      ([, evt]) => evt === 'workflow:created',
    );
    expect(wfRoomCall).toBeDefined();
    expect(wfRoomCall[2].clientMutationId.length).toBe(64);
  });
});
