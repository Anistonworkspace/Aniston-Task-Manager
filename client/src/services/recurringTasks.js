/**
 * Recurring tasks (Daily Work) — API helpers.
 *
 * Thin wrappers over the shared axios instance so callers don't have to
 * remember exact paths, and so the response-unwrapping shape (controller
 * responses are { success, data: { template, ... } }; the response
 * interceptor in api.js merges `data` into `response.data`) is handled in one
 * place.
 *
 * Backend contract: see server/routes/recurringTasks.js.
 *
 * NOT to be confused with the legacy per-task recurrence (`Task.recurrence`
 * JSONB) handled by /api/task-extras/:id/recurrence — that path is
 * preserved for backward compatibility but new work goes through here.
 */

import api from './api';

function unwrap(res) {
  // api.js merges response.data.data into response.data so both shapes are safe.
  return res?.data?.template ?? res?.data?.data?.template ?? res?.data ?? null;
}

function unwrapList(res) {
  return res?.data?.templates ?? res?.data?.data?.templates ?? [];
}

function unwrapInstances(res) {
  return res?.data?.instances ?? res?.data?.data?.instances ?? [];
}

/** GET /api/recurring-tasks */
export async function listTemplates(params = {}) {
  const res = await api.get('/recurring-tasks', { params });
  return unwrapList(res);
}

/** GET /api/recurring-tasks/:id — also returns recent instances */
export async function getTemplate(id) {
  const res = await api.get(`/recurring-tasks/${id}`);
  return {
    template: unwrap(res),
    instances: unwrapInstances(res),
  };
}

/**
 * POST /api/recurring-tasks
 *
 * Returns `{ template, immediateGeneration }` where `immediateGeneration` is
 * `{ generated, alreadyExisted, occurrenceDate, nextRunAt }`. The server runs
 * a same-request generation pass so today's task lands immediately when
 * eligible — callers should branch their toast / refetch on
 * `immediateGeneration.generated`.
 */
export async function createTemplate(payload) {
  const res = await api.post('/recurring-tasks', payload);
  // The response interceptor in api.js merges response.data.data into
  // response.data, so both shapes are reachable. Pull both fields explicitly
  // so the caller never has to remember the wrapping rules.
  const template = res?.data?.template ?? res?.data?.data?.template ?? null;
  const immediateGeneration = res?.data?.immediateGeneration
    ?? res?.data?.data?.immediateGeneration
    ?? { generated: false, alreadyExisted: false, occurrenceDate: null };
  return { template, immediateGeneration };
}

/** PATCH /api/recurring-tasks/:id */
export async function updateTemplate(id, payload) {
  const res = await api.patch(`/recurring-tasks/${id}`, payload);
  return unwrap(res);
}

/** POST /api/recurring-tasks/:id/pause */
export async function pauseTemplate(id) {
  const res = await api.post(`/recurring-tasks/${id}/pause`);
  return unwrap(res);
}

/** POST /api/recurring-tasks/:id/resume */
export async function resumeTemplate(id) {
  const res = await api.post(`/recurring-tasks/${id}/resume`);
  return unwrap(res);
}

/** POST /api/recurring-tasks/:id/archive (also reachable as DELETE) */
export async function archiveTemplate(id) {
  const res = await api.post(`/recurring-tasks/${id}/archive`);
  return unwrap(res);
}

/** POST /api/recurring-tasks/:id/generate-now (admin only). */
export async function generateNow(id) {
  const res = await api.post(`/recurring-tasks/${id}/generate-now`);
  return res?.data?.result ?? res?.data?.data?.result ?? res?.data ?? null;
}

// ─── Frequency / weekday helpers used by the UI ─────────────────────────────

export const FREQUENCIES = [
  { value: 'daily', label: 'Daily', hint: 'Every day' },
  { value: 'weekdays', label: 'Weekdays', hint: 'Mon – Fri' },
  { value: 'weekly', label: 'Weekly', hint: 'Pick days of the week' },
  { value: 'monthly', label: 'Monthly', hint: 'On a specific day each month' },
  { value: 'custom', label: 'Custom', hint: 'Custom day-of-week pattern' },
];

// Match the schema convention: 0 = Sunday … 6 = Saturday.
export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const ESCALATION_TARGETS = [
  { value: 'assignee', label: 'Assignee' },
  { value: 'manager', label: 'Direct manager(s)' },
  { value: 'admin', label: 'Admin / super-admin' },
];

/**
 * Build a short human-readable schedule string for list views.
 * E.g. "Daily at 6:00 PM (Asia/Kolkata)" or "Mon · Wed · Fri at 9:30 AM".
 */
export function formatSchedule(template) {
  if (!template) return '';
  const dueTime = formatDueTime12h(template.dueTime);
  const tzPart = template.timezone && template.timezone !== 'UTC' ? ` (${template.timezone})` : '';
  if (template.frequency === 'daily') return `Daily at ${dueTime}${tzPart}`;
  if (template.frequency === 'weekdays') return `Weekdays at ${dueTime}${tzPart}`;
  if (template.frequency === 'weekly' || template.frequency === 'custom') {
    const days = (Array.isArray(template.weekdays) ? template.weekdays : [])
      .map(d => WEEKDAY_LABELS[d])
      .join(' · ');
    return `${days || '—'} at ${dueTime}${tzPart}`;
  }
  if (template.frequency === 'monthly') {
    const dom = template.dayOfMonth || '—';
    const suffix = ['th','st','nd','rd'][((dom - 1) % 10 < 4 && Math.floor((dom - 1) % 100 / 10) !== 1) ? Math.min((dom - 1) % 10 + 1, 3) : 0];
    return `Day ${dom}${suffix} of each month at ${dueTime}${tzPart}`;
  }
  return template.frequency;
}

export function formatDueTime12h(dueTime) {
  if (!dueTime) return '—';
  const m = String(dueTime).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return dueTime;
  let h = parseInt(m[1], 10);
  const mm = m[2];
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = ((h + 11) % 12) + 1;
  return `${h}:${mm} ${ampm}`;
}

/** "HH:mm" (24h) — used to populate <input type="time"> from server "HH:mm:ss". */
export function dueTimeToInputValue(dueTime) {
  if (!dueTime) return '18:00';
  const m = String(dueTime).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '18:00';
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

export default {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  pauseTemplate,
  resumeTemplate,
  archiveTemplate,
  generateNow,
  FREQUENCIES,
  WEEKDAY_LABELS,
  ESCALATION_TARGETS,
  formatSchedule,
  formatDueTime12h,
  dueTimeToInputValue,
};
