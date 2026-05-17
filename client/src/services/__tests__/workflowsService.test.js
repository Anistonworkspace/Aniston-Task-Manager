import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import api from '../api';
import {
  listWorkflows,
  createWorkflow,
  getWorkflow,
  updateWorkflow,
  deleteWorkflow,
  createNode,
  updateNode,
  deleteNode,
  createEdge,
  deleteEdge,
  listWorkflowRuns,
} from '../workflowsService';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('workflowsService client wrappers', () => {
  it('listWorkflows GETs /workflows with workspaceId param when supplied', async () => {
    api.get.mockResolvedValue({
      data: { success: true, data: { workflows: [{ id: 'w1' }] } },
    });
    const out = await listWorkflows('ws1');
    expect(api.get).toHaveBeenCalledWith('/workflows', { params: { workspaceId: 'ws1' } });
    expect(out.workflows).toEqual([{ id: 'w1' }]);
  });

  it('listWorkflows omits workspaceId param when not supplied', async () => {
    api.get.mockResolvedValue({ data: { success: true, data: { workflows: [] } } });
    await listWorkflows();
    expect(api.get).toHaveBeenCalledWith('/workflows', { params: {} });
  });

  it('createWorkflow POSTs /workflows with body and rejects on missing name', async () => {
    api.post.mockResolvedValue({
      data: { success: true, data: { workflow: { id: 'w1', name: 'Hi' } } },
    });
    const out = await createWorkflow({ name: 'Hi', workspaceId: 'ws1' });
    expect(api.post).toHaveBeenCalledWith('/workflows', { name: 'Hi', workspaceId: 'ws1' });
    expect(out.workflow.id).toBe('w1');

    await expect(createWorkflow()).rejects.toThrow(/name/);
    await expect(createWorkflow({})).rejects.toThrow(/name/);
  });

  it('getWorkflow GETs /workflows/:id and rejects when id missing', async () => {
    api.get.mockResolvedValue({
      data: { success: true, data: { workflow: { id: 'w1' }, nodes: [], edges: [] } },
    });
    const out = await getWorkflow('w1');
    expect(api.get).toHaveBeenCalledWith('/workflows/w1');
    expect(out.workflow.id).toBe('w1');
    expect(out.nodes).toEqual([]);
    expect(out.edges).toEqual([]);

    await expect(getWorkflow()).rejects.toThrow(/id/);
  });

  it('updateWorkflow PATCHes /workflows/:id with patch and rejects when id missing', async () => {
    api.patch.mockResolvedValue({
      data: { success: true, data: { workflow: { id: 'w1', name: 'Renamed', isActive: true } } },
    });
    const out = await updateWorkflow('w1', { name: 'Renamed', isActive: true });
    expect(api.patch).toHaveBeenCalledWith('/workflows/w1', { name: 'Renamed', isActive: true });
    expect(out.workflow.isActive).toBe(true);

    await expect(updateWorkflow()).rejects.toThrow(/id/);
  });

  it('deleteWorkflow DELETEs /workflows/:id and rejects when id missing', async () => {
    api.delete.mockResolvedValue({ data: { success: true, data: { id: 'w1' } } });
    const out = await deleteWorkflow('w1');
    expect(api.delete).toHaveBeenCalledWith('/workflows/w1');
    expect(out.id).toBe('w1');

    await expect(deleteWorkflow()).rejects.toThrow(/id/);
  });

  it('createNode POSTs /workflows/:id/nodes with body and rejects on missing args', async () => {
    api.post.mockResolvedValue({
      data: { success: true, data: { node: { id: 'n1', type: 'trigger', kind: 'task_created' } } },
    });
    const out = await createNode('w1', {
      type: 'trigger',
      kind: 'task_created',
      position: { x: 10, y: 20 },
    });
    expect(api.post).toHaveBeenCalledWith('/workflows/w1/nodes', {
      type: 'trigger',
      kind: 'task_created',
      position: { x: 10, y: 20 },
    });
    expect(out.node.id).toBe('n1');

    await expect(createNode()).rejects.toThrow(/workflowId/);
    await expect(createNode('w1')).rejects.toThrow(/type/);
    await expect(createNode('w1', { type: 'trigger' })).rejects.toThrow(/kind/);
  });

  it('updateNode PATCHes /workflows/:wid/nodes/:nid with the patch', async () => {
    api.patch.mockResolvedValue({
      data: { success: true, data: { node: { id: 'n1', config: { to: 'done' } } } },
    });
    const out = await updateNode('w1', 'n1', { config: { to: 'done' } });
    expect(api.patch).toHaveBeenCalledWith('/workflows/w1/nodes/n1', { config: { to: 'done' } });
    expect(out.node.config.to).toBe('done');

    await expect(updateNode()).rejects.toThrow(/workflowId/);
    await expect(updateNode('w1')).rejects.toThrow(/nodeId/);
  });

  it('deleteNode DELETEs /workflows/:wid/nodes/:nid', async () => {
    api.delete.mockResolvedValue({ data: { success: true, data: { id: 'n1' } } });
    const out = await deleteNode('w1', 'n1');
    expect(api.delete).toHaveBeenCalledWith('/workflows/w1/nodes/n1');
    expect(out.id).toBe('n1');

    await expect(deleteNode()).rejects.toThrow(/workflowId/);
    await expect(deleteNode('w1')).rejects.toThrow(/nodeId/);
  });

  it('createEdge POSTs /workflows/:id/edges and rejects on missing args', async () => {
    api.post.mockResolvedValue({
      data: { success: true, data: { edge: { id: 'e1', sourceNodeId: 'n1', targetNodeId: 'n2' } } },
    });
    const out = await createEdge('w1', { sourceNodeId: 'n1', targetNodeId: 'n2' });
    expect(api.post).toHaveBeenCalledWith('/workflows/w1/edges', {
      sourceNodeId: 'n1',
      targetNodeId: 'n2',
    });
    expect(out.edge.id).toBe('e1');

    await expect(createEdge()).rejects.toThrow(/workflowId/);
    await expect(createEdge('w1')).rejects.toThrow(/sourceNodeId/);
    await expect(createEdge('w1', { sourceNodeId: 'n1' })).rejects.toThrow(/targetNodeId/);
  });

  it('deleteEdge DELETEs /workflows/:wid/edges/:eid', async () => {
    api.delete.mockResolvedValue({ data: { success: true, data: { id: 'e1' } } });
    const out = await deleteEdge('w1', 'e1');
    expect(api.delete).toHaveBeenCalledWith('/workflows/w1/edges/e1');
    expect(out.id).toBe('e1');

    await expect(deleteEdge()).rejects.toThrow(/workflowId/);
    await expect(deleteEdge('w1')).rejects.toThrow(/edgeId/);
  });

  it('listWorkflowRuns GETs /workflows/:id/runs', async () => {
    api.get.mockResolvedValue({
      data: { success: true, data: { runs: [{ id: 'r1' }, { id: 'r2' }] } },
    });
    const out = await listWorkflowRuns('w1');
    expect(api.get).toHaveBeenCalledWith('/workflows/w1/runs');
    expect(out.runs).toHaveLength(2);

    await expect(listWorkflowRuns()).rejects.toThrow(/workflowId/);
  });

  it('unwrap helper: prefers res.data.data, falls back to res.data, then {}', async () => {
    api.get.mockResolvedValue({ data: { success: true, data: { workflows: ['nested'] } } });
    let out = await listWorkflows();
    expect(out).toEqual({ workflows: ['nested'] });

    api.get.mockResolvedValue({ data: { workflows: ['flat'] } });
    out = await listWorkflows();
    expect(out).toEqual({ workflows: ['flat'] });

    api.get.mockResolvedValue({});
    out = await listWorkflows();
    expect(out).toEqual({});
  });
});
