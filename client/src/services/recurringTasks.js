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

// User-facing frequency catalogue. The legacy 'custom' value is intentionally
// NOT shown — it was an alias of 'weekly' and only created UX confusion. Old
// templates with frequency='custom' are surfaced as 'weekly' by
// `normalizeFrequencyForUI` below; they keep their selected weekdays and round-
// trip safely (the modal saves them back as 'weekly' on next edit).
export const FREQUENCIES = [
  { value: 'daily', label: 'Daily', hint: 'Every day' },
  { value: 'weekdays', label: 'Weekdays', hint: 'Mon – Sat' },
  { value: 'weekly', label: 'Weekly', hint: 'Choose days of the week' },
  { value: 'monthly', label: 'Monthly', hint: 'Choose date(s) each month' },
];

/**
 * Normalise a stored frequency value for UI rendering. The legacy 'custom'
 * frequency had identical semantics to 'weekly' (server-side
 * `isOccurrenceEligible` treats them the same), so the modal collapses them
 * onto the same picker — keeps existing rules editable without a backfill.
 */
export function normalizeFrequencyForUI(frequency) {
  if (frequency === 'custom') return 'weekly';
  return frequency || 'daily';
}

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
    // Prefer the modern multi-day array; fall back to the legacy single-day
    // integer for templates that pre-date multi-day support.
    const list = getMonthlyDaysFromTemplate(template);
    if (list.length === 0) return `Monthly at ${dueTime}${tzPart}`;
    if (list.length === 1) {
      const dom = list[0];
      return `Monthly on day ${dom}${ordinalSuffix(dom)} at ${dueTime}${tzPart}`;
    }
    return `Monthly on days ${list.join(', ')} at ${dueTime}${tzPart}`;
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

/**
 * Normalise a recurring template's monthly day configuration into a sorted,
 * deduped int[] (1–31). Mirrors the server-side helper in
 * recurringTaskService.getMonthlyDays — frontend code should never have to
 * worry about whether a template is using the new `daysOfMonth` array or the
 * legacy `dayOfMonth` integer.
 */
export function getMonthlyDaysFromTemplate(template) {
  if (!template) return [];
  const arr = Array.isArray(template.daysOfMonth) ? template.daysOfMonth : [];
  const cleaned = arr
    .map((d) => parseInt(d, 10))
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 31);
  if (cleaned.length > 0) {
    return [...new Set(cleaned)].sort((a, b) => a - b);
  }
  const legacy = parseInt(template.dayOfMonth, 10);
  if (Number.isInteger(legacy) && legacy >= 1 && legacy <= 31) return [legacy];
  return [];
}

/**
 * Build a structured schedule summary for the Recurring Work UI. Distinct
 * from `formatSchedule` (which is a one-line label for table rows) — this
 * returns the discrete pieces so the modal / detail panel can lay them out
 * with icons and labels:
 *
 *   { kind: 'Daily' | 'Weekdays' | 'Custom days' | 'Monthly', summary,
 *     days: string[]|null, dueTime, timezone, startDate, endDate }
 *
 * Frequency 'custom' is treated as 'Custom days' (alias of weekly).
 */
export function buildScheduleSummary(template) {
  if (!template) return null;
  const dueTime = formatDueTime12h(template.dueTime);
  const tz = template.timezone || 'UTC';
  const startDate = template.startDate || null;
  const endDate = template.endDate || null;
  const base = { dueTime, timezone: tz, startDate, endDate, days: null };

  switch (template.frequency) {
    case 'daily':
      return { ...base, kind: 'Daily', summary: 'Every day' };
    case 'weekdays':
      return { ...base, kind: 'Weekdays', summary: 'Mon – Sat (Sunday excluded)' };
    case 'weekly':
    case 'custom': {
      const list = (Array.isArray(template.weekdays) ? template.weekdays : [])
        .map((d) => WEEKDAY_LABELS[d])
        .filter(Boolean);
      return {
        ...base,
        kind: 'Custom days',
        summary: list.length ? list.join(', ') : 'No weekdays selected',
        days: list,
      };
    }
    case 'monthly': {
      const list = getMonthlyDaysFromTemplate(template);
      const labelled = list.map((d) => `Day ${d}`);
      return {
        ...base,
        kind: 'Monthly',
        summary: labelled.length ? labelled.join(', ') : 'No days selected',
        days: labelled,
      };
    }
    default:
      return { ...base, kind: template.frequency || '—', summary: template.frequency || '' };
  }
}

/** "1" → "st", "2" → "nd", "3" → "rd", everything else → "th". Locale-agnostic. */
function ordinalSuffix(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return 'th';
  switch (n % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
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
  getMonthlyDaysFromTemplate,
  normalizeFrequencyForUI,
  buildScheduleSummary,
};
