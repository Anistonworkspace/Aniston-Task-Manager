const {
  isCompletedStatus,
  getStatusUrgency,
  normalizeProgress,
  isOverdue,
  getTaskPriorityScore,
  sortTasksByPendingPriority,
  buildPendingPriorityOrder,
} = require('../../utils/taskPrioritization');

// ─── isCompletedStatus ──────────────────────────────────────────────────────

describe('isCompletedStatus', () => {
  test('recognizes done/completed/closed/finished', () => {
    expect(isCompletedStatus('done')).toBe(true);
    expect(isCompletedStatus('completed')).toBe(true);
    expect(isCompletedStatus('closed')).toBe(true);
    expect(isCompletedStatus('finished')).toBe(true);
  });

  test('is case-insensitive', () => {
    expect(isCompletedStatus('Done')).toBe(true);
    expect(isCompletedStatus('DONE')).toBe(true);
  });

  test('returns false for pending statuses', () => {
    expect(isCompletedStatus('not_started')).toBe(false);
    expect(isCompletedStatus('working_on_it')).toBe(false);
    expect(isCompletedStatus('stuck')).toBe(false);
    expect(isCompletedStatus('review')).toBe(false);
  });

  test('returns false for null/undefined/empty', () => {
    expect(isCompletedStatus(null)).toBe(false);
    expect(isCompletedStatus(undefined)).toBe(false);
    expect(isCompletedStatus('')).toBe(false);
  });
});

// ─── getStatusUrgency ───────────────────────────────────────────────────────

describe('getStatusUrgency', () => {
  test('stuck/blocked are most urgent', () => {
    expect(getStatusUrgency('stuck')).toBe(10);
    expect(getStatusUrgency('blocked')).toBe(10);
  });

  test('in-progress statuses are middle urgency', () => {
    expect(getStatusUrgency('working_on_it')).toBe(30);
    expect(getStatusUrgency('in_progress')).toBe(30);
  });

  test('review statuses are lower urgency', () => {
    expect(getStatusUrgency('review')).toBe(40);
    expect(getStatusUrgency('waiting_for_review')).toBe(40);
  });

  test('not started is low urgency', () => {
    expect(getStatusUrgency('not_started')).toBe(50);
  });

  test('done is lowest urgency', () => {
    expect(getStatusUrgency('done')).toBe(90);
  });

  test('unknown status defaults to pending urgency', () => {
    expect(getStatusUrgency('custom_status')).toBe(50);
  });

  test('null/undefined defaults to pending urgency', () => {
    expect(getStatusUrgency(null)).toBe(50);
    expect(getStatusUrgency(undefined)).toBe(50);
  });
});

// ─── normalizeProgress ─────────────────────────────────────────────────────

describe('normalizeProgress', () => {
  test('handles numeric values', () => {
    expect(normalizeProgress(0)).toBe(0);
    expect(normalizeProgress(50)).toBe(50);
    expect(normalizeProgress(100)).toBe(100);
  });

  test('clamps to 0-100', () => {
    expect(normalizeProgress(-10)).toBe(0);
    expect(normalizeProgress(150)).toBe(100);
  });

  test('handles string percentages', () => {
    expect(normalizeProgress('45%')).toBe(45);
    expect(normalizeProgress('100%')).toBe(100);
    expect(normalizeProgress('0%')).toBe(0);
  });

  test('handles string numbers', () => {
    expect(normalizeProgress('75')).toBe(75);
  });

  test('handles null/undefined', () => {
    expect(normalizeProgress(null)).toBe(0);
    expect(normalizeProgress(undefined)).toBe(0);
  });

  test('handles invalid strings', () => {
    expect(normalizeProgress('abc')).toBe(0);
    expect(normalizeProgress('')).toBe(0);
  });

  test('rounds to integer', () => {
    expect(normalizeProgress(33.7)).toBe(34);
    expect(normalizeProgress(33.3)).toBe(33);
  });
});

// ─── isOverdue ──────────────────────────────────────────────────────────────

describe('isOverdue', () => {
  test('returns true for past due date on pending task', () => {
    const task = { status: 'working_on_it', dueDate: '2020-01-01' };
    expect(isOverdue(task)).toBe(true);
  });

  test('returns false for completed task even with past due date', () => {
    const task = { status: 'done', dueDate: '2020-01-01' };
    expect(isOverdue(task)).toBe(false);
  });

  test('returns false for future due date', () => {
    const futureDate = new Date();
    futureDate.setFullYear(futureDate.getFullYear() + 1);
    const task = { status: 'working_on_it', dueDate: futureDate.toISOString().slice(0, 10) };
    expect(isOverdue(task)).toBe(false);
  });

  test('returns false for no due date', () => {
    const task = { status: 'working_on_it', dueDate: null };
    expect(isOverdue(task)).toBe(false);
  });

  test('returns false for null task', () => {
    expect(isOverdue(null)).toBe(false);
  });
});

// ─── getTaskPriorityScore ──────────────────────────────────────────────────

describe('getTaskPriorityScore', () => {
  test('completed tasks have much higher score than pending', () => {
    const doneTask = { status: 'done', progress: 100 };
    const pendingTask = { status: 'not_started', progress: 0 };
    expect(getTaskPriorityScore(doneTask)).toBeGreaterThan(getTaskPriorityScore(pendingTask));
  });

  test('stuck tasks have lower score than in-progress', () => {
    const stuckTask = { status: 'stuck', progress: 50 };
    const workingTask = { status: 'working_on_it', progress: 50 };
    expect(getTaskPriorityScore(stuckTask)).toBeLessThan(getTaskPriorityScore(workingTask));
  });

  test('overdue tasks have lower score (higher priority)', () => {
    const overdueTask = { status: 'working_on_it', progress: 50, dueDate: '2020-01-01' };
    const normalTask = { status: 'working_on_it', progress: 50 };
    expect(getTaskPriorityScore(overdueTask)).toBeLessThan(getTaskPriorityScore(normalTask));
  });

  test('null task returns max score', () => {
    expect(getTaskPriorityScore(null)).toBe(99999);
  });

  test('task with no status defaults to not_started urgency', () => {
    const task = { progress: 0 };
    const notStartedTask = { status: 'not_started', progress: 0 };
    expect(getTaskPriorityScore(task)).toBe(getTaskPriorityScore(notStartedTask));
  });
});

// ─── sortTasksByPendingPriority ────────────────────────────────────────────

describe('sortTasksByPendingPriority', () => {
  test('puts pending tasks before completed tasks', () => {
    const tasks = [
      { id: '1', status: 'done', progress: 100 },
      { id: '2', status: 'not_started', progress: 0 },
      { id: '3', status: 'working_on_it', progress: 50 },
    ];
    const sorted = sortTasksByPendingPriority(tasks);
    expect(sorted[sorted.length - 1].status).toBe('done');
    expect(sorted[0].status).not.toBe('done');
  });

  test('puts stuck tasks before in-progress tasks', () => {
    const tasks = [
      { id: '1', status: 'working_on_it', progress: 50 },
      { id: '2', status: 'stuck', progress: 50 },
    ];
    const sorted = sortTasksByPendingPriority(tasks);
    expect(sorted[0].id).toBe('2'); // stuck first
    expect(sorted[1].id).toBe('1');
  });

  test('puts overdue tasks before non-overdue pending tasks', () => {
    const tasks = [
      { id: '1', status: 'working_on_it', progress: 50 },
      { id: '2', status: 'working_on_it', progress: 50, dueDate: '2020-01-01' },
    ];
    const sorted = sortTasksByPendingPriority(tasks);
    expect(sorted[0].id).toBe('2'); // overdue first
  });

  test('returns empty array for empty input', () => {
    expect(sortTasksByPendingPriority([])).toEqual([]);
  });

  test('returns empty array for null input', () => {
    expect(sortTasksByPendingPriority(null)).toEqual([]);
  });

  test('does not mutate original array', () => {
    const tasks = [
      { id: '1', status: 'done', progress: 100 },
      { id: '2', status: 'stuck', progress: 0 },
    ];
    const original = [...tasks];
    sortTasksByPendingPriority(tasks);
    expect(tasks).toEqual(original);
  });

  test('deterministic ordering with tie-breakers', () => {
    const tasks = [
      { id: '2', status: 'not_started', progress: 0, updatedAt: '2024-01-01T00:00:00Z' },
      { id: '1', status: 'not_started', progress: 0, updatedAt: '2024-01-02T00:00:00Z' },
    ];
    const sorted = sortTasksByPendingPriority(tasks);
    expect(sorted[0].id).toBe('1'); // more recently updated first
    expect(sorted[1].id).toBe('2');
  });

  test('handles tasks with null/undefined fields gracefully', () => {
    const tasks = [
      { id: '1', status: null, progress: null, dueDate: null },
      { id: '2' },
      { id: '3', status: 'done', progress: '100%' },
      { id: '4', status: 'stuck', progress: undefined, dueDate: '2020-01-01' },
    ];
    expect(() => sortTasksByPendingPriority(tasks)).not.toThrow();
    const sorted = sortTasksByPendingPriority(tasks);
    expect(sorted).toHaveLength(4);
    // Stuck+overdue should be first, done should be last
    expect(sorted[0].id).toBe('4');
    expect(sorted[sorted.length - 1].id).toBe('3');
  });

  test('handles string progress values', () => {
    const tasks = [
      { id: '1', status: 'working_on_it', progress: '80%' },
      { id: '2', status: 'working_on_it', progress: '20%' },
    ];
    const sorted = sortTasksByPendingPriority(tasks);
    // Lower progress = more attention needed = appears first
    expect(sorted[0].id).toBe('2');
    expect(sorted[1].id).toBe('1');
  });

  test('full priority chain: blocked > overdue > in-progress > review > not-started > done', () => {
    const futureDate = new Date();
    futureDate.setFullYear(futureDate.getFullYear() + 1);
    const futureDateStr = futureDate.toISOString().slice(0, 10);

    const tasks = [
      { id: 'done', status: 'done', progress: 100, dueDate: futureDateStr },
      { id: 'not_started', status: 'not_started', progress: 0, dueDate: futureDateStr },
      { id: 'review', status: 'review', progress: 80, dueDate: futureDateStr },
      { id: 'working', status: 'working_on_it', progress: 50, dueDate: futureDateStr },
      { id: 'overdue', status: 'working_on_it', progress: 50, dueDate: '2020-01-01' },
      { id: 'stuck', status: 'stuck', progress: 30, dueDate: futureDateStr },
    ];

    const sorted = sortTasksByPendingPriority(tasks);
    const ids = sorted.map(t => t.id);

    // Stuck should be before working
    expect(ids.indexOf('stuck')).toBeLessThan(ids.indexOf('working'));
    // Overdue working should be before non-overdue working
    expect(ids.indexOf('overdue')).toBeLessThan(ids.indexOf('working'));
    // Working should be before review (review has higher progress reducing its advantage)
    // but status urgency matters more: working=30 < review=40
    expect(ids.indexOf('working')).toBeLessThan(ids.indexOf('review'));
    // Review should be before not_started
    expect(ids.indexOf('review')).toBeLessThan(ids.indexOf('not_started'));
    // Done should be last
    expect(ids.indexOf('done')).toBe(ids.length - 1);
  });

  test('manual sort override: user-selected sort should take precedence (conceptual)', () => {
    // This test documents the design: the utility only handles default sorting.
    // Manual sort override is handled at the call site (controller/component level).
    const tasks = [
      { id: '1', status: 'done', progress: 100, createdAt: '2024-01-01' },
      { id: '2', status: 'not_started', progress: 0, createdAt: '2024-06-01' },
    ];
    // Default sort: pending first
    const defaultSorted = sortTasksByPendingPriority(tasks);
    expect(defaultSorted[0].id).toBe('2');

    // Manual sort by createdAt: user would use their own sort, not this function
    const manualSorted = [...tasks].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    expect(manualSorted[0].id).toBe('1');
  });
});

// ─── buildPendingPriorityOrder ─────────────────────────────────────────────

describe('buildPendingPriorityOrder', () => {
  test('returns an array of order clauses', () => {
    const order = buildPendingPriorityOrder();
    expect(Array.isArray(order)).toBe(true);
    expect(order.length).toBeGreaterThanOrEqual(5);
  });

  test('each clause has [expression, direction] format', () => {
    const order = buildPendingPriorityOrder();
    order.forEach(clause => {
      expect(Array.isArray(clause)).toBe(true);
      expect(clause).toHaveLength(2);
      expect(typeof clause[1]).toBe('string');
    });
  });
});
