import api from './api';

/**
 * formsService — Phase F1 client wrapper around /api/forms.
 *
 * Mirrors workflowsService in shape — every wrapper returns the unwrapped
 * `data` payload, throws on missing required arguments before the network
 * call, and keeps `unwrap` lenient about flat/nested response shapes.
 *
 *   listForms(workspaceId?)                  → { forms }
 *   createForm({ workspaceId, name, ... })   → { form }
 *   getForm(id)                              → { form }
 *   updateForm(id, patch)                    → { form }
 *   deleteForm(id)                           → { message }
 *
 *   listSubmissions(formId, { limit?, offset? }) → { submissions }
 *
 *   getPublicForm(slug)                          → { form }     (PUBLIC)
 *   submitPublicForm(slug, payload)              → { submittedAt } (PUBLIC)
 */

function unwrap(res) {
  return res?.data?.data ?? res?.data ?? {};
}

export async function listForms(workspaceId) {
  const params = {};
  if (workspaceId) params.workspaceId = workspaceId;
  const res = await api.get('/forms', { params });
  return unwrap(res);
}

export async function createForm({ workspaceId, name, description, targetBoardId, targetColumnMap, fields, isPublic } = {}) {
  if (!workspaceId) throw new Error('workspaceId is required');
  if (!name) throw new Error('name is required');
  const body = { workspaceId, name };
  if (description !== undefined) body.description = description;
  if (targetBoardId !== undefined) body.targetBoardId = targetBoardId;
  if (targetColumnMap !== undefined) body.targetColumnMap = targetColumnMap;
  if (fields !== undefined) body.fields = fields;
  if (isPublic !== undefined) body.isPublic = isPublic;
  const res = await api.post('/forms', body);
  return unwrap(res);
}

// Phase F2 — manually promote a stored submission to a task. Server requires
// form.targetBoardId + form.targetColumnMap.title to be set first.
export async function promoteSubmission(formId, submissionId) {
  if (!formId) throw new Error('formId is required');
  if (!submissionId) throw new Error('submissionId is required');
  const res = await api.post(`/forms/${formId}/submissions/${submissionId}/promote`);
  return unwrap(res);
}

export async function getForm(id) {
  if (!id) throw new Error('id is required');
  const res = await api.get(`/forms/${id}`);
  return unwrap(res);
}

export async function updateForm(id, patch) {
  if (!id) throw new Error('id is required');
  const res = await api.patch(`/forms/${id}`, patch || {});
  return unwrap(res);
}

export async function deleteForm(id) {
  if (!id) throw new Error('id is required');
  const res = await api.delete(`/forms/${id}`);
  return unwrap(res);
}

export async function listSubmissions(formId, { limit, offset } = {}) {
  if (!formId) throw new Error('formId is required');
  const params = {};
  if (limit !== undefined) params.limit = limit;
  if (offset !== undefined) params.offset = offset;
  const res = await api.get(`/forms/${formId}/submissions`, { params });
  return unwrap(res);
}

// PUBLIC — never use this for authenticated previews. The server returns
// only the slim public payload (no workspace / creator metadata).
export async function getPublicForm(slug) {
  if (!slug) throw new Error('slug is required');
  const res = await api.get(`/forms/public/${slug}`);
  return unwrap(res);
}

export async function submitPublicForm(slug, payload) {
  if (!slug) throw new Error('slug is required');
  const res = await api.post(`/forms/public/${slug}/submit`, payload || {});
  return unwrap(res);
}

export default {
  listForms,
  createForm,
  getForm,
  updateForm,
  deleteForm,
  listSubmissions,
  getPublicForm,
  submitPublicForm,
  promoteSubmission,
};
