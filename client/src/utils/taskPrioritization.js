/**
 * Pending Task Prioritization System (Frontend)
 *
 * Shared sorting logic that prioritizes unfinished tasks over completed ones,
 * with urgency-based status ordering, progress weighting, and due-date tie-breaking.
 *
 * Usage:
 *   import { sortTasksByPendingPriority } from '../utils/taskPrioritization';
 *   const sorted = sortTasksByPendingPriority(tasks);
 */

// ─── Status classification ──────────────────────────────────────────────────

const COMPLETED_STATUSES = new Set(['done', 'completed', 'closed', 'finished']);

/**
 * Returns true if the status key represents a completed/done state.
 */
export function isCompletedStatus(status) {
  if (!status) return false;
  return COMPLETED_STATUSES.has(String(status).toLowerCase().trim());
}

/**
 * Status urgency score — lower number = higher urgency (appears first).
 */
const STATUS_URGENCY = {
  stuck:               10,
  blocked:             10,
  escalated:           10,
  working_on_it:       30,
  in_progress:         30,
  review:              40,
  in_review:           40,
  waiting_for_review:  40,
  pending_deploy:      40,
  approval_pending:    40,
  qa:                  40,
  ready_to_start:      50,
  not_started:         50,
  pending:             50,
  done:                90,
  completed:           90,
  closed:              90,
  finished:            90,
};

const DEFAULT_URGENCY_PENDING = 50;
const DEFAULT_URGENCY_DONE    = 90;

export function getStatusUrgency(status) {
  if (!status) return DEFAULT_URGENCY_PENDING;
  const key = String(status).toLowerCase().trim();
  if (STATUS_URGENCY[key] !== undefined) return STATUS_URGENCY[key];
  return isCompletedStatus(key) ? DEFAULT_URGENCY_DONE : DEFAULT_URGENCY_PENDING;
}

// ─── Progress normalization ─────────────────────────────────────────────────

/**
 * Normalize progress to 0..100 integer, handling null/undefined/strings/"45%".
 */
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

/**
 * Returns true if the task is overdue (dueDate in the past and not completed).
 */
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

/**
 * Compute a numeric priority score for a task. Lower = higher priority.
 *
 * Score components:
 *   completedBucket:  +10000 if completed
 *   overdueBoost:     -500 if overdue and pending
 *   statusUrgency:    10..90 × 10
 *   progressFactor:   (100 - progress) for pending tasks
 *   dueDateFactor:    daysUntilDue × 0.1
 */
export function getTaskPriorityScore(task) {
  if (!task) return 99999;

  const status = task.status || 'not_started';
  const completed = isCompletedStatus(status);
  const progress = normalizeProgress(task.progress);

  let score = 0;

  // 1. Completed → bottom
  if (completed) score += 10000;

  // 2. Overdue boost
  if (!completed && isOverdue(task)) score -= 500;

  // 3. Status urgency
  score += getStatusUrgency(status) * 10;

  // 4. Progress (pending only): lower progress → higher priority
  // 4. Progress (pending only): lower progress → higher priority (needs more attention)
  if (!completed) score += progress;  // 0% → +0 (highest priority), 100% → +100

  // 5. Due date proximity
  if (task.dueDate && !completed) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(task.dueDate);
    due.setHours(0, 0, 0, 0);
    const daysUntil = (due - today) / (1000 * 60 * 60 * 24);
    score += daysUntil * 0.1;
  }

  return score;
}

// ─── Sort comparator ────────────────────────────────────────────────────────

/**
 * Sort an array of task objects by pending priority.
 * Returns a new sorted array (does not mutate input).
 *
 * Deterministic tie-breaking: updatedAt DESC → createdAt DESC → id ASC.
 */
export function sortTasksByPendingPriority(tasks) {
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
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}
