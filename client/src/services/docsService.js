import api from './api';

/**
 * docsService — client wrapper for the Doc Editor (Phase B).
 *
 *   listWorkspaceDocs(workspaceId, { q, archived }) → { docs }
 *   createDoc(workspaceId, { title?, contentJson? }) → { doc }
 *   getDoc(id)                                       → { doc }
 *   updateDoc(id, { title?, contentJson?, sharePolicy? }) → { doc }
 *   archiveDoc(id)                                   → { doc }
 *   restoreDoc(id)                                   → { doc }
 *   listVersions(id)                                 → { versions }
 *   restoreVersion(docId, versionId)                 → { doc }
 *
 * Returns `data` already unwrapped — the Axios interceptor handles
 * `{ success, data }`; this just normalizes the older-shape fallback so
 * callers consume one shape.
 */

function unwrap(res) {
  return res?.data?.data ?? res?.data ?? {};
}

export async function listWorkspaceDocs(workspaceId, { q, archived } = {}) {
  if (!workspaceId) throw new Error('workspaceId is required');
  const params = {};
  if (q) params.q = q;
  if (archived) params.archived = '1';
  const res = await api.get(`/workspaces/${workspaceId}/docs`, { params });
  return unwrap(res);
}

export async function createDoc(workspaceId, { title, contentJson } = {}) {
  if (!workspaceId) throw new Error('workspaceId is required');
  const body = {};
  if (title !== undefined) body.title = title;
  if (contentJson !== undefined) body.contentJson = contentJson;
  const res = await api.post(`/workspaces/${workspaceId}/docs`, body);
  return unwrap(res);
}

export async function getDoc(id) {
  if (!id) throw new Error('id is required');
  const res = await api.get(`/docs/${id}`);
  return unwrap(res);
}

export async function updateDoc(id, patch = {}) {
  if (!id) throw new Error('id is required');
  const res = await api.patch(`/docs/${id}`, patch);
  return unwrap(res);
}

export async function archiveDoc(id) {
  if (!id) throw new Error('id is required');
  const res = await api.delete(`/docs/${id}`);
  return unwrap(res);
}

export async function restoreDoc(id) {
  if (!id) throw new Error('id is required');
  const res = await api.post(`/docs/${id}/restore`);
  return unwrap(res);
}

export async function listVersions(id) {
  if (!id) throw new Error('id is required');
  const res = await api.get(`/docs/${id}/versions`);
  return unwrap(res);
}

export async function restoreVersion(docId, versionId) {
  if (!docId || !versionId) throw new Error('docId and versionId are required');
  const res = await api.post(`/docs/${docId}/versions/${versionId}/restore`);
  return unwrap(res);
}

export default {
  listWorkspaceDocs,
  createDoc,
  getDoc,
  updateDoc,
  archiveDoc,
  restoreDoc,
  listVersions,
  restoreVersion,
};
