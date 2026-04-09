/**
 * Server-side status configuration helpers.
 *
 * Resolution order:
 *   1. task.statusConfig (task-specific statuses)
 *   2. board.columns[type=status].statuses (board-level statuses)
 *   3. DEFAULT_STATUS_KEYS (global defaults)
 */

const DEFAULT_STATUS_KEYS = [
  'not_started', 'ready_to_start', 'working_on_it', 'in_progress',
  'waiting_for_review', 'pending_deploy', 'stuck', 'done', 'review',
];

/**
 * Get allowed status keys for a task, considering task → board → global fallback.
 * @param {Object} task  - Task model instance (may have .statusConfig JSONB)
 * @param {Object} board - Board model instance (may have .columns JSONB)
 * @returns {string[]} Array of allowed status key strings
 */
function getAllowedStatusesForTask(task, board) {
  // 1. Task-level config
  if (task?.statusConfig && Array.isArray(task.statusConfig) && task.statusConfig.length > 0) {
    return task.statusConfig.map(s => s.key);
  }
  // 2. Board-level config
  if (board && Array.isArray(board.columns)) {
    const statusCol = board.columns.find(c => c.type === 'status');
    if (statusCol?.statuses && Array.isArray(statusCol.statuses) && statusCol.statuses.length > 0) {
      return statusCol.statuses.map(s => s.key);
    }
  }
  // 3. Global defaults
  return DEFAULT_STATUS_KEYS;
}

/**
 * Get allowed status keys for a board (board-level only, no task context).
 * @param {Object} board - Board model instance (must have .columns)
 * @returns {string[]} Array of allowed status key strings
 */
function getAllowedStatuses(board) {
  if (!board || !Array.isArray(board.columns)) return DEFAULT_STATUS_KEYS;
  const statusCol = board.columns.find(c => c.type === 'status');
  if (statusCol?.statuses && Array.isArray(statusCol.statuses) && statusCol.statuses.length > 0) {
    return statusCol.statuses.map(s => s.key);
  }
  return DEFAULT_STATUS_KEYS;
}

/**
 * Check if a status value is valid for a given task + board context.
 * Uses task-level config first, then board, then global defaults.
 * @param {string} status - The status key to validate
 * @param {Object} task   - Task model instance (may have .statusConfig)
 * @param {Object} board  - Board model instance (may have .columns)
 * @returns {boolean}
 */
function isValidStatusForTask(status, task, board) {
  const allowed = getAllowedStatusesForTask(task, board);
  return allowed.includes(status);
}

/**
 * Backward-compatible: check status against board only.
 */
function isValidStatus(status, board) {
  const allowed = getAllowedStatuses(board);
  return allowed.includes(status);
}

module.exports = { DEFAULT_STATUS_KEYS, getAllowedStatuses, getAllowedStatusesForTask, isValidStatus, isValidStatusForTask };
