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

/**
 * Phase H — thin convenience wrapper around updateDoc that only sends the
 * sharePolicy field. Used by DocShareDropdown so the consumer doesn't have
 * to re-construct the full patch envelope.
 *
 *   sharePolicy ∈ { 'private', 'workspace', 'public_link' }
 *
 * Server enforces validation; this just forwards the value.
 */
export async function updateDocSharePolicy(docId, sharePolicy) {
  if (!docId) throw new Error('docId is required');
  if (!sharePolicy) throw new Error('sharePolicy is required');
  const res = await api.patch(`/docs/${docId}`, { sharePolicy });
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

/**
 * Phase G follow-up — migrate an existing pre-collab doc to Y.js.
 * Snapshots the current contentJson to version history server-side, then
 * resets yjsState to a clean empty Y.doc + replaces contentJson with a
 * one-line migration notice. The user keeps everything via the version
 * history modal.
 *
 * Returns `{ doc, alreadyMigrated }`. `alreadyMigrated=true` is the
 * idempotent path when a doc already has yjsState set.
 */
export async function migrateDocToCollab(docId) {
  if (!docId) throw new Error('docId is required');
  const res = await api.post(`/docs/${docId}/migrate-to-collab`);
  return unwrap(res);
}

/**
 * Phase D Slice 1 — GET /api/docs/mentionable?workspaceId=…&q=…
 *
 * Returns the workspace-scoped users the caller can @-mention. Used by
 * RichTextEditor's mention extension via the `mentions.suggest(q)` prop.
 */
export async function listMentionableUsers(workspaceId, { q } = {}) {
  if (!workspaceId) throw new Error('workspaceId is required');
  const res = await api.get('/docs/mentionable', { params: { workspaceId, q } });
  return unwrap(res);
}

/**
 * Phase D Slice 2 — GET /api/docs/searchable-tasks?workspaceId=…&q=…
 *
 * Returns the workspace-scoped tasks the caller can reference inside a
 * doc. Used by RichTextEditor's task-chip extension via the
 * `tasks.suggest(q)` prop. Results capped server-side at 25.
 */
export async function listSearchableTasks(workspaceId, { q } = {}) {
  if (!workspaceId) throw new Error('workspaceId is required');
  const res = await api.get('/docs/searchable-tasks', { params: { workspaceId, q } });
  return unwrap(res);
}

/**
 * Phase D Slice 2 — GET /api/tasks/:id/doc-references
 *
 * Bidirectional companion to task chips: "which docs reference this task?"
 * Used by the upcoming TaskModal pill (Slice 2b).
 */
export async function getTaskDocReferences(taskId) {
  if (!taskId) throw new Error('taskId is required');
  const res = await api.get(`/tasks/${taskId}/doc-references`);
  return unwrap(res);
}

/**
 * Phase F — Notion/Google-Docs-style threaded comments anchored to a
 * snapshot of the selected doc text. The sidebar renders the result of
 * listDocComments(); the bubble + reply input post via addDocComment().
 *
 *   listDocComments(docId)             → { threads: [{ ...top, replies: [] }] }
 *   addDocComment(docId, payload)      → { comment }
 *   updateDocComment(docId, id, body)  → { comment }
 *   deleteDocComment(docId, id)        → { mode: 'hard' | 'soft', commentId }
 *   resolveDocComment(docId, id)       → { comment }
 *   unresolveDocComment(docId, id)     → { comment }
 */
export async function listDocComments(docId) {
  if (!docId) throw new Error('docId is required');
  const res = await api.get(`/docs/${docId}/comments`);
  return unwrap(res);
}

export async function addDocComment(docId, payload = {}) {
  if (!docId) throw new Error('docId is required');
  const { body, anchorText, anchorFrom, anchorTo, parentId } = payload;
  const res = await api.post(`/docs/${docId}/comments`, {
    body,
    anchorText,
    anchorFrom,
    anchorTo,
    parentId,
  });
  return unwrap(res);
}

export async function updateDocComment(docId, commentId, { body } = {}) {
  if (!docId || !commentId) throw new Error('docId and commentId are required');
  const res = await api.patch(`/docs/${docId}/comments/${commentId}`, { body });
  return unwrap(res);
}

export async function deleteDocComment(docId, commentId) {
  if (!docId || !commentId) throw new Error('docId and commentId are required');
  const res = await api.delete(`/docs/${docId}/comments/${commentId}`);
  return unwrap(res);
}

export async function resolveDocComment(docId, commentId) {
  if (!docId || !commentId) throw new Error('docId and commentId are required');
  const res = await api.post(`/docs/${docId}/comments/${commentId}/resolve`);
  return unwrap(res);
}

export async function unresolveDocComment(docId, commentId) {
  if (!docId || !commentId) throw new Error('docId and commentId are required');
  const res = await api.post(`/docs/${docId}/comments/${commentId}/unresolve`);
  return unwrap(res);
}

export default {
  listWorkspaceDocs,
  createDoc,
  getDoc,
  updateDoc,
  updateDocSharePolicy,
  archiveDoc,
  restoreDoc,
  listVersions,
  restoreVersion,
  migrateDocToCollab,
  listMentionableUsers,
  listSearchableTasks,
  getTaskDocReferences,
  listDocComments,
  addDocComment,
  updateDocComment,
  deleteDocComment,
  resolveDocComment,
  unresolveDocComment,
};
