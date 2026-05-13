import api from '../services/api';

// Resolve a task's boardId. If `boardId` is missing we fetch the task to find
// it. Returns { taskId, boardId } or null when nothing usable is available.
export async function resolveTaskTarget({ taskId, boardId } = {}) {
  if (!taskId) return null;
  if (boardId) return { taskId, boardId };
  try {
    const res = await api.get(`/tasks/${taskId}`);
    const payload = res.data || {};
    const task = payload.task || payload.data?.task || payload.data || payload;
    const resolvedBoardId = task?.boardId || task?.board?.id;
    if (resolvedBoardId) return { taskId, boardId: resolvedBoardId };
  } catch {
    // Task may have been deleted/archived or the user may have lost access —
    // callers can decide on a fallback.
  }
  return null;
}

// Jump to a task's board with the ?taskId= deep link consumed by BoardPage.
// BoardPage opens the matching TaskModal once tasks finish loading and then
// strips the param so refreshing/closing the modal leaves a clean URL.
//
// Use this from any task tile/list/notification that should land on the exact
// task sheet (Dashboard My Tasks, Team Dashboard Overdue, Notifications,
// MemberDrillDown, RecurringWorkPage).
export async function openTaskFromAnywhere(navigate, input = {}) {
  const target = await resolveTaskTarget(input);
  if (!target) return false;
  navigate(`/boards/${target.boardId}?taskId=${target.taskId}`);
  return true;
}
