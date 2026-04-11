const {
  isCompletedStatus,
  getPriorityRank,
  normalizeProgress,
  isOverdue,
  getTaskPriorityScore,
  sortTasksByPendingPriority,
  buildPendingPriorityOrder,
  findGroupForStatus,
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
  });

  test('returns false for null/undefined/empty', () => {
    expect(isCompletedStatus(null)).toBe(false);
    expect(isCompletedStatus(undefined)).toBe(false);
    expect(isCompletedStatus('')).toBe(false);
  });
});

// ─── getPriorityRank ────────────────────────────────────────────────────────

describe('getPriorityRank', () => {
  test('critical is highest (0)', () => {
    expect(getPriorityRank('critical')).toBe(0);
  });

  test('high is 1', () => {
    expect(getPriorityRank('high')).toBe(1);
  });

  test('medium is 2', () => {
    expect(getPriorityRank('medium')).toBe(2);
  });

  test('low is 3', () => {
    expect(getPriorityRank('low')).toBe(3);
  });

  test('null/undefined defaults to low (3)', () => {
    expect(getPriorityRank(null)).toBe(3);
    expect(getPriorityRank(undefined)).toBe(3);
  });

  test('unknown priority defaults to low (3)', () => {
    expect(getPriorityRank('unknown')).toBe(3);
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
  });

  test('handles null/undefined', () => {
    expect(normalizeProgress(null)).toBe(0);
    expect(normalizeProgress(undefined)).toBe(0);
  });

  test('handles invalid strings', () => {
    expect(normalizeProgress('abc')).toBe(0);
  });
});

// ─── isOverdue ──────────────────────────────────────────────────────────────

describe('isOverdue', () => {
  test('returns true for past due date on pending task', () => {
    expect(isOverdue({ status: 'working_on_it', dueDate: '2020-01-01' })).toBe(true);
  });

  test('returns false for completed task even with past due date', () => {
    expect(isOverdue({ status: 'done', dueDate: '2020-01-01' })).toBe(false);
  });

  test('returns false for no due date', () => {
    expect(isOverdue({ status: 'working_on_it', dueDate: null })).toBe(false);
  });

  test('returns false for null task', () => {
    expect(isOverdue(null)).toBe(false);
  });
});

// ─── sortTasksByPendingPriority ────────────────────────────────────────────

describe('sortTasksByPendingPriority', () => {
  test('completed tasks sink to bottom', () => {
    const tasks = [
      { id: '1', status: 'done', priority: 'critical' },
      { id: '2', status: 'not_started', priority: 'low' },
    ];
    const sorted = sortTasksByPendingPriority(tasks);
    expect(sorted[0].id).toBe('2'); // pending first even with low priority
    expect(sorted[1].id).toBe('1'); // done last even with critical priority
  });

  test('sorts by priority: critical > high > medium > low', () => {
    const tasks = [
      { id: 'low', status: 'not_started', priority: 'low' },
      { id: 'critical', status: 'not_started', priority: 'critical' },
      { id: 'medium', status: 'not_started', priority: 'medium' },
      { id: 'high', status: 'not_started', priority: 'high' },
    ];
    const sorted = sortTasksByPendingPriority(tasks);
    expect(sorted.map(t => t.id)).toEqual(['critical', 'high', 'medium', 'low']);
  });

  test('same priority sorts by due date (earliest first)', () => {
    const tasks = [
      { id: 'later', status: 'not_started', priority: 'medium', dueDate: '2026-12-01' },
      { id: 'sooner', status: 'not_started', priority: 'medium', dueDate: '2026-06-01' },
    ];
    const sorted = sortTasksByPendingPriority(tasks);
    expect(sorted[0].id).toBe('sooner');
    expect(sorted[1].id).toBe('later');
  });

  test('tasks without due date go after tasks with due date (same priority)', () => {
    const tasks = [
      { id: 'no_date', status: 'not_started', priority: 'high' },
      { id: 'has_date', status: 'not_started', priority: 'high', dueDate: '2026-12-01' },
    ];
    const sorted = sortTasksByPendingPriority(tasks);
    expect(sorted[0].id).toBe('has_date');
    expect(sorted[1].id).toBe('no_date');
  });

  test('high priority task appears above medium even without due date', () => {
    const tasks = [
      { id: 'med_with_date', status: 'not_started', priority: 'medium', dueDate: '2026-01-01' },
      { id: 'high_no_date', status: 'not_started', priority: 'high' },
    ];
    const sorted = sortTasksByPendingPriority(tasks);
    expect(sorted[0].id).toBe('high_no_date'); // high > medium regardless of date
  });

  test('returns empty array for null/empty input', () => {
    expect(sortTasksByPendingPriority(null)).toEqual([]);
    expect(sortTasksByPendingPriority([])).toEqual([]);
  });

  test('does not mutate original array', () => {
    const tasks = [
      { id: '1', status: 'done', priority: 'high' },
      { id: '2', status: 'not_started', priority: 'low' },
    ];
    const original = [...tasks];
    sortTasksByPendingPriority(tasks);
    expect(tasks).toEqual(original);
  });

  test('handles tasks with null/undefined fields gracefully', () => {
    const tasks = [
      { id: '1', status: null, priority: null, dueDate: null },
      { id: '2' },
      { id: '3', status: 'done', priority: 'high' },
    ];
    expect(() => sortTasksByPendingPriority(tasks)).not.toThrow();
    const sorted = sortTasksByPendingPriority(tasks);
    expect(sorted).toHaveLength(3);
    expect(sorted[sorted.length - 1].id).toBe('3'); // done last
  });

  test('full ordering example from real board data', () => {
    const tasks = [
      { id: 'software_test', status: 'done',        priority: 'high',   dueDate: null },
      { id: 'try_115',       status: 'not_started', priority: 'medium', dueDate: null },
      { id: 'day_3',         status: 'not_started', priority: 'medium', dueDate: null },
      { id: 'hi',            status: 'done',        priority: 'medium', dueDate: null },
      { id: 'hello',         status: 'done',        priority: 'medium', dueDate: null },
      { id: 'sdfjsald',      status: 'not_started', priority: 'medium', dueDate: null },
    ];
    const sorted = sortTasksByPendingPriority(tasks);
    // Pending tasks first (not_started), then done
    expect(sorted[0].status).toBe('not_started');
    expect(sorted[1].status).toBe('not_started');
    expect(sorted[2].status).toBe('not_started');
    // Done tasks last, high priority first within done
    expect(sorted[3].id).toBe('software_test'); // done + high
    expect(sorted[4].status).toBe('done'); // done + medium
    expect(sorted[5].status).toBe('done'); // done + medium
  });
});

// ─── findGroupForStatus ────────────────────────────────────────────────────

describe('findGroupForStatus', () => {
  const defaultGroups = [
    { id: 'new', title: 'New' },
    { id: 'in_progress', title: 'In Progress' },
    { id: 'done', title: 'Done' },
  ];

  test('done status maps to Done group', () => {
    expect(findGroupForStatus('done', defaultGroups)).toBe('done');
  });

  test('working_on_it maps to In Progress group', () => {
    expect(findGroupForStatus('working_on_it', defaultGroups)).toBe('in_progress');
  });

  test('in_progress maps to In Progress group', () => {
    expect(findGroupForStatus('in_progress', defaultGroups)).toBe('in_progress');
  });

  test('not_started maps to first group (fallback)', () => {
    expect(findGroupForStatus('not_started', defaultGroups)).toBe('new');
  });

  test('exact id match works', () => {
    const groups = [
      { id: 'done', title: 'Completed Tasks' },
      { id: 'todo', title: 'To Do' },
    ];
    expect(findGroupForStatus('done', groups)).toBe('done');
  });

  test('pattern match on title works for Completed', () => {
    const groups = [
      { id: 'g1', title: 'To Do' },
      { id: 'g2', title: 'Completed' },
    ];
    expect(findGroupForStatus('done', groups)).toBe('g2');
  });

  test('returns null for empty groups', () => {
    expect(findGroupForStatus('done', [])).toBeNull();
  });

  test('returns null for null status', () => {
    expect(findGroupForStatus(null, defaultGroups)).toBeNull();
  });

  test('returns null for unrecognized status with no match', () => {
    expect(findGroupForStatus('custom_weird_status', defaultGroups)).toBeNull();
  });
});

// ─── buildPendingPriorityOrder ─────────────────────────────────────────────

describe('buildPendingPriorityOrder', () => {
  test('returns an array of order clauses', () => {
    const order = buildPendingPriorityOrder();
    expect(Array.isArray(order)).toBe(true);
    expect(order.length).toBeGreaterThanOrEqual(4);
  });

  test('each clause has [expression, direction] format', () => {
    const order = buildPendingPriorityOrder();
    order.forEach(clause => {
      expect(Array.isArray(clause)).toBe(true);
      expect(clause).toHaveLength(2);
    });
  });
});
