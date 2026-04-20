/**
 * Calendar Sync Service — One-way: App task → Microsoft 365 calendar.
 *
 * Uses Microsoft Graph Application permissions (client credentials) via
 * `/users/{teamsUserId}/events`. Never uses delegated `/me/events`.
 *
 * Single responsibility for task calendar sync. The parallel
 * `teamsCalendarService.js` is used by the Director Plan module only.
 *
 * Sync state on Task:
 *   - teamsEventId          → Graph event id
 *   - teamsCalendarUserId   → Graph user id (mailbox) the event lives on
 *   - syncStatus            → not_synced | pending | synced | failed | skipped
 *   - lastSyncedAt          → last successful sync timestamp
 *   - syncError             → last error message (null on success)
 *   - syncAttempts          → consecutive failed attempts (reset to 0 on success)
 *
 * Old-task attach policy:
 *   Only attach when exactly one Graph event matches via the
 *   AnistonTaskId singleValueExtendedProperty. Never attach by fuzzy
 *   title/date match — that can falsely match unrelated events and
 *   later cause wrong-event deletion.
 */
const axios = require('axios');
const { User, Task, Board } = require('../models');
const { getTeamsConfig } = require('../config/teams');
const { getAppToken } = require('./teamsUserSync');
const logger = require('../utils/logger');

// Note: we do NOT write to the Activity table for calendar sync outcomes —
// Activity.userId is NOT NULL and sync events are system-driven, not user-driven.
// The durable audit trail lives on the Task row itself (syncStatus / lastSyncedAt
// / syncError / syncAttempts) plus structured winston logs.

// ── App identity markers embedded in every event we create ────────────────
// Stable UUID namespace for Graph singleValueExtendedProperty. Do NOT change —
// existing events in production carry this id and future attach logic relies on it.
const EXT_NAMESPACE_GUID = 'a64d2e5c-7e3d-4f55-a39e-5b7f2c9d4a80';
const EXT_TASK_ID_NAME = 'AnistonTaskId';
const EXT_TASK_ID = `String {${EXT_NAMESPACE_GUID}} Name ${EXT_TASK_ID_NAME}`;
const APP_SOURCE_LABEL = 'Aniston Hub Task Sync';
const MAX_RETRY_ATTEMPTS = 3;

// In-memory cache for calendar view fetches (5-minute TTL)
const calendarCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Record the outcome of a sync operation on the task row.
 * Fire-and-forget from the caller's perspective — failures here are logged
 * but never thrown, because we don't want sync bookkeeping to crash task CRUD.
 */
async function updateSyncState(taskId, patch) {
  try {
    await Task.update(patch, { where: { id: taskId } });
  } catch (err) {
    logger.warn('[Calendar] updateSyncState failed', { taskId, err: err.message });
  }
}

function buildEventSubject(task) {
  const base = `[Aniston Hub] ${task.title}`;
  return task.status === 'done' ? `[DONE] ${base}` : base;
}

function buildEventBody(task, board) {
  const taskUrl = `${process.env.CLIENT_URL || 'http://localhost:3000'}/boards/${task.boardId}`;
  return {
    contentType: 'HTML',
    content: `
<div>
  <b>Task:</b> ${escapeHtml(task.title)}<br>
  <b>Board:</b> ${escapeHtml(board?.name || 'N/A')}<br>
  <b>Priority:</b> ${escapeHtml(task.priority || '')}<br>
  <b>Status:</b> ${escapeHtml(task.status || '')}<br>
  ${task.description ? `<b>Description:</b> ${escapeHtml(task.description)}<br>` : ''}
  <br><a href="${taskUrl}">Open in Aniston Hub</a>
</div>
<!-- ${APP_SOURCE_LABEL} | taskId: ${task.id} -->
    `.trim(),
  };
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Resolve the event's Graph time window from task fields.
 *
 * Priority:
 *   1. plannedStartTime + plannedEndTime → precise timed event.
 *   2. plannedStartTime only → 1-hour timed event at that start.
 *   3. dueDate (date-only, with optional startDate) → multi-day all-day block.
 *      The block spans from the task's "working window start" through dueDate.
 *      Working-window start is resolved as:
 *        - task.startDate if present,
 *        - otherwise the task's createdAt date (so newly-created tasks are
 *          immediately visible in today's calendar view rather than only on
 *          the due date).
 *      Capped to max WINDOW_DAYS_CAP days to avoid very long tasks painting
 *      huge blocks across the calendar.
 *      Graph all-day requirements:
 *        - start/end must both be at midnight in their time zone
 *        - end is EXCLUSIVE (midnight of the day AFTER the last visible day)
 *        - isAllDay: true
 *   4. No dates at all → 1-hour timed event starting now (edge case).
 *
 * Returns `{ startISO, endISO, isAllDay }`.
 *
 * Regression history:
 *   - v1 (pre-fix): dueDate-only tasks collapsed into a 1-hour sliver at
 *     midnight UTC — invisible in Teams month view. Fixed.
 *   - v2 (previous): dueDate-only tasks became a single-day all-day event
 *     only on the due date — correct semantically, but users used to seeing
 *     the task span "from today until due" (old timed-event behavior) could
 *     not find newly-created tasks in today's/near-term calendar view.
 *   - v3 (current): dueDate-only tasks span createdAt → dueDate as a
 *     multi-day all-day block, matching pre-change visibility while using
 *     the correct all-day semantics.
 */
const WINDOW_DAYS_CAP = 60;

function resolveEventWindow(task) {
  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;

  // 1. Both planned times → precise timed event.
  if (task.plannedStartTime && task.plannedEndTime) {
    const s = new Date(task.plannedStartTime).getTime();
    let e = new Date(task.plannedEndTime).getTime();
    if (!(e > s)) e = s + HOUR_MS;
    return { startISO: new Date(s).toISOString(), endISO: new Date(e).toISOString(), isAllDay: false };
  }
  // 2. Only plannedStartTime → 1h timed event.
  if (task.plannedStartTime) {
    const s = new Date(task.plannedStartTime).getTime();
    return { startISO: new Date(s).toISOString(), endISO: new Date(s + HOUR_MS).toISOString(), isAllDay: false };
  }
  // 3. Date-only task → multi-day all-day event from working-window start to dueDate.
  if (task.dueDate) {
    const dueMidnightUtc = new Date(`${task.dueDate}T00:00:00.000Z`).getTime();
    // Resolve working-window start:
    //   startDate (if set) > createdAt date (if before due) > dueDate itself
    let startMidnightUtc;
    if (task.startDate) {
      startMidnightUtc = new Date(`${task.startDate}T00:00:00.000Z`).getTime();
    } else if (task.createdAt) {
      const c = new Date(task.createdAt);
      startMidnightUtc = Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate());
    } else {
      startMidnightUtc = dueMidnightUtc;
    }
    // Safety clamps:
    //   - start must not be after due (fallback to due if it is)
    //   - cap span at WINDOW_DAYS_CAP days to avoid huge blocks
    if (startMidnightUtc > dueMidnightUtc) startMidnightUtc = dueMidnightUtc;
    const minStart = dueMidnightUtc - (WINDOW_DAYS_CAP - 1) * DAY_MS;
    if (startMidnightUtc < minStart) startMidnightUtc = minStart;
    const endExclusiveUtc = dueMidnightUtc + DAY_MS;
    return {
      startISO: new Date(startMidnightUtc).toISOString(),
      endISO: new Date(endExclusiveUtc).toISOString(),
      isAllDay: true,
    };
  }
  // 4. Nothing to anchor to — default to "now, 1 hour" (rare).
  const now = Date.now();
  return { startISO: new Date(now).toISOString(), endISO: new Date(now + HOUR_MS).toISOString(), isAllDay: false };
}

function buildCreatePayload(task, board) {
  const { startISO, endISO, isAllDay } = resolveEventWindow(task);
  const payload = {
    subject: buildEventSubject(task),
    body: buildEventBody(task, board),
    start: { dateTime: startISO, timeZone: 'UTC' },
    end: { dateTime: endISO, timeZone: 'UTC' },
    isAllDay,
    categories: [APP_SOURCE_LABEL, task.priority || 'medium'],
    singleValueExtendedProperties: [
      { id: EXT_TASK_ID, value: String(task.id) },
    ],
  };
  // All-day events don't support per-minute reminders in Graph (reminder is
  // relative to the start-of-day). Only attach a reminder for timed events.
  if (!isAllDay) {
    payload.isReminderOn = true;
    payload.reminderMinutesBeforeStart = 30;
  }
  return payload;
}

function buildPatchPayload(task, board) {
  const { startISO, endISO, isAllDay } = resolveEventWindow(task);
  return {
    subject: buildEventSubject(task),
    body: buildEventBody(task, board),
    start: { dateTime: startISO, timeZone: 'UTC' },
    end: { dateTime: endISO, timeZone: 'UTC' },
    isAllDay,
    categories: [APP_SOURCE_LABEL, task.priority || 'medium'],
  };
}

function graphErrorMessage(err) {
  return (
    err?.response?.data?.error?.message
    || err?.message
    || 'Unknown Graph error'
  );
}

function graphStatus(err) {
  return err?.response?.status || 0;
}

/**
 * Load task + its board in one query. Returns null if task missing.
 */
async function loadTaskWithBoard(taskId) {
  return Task.findByPk(taskId, {
    include: [{ model: Board, as: 'board', attributes: ['id', 'name'] }],
  });
}

/**
 * Resolve the mailbox Azure AD user id to use for a given app-user id.
 * Returns null if teams not configured, user missing, or teamsUserId not set.
 */
async function resolveMailboxContext(appUserId) {
  const teamsConfig = await getTeamsConfig();
  if (!teamsConfig.isConfigured) {
    return { skipReason: 'teams_not_configured' };
  }
  if (!appUserId) {
    return { skipReason: 'no_assignee' };
  }
  const user = await User.findByPk(appUserId, {
    attributes: ['id', 'name', 'teamsUserId'],
  });
  if (!user) return { skipReason: 'user_not_found' };
  if (!user.teamsUserId) {
    return { skipReason: 'user_not_synced_to_m365' };
  }
  return { teamsConfig, user, teamsUserId: user.teamsUserId };
}

/**
 * Safe old-task attach: query the mailbox for an event carrying our
 * AnistonTaskId extended property. Returns eventId only if exactly one match.
 */
async function findEventByExtendedTaskId({ graphUrl, teamsUserId, taskId, token }) {
  try {
    const filter = `singleValueExtendedProperties/Any(ep: ep/id eq '${EXT_TASK_ID}' and ep/value eq '${taskId}')`;
    const url = `${graphUrl}/users/${teamsUserId}/events`
      + `?$filter=${encodeURIComponent(filter)}`
      + `&$select=id,subject`
      + `&$top=2`;
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const matches = res.data?.value || [];
    if (matches.length === 1) return matches[0].id;
    // 0 matches → no attach candidate. >1 matches → ambiguous, refuse to attach.
    if (matches.length > 1) {
      logger.warn('[Calendar] attach skipped — multiple candidates', {
        taskId, teamsUserId, count: matches.length,
      });
    }
    return null;
  } catch (err) {
    logger.warn('[Calendar] findEventByExtendedTaskId failed', {
      taskId, err: graphErrorMessage(err), status: graphStatus(err),
    });
    return null;
  }
}

/**
 * Structured sync-outcome log. Winston-only — no DB write.
 * Keep the key names stable so downstream log pipelines can filter.
 */
function logSyncActivity(taskId, boardId, action, detail) {
  const level = action.endsWith('_failed') ? 'error' : 'info';
  logger[level]('[CalendarSync]', { taskId, boardId, action, detail });
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Get a valid access token for a user (delegated flow — kept for legacy callers).
 * Not used by task sync. Task sync uses the app-level `getAppToken()`.
 */
async function getAccessToken(userId) {
  const user = await User.findByPk(userId);
  if (!user || !user.teamsAccessToken) return null;

  if (user.teamsTokenExpiry && new Date(user.teamsTokenExpiry) < new Date(Date.now() + 5 * 60 * 1000)) {
    if (!user.teamsRefreshToken) return null;
    try {
      const teamsConfig = await getTeamsConfig();
      const res = await axios.post(`${teamsConfig.authUrl}/token`, new URLSearchParams({
        client_id: teamsConfig.clientId,
        client_secret: teamsConfig.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: user.teamsRefreshToken,
      }).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      await user.update({
        teamsAccessToken: res.data.access_token,
        teamsRefreshToken: res.data.refresh_token || user.teamsRefreshToken,
        teamsTokenExpiry: new Date(Date.now() + res.data.expires_in * 1000),
      });

      return res.data.access_token;
    } catch (err) {
      logger.error('[Calendar] Delegated token refresh failed', { userId, err: err.response?.data || err.message });
      return null;
    }
  }

  return user.teamsAccessToken;
}

/**
 * Create OR attach a Graph calendar event for a task.
 * Idempotent: safe to call multiple times. Will not create duplicates.
 *
 * Returns the Graph event id on success, or null on skip/failure.
 */
async function createTaskEvent(taskId, userId) {
  const ctx = await resolveMailboxContext(userId);
  if (ctx.skipReason) {
    await updateSyncState(taskId, {
      syncStatus: 'skipped',
      syncError: ctx.skipReason,
    });
    return null;
  }
  const { teamsConfig, user, teamsUserId } = ctx;

  const task = await loadTaskWithBoard(taskId);
  if (!task) return null;

  // Idempotency — if already mapped to this mailbox, do nothing.
  if (task.teamsEventId && task.teamsCalendarUserId === teamsUserId) {
    logger.debug('[Calendar] createTaskEvent — already synced, skipping duplicate create', { taskId });
    return task.teamsEventId;
  }

  let token;
  try {
    token = await getAppToken();
  } catch (err) {
    logger.warn('[Calendar] getAppToken failed', { taskId, err: err.message });
    await updateSyncState(taskId, {
      syncStatus: 'failed',
      syncError: `app_token: ${err.message}`,
      syncAttempts: (task.syncAttempts || 0) + 1,
    });
    return null;
  }

  // Safe attach for pre-existing mapping-less tasks.
  const existing = await findEventByExtendedTaskId({
    graphUrl: teamsConfig.graphUrl, teamsUserId, taskId, token,
  });
  if (existing) {
    await updateSyncState(taskId, {
      teamsEventId: existing,
      teamsCalendarUserId: teamsUserId,
      syncStatus: 'synced',
      lastSyncedAt: new Date(),
      syncError: null,
      syncAttempts: 0,
    });
    logger.info('[Calendar] Attached existing event to task', { taskId, eventId: existing });
    logSyncActivity(taskId, task.boardId, 'attached', `"${task.title}" attached to existing event ${existing} in ${user.name}'s mailbox`);
    return existing;
  }

  // Create new event.
  try {
    const res = await axios.post(
      `${teamsConfig.graphUrl}/users/${teamsUserId}/events`,
      buildCreatePayload(task, task.board),
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    const eventId = res.data.id;
    await updateSyncState(taskId, {
      teamsEventId: eventId,
      teamsCalendarUserId: teamsUserId,
      syncStatus: 'synced',
      lastSyncedAt: new Date(),
      syncError: null,
      syncAttempts: 0,
    });
    logger.info('[Calendar] Event created', { taskId, eventId, mailbox: user.name });
    logSyncActivity(taskId, task.boardId, 'created', `"${task.title}" synced to ${user.name}'s calendar`);
    return eventId;
  } catch (err) {
    const msg = graphErrorMessage(err);
    logger.error('[Calendar] Create event failed', { taskId, err: msg, status: graphStatus(err) });
    await updateSyncState(taskId, {
      syncStatus: 'failed',
      syncError: `create: ${msg}`,
      syncAttempts: (task.syncAttempts || 0) + 1,
    });
    logSyncActivity(taskId, task.boardId, 'create_failed', `"${task.title}" — ${msg}`);
    return null;
  }
}

/**
 * Update a Graph calendar event for a task.
 * If the task has no mapping yet (old task), falls back to create-or-attach.
 * If the remote event is gone (404), clears the mapping and recreates.
 */
async function updateTaskEvent(taskId, userId) {
  const task = await loadTaskWithBoard(taskId);
  if (!task) return null;

  // No mapping → treat as create-or-attach path.
  if (!task.teamsEventId) {
    return createTaskEvent(taskId, userId);
  }

  // Always target the mailbox the event actually lives on, NOT the current assignee.
  // (Assignee may have changed since the event was created.)
  const mailboxUserId = task.teamsCalendarUserId;
  if (!mailboxUserId) {
    // Have an eventId but no mailbox stored → legacy state. Best effort: use current assignee.
    logger.warn('[Calendar] teamsEventId set without teamsCalendarUserId — legacy state', { taskId });
  }

  const teamsConfig = await getTeamsConfig();
  if (!teamsConfig.isConfigured) {
    await updateSyncState(taskId, { syncStatus: 'skipped', syncError: 'teams_not_configured' });
    return null;
  }

  let targetMailbox = mailboxUserId;
  if (!targetMailbox) {
    const ctx = await resolveMailboxContext(userId);
    if (ctx.skipReason) {
      await updateSyncState(taskId, { syncStatus: 'skipped', syncError: ctx.skipReason });
      return null;
    }
    targetMailbox = ctx.teamsUserId;
  }

  let token;
  try {
    token = await getAppToken();
  } catch (err) {
    await updateSyncState(taskId, {
      syncStatus: 'failed',
      syncError: `app_token: ${err.message}`,
      syncAttempts: (task.syncAttempts || 0) + 1,
    });
    return null;
  }

  try {
    await axios.patch(
      `${teamsConfig.graphUrl}/users/${targetMailbox}/events/${task.teamsEventId}`,
      buildPatchPayload(task, task.board),
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    await updateSyncState(taskId, {
      syncStatus: 'synced',
      lastSyncedAt: new Date(),
      syncError: null,
      syncAttempts: 0,
    });
    logger.info('[Calendar] Event updated', { taskId, eventId: task.teamsEventId });
    logSyncActivity(taskId, task.boardId, 'updated', `"${task.title}" updated`);
    return task.teamsEventId;
  } catch (err) {
    const status = graphStatus(err);
    const msg = graphErrorMessage(err);
    // Event gone remotely → clear mapping and recreate.
    if (status === 404 || /ErrorItemNotFound/i.test(msg)) {
      logger.warn('[Calendar] Event missing remotely, clearing mapping and recreating', { taskId, eventId: task.teamsEventId });
      await updateSyncState(taskId, {
        teamsEventId: null,
        teamsCalendarUserId: null,
        syncStatus: 'pending',
        syncError: 'remote_missing_recreating',
      });
      return createTaskEvent(taskId, userId);
    }
    logger.error('[Calendar] Update event failed', { taskId, err: msg, status });
    await updateSyncState(taskId, {
      syncStatus: 'failed',
      syncError: `update: ${msg}`,
      syncAttempts: (task.syncAttempts || 0) + 1,
    });
    logSyncActivity(taskId, task.boardId, 'update_failed', `"${task.title}" — ${msg}`);
    return null;
  }
}

/**
 * Delete a Graph calendar event for a task.
 *
 * Safety contract:
 *   - If teamsEventId exists → DELETE it (tolerate 404).
 *   - If teamsEventId missing → attempt ONE high-confidence attach by extension
 *     property. Only delete if a single matching event is found. Otherwise, skip
 *     the remote delete entirely — we will NOT guess based on title/date.
 *
 * `userId` is the app user id whose mailbox we should check. Usually the task's
 * current (or previous) assignee.
 */
async function deleteTaskEvent(taskId, userId) {
  const task = await Task.findByPk(taskId);
  if (!task) return;

  const teamsConfig = await getTeamsConfig();
  if (!teamsConfig.isConfigured) return;

  // Resolve mailbox: stored > userId lookup.
  let teamsUserId = task.teamsCalendarUserId;
  let userName = null;
  if (!teamsUserId && userId) {
    const ctx = await resolveMailboxContext(userId);
    if (ctx.skipReason) {
      logger.debug('[Calendar] deleteTaskEvent — mailbox unresolvable, skipping remote delete', {
        taskId, reason: ctx.skipReason,
      });
      return;
    }
    teamsUserId = ctx.teamsUserId;
    userName = ctx.user.name;
  }

  if (!teamsUserId) {
    logger.debug('[Calendar] deleteTaskEvent — no mailbox context', { taskId });
    return;
  }

  let token;
  try {
    token = await getAppToken();
  } catch (err) {
    logger.warn('[Calendar] deleteTaskEvent — app token failed', { taskId, err: err.message });
    return;
  }

  let eventId = task.teamsEventId;

  // Old-task path: attempt safe attach-by-extension-property.
  if (!eventId) {
    eventId = await findEventByExtendedTaskId({
      graphUrl: teamsConfig.graphUrl, teamsUserId, taskId, token,
    });
    if (!eventId) {
      logger.info('[Calendar] deleteTaskEvent — no remote event found for unmapped task, skipping', { taskId });
      logSyncActivity(taskId, task.boardId, 'delete_skipped', `"${task.title}" — no mapped event, remote skip (safe)`);
      return;
    }
    logger.info('[Calendar] deleteTaskEvent — attached and deleting old-task event', { taskId, eventId });
  }

  try {
    await axios.delete(
      `${teamsConfig.graphUrl}/users/${teamsUserId}/events/${eventId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    await updateSyncState(taskId, {
      teamsEventId: null,
      teamsCalendarUserId: null,
      syncStatus: 'not_synced',
      syncError: null,
      lastSyncedAt: new Date(),
    });
    logger.info('[Calendar] Event deleted', { taskId, eventId, mailbox: userName || teamsUserId });
    logSyncActivity(taskId, task.boardId, 'deleted', `"${task.title}" removed from calendar`);
  } catch (err) {
    const status = graphStatus(err);
    const msg = graphErrorMessage(err);
    // Already gone — treat as success.
    if (status === 404 || /ErrorItemNotFound/i.test(msg)) {
      await updateSyncState(taskId, {
        teamsEventId: null,
        teamsCalendarUserId: null,
        syncStatus: 'not_synced',
        syncError: null,
      });
      logger.info('[Calendar] Event already gone remotely, cleared mapping', { taskId, eventId });
      return;
    }
    logger.error('[Calendar] Delete event failed', { taskId, err: msg, status });
    // Keep the mapping so retry job can try again later.
    await updateSyncState(taskId, {
      syncStatus: 'failed',
      syncError: `delete: ${msg}`,
      syncAttempts: (task.syncAttempts || 0) + 1,
    });
    logSyncActivity(taskId, task.boardId, 'delete_failed', `"${task.title}" — ${msg}`);
  }
}

/**
 * Create-or-update orchestrator used by the retry job and ad-hoc sync calls.
 */
async function syncToTeamsCalendar(taskId, userId) {
  const task = await Task.findByPk(taskId);
  if (!task) return null;
  if (task.teamsEventId) return updateTaskEvent(taskId, userId);
  return createTaskEvent(taskId, userId);
}

/**
 * Retry-job entrypoint — idempotent, respects MAX_RETRY_ATTEMPTS.
 * Returns true on success, false on skip/fail.
 */
async function ensureSynced(taskId) {
  const task = await Task.findByPk(taskId);
  if (!task || task.isArchived) return false;
  if ((task.syncAttempts || 0) >= MAX_RETRY_ATTEMPTS) {
    logger.warn('[Calendar] Max retries reached — abandoning', { taskId, attempts: task.syncAttempts });
    return false;
  }
  if (!task.assignedTo) return false;
  const result = await syncToTeamsCalendar(taskId, task.assignedTo);
  return !!result;
}

/**
 * Fetch calendar events for a mailbox (used by time planner — unchanged).
 */
async function fetchCalendarEvents(teamsUserId, startDate, endDate) {
  const teamsConfig = await getTeamsConfig();
  if (!teamsConfig.isConfigured || !teamsUserId) return null;

  const cacheKey = `${teamsUserId}:${startDate}:${endDate}`;
  const cached = calendarCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  try {
    const token = await getAppToken();
    const startISO = `${startDate}T00:00:00`;
    const endISO = `${endDate}T23:59:59`;

    let allEvents = [];
    let nextLink = `${teamsConfig.graphUrl}/users/${teamsUserId}/calendarView?startDateTime=${startISO}&endDateTime=${endISO}&$select=id,subject,start,end,isAllDay,location,showAs,bodyPreview&$top=100&$orderby=start/dateTime`;

    while (nextLink) {
      const res = await axios.get(nextLink, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Prefer': 'outlook.timezone="Asia/Kolkata"',
        },
      });
      allEvents = allEvents.concat(res.data.value || []);
      nextLink = res.data['@odata.nextLink'] || null;
    }

    const timedEvents = [];
    const allDayEvents = [];
    for (const event of allEvents) {
      const mapped = {
        id: event.id,
        subject: event.subject || '(No title)',
        isAllDay: event.isAllDay,
        location: event.location?.displayName || '',
        showAs: event.showAs,
        bodyPreview: event.bodyPreview || '',
        source: 'teams',
      };
      if (event.isAllDay) {
        mapped.date = event.start.dateTime.split('T')[0];
        allDayEvents.push(mapped);
      } else {
        const startDT = event.start.dateTime;
        const endDT = event.end.dateTime;
        mapped.date = startDT.split('T')[0];
        mapped.startTime = startDT.split('T')[1].substring(0, 5);
        mapped.endTime = endDT.split('T')[1].substring(0, 5);
        if (mapped.endTime <= mapped.startTime) mapped.endTime = '20:00';
        timedEvents.push(mapped);
      }
    }

    const result = { timedEvents, allDayEvents };
    calendarCache.set(cacheKey, { data: result, expiresAt: Date.now() + CACHE_TTL });
    for (const [key, val] of calendarCache) {
      if (val.expiresAt < Date.now()) calendarCache.delete(key);
    }
    return result;
  } catch (err) {
    logger.error('[Calendar] fetchCalendarEvents error', { err: graphErrorMessage(err) });
    return { timedEvents: [], allDayEvents: [] };
  }
}

module.exports = {
  getAccessToken,
  createTaskEvent,
  updateTaskEvent,
  deleteTaskEvent,
  syncToTeamsCalendar,
  fetchCalendarEvents,
  ensureSynced,
  // Exposed for tests / diagnostics:
  MAX_RETRY_ATTEMPTS,
  EXT_TASK_ID,
};
