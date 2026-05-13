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
 * Notification types that affect the Approvals & Requests sidebar badge
 * (`/task-extras/pending-counts`). These map to the four pending-action
 * surfaces a user can reach from that menu:
 *   - task approvals       → approval_*
 *   - due-date extensions  → extension_*
 *   - cross-team help asks → help_*
 *   - access requests      → access_*
 *
 * Anything outside this list (task_assigned, comment_added, due_date,
 * recurring_*, mention, priority_change, …) leaves the badge value
 * unchanged, so a 30-notification burst of recurring_missed escalations
 * no longer triggers 30 GETs to `/task-extras/pending-counts`.
 */
function isApprovalLikeType(t) {
  if (!t) return false;
  return (
    t.startsWith('approval_')
    || t.startsWith('extension_')
    || t.startsWith('help_')
    || t.startsWith('access_')
  );
}

/**
 * Notification types that affect the global Dependencies header badge
 * (`/dependencies/assigned-active-count`). Same idea: gate the refetch
 * on payload shape so a notification storm in another domain doesn't
 * flood the dependencies endpoint.
 *
 * `dependency_*` is the canonical prefix on the server-side Notification
 * enum. `task_unblocked` is included because an unblock event is the one
 * lifecycle transition that flips an "active" dependency to "done" from
 * the assigned user's perspective.
 */
function isDependencyLikeType(t) {
  if (!t) return false;
  return t.startsWith('dependency_') || t === 'task_unblocked';
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
      // Sidebar "Approvals & Requests" badge tracks the caller's actionable
      // queue — a chain advance / approve / reject / changes_requested all
      // shift who's the current pending approver, which can change the count.
      out.push('approvals.pendingCounts');
      break;
    }

    case 'task:receipt': {
      // Receipts decorate task rows on the assigner's board. Tightly scoped
      // — receipt arrival doesn't need to disturb MyWork or the dashboard.
      pushIf(out, !!boardId, `tasks.board.${boardId}`);
      pushIf(out, !!taskId, `tasks.id.${taskId}`);
      break;
    }

    // Per-task multi-value column updates (label/reference/link). BoardPage
    // already patches state via raw useRealtimeEvent listeners, but ALSO
    // wiring the router means any future consumer (MyWorkPage, HomePage,
    // dashboard widgets that read task.labels / task.references) only needs
    // to register a `tasks.id.<taskId>` or `tasks.board.<boardId>` queryKey
    // to stay in sync — no per-event listener chain to maintain.
    case 'task:labels_updated':
    case 'task:references_updated':
    case 'task:links_updated': {
      pushIf(out, !!taskId, `tasks.id.${taskId}`);
      pushIf(out, !!boardId, `tasks.board.${boardId}`);
      // Assignee-side surfaces — MyWork, HomePage's "My Tasks" widget —
      // also render these cells, so their canonical user-tasks query
      // should refresh too. Server already gates the refetch via
      // visibility, so a stray invalidation costs at most a 200 with no
      // changed rows.
      out.push('tasks.assignedTo.me');
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
      // Type-aware fan-out (May 2026 storm fix): the unconditional invalidation
      // of `approvals.pendingCounts` + `dependencies.assignedActiveCount` on
      // every notification used to multiply a 30-notification burst into
      // 120 unrelated API calls in a few hundred milliseconds. The badges
      // only change when an approval-shaped or dependency-shaped event
      // arrives, so gate the invalidation on the notification type. The
      // server-side `Notification.type` enum is the contract here:
      //   approvals  → approval_*, extension_*, help_*, access_*
      //   dependencies → dependency_* (and the generic task_unblocked)
      // All other types (task_assigned, comment_added, due_date,
      // recurring_*, mention, priority_change, ...) keep the bell count
      // accurate via `notifications.unreadCount` alone.
      const notifType = payload?.notification?.type;
      if (isApprovalLikeType(notifType)) {
        out.push('approvals.pendingCounts');
      }
      if (isDependencyLikeType(notifType)) {
        out.push('dependencies.assignedActiveCount');
      }
      break;
    }

    // Dependency request lifecycle — these are emitted as raw events the
    // /cross-team page already listens to; map them into the router so the
    // global header badge refreshes too.
    case 'dependency:requested':
    case 'dependency:accepted':
    case 'dependency:started':
    case 'dependency:done':
    case 'dependency:rejected':
    case 'dependency:cancelled':
    case 'dependency:reassigned': {
      out.push('dependencies.assignedActiveCount');
      break;
    }

    // Extension / help-request lifecycle — these don't currently emit
    // dedicated socket events for every state change, but when they do
    // (or via notification:new fan-out above), the badge needs to refresh.
    case 'extension:requested':
    case 'extension:approved':
    case 'extension:rejected':
    case 'help:requested':
    case 'help:resolved':
    case 'help:status-updated': {
      out.push('approvals.pendingCounts');
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

    case 'workspace:created':
    case 'workspace:updated':
    case 'workspace:deleted':
    case 'workspace:archived':
    case 'workspace:restored':
    case 'workspace:memberUpdated': {
      // The sidebar fetches both /boards and /workspaces/mine in one
      // loadData() call, so invalidating `boards.list` is sufficient to
      // re-sync the workspace tree. The actual visibility filtering happens
      // server-side via boardVisibilityService — clients receive only what
      // their RBAC permits, so the global broadcast is safe.
      out.push('boards.list');
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

    case 'recurring_template:created':
    case 'recurring_template:updated':
    case 'recurring_template:paused':
    case 'recurring_template:resumed':
    case 'recurring_template:archived': {
      // The Recurring Work page lists templates; bust its query so other
      // viewers see pause/resume/archive without manual refresh. Updates
      // that change the assignee also produce task:updated events for the
      // affected open instances (see reassignOpenInstances) — those drive
      // tasks.assignedTo.me / tasks.board.<id> invalidation independently.
      out.push('recurring.list');
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
