/**
 * Task Prioritization System (Frontend)
 *
 * Sorting order (within each board group):
 *   1. Completed tasks sink to bottom
 *   2. Priority field: critical (0) > high (1) > medium (2) > low (3)
 *   3. Due date: earliest first, null/missing at bottom
 *   4. CreatedAt DESC for stable ordering
 */

// ─── Priority field mapping ────────────────────────────────────────────────

const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

export function getPriorityRank(priority) {
  if (!priority) return 3;
  const key = String(priority).toLowerCase().trim();
  return PRIORITY_RANK[key] !== undefined ? PRIORITY_RANK[key] : 3;
}

// ─── Status classification ──────────────────────────────────────────────────

const COMPLETED_STATUSES = new Set(['done', 'completed', 'closed', 'finished']);

export function isCompletedStatus(status) {
  if (!status) return false;
  return COMPLETED_STATUSES.has(String(status).toLowerCase().trim());
}

// ─── Progress normalization ─────────────────────────────────────────────────

export function normalizeProgress(progress) {
  if (progress == null) return 0;
  let val = progress;
  if (typeof val === 'string') {
    val = val.replace('%', '').trim();
    val = parseFloat(val);
  } else {
    val = Number(val);
  }
  if (isNaN(val)) return 0;
  return Math.max(0, Math.min(100, Math.round(val)));
}

// ─── Overdue detection ──────────────────────────────────────────────────────

export function isOverdue(task) {
  if (!task || !task.dueDate) return false;
  if (isCompletedStatus(task.status)) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(task.dueDate);
  due.setHours(0, 0, 0, 0);
  return due < today;
}

// ─── Priority score ─────────────────────────────────────────────────────────

export function getTaskPriorityScore(task) {
  if (!task) return 99999;

  const completed = isCompletedStatus(task.status);
  let score = 0;

  if (completed) score += 10000;

  score += getPriorityRank(task.priority) * 1000;

  if (task.dueDate && !completed) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(task.dueDate);
    due.setHours(0, 0, 0, 0);
    score += (due - today) / (1000 * 60 * 60 * 24);
  } else if (!completed) {
    score += 9999;
  }

  return score;
}

// ─── Sort comparator ────────────────────────────────────────────────────────

/**
 * Sort tasks by: completed last → priority (critical>high>medium>low) →
 * due date (earliest first, null last) → createdAt DESC.
 * Returns a new sorted array (does not mutate input).
 */
export function sortTasksByPendingPriority(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return tasks || [];

  return [...tasks].sort((a, b) => {
    // 1. Completed tasks always at bottom
    const aDone = isCompletedStatus(a.status) ? 1 : 0;
    const bDone = isCompletedStatus(b.status) ? 1 : 0;
    if (aDone !== bDone) return aDone - bDone;

    // 2. Priority rank (critical=0, high=1, medium=2, low=3)
    const aPri = getPriorityRank(a.priority);
    const bPri = getPriorityRank(b.priority);
    if (aPri !== bPri) return aPri - bPri;

    // 3. Due date (earliest first, null at bottom)
    const aDate = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
    const bDate = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
    if (aDate !== bDate) return aDate - bDate;

    // 4. CreatedAt DESC (newest first as tiebreaker)
    const aCre = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bCre = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (aCre !== bCre) return bCre - aCre;

    // 5. Stable ID tiebreaker
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

// ─── Auto-group assignment (frontend mirror) ────────────────────────────────

const STATUS_GROUP_MAP = {
  done:               /done|complet|finish|closed/i,
  completed:          /done|complet|finish|closed/i,
  closed:             /done|complet|finish|closed/i,
  finished:           /done|complet|finish|closed/i,
  working_on_it:      /progress|working|active|doing|started/i,
  in_progress:        /progress|working|active|doing|started/i,
  stuck:              /stuck|block/i,
  blocked:            /stuck|block/i,
  review:             /review|qa|test|verify/i,
  waiting_for_review: /review|qa|test|verify/i,
  pending_deploy:     /deploy|release|staging/i,
  not_started:        /to.?do|not.?started|new|backlog|pending|todo/i,
  ready_to_start:     /to.?do|not.?started|new|backlog|pending|todo|ready/i,
};

/**
 * Find the best matching board group for a given task status.
 * @param {string} status - Task status value
 * @param {Array} groups  - Board groups array: [{ id, title, color }]
 * @returns {string|null} The matching group id, or null
 */
export function findGroupForStatus(status, groups) {
  if (!status || !Array.isArray(groups) || groups.length === 0) return null;

  const key = String(status).toLowerCase().trim();

  // Exact match on group id
  const exactMatch = groups.find(g => g.id === key);
  if (exactMatch) return exactMatch.id;

  // Pattern match on group title
  const pattern = STATUS_GROUP_MAP[key];
  if (pattern) {
    const match = groups.find(g => pattern.test(g.title || g.name || ''));
    if (match) return match.id;
  }

  // Not-started fallback to first group
  if (key === 'not_started' || key === 'pending' || key === 'ready_to_start') {
    return groups[0]?.id || null;
  }

  return null;
}
