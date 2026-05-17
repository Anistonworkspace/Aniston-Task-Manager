import api from './api';

/**
 * AI Summary Service (Plan A Slice 2) — client wrappers around the
 * one-shot AI endpoints.
 *
 *   summarizeTask(taskId)                                → { summary }
 *   summarizeBoard(boardId)                              → { summary }
 *   suggestPriority({ taskTitle, taskDescription, boardId? })
 *                                                        → { priority, reason, suggestedDueDate? }
 *   planWeek({ taskIds? })                               → { schedule, notes }
 *
 * Every call returns `data` unwrapped — the Axios interceptor already
 * unwraps `{ success, data }`, but we double-tolerate older shapes (some
 * endpoints in this codebase still return `{ data: { ... } }` directly).
 *
 * Errors propagate as-is so callers can route them through `getErrorMessage`.
 */

function unwrap(res) {
  const data = res?.data?.data ?? res?.data ?? null;
  return data || {};
}

export async function summarizeTask(taskId, { providerId } = {}) {
  if (!taskId) throw new Error('taskId is required');
  const res = await api.post(`/ai/summarize/task/${taskId}`, providerId ? { providerId } : {});
  return unwrap(res);
}

export async function summarizeBoard(boardId, { providerId } = {}) {
  if (!boardId) throw new Error('boardId is required');
  const res = await api.post(`/ai/summarize/board/${boardId}`, providerId ? { providerId } : {});
  return unwrap(res);
}

export async function summarizeDoc(docId, { providerId } = {}) {
  if (!docId) throw new Error('docId is required');
  const res = await api.post(`/ai/summarize/doc/${docId}`, providerId ? { providerId } : {});
  return unwrap(res);
}

export async function suggestPriority({ taskTitle, taskDescription, boardId, providerId } = {}) {
  if (!taskTitle) throw new Error('taskTitle is required');
  const res = await api.post('/ai/suggest-priority', {
    taskTitle, taskDescription, boardId, providerId,
  });
  return unwrap(res);
}

export async function planWeek({ taskIds, providerId } = {}) {
  const res = await api.post('/ai/plan-week', {
    taskIds: Array.isArray(taskIds) ? taskIds : undefined,
    providerId,
  });
  return unwrap(res);
}

/**
 * Notetaker — extract action items from a transcript.
 *
 * Returns { kind: 'structured', actions: [{ title, owner, dueDate, priority }] }.
 * `owner` is a free-text name the model heard ("Sara") — the caller is
 * responsible for resolving to a real user ID when creating tasks.
 */
export async function extractActions({ text, providerId } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('text is required');
  }
  const res = await api.post('/ai/extract-actions', { text, providerId });
  return unwrap(res);
}

/**
 * Phase E — "select text in editor → AI transform".
 *
 * Modes: 'improve' | 'shorter' | 'longer' | 'grammar' | 'continue' |
 *        'casual' | 'professional'
 *
 * Returns { kind: 'text', mode, output } where `output` is the cleaned
 * text the caller should swap into the editor's selection.
 */
export async function transformInline({ text, mode, providerId } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('text is required');
  }
  if (typeof mode !== 'string' || !mode.trim()) {
    throw new Error('mode is required');
  }
  const res = await api.post('/ai/inline-edit', { text, mode, providerId });
  return unwrap(res);
}

export default {
  summarizeTask,
  summarizeBoard,
  summarizeDoc,
  suggestPriority,
  planWeek,
  transformInline,
  extractActions,
};
