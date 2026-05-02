/**
 * Pure mapping from a server-emitted realtime event to the set of frontend
 * "queryKey" strings that should be invalidated.
 *
 * This is the SINGLE PLACE that decides "when X happens on the server,
 * which page caches need to refetch?" Adding a new event or a new page
 * means editing this file alone — pages don't hand-roll their own list
 * of socket events to listen to any more.
 *
 * QueryKey conventions (mirrors React Query naming for an easy port later):
 *
 *   tasks.board.<boardId>      — list of tasks for one board (BoardPage)
 *   tasks.assignedTo.me        — current user's task list (HomePage, MyWorkPage)
 *   tasks.id.<taskId>          — a single task (TaskModal)
 *   subtasks.task.<taskId>     — subtasks for one task
 *   approvals.task.<taskId>    — approval flows for one task
 *   watchers.task.<taskId>     — watchers list for one task
 *   dependencies.task.<taskId> — dependencies for one task
 *   notifications.list         — bell dropdown / notifications page
 *   notifications.unreadCount  — bell badge count
 *   boards.list                — sidebar / boards index
 *   boards.id.<boardId>        — one board's metadata
 *   dashboard.stats            — dashboard widgets (board-level + global)
 *   meetings.my                — current user's meetings
 *
 * IMPORTANT: returning a queryKey here does not mean every component refetches.
 * Only components that have actually registered for that exact key (via
 * useRealtimeQuery) will refetch. Wildcards/prefixes are intentionally NOT
 * supported — the router enumerates every concrete affected key.
 */

function pushIf(arr, cond, value) {
  if (cond && value) arr.push(value);
}

/**
 * @param {string} event   Socket event name (e.g. 'task:created')
 * @param {object} payload Event payload — Phase 2 envelope adds taskId/boardId
 *                         /groupId/changedFields/actorId/timestamp at the top
 *                         level. Falls back to nested .task / .board / .taskId
 *                         for backward compat with pre-envelope events.
 * @returns {string[]} List of queryKeys that should be invalidated.
 */
export function routeEvent(event, payload = {}) {
  const out = [];

  // Phase 2 envelope first; fall back to legacy nested fields.
  const taskId =
    payload.taskId
    || payload.task?.id
    || payload.subtask?.taskId
    || null;
  const boardId =
    payload.boardId
    || payload.task?.boardId
    || payload.board?.id
    || null;

  switch (event) {
    case 'task:created':
    case 'task:updated':
    case 'task:deleted':
    case 'task:moved':
    case 'task:delegated':
    case 'tasks:bulkUpdated':
    case 'tasks:reordered': {
      pushIf(out, !!boardId, `tasks.board.${boardId}`);
      pushIf(out, !!taskId, `tasks.id.${taskId}`);
      out.push('tasks.assignedTo.me');
      out.push('dashboard.stats');
      break;
    }

    case 'task:approval-updated': {
      pushIf(out, !!taskId, `approvals.task.${taskId}`);
      pushIf(out, !!taskId, `tasks.id.${taskId}`);
      pushIf(out, !!boardId, `tasks.board.${boardId}`);
      break;
    }

    case 'task:receipt': {
      // Receipts decorate task rows on the assigner's board. Tightly scoped
      // — receipt arrival doesn't need to disturb MyWork or the dashboard.
      pushIf(out, !!boardId, `tasks.board.${boardId}`);
      pushIf(out, !!taskId, `tasks.id.${taskId}`);
      break;
    }

    case 'subtask:created':
    case 'subtask:updated':
    case 'subtask:deleted': {
      pushIf(out, !!taskId, `subtasks.task.${taskId}`);
      // The badge on the parent task row reflects the subtask count, so the
      // board list also needs to refresh (or the count will be stale until
      // the user navigates away and back).
      pushIf(out, !!taskId, `tasks.id.${taskId}`);
      pushIf(out, !!boardId, `tasks.board.${boardId}`);
      break;
    }

    case 'watcher:added':
    case 'watcher:removed': {
      pushIf(out, !!taskId, `watchers.task.${taskId}`);
      pushIf(out, !!taskId, `tasks.id.${taskId}`);
      break;
    }

    case 'dependency:added':
    case 'dependency:removed':
    case 'dependency:auto_unblocked':
    case 'dependency:delegated':
    case 'task:unblocked': {
      pushIf(out, !!taskId, `dependencies.task.${taskId}`);
      pushIf(out, !!taskId, `tasks.id.${taskId}`);
      pushIf(out, !!boardId, `tasks.board.${boardId}`);
      break;
    }

    case 'notification:new':
    case 'notification:read': {
      out.push('notifications.list');
      out.push('notifications.unreadCount');
      break;
    }

    case 'board:created':
    case 'board:updated':
    case 'board:deleted':
    case 'board:memberAdded':
    case 'board:memberRemoved': {
      out.push('boards.list');
      pushIf(out, !!boardId, `boards.id.${boardId}`);
      // A user being added/removed from a board changes which tasks they
      // can see — refresh their task lists too.
      out.push('tasks.assignedTo.me');
      break;
    }

    case 'comment:created':
    case 'comment:deleted': {
      pushIf(out, !!taskId, `comments.task.${taskId}`);
      pushIf(out, !!taskId, `tasks.id.${taskId}`);
      break;
    }

    case 'file:uploaded':
    case 'file:deleted': {
      pushIf(out, !!taskId, `files.task.${taskId}`);
      pushIf(out, !!taskId, `tasks.id.${taskId}`);
      break;
    }

    case 'meeting:created':
    case 'meeting:updated':
    case 'meeting:deleted':
    case 'meeting:accepted':
    case 'meeting:declined': {
      out.push('meetings.my');
      break;
    }

    case 'permissions:updated': {
      // Permission changes potentially affect EVERY task list the user is
      // looking at — easier to just bust the user's main caches.
      out.push('tasks.assignedTo.me');
      out.push('boards.list');
      out.push('dashboard.stats');
      break;
    }

    default:
      // Unknown event — return empty array so the registry is a no-op for it.
      // useRealtimeEvent (the escape hatch) can still catch raw events
      // bypassing the router.
      break;
  }

  return out;
}

// Used by tests and by the dev-only debug logging in RealtimeProvider.
export const __TEST_ONLY__ = { routeEvent };
