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

// Default human labels for the global status keys. Boards/tasks with custom
// statusConfig override these — resolveStatusByLabel checks the configured
// labels first and only falls back to this map if a board has no matching
// custom label. This keeps the approval lifecycle ("Waiting for Review",
// "Done", "Not Started") working on every board, including boards that
// haven't been customized.
const DEFAULT_STATUS_LABELS = {
  not_started:        'Not Started',
  ready_to_start:     'Ready to Start',
  working_on_it:      'Working on it',
  in_progress:        'In Progress',
  waiting_for_review: 'Waiting for Review',
  pending_deploy:     'Pending Deploy',
  stuck:              'Stuck',
  done:               'Done',
  review:             'In Review',
};

function normalizeLabel(s) {
  return String(s || '').toLowerCase().replace(/[\s_-]+/g, ' ').trim();
}

/**
 * Resolve a logical label (e.g. "Waiting for Review") to an actual status key
 * configured for THIS task on THIS board. Used by the approval lifecycle so
 * the same code works whether the board uses default statuses, custom keys,
 * or renamed labels.
 *
 * Resolution order:
 *   1. Match against task-level statusConfig labels (case- and space-insensitive)
 *   2. Match against board status column labels
 *   3. Match against the global DEFAULT_STATUS_LABELS map
 *   4. If `fallbacks` is provided, try each fallback label in turn
 *
 * Returns the resolved status KEY (string) or null when nothing matches —
 * caller decides whether to skip the transition or hard-fail.
 *
 * @param {string|string[]} labelOrLabels - Logical label(s) to look up
 * @param {Object} task - Task model instance (may have .statusConfig)
 * @param {Object} board - Board model instance (may have .columns)
 * @returns {string|null} The matching status key, or null
 */
function resolveStatusByLabel(labelOrLabels, task, board) {
  const candidates = Array.isArray(labelOrLabels) ? labelOrLabels : [labelOrLabels];

  // Build a list of (key, normalizedLabel) pairs from every available source,
  // preferring task config over board over defaults. Order matters — the first
  // matching pair wins.
  const sources = [];
  if (task?.statusConfig && Array.isArray(task.statusConfig)) {
    for (const s of task.statusConfig) {
      sources.push({ key: s.key, label: normalizeLabel(s.label || s.key) });
    }
  }
  if (board && Array.isArray(board.columns)) {
    const statusCol = board.columns.find((c) => c.type === 'status');
    if (statusCol?.statuses && Array.isArray(statusCol.statuses)) {
      for (const s of statusCol.statuses) {
        sources.push({ key: s.key, label: normalizeLabel(s.label || s.key) });
      }
    }
  }
  // Defaults — both label and key form, so 'not_started' or 'Not Started'
  // resolve. Only used when the board doesn't define this status explicitly.
  for (const [key, label] of Object.entries(DEFAULT_STATUS_LABELS)) {
    sources.push({ key, label: normalizeLabel(label) });
    sources.push({ key, label: normalizeLabel(key) });
  }

  for (const candidate of candidates) {
    const target = normalizeLabel(candidate);
    if (!target) continue;
    const hit = sources.find((s) => s.label === target);
    if (hit) {
      // Must also be in the actual allowed set for this task — otherwise we
      // pick a default key that the board doesn't support and isValidStatus
      // would reject the eventual write.
      const allowed = getAllowedStatusesForTask(task, board);
      if (allowed.includes(hit.key)) return hit.key;
    }
  }

  return null;
}

module.exports = {
  DEFAULT_STATUS_KEYS,
  DEFAULT_STATUS_LABELS,
  getAllowedStatuses,
  getAllowedStatusesForTask,
  isValidStatus,
  isValidStatusForTask,
  resolveStatusByLabel,
};
