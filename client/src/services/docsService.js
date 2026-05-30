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

/**
 * feat/docs-personal-notion Phase 2 — personal docs surface.
 *
 *   listMyDocs({ q, archived, filter })   → GET  /api/docs
 *   createDoc({ title, contentJson })     → POST /api/docs
 *
 * `filter` ∈ 'all' | 'owned' | 'shared' | 'mentioned' (Phase 3+ surfaces
 *  'shared' / 'mentioned' in the UI; the backend recognises 'owned' today).
 */
export async function listMyDocs({ q, archived, filter } = {}) {
  const params = {};
  if (q) params.q = q;
  if (archived) params.archived = '1';
  if (filter) params.filter = filter;
  const res = await api.get('/docs', { params });
  return unwrap(res);
}

export async function createDoc({ title, contentJson, contentFormat } = {}) {
  const body = {};
  if (title !== undefined) body.title = title;
  if (contentJson !== undefined) body.contentJson = contentJson;
  if (contentFormat !== undefined) body.contentFormat = contentFormat;
  const res = await api.post('/docs', body);
  return unwrap(res);
}

/**
 * Backward-compat shim: `listWorkspaceDocs(workspaceId, opts)` is now a
 * thin wrapper around `listMyDocs(opts)` — the workspaceId argument is
 * ignored, since the backend endpoint is no longer workspace-scoped. The
 * shim is kept so any caller that hasn't migrated yet (e.g. existing
 * tests, third-party scripts) keeps working with a single param flip.
 */
export async function listWorkspaceDocs(_workspaceId, opts = {}) {
  return listMyDocs(opts);
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
 * Phase 3+8 — manual share / collaborator management.
 *
 *   listCollaborators(docId)                   → GET    /api/docs/:id/collaborators
 *   addCollaborator(docId, { userId, accessLevel? })  → POST   ...
 *   updateCollaborator(docId, userId, accessLevel)    → PATCH  .../:userId
 *   removeCollaborator(docId, userId)          → DELETE .../:userId
 *
 * Owner-only mutations server-side; the Share panel hides the controls
 * when callerAccessLevel !== 'owner'. Mention-derived rows have
 * source='mention' and are best removed by editing the doc body instead
 * of revoking here (Phase 5 safe-rule).
 */
export async function listCollaborators(docId) {
  if (!docId) throw new Error('docId is required');
  const res = await api.get(`/docs/${docId}/collaborators`);
  return unwrap(res);
}

export async function addCollaborator(docId, { userId, accessLevel = 'comment' } = {}) {
  if (!docId) throw new Error('docId is required');
  if (!userId) throw new Error('userId is required');
  const res = await api.post(`/docs/${docId}/collaborators`, { userId, accessLevel });
  return unwrap(res);
}

export async function updateCollaboratorLevel(docId, userId, accessLevel) {
  if (!docId || !userId) throw new Error('docId and userId are required');
  if (!accessLevel) throw new Error('accessLevel is required');
  const res = await api.patch(`/docs/${docId}/collaborators/${userId}`, { accessLevel });
  return unwrap(res);
}

export async function removeCollaborator(docId, userId) {
  if (!docId || !userId) throw new Error('docId and userId are required');
  const res = await api.delete(`/docs/${docId}/collaborators/${userId}`);
  return unwrap(res);
}

/**
 * Phase 4 — global active-user mention search.
 *
 *   listMentionableUsers({ q, limit })  → GET /api/users/mentions
 *
 * Backward-compat shim: the previous signature was
 * `listMentionableUsers(workspaceId, { q })` (Phase D Slice 1). The
 * `workspaceId` argument is no longer used — per decision 17.5 any active
 * user can mention any active user across the whole app. We accept both
 * shapes so existing callers (and tests) keep working:
 *
 *   listMentionableUsers({ q: 'sa' })            // new
 *   listMentionableUsers('w1', { q: 'sa' })      // legacy — workspaceId ignored
 *   listMentionableUsers()                       // returns top 15 by name
 */
export async function listMentionableUsers(workspaceIdOrOpts, maybeOpts) {
  const opts = (typeof workspaceIdOrOpts === 'string' || workspaceIdOrOpts == null)
    ? (maybeOpts || {})
    : workspaceIdOrOpts;
  const params = {};
  if (opts.q !== undefined && opts.q !== null && opts.q !== '') params.q = opts.q;
  if (opts.limit !== undefined && opts.limit !== null) params.limit = opts.limit;
  const res = await api.get('/users/mentions', { params });
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
  listMyDocs,
  listWorkspaceDocs, // backward-compat shim
  createDoc,
  getDoc,
  // Phase 8 — share panel
  listCollaborators,
  addCollaborator,
  updateCollaboratorLevel,
  removeCollaborator,
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
