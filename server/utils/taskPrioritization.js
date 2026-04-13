'use strict';

const { literal } = require('sequelize');

/**
 * Task Prioritization & Auto-Group Assignment System
 *
 * Sorting order (within each board group):
 *   1. Completed tasks sink to bottom
 *   2. Priority field: critical (0) > high (1) > medium (2) > low (3)
 *   3. Due date: earliest first, null/missing at bottom
 *   4. CreatedAt DESC for stable ordering
 *
 * Auto-group assignment:
 *   When a task's status changes, it is automatically moved to the
 *   board group that matches the new status (e.g., done → "Done" group).
 */

// ─── Priority field mapping ────────────────────────────────────────────────

const PRIORITY_RANK = {
  critical: 0,
  high:     1,
  medium:   2,
  low:      3,
};

function getPriorityRank(priority) {
  if (!priority) return 3; // no priority = treat as low
  const key = String(priority).toLowerCase().trim();
  return PRIORITY_RANK[key] !== undefined ? PRIORITY_RANK[key] : 3;
}

// ─── Status classification ──────────────────────────────────────────────────

const COMPLETED_STATUSES = new Set(['done', 'completed', 'closed', 'finished']);

function isCompletedStatus(status) {
  if (!status) return false;
  return COMPLETED_STATUSES.has(String(status).toLowerCase().trim());
}

// ─── Progress normalization ─────────────────────────────────────────────────

function normalizeProgress(progress) {
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

function isOverdue(task) {
  if (!task || !task.dueDate) return false;
  if (isCompletedStatus(task.status)) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(task.dueDate);
  due.setHours(0, 0, 0, 0);
  return due < today;
}

// ─── In-memory sort ─────────────────────────────────────────────────────────

/**
 * Compute a numeric score for a task. Lower = higher priority (appears first).
 *
 * Score:
 *   +10000  if completed (sinks to bottom)
 *   priority rank × 1000 (critical=0, high=1000, medium=2000, low=3000)
 *   due date factor: days until due (earlier = lower). No due date = +9999
 *   createdAt tiebreaker
 */
function getTaskPriorityScore(task) {
  if (!task) return 99999;

  const completed = isCompletedStatus(task.status);
  let score = 0;

  // 1. Completed tasks → bottom
  if (completed) score += 10000;

  // 2. Priority rank (critical=0, high=1000, medium=2000, low=3000)
  score += getPriorityRank(task.priority) * 1000;

  // 3. Due date: earlier = lower score. No due date = large penalty
  if (task.dueDate && !completed) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(task.dueDate);
    due.setHours(0, 0, 0, 0);
    const daysUntil = (due - today) / (1000 * 60 * 60 * 24);
    score += daysUntil; // overdue → negative → rises to top
  } else if (!completed) {
    score += 9999; // no due date → bottom of its priority tier
  }

  return score;
}

/**
 * Sort tasks by: completed last → priority (critical>high>medium>low) → due date → createdAt.
 * Returns a new sorted array (does not mutate input).
 */
function sortTasksByPendingPriority(tasks) {
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

// ─── Sequelize ORDER clause ─────────────────────────────────────────────────

/**
 * Build a Sequelize ORDER array:
 *   1. Completed tasks last
 *   2. Priority: critical(0) > high(1) > medium(2) > low(3)
 *   3. Due date ASC NULLS LAST
 *   4. createdAt DESC
 */
function buildPendingPriorityOrder() {
  // Cast to TEXT before LOWER() — priority/status may be ENUM or VARCHAR depending on migration state
  const completedBucket = literal(`
    CASE WHEN LOWER("Task"."status"::text) IN ('done','completed','closed','finished')
         THEN 1 ELSE 0 END
  `);

  const priorityRank = literal(`
    CASE LOWER("Task"."priority"::text)
      WHEN 'critical' THEN 0
      WHEN 'high'     THEN 1
      WHEN 'medium'   THEN 2
      WHEN 'low'      THEN 3
      ELSE 3
    END
  `);

  return [
    [completedBucket, 'ASC'],          // pending first, done last
    [priorityRank, 'ASC'],             // critical > high > medium > low
    ['dueDate', 'ASC NULLS LAST'],     // earliest due first, no-date last
    ['createdAt', 'DESC'],             // newest first as tiebreaker
  ];
}

/**
 * Same as buildPendingPriorityOrder but with a custom table alias.
 */
function buildPendingPriorityOrderAliased(alias) {
  const q = alias;

  const completedBucket = literal(`
    CASE WHEN LOWER("${q}"."status"::text) IN ('done','completed','closed','finished')
         THEN 1 ELSE 0 END
  `);

  const priorityRank = literal(`
    CASE LOWER("${q}"."priority"::text)
      WHEN 'critical' THEN 0
      WHEN 'high'     THEN 1
      WHEN 'medium'   THEN 2
      WHEN 'low'      THEN 3
      ELSE 3
    END
  `);

  return [
    [completedBucket, 'ASC'],
    [priorityRank, 'ASC'],
    [literal(`"${q}"."dueDate"`), 'ASC NULLS LAST'],
    [literal(`"${q}"."createdAt"`), 'DESC'],
  ];
}

// ─── Auto-group assignment ──────────────────────────────────────────────────

/**
 * Status-to-group keyword mapping.
 * Keys are status values, values are regex patterns to match group titles.
 */
const STATUS_GROUP_MAP = {
  // Completed statuses → "Done" / "Completed" / "Finished" / "Closed" group
  done:       /done|complet|finish|closed/i,
  completed:  /done|complet|finish|closed/i,
  closed:     /done|complet|finish|closed/i,
  finished:   /done|complet|finish|closed/i,

  // Active/working statuses → "In Progress" / "Working" / "Active" group
  working_on_it:      /progress|working|active|doing|started/i,
  in_progress:        /progress|working|active|doing|started/i,

  // Stuck / blocked → "Stuck" / "Blocked" group (if exists)
  stuck:    /stuck|block/i,
  blocked:  /stuck|block/i,

  // Review statuses → "Review" / "QA" group (if exists)
  review:             /review|qa|test|verify/i,
  waiting_for_review: /review|qa|test|verify/i,
  pending_deploy:     /deploy|release|staging/i,

  // Not started → "To Do" / "New" / "Not Started" / "Backlog" or first group
  not_started:    /to.?do|not.?started|new|backlog|pending|todo/i,
  ready_to_start: /to.?do|not.?started|new|backlog|pending|todo|ready/i,
};

/**
 * Find the best matching board group for a given task status.
 *
 * @param {string} status - The task status value (e.g., 'done', 'working_on_it')
 * @param {Array} groups  - Board groups array: [{ id, title, color, position }]
 * @returns {string|null} The matching group id, or null if no match found
 */
function findGroupForStatus(status, groups) {
  if (!status || !Array.isArray(groups) || groups.length === 0) return null;

  const key = String(status).toLowerCase().trim();

  // 1. Exact match: group id matches the status key directly
  const exactMatch = groups.find(g => g.id === key);
  if (exactMatch) return exactMatch.id;

  // 2. Pattern match: use the status-to-group regex map
  const pattern = STATUS_GROUP_MAP[key];
  if (pattern) {
    const match = groups.find(g => pattern.test(g.title || g.name || ''));
    if (match) return match.id;
  }

  // 3. For not-started/unknown statuses, fall back to the first group
  if (key === 'not_started' || key === 'pending' || key === 'ready_to_start') {
    return groups[0]?.id || null;
  }

  return null; // no match → don't move the task
}

module.exports = {
  isCompletedStatus,
  getPriorityRank,
  normalizeProgress,
  isOverdue,
  getTaskPriorityScore,
  sortTasksByPendingPriority,
  buildPendingPriorityOrder,
  buildPendingPriorityOrderAliased,
  findGroupForStatus,
  COMPLETED_STATUSES,
  PRIORITY_RANK,
};
