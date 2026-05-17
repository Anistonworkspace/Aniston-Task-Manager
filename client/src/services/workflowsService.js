import api from './api';

/**
 * workflowsService — client wrapper for the Workflow Canvas (Phase W1).
 *
 * Mirrors `docsService` in shape: every wrapper returns the unwrapped data
 * payload (`{ workflow, nodes, edges }`, `{ workflows }`, etc.) and throws a
 * clean Error on missing required arguments before hitting the network.
 *
 *   listWorkflows(workspaceId?)                                → { workflows }
 *   createWorkflow({ workspaceId, name, boardId? })            → { workflow }
 *   getWorkflow(id)                                            → { workflow, nodes, edges }
 *   updateWorkflow(id, patch)                                  → { workflow }
 *   deleteWorkflow(id)                                         → { id }
 *   createNode(workflowId, { type, kind, config?, position })  → { node }
 *   updateNode(workflowId, nodeId, patch)                      → { node }
 *   deleteNode(workflowId, nodeId)                             → { id }
 *   createEdge(workflowId, { sourceNodeId, targetNodeId })     → { edge }
 *   deleteEdge(workflowId, edgeId)                             → { id }
 *   listWorkflowRuns(workflowId)                               → { runs }
 *
 * The Axios interceptor already auto-unwraps `{ success, data }`; the
 * `unwrap` helper here just normalizes the older flat shape so callers
 * consume one consistent envelope.
 */

function unwrap(res) {
  return res?.data?.data ?? res?.data ?? {};
}

export async function listWorkflows(workspaceId) {
  const params = {};
  if (workspaceId) params.workspaceId = workspaceId;
  const res = await api.get('/workflows', { params });
  return unwrap(res);
}

export async function createWorkflow({ workspaceId, name, boardId } = {}) {
  if (!name) throw new Error('name is required');
  const body = { name };
  if (workspaceId) body.workspaceId = workspaceId;
  if (boardId) body.boardId = boardId;
  const res = await api.post('/workflows', body);
  return unwrap(res);
}

export async function getWorkflow(id) {
  if (!id) throw new Error('id is required');
  const res = await api.get(`/workflows/${id}`);
  return unwrap(res);
}

export async function updateWorkflow(id, patch = {}) {
  if (!id) throw new Error('id is required');
  const res = await api.patch(`/workflows/${id}`, patch);
  return unwrap(res);
}

export async function deleteWorkflow(id) {
  if (!id) throw new Error('id is required');
  const res = await api.delete(`/workflows/${id}`);
  return unwrap(res);
}

export async function createNode(workflowId, { type, kind, config, position } = {}) {
  if (!workflowId) throw new Error('workflowId is required');
  if (!type) throw new Error('type is required');
  if (!kind) throw new Error('kind is required');
  const body = { type, kind };
  if (config !== undefined) body.config = config;
  if (position !== undefined) body.position = position;
  const res = await api.post(`/workflows/${workflowId}/nodes`, body);
  return unwrap(res);
}

export async function updateNode(workflowId, nodeId, patch = {}) {
  if (!workflowId) throw new Error('workflowId is required');
  if (!nodeId) throw new Error('nodeId is required');
  const res = await api.patch(`/workflows/${workflowId}/nodes/${nodeId}`, patch);
  return unwrap(res);
}

export async function deleteNode(workflowId, nodeId) {
  if (!workflowId) throw new Error('workflowId is required');
  if (!nodeId) throw new Error('nodeId is required');
  const res = await api.delete(`/workflows/${workflowId}/nodes/${nodeId}`);
  return unwrap(res);
}

export async function createEdge(workflowId, { sourceNodeId, targetNodeId, branch } = {}) {
  if (!workflowId) throw new Error('workflowId is required');
  if (!sourceNodeId) throw new Error('sourceNodeId is required');
  if (!targetNodeId) throw new Error('targetNodeId is required');
  const body = { sourceNodeId, targetNodeId };
  if (branch === 'true' || branch === 'false') body.branch = branch;
  const res = await api.post(`/workflows/${workflowId}/edges`, body);
  return unwrap(res);
}

// Phase W2 — synthetic run from the canvas's "Test run" button. Returns
// `{ result: { status, nodesRun, durationMs }, trigger, synthetic }`.
export async function testRunWorkflow(workflowId, taskOverrides) {
  if (!workflowId) throw new Error('workflowId is required');
  const body = (taskOverrides && typeof taskOverrides === 'object')
    ? { task: taskOverrides }
    : {};
  const res = await api.post(`/workflows/${workflowId}/test-run`, body);
  return unwrap(res);
}

export async function deleteEdge(workflowId, edgeId) {
  if (!workflowId) throw new Error('workflowId is required');
  if (!edgeId) throw new Error('edgeId is required');
  const res = await api.delete(`/workflows/${workflowId}/edges/${edgeId}`);
  return unwrap(res);
}

export async function listWorkflowRuns(workflowId) {
  if (!workflowId) throw new Error('workflowId is required');
  const res = await api.get(`/workflows/${workflowId}/runs`);
  return unwrap(res);
}

export default {
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
  testRunWorkflow,
};
