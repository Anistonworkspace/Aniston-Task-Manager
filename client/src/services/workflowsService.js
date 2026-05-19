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

/**
 * When the caller supplies a `clientMutationId`, return the axios config
 * (header) and body addendum that ride along on the request so the backend
 * can stamp the same id onto its `workflow:*` socket broadcast — the
 * originating tab uses it to suppress echoes of its own saves.
 *
 * When no id is supplied (legacy callers / tests), both return values are
 * `undefined`, so the call site can pass them positionally without
 * changing the exact axios signature it used before. This keeps the
 * service backwards-compatible with the existing service-layer unit tests.
 */
function buildMutationConfig(clientMutationId) {
  if (!clientMutationId) return { config: undefined, bodyExtras: null };
  const safe = String(clientMutationId).slice(0, 64);
  return {
    config: { headers: { 'X-Client-Mutation-Id': safe } },
    bodyExtras: { _clientMutationId: safe },
  };
}

// Helper: only merge mutation-id into the body when the caller actually
// supplied one. Avoids passing a `{ _clientMutationId: undefined }` shape
// that would break tests asserting the exact body shape.
function withMutationBody(body, bodyExtras) {
  return bodyExtras ? { ...body, ...bodyExtras } : body;
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

export async function updateWorkflow(id, patch = {}, opts = {}) {
  if (!id) throw new Error('id is required');
  const { config, bodyExtras } = buildMutationConfig(opts.clientMutationId);
  const res = config
    ? await api.patch(`/workflows/${id}`, withMutationBody(patch, bodyExtras), config)
    : await api.patch(`/workflows/${id}`, patch);
  return unwrap(res);
}

export async function deleteWorkflow(id, opts = {}) {
  if (!id) throw new Error('id is required');
  const { config } = buildMutationConfig(opts.clientMutationId);
  const res = config
    ? await api.delete(`/workflows/${id}`, config)
    : await api.delete(`/workflows/${id}`);
  return unwrap(res);
}

export async function createNode(workflowId, { type, kind, config, position } = {}, opts = {}) {
  if (!workflowId) throw new Error('workflowId is required');
  if (!type) throw new Error('type is required');
  if (!kind) throw new Error('kind is required');
  const body = { type, kind };
  if (config !== undefined) body.config = config;
  if (position !== undefined) body.position = position;
  const { config: axiosCfg, bodyExtras } = buildMutationConfig(opts.clientMutationId);
  const res = axiosCfg
    ? await api.post(`/workflows/${workflowId}/nodes`, withMutationBody(body, bodyExtras), axiosCfg)
    : await api.post(`/workflows/${workflowId}/nodes`, body);
  return unwrap(res);
}

export async function updateNode(workflowId, nodeId, patch = {}, opts = {}) {
  if (!workflowId) throw new Error('workflowId is required');
  if (!nodeId) throw new Error('nodeId is required');
  const { config, bodyExtras } = buildMutationConfig(opts.clientMutationId);
  const res = config
    ? await api.patch(`/workflows/${workflowId}/nodes/${nodeId}`, withMutationBody(patch, bodyExtras), config)
    : await api.patch(`/workflows/${workflowId}/nodes/${nodeId}`, patch);
  return unwrap(res);
}

export async function deleteNode(workflowId, nodeId, opts = {}) {
  if (!workflowId) throw new Error('workflowId is required');
  if (!nodeId) throw new Error('nodeId is required');
  const { config } = buildMutationConfig(opts.clientMutationId);
  const res = config
    ? await api.delete(`/workflows/${workflowId}/nodes/${nodeId}`, config)
    : await api.delete(`/workflows/${workflowId}/nodes/${nodeId}`);
  return unwrap(res);
}

export async function createEdge(workflowId, { sourceNodeId, targetNodeId, branch } = {}, opts = {}) {
  if (!workflowId) throw new Error('workflowId is required');
  if (!sourceNodeId) throw new Error('sourceNodeId is required');
  if (!targetNodeId) throw new Error('targetNodeId is required');
  const body = { sourceNodeId, targetNodeId };
  if (branch === 'true' || branch === 'false') body.branch = branch;
  const { config, bodyExtras } = buildMutationConfig(opts.clientMutationId);
  const res = config
    ? await api.post(`/workflows/${workflowId}/edges`, withMutationBody(body, bodyExtras), config)
    : await api.post(`/workflows/${workflowId}/edges`, body);
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

export async function deleteEdge(workflowId, edgeId, opts = {}) {
  if (!workflowId) throw new Error('workflowId is required');
  if (!edgeId) throw new Error('edgeId is required');
  const { config } = buildMutationConfig(opts.clientMutationId);
  const res = config
    ? await api.delete(`/workflows/${workflowId}/edges/${edgeId}`, config)
    : await api.delete(`/workflows/${workflowId}/edges/${edgeId}`);
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
