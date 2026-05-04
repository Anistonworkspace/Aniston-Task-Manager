/**
 * Centralised realtime emit layer for Aniston Task Manager.
 *
 * Goal: stop having every controller hand-roll its own list of "who needs to
 * know about this change". One place to add a new recipient (e.g. when we
 * introduce dependency owners or shared workspaces), one place to make payload
 * decisions, one place to add observability later.
 *
 * Design:
 *   - Wraps `socketService.emitToBoardAndUsers` (Phase 1) under semantic
 *     methods. Controllers call `realtime.emitTaskCreated(task, opts)`
 *     instead of figuring out which rooms to hit.
 *   - Every method is fire-and-forget: returns void synchronously, runs the
 *     recipient resolution + emit on a microtask, swallows errors so a
 *     failed emit can't break the originating API request.
 *   - Event names are UNCHANGED — frontend listeners (BoardPage, HomePage,
 *     MyWorkPage, TaskModal, …) keep working without any client edit. This
 *     is what unblocks Phase 3 to migrate at its own pace.
 *   - Payloads are a small SLIM ENVELOPE merged with the existing fields
 *     consumers expect. New consumers can rely on `taskId / boardId /
 *     groupId / changedFields / actorId / timestamp` at the top level. Old
 *     consumers keep reading `data.task.boardId` etc. Phase 3/4 can drop
 *     the full `task` blob once nothing reads it any more.
 *
 * RBAC:
 *   - `emitToBoardAndUsers` only delivers to board members (the room is
 *     gated by socketService) and to the explicit user-IDs we pass in,
 *     which we resolve from the task's own associations (creator,
 *     assignees, supervisors, owners, watchers). Every one of those is by
 *     definition authorised to know about the task.
 *   - The frontend always re-fetches via the authorised API after seeing
 *     an event; if access has been revoked between emit and refetch, the
 *     GET 403s and the row silently disappears. No data leak via the
 *     payload.
 *
 * Multi-instance scaling: see TODO in socketService.js (Redis adapter).
 */

const {
  Task, TaskAssignee, TaskOwner, TaskWatcher,
} = require('../models');
const socketService = require('./socketService');
const taskVisibility = require('./taskVisibilityService');
// Outbound webhooks. Fire-and-forget: a slow/broken receiver must never
// block or fail the realtime fan-out. webhookService swallows its own errors.
const webhookService = require('./webhookService');

function fireWebhook(event, data) {
  try {
    webhookService.dispatch(event, data).catch((err) => {
      console.error(`[realtime] webhook dispatch (${event}) failed:`, err.message);
    });
  } catch (err) {
    console.error(`[realtime] webhook dispatch (${event}) threw:`, err.message);
  }
}

function taskToWebhookPayload(task) {
  if (!task) return null;
  const t = typeof task.toJSON === 'function' ? task.toJSON() : task;
  // Slim payload — only the fields an external receiver needs to mirror the
  // row. Avoid leaking internal join data (board members, watchers, etc).
  return {
    id: t.id,
    boardId: t.boardId,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    progress: t.progress,
    assignedTo: t.assignedTo,
    createdBy: t.createdBy,
    dueDate: t.dueDate,
    startDate: t.startDate,
    isArchived: t.isArchived,
    tags: t.tags,
    labels: t.labels,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

// ── envelope ───────────────────────────────────────────────────

/**
 * Build the slim metadata that goes on every realtime event.
 * Existing consumers can ignore this; new consumers (Phase 3) can read it
 * without having to crack open the full task blob.
 */
function envelope({ taskId, boardId, groupId, changedFields, actorId, extra } = {}) {
  return {
    taskId: taskId || undefined,
    boardId: boardId || undefined,
    groupId: groupId || undefined,
    changedFields: Array.isArray(changedFields) && changedFields.length ? changedFields : undefined,
    actorId: actorId || undefined,
    timestamp: Date.now(),
    ...(extra || {}),
  };
}

// ── recipient resolution ──────────────────────────────────────

/**
 * Resolve the AUTHORIZED user IDs that should receive a realtime event for a
 * given task — i.e. the union of:
 *   - task creator + assignedTo + task_assignees + task_owners + watchers
 *   - every ancestor of each affected user (subtree-scoped readers)
 *   - every active admin / super admin (unrestricted readers)
 *
 * Delegates to taskVisibilityService.getAuthorizedRealtimeRecipients, which
 * is the SAME rule used by list/detail visibility — guaranteeing that no
 * realtime event ever ships to a user who would be denied by the API.
 *
 * Watchers are added separately because they explicitly opted in.
 */
async function resolveAffectedUserIds(taskOrId, opts = {}) {
  const recipients = new Set(
    await taskVisibility.getAuthorizedRealtimeRecipients(taskOrId, {
      extraUserIds: opts.extraUserIds,
      excludeUserId: opts.excludeUserId,
    })
  );

  // Watchers are visibility-bearing only if they're already authorized via
  // the rules above. We do NOT auto-grant view to a watcher who is outside
  // the subtree; that would re-open the leak. Add only watchers who are
  // already in the recipient set OR who are admin/super_admin/ancestor.
  // Easiest correct read: rely on getAuthorizedRealtimeRecipients to have
  // already handled hierarchy + admin coverage; watchers outside that set
  // are NOT given a backdoor.

  if (opts.excludeUserId) recipients.delete(opts.excludeUserId);
  return Array.from(recipients);
}

// ── fire-and-forget guard ──────────────────────────────────────

/**
 * Wrap an async impl so callers can invoke it synchronously. Errors are
 * logged but never bubble to the controller — a broken realtime emit must
 * never fail the API request that triggered it.
 */
function fnf(label, impl) {
  return function (...args) {
    try {
      Promise.resolve(impl(...args)).catch((err) => {
        console.error(`[realtime] ${label} failed:`, err.message);
      });
    } catch (err) {
      console.error(`[realtime] ${label} threw synchronously:`, err.message);
    }
  };
}

// ── task ───────────────────────────────────────────────────────

const emitTaskCreated = fnf('emitTaskCreated', async (task, opts = {}) => {
  if (!task?.id || !task?.boardId) return;
  // CP-3 RBAC: send ONLY to authorized recipients. We deliberately do not
  // call emitToBoardAndUsers — the board-room broadcast was the leak path
  // (any joined viewer received every task event, regardless of subtree).
  const userIds = await resolveAffectedUserIds(task, opts);
  const payload = {
    ...envelope({
      taskId: task.id,
      boardId: task.boardId,
      groupId: task.groupId,
      actorId: opts.actorId,
    }),
    task,
  };
  socketService.emitToUsers('task:created', payload, userIds);
  fireWebhook('task.created', { task: taskToWebhookPayload(task), actorId: opts.actorId });
});

const emitTaskUpdated = fnf('emitTaskUpdated', async (task, opts = {}) => {
  if (!task?.id || !task?.boardId) return;
  // For reassignments, callers should pass `extraUserIds: [previousAssignee]`
  // so the user who was REMOVED from the task still receives the update and
  // can drop it from their MyWork list. (Their visibility is restored via the
  // explicit extraUserIds path; the next refetch will 403 cleanly.)
  const userIds = await resolveAffectedUserIds(task, opts);
  const payload = {
    ...envelope({
      taskId: task.id,
      boardId: task.boardId,
      groupId: task.groupId,
      changedFields: opts.changedFields,
      actorId: opts.actorId,
    }),
    task,
  };
  socketService.emitToUsers('task:updated', payload, userIds);
  fireWebhook('task.updated', {
    task: taskToWebhookPayload(task),
    changedFields: opts.changedFields || [],
    actorId: opts.actorId,
  });
});

const emitTaskDeleted = fnf('emitTaskDeleted', async ({ taskId, boardId, affectedUserIds }, opts = {}) => {
  if (!taskId) return;
  // For deletes the task is gone — caller MUST supply affectedUserIds (we
  // can't derive them after the row is destroyed). Captured at controller
  // level just before the destroy(). Even on delete we don't blast the room.
  const userIds = Array.isArray(affectedUserIds) ? affectedUserIds.filter(Boolean) : [];
  const payload = {
    ...envelope({ taskId, boardId, actorId: opts.actorId }),
  };
  socketService.emitToUsers('task:deleted', payload, userIds);
  fireWebhook('task.deleted', { taskId, boardId, actorId: opts.actorId });
});

const emitTaskMoved = fnf('emitTaskMoved', async (task, opts = {}) => {
  if (!task?.id) return;
  const fromBoardId = opts.fromBoardId;
  const toBoardId = task.boardId;
  const userIds = await resolveAffectedUserIds(task, opts);
  const payload = {
    ...envelope({
      taskId: task.id,
      boardId: toBoardId,
      groupId: task.groupId,
      actorId: opts.actorId,
      extra: { fromBoardId, toBoardId },
    }),
    task,
  };
  // BoardPage filters by data.task.boardId — but a task moved AWAY from
  // a board needs to disappear from THAT board's listing. So we emit the
  // 'task:deleted' to the fromBoard recipients, and 'task:moved' to the
  // toBoard recipients. Pages that key off boardId will react correctly.
  if (fromBoardId && fromBoardId !== toBoardId) {
    socketService.emitToUsers(
      'task:deleted',
      envelope({ taskId: task.id, boardId: fromBoardId, actorId: opts.actorId, extra: { reason: 'moved' } }),
      userIds,
    );
  }
  socketService.emitToUsers('task:moved', payload, userIds);
});

// ── subtask ────────────────────────────────────────────────────

const emitSubtaskChanged = fnf('emitSubtaskChanged', async (action, parentTaskId, payload, opts = {}) => {
  // action: 'created' | 'updated' | 'deleted'
  if (!action || !parentTaskId) return;
  const t = await Task.findByPk(parentTaskId, { attributes: ['id', 'boardId', 'createdBy', 'assignedTo'] });
  if (!t || !t.boardId) return;
  const userIds = await resolveAffectedUserIds(t, opts);
  const enriched = {
    ...envelope({
      taskId: parentTaskId,
      boardId: t.boardId,
      actorId: opts.actorId,
    }),
    ...(payload || {}),
  };
  socketService.emitToUsers(`subtask:${action}`, enriched, userIds);
});

// ── approval ───────────────────────────────────────────────────

const emitApprovalChanged = fnf('emitApprovalChanged', async (task, flows, opts = {}) => {
  // Two events for parity with the frontend: 'task:updated' (so the task row
  // re-renders with the new approvalStatus) and 'task:approval-updated' (so
  // the inline approval indicator + TaskModal's ApprovalSection refresh
  // without refetch).
  if (!task?.id || !task?.boardId) return;
  const userIds = await resolveAffectedUserIds(task, opts);
  const updatedPayload = {
    ...envelope({
      taskId: task.id,
      boardId: task.boardId,
      groupId: task.groupId,
      changedFields: ['approvalStatus'],
      actorId: opts.actorId,
    }),
    task,
  };
  const approvalPayload = {
    ...envelope({ taskId: task.id, boardId: task.boardId, actorId: opts.actorId }),
    flows: Array.isArray(flows) ? flows : [],
  };
  socketService.emitToUsers('task:updated', updatedPayload, userIds);
  socketService.emitToUsers('task:approval-updated', approvalPayload, userIds);
});

// ── watcher ────────────────────────────────────────────────────

const emitWatcherChanged = fnf('emitWatcherChanged', async (action, taskId, watcherUserId, opts = {}) => {
  // action: 'added' | 'removed'
  if (!action || !taskId || !watcherUserId) return;
  const t = await Task.findByPk(taskId, { attributes: ['id', 'boardId'] });
  if (!t || !t.boardId) return;
  const payload = {
    ...envelope({ taskId, boardId: t.boardId, actorId: opts.actorId, extra: { watcherUserId, action } }),
  };
  // CP-3 RBAC: send only to authorized recipients of the parent task plus
  // the watcher themselves (always allowed to know about their own watch
  // state) and the actor (for UI sync). No board-room broadcast.
  const taskRecipients = await resolveAffectedUserIds(t, opts);
  const userIds = new Set([...taskRecipients, watcherUserId, opts.actorId].filter(Boolean));
  socketService.emitToUsers(`watcher:${action}`, payload, Array.from(userIds));
});

// ── dependency ─────────────────────────────────────────────────

const emitDependencyChanged = fnf('emitDependencyChanged', async (action, { taskId, boardId, dependsOnTaskId }, opts = {}) => {
  // action: 'added' | 'removed' | 'auto_unblocked' | 'delegated'
  if (!action || !taskId) return;
  const ids = new Set();
  // Resolve recipients for both ends of the dependency.
  for (const id of await resolveAffectedUserIds(taskId, { extraUserIds: opts.extraUserIds })) ids.add(id);
  if (dependsOnTaskId) {
    for (const id of await resolveAffectedUserIds(dependsOnTaskId)) ids.add(id);
  }
  if (opts.excludeUserId) ids.delete(opts.excludeUserId);

  // Look up boardId if not provided so we can also broadcast to the room.
  let resolvedBoardId = boardId;
  if (!resolvedBoardId) {
    try {
      const t = await Task.findByPk(taskId, { attributes: ['boardId'] });
      resolvedBoardId = t?.boardId;
    } catch { /* non-fatal */ }
  }

  const payload = {
    ...envelope({ taskId, boardId: resolvedBoardId, actorId: opts.actorId, extra: { action, dependsOnTaskId } }),
  };
  // CP-3 RBAC: emit to authorized recipients only — no board-room broadcast.
  socketService.emitToUsers(`dependency:${action}`, payload, Array.from(ids));
});

// ── meeting ────────────────────────────────────────────────────

const emitMeetingChanged = fnf('emitMeetingChanged', async (action, meeting, opts = {}) => {
  // action: 'created' | 'updated' | 'cancelled' | 'accepted' | 'declined'
  // The meeting flows already create Notification rows + emit notification:new
  // for participants — that path is left in place. THIS event drives
  // meetings.my refresh on the assignees' MeetingsPage so they don't have
  // to rely on the notifications.list piggyback that Phase 3 had to fall
  // back on. Keeps cross-cutting cache invalidation correct without
  // sending the full meeting blob through the bell flow.
  if (!action || !meeting?.id) return;
  const ids = new Set();
  if (Array.isArray(meeting.participants)) {
    for (const p of meeting.participants) {
      // participants may be array of { userId } or array of user-id strings
      const id = (typeof p === 'string') ? p : (p?.userId || p?.id);
      if (id) ids.add(id);
    }
  }
  if (meeting.createdBy) ids.add(meeting.createdBy);
  if (Array.isArray(opts.extraUserIds)) {
    for (const uid of opts.extraUserIds) if (uid) ids.add(uid);
  }
  if (opts.excludeUserId) ids.delete(opts.excludeUserId);

  const payload = {
    ...envelope({ actorId: opts.actorId, extra: { meetingId: meeting.id, action } }),
    meeting,
  };
  // No board room — meetings aren't board-scoped. Direct fan-out to user
  // rooms is enough.
  for (const uid of ids) {
    socketService.emitToUser(uid, `meeting:${action}`, payload);
  }
});

// ── exports ────────────────────────────────────────────────────

module.exports = {
  // resolved emitters
  emitTaskCreated,
  emitTaskUpdated,
  emitTaskDeleted,
  emitTaskMoved,
  emitSubtaskChanged,
  emitApprovalChanged,
  emitWatcherChanged,
  emitDependencyChanged,
  emitMeetingChanged,
  // helpers, for direct use where the semantic methods don't fit
  resolveAffectedUserIds,
  // re-export base helpers so callers don't need to import socketService
  // separately when they need the lower-level primitives (notifications,
  // bulk events, room-only broadcasts, etc.)
  emitToBoard: socketService.emitToBoard,
  emitToUser: socketService.emitToUser,
  emitToBoardAndUsers: socketService.emitToBoardAndUsers,
};
