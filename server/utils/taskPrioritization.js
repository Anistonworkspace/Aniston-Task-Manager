'use strict';

const { Op, literal, fn, col, cast } = require('sequelize');

/**
 * Pending Task Prioritization System
 *
 * Priority order:
 *   1. Pending/unfinished tasks before completed tasks
 *   2. Among pending: stuck/blocked → overdue → in progress → review → not started
 *   3. Progress-based tie-breaking (lower progress = more attention needed)
 *   4. Due date tie-breaking (overdue first, then earliest due)
 *   5. updatedAt DESC, then createdAt DESC for stable ordering
 *
 * Completed statuses sink to bottom.
 */

// ─── Status classification ──────────────────────────────────────────────────

const COMPLETED_STATUSES = new Set(['done', 'completed', 'closed', 'finished']);

/**
 * Returns true if the status key represents a completed/done state.
 */
function isCompletedStatus(status) {
  if (!status) return false;
  const key = String(status).toLowerCase().trim();
  return COMPLETED_STATUSES.has(key);
}

/**
 * Status urgency score — lower number = higher urgency (appears first).
 * Stuck/blocked are most urgent, done is least.
 */
const STATUS_URGENCY = {
  stuck:               10,
  blocked:             10,
  escalated:           10,
  // in-progress statuses
  working_on_it:       30,
  in_progress:         30,
  // review / waiting statuses
  review:              40,
  in_review:           40,
  waiting_for_review:  40,
  pending_deploy:      40,
  approval_pending:    40,
  qa:                  40,
  // not started / ready
  ready_to_start:      50,
  not_started:         50,
  pending:             50,
  // completed — always last
  done:                90,
  completed:           90,
  closed:              90,
  finished:            90,
};

const DEFAULT_URGENCY_PENDING  = 50;  // unknown pending status
const DEFAULT_URGENCY_DONE     = 90;  // unknown completed status

function getStatusUrgency(status) {
  if (!status) return DEFAULT_URGENCY_PENDING;
  const key = String(status).toLowerCase().trim();
  if (STATUS_URGENCY[key] !== undefined) return STATUS_URGENCY[key];
  return isCompletedStatus(key) ? DEFAULT_URGENCY_DONE : DEFAULT_URGENCY_PENDING;
}

// ─── Progress normalization ─────────────────────────────────────────────────

/**
 * Normalize progress to 0..100 integer, handling null/undefined/strings.
 */
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

/**
 * Returns true if the task is overdue (dueDate in the past and not completed).
 */
function isOverdue(task) {
  if (!task || !task.dueDate) return false;
  if (isCompletedStatus(task.status)) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(task.dueDate);
  due.setHours(0, 0, 0, 0);
  return due < today;
}

// ─── In-memory sort comparator ──────────────────────────────────────────────

/**
 * Compute a numeric priority score for a task. Lower = higher priority.
 *
 * Score breakdown (additive):
 *   completedBucket:  0 (pending) or 10000 (completed)
 *   overdueBoost:     -500 if overdue and pending
 *   statusUrgency:    10..90 (×10 for spread)
 *   progressPenalty:  for pending tasks, lower progress = lower score (higher priority)
 *                     inverted: (100 - progress) so 0% progress → +100, 100% → +0
 *   dueDateFactor:    days until due × 0.1 (earlier = lower score)
 */
function getTaskPriorityScore(task) {
  if (!task) return 99999;

  const status = task.status || 'not_started';
  const completed = isCompletedStatus(status);
  const progress = normalizeProgress(task.progress);

  let score = 0;

  // 1. Completed tasks get a massive penalty to push them to bottom
  if (completed) {
    score += 10000;
  }

  // 2. Overdue boost for pending tasks
  if (!completed && isOverdue(task)) {
    score -= 500;
  }

  // 3. Status urgency (10..90 range, multiply by 10 for spacing)
  score += getStatusUrgency(status) * 10;

  // 4. Progress factor for pending tasks
  //    Lower progress = needs more attention = should appear higher
  if (!completed) {
    score += progress;  // 0% → +0 (highest priority), 100% → +100 (lower priority)
  }

  // 5. Due date factor
  if (task.dueDate && !completed) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(task.dueDate);
    due.setHours(0, 0, 0, 0);
    const daysUntil = (due - today) / (1000 * 60 * 60 * 24);
    score += daysUntil * 0.1;  // earlier due = lower score
  }

  return score;
}

/**
 * Sort an array of task objects by pending priority.
 * Returns a new sorted array (does not mutate input).
 *
 * Deterministic tie-breaking: updatedAt DESC → createdAt DESC → id ASC.
 */
function sortTasksByPendingPriority(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return tasks || [];

  return [...tasks].sort((a, b) => {
    const scoreA = getTaskPriorityScore(a);
    const scoreB = getTaskPriorityScore(b);

    if (scoreA !== scoreB) return scoreA - scoreB;

    // Tie-breaker 1: more recently updated first
    const updA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const updB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    if (updA !== updB) return updB - updA;

    // Tie-breaker 2: more recently created first
    const creA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const creB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (creA !== creB) return creB - creA;

    // Tie-breaker 3: stable ID ordering
    const idA = String(a.id || '');
    const idB = String(b.id || '');
    return idA.localeCompare(idB);
  });
}

// ─── Sequelize ORDER clause ─────────────────────────────────────────────────

/**
 * Build a Sequelize-compatible ORDER array that implements pending-task
 * prioritization at the database level.
 *
 * Uses CASE expressions for status bucketing and overdue detection.
 * Falls back to progress, dueDate, updatedAt for tie-breaking.
 *
 * @returns {Array} Sequelize order array
 */
function buildPendingPriorityOrder() {
  // 1. Completed tasks last (CASE: done/completed/closed/finished → 1, else 0)
  const completedBucket = literal(`
    CASE WHEN LOWER("Task"."status") IN ('done','completed','closed','finished')
         THEN 1 ELSE 0 END
  `);

  // 2. Overdue pending tasks first
  //    (status not done AND dueDate < today → 0, else 1)
  const overdueBucket = literal(`
    CASE WHEN LOWER("Task"."status") NOT IN ('done','completed','closed','finished')
              AND "Task"."dueDate" IS NOT NULL
              AND "Task"."dueDate" < CURRENT_DATE
         THEN 0 ELSE 1 END
  `);

  // 3. Status urgency ordering
  const statusUrgency = literal(`
    CASE LOWER("Task"."status")
      WHEN 'stuck'              THEN 1
      WHEN 'blocked'            THEN 1
      WHEN 'escalated'          THEN 1
      WHEN 'working_on_it'      THEN 3
      WHEN 'in_progress'        THEN 3
      WHEN 'review'             THEN 4
      WHEN 'waiting_for_review' THEN 4
      WHEN 'pending_deploy'     THEN 4
      WHEN 'ready_to_start'     THEN 5
      WHEN 'not_started'        THEN 5
      WHEN 'done'               THEN 9
      WHEN 'completed'          THEN 9
      WHEN 'closed'             THEN 9
      WHEN 'finished'           THEN 9
      ELSE 5
    END
  `);

  // 4. Progress: for pending tasks, lower progress first (needs more attention)
  //    For completed tasks, progress doesn't matter — push to end
  const progressOrder = literal(`
    CASE WHEN LOWER("Task"."status") IN ('done','completed','closed','finished')
         THEN 100
         ELSE COALESCE("Task"."progress", 0)
    END
  `);

  return [
    [completedBucket, 'ASC'],    // pending first
    [overdueBucket, 'ASC'],      // overdue pending first
    [statusUrgency, 'ASC'],      // stuck > in-progress > review > not-started > done
    [progressOrder, 'ASC'],      // lower progress first (among pending)
    ['dueDate', 'ASC NULLS LAST'], // earlier due date first, no-date last
    ['updatedAt', 'DESC'],       // recently updated first
  ];
}

/**
 * Same as buildPendingPriorityOrder but with a custom table alias for use
 * in nested includes (e.g., when Task is included inside Board).
 *
 * @param {string} alias - The SQL alias for the tasks table (e.g., 'tasks')
 * @returns {Array} Sequelize order array
 */
function buildPendingPriorityOrderAliased(alias) {
  const q = alias;

  const completedBucket = literal(`
    CASE WHEN LOWER("${q}"."status") IN ('done','completed','closed','finished')
         THEN 1 ELSE 0 END
  `);

  const overdueBucket = literal(`
    CASE WHEN LOWER("${q}"."status") NOT IN ('done','completed','closed','finished')
              AND "${q}"."dueDate" IS NOT NULL
              AND "${q}"."dueDate" < CURRENT_DATE
         THEN 0 ELSE 1 END
  `);

  const statusUrgency = literal(`
    CASE LOWER("${q}"."status")
      WHEN 'stuck'              THEN 1
      WHEN 'blocked'            THEN 1
      WHEN 'escalated'          THEN 1
      WHEN 'working_on_it'      THEN 3
      WHEN 'in_progress'        THEN 3
      WHEN 'review'             THEN 4
      WHEN 'waiting_for_review' THEN 4
      WHEN 'pending_deploy'     THEN 4
      WHEN 'ready_to_start'     THEN 5
      WHEN 'not_started'        THEN 5
      WHEN 'done'               THEN 9
      WHEN 'completed'          THEN 9
      WHEN 'closed'             THEN 9
      WHEN 'finished'           THEN 9
      ELSE 5
    END
  `);

  const progressOrder = literal(`
    CASE WHEN LOWER("${q}"."status") IN ('done','completed','closed','finished')
         THEN 100
         ELSE COALESCE("${q}"."progress", 0)
    END
  `);

  return [
    [completedBucket, 'ASC'],
    [overdueBucket, 'ASC'],
    [statusUrgency, 'ASC'],
    [progressOrder, 'ASC'],
    [literal(`"${q}"."dueDate"`), 'ASC NULLS LAST'],
    [literal(`"${q}"."updatedAt"`), 'DESC'],
  ];
}

module.exports = {
  isCompletedStatus,
  getStatusUrgency,
  normalizeProgress,
  isOverdue,
  getTaskPriorityScore,
  sortTasksByPendingPriority,
  buildPendingPriorityOrder,
  buildPendingPriorityOrderAliased,
  // Exported for testing
  COMPLETED_STATUSES,
  STATUS_URGENCY,
};
