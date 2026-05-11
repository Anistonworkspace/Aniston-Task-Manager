'use strict';

/**
 * Tests for `getTaskNotificationRecipients` — the helper that unions
 * TaskAssignee rows + the legacy task.assignedTo column into a single
 * deduped Map<userId, user>.
 */

process.env.LOG_LEVEL = 'error';

const mockTAFindAll = jest.fn();
const mockUserFindByPk = jest.fn();

jest.mock('../../models', () => ({
  TaskAssignee: { findAll: (...a) => mockTAFindAll(...a) },
  User: { findByPk: (...a) => mockUserFindByPk(...a) },
}));

const { getTaskNotificationRecipients } = require('../../utils/taskNotificationRecipients');

beforeEach(() => {
  mockTAFindAll.mockReset();
  mockUserFindByPk.mockReset();
});

describe('getTaskNotificationRecipients', () => {
  it('returns an empty Map when task is null', async () => {
    const out = await getTaskNotificationRecipients(null);
    expect(out).toBeInstanceOf(Map);
    expect(out.size).toBe(0);
    expect(mockTAFindAll).not.toHaveBeenCalled();
  });

  it('returns an empty Map when task has no id', async () => {
    const out = await getTaskNotificationRecipients({});
    expect(out.size).toBe(0);
  });

  it('returns every TaskAssignee user', async () => {
    mockTAFindAll.mockResolvedValueOnce([
      { user: { id: 'u-1', name: 'Alice', email: 'a@x' } },
      { user: { id: 'u-2', name: 'Bob', email: 'b@x' } },
    ]);
    const out = await getTaskNotificationRecipients({ id: 't-1' });
    expect(out.size).toBe(2);
    expect(out.get('u-1')).toEqual({ id: 'u-1', name: 'Alice', email: 'a@x' });
    expect(out.get('u-2')).toEqual({ id: 'u-2', name: 'Bob', email: 'b@x' });
    expect(mockUserFindByPk).not.toHaveBeenCalled();
  });

  it('adds legacy assignedTo user when not already in junction', async () => {
    mockTAFindAll.mockResolvedValueOnce([
      { user: { id: 'u-1', name: 'Alice', email: 'a@x' } },
    ]);
    mockUserFindByPk.mockResolvedValueOnce({ id: 'u-legacy', name: 'Legacy', email: 'l@x' });
    const out = await getTaskNotificationRecipients({ id: 't-1', assignedTo: 'u-legacy' });
    expect(out.size).toBe(2);
    expect(out.has('u-1')).toBe(true);
    expect(out.has('u-legacy')).toBe(true);
  });

  it('does not double-add legacy assignedTo if already in junction', async () => {
    mockTAFindAll.mockResolvedValueOnce([
      { user: { id: 'u-1', name: 'Alice', email: 'a@x' } },
    ]);
    const out = await getTaskNotificationRecipients({ id: 't-1', assignedTo: 'u-1' });
    expect(out.size).toBe(1);
    expect(mockUserFindByPk).not.toHaveBeenCalled();
  });

  it('handles an empty junction with a legacy assignedTo (old single-assignee row)', async () => {
    mockTAFindAll.mockResolvedValueOnce([]);
    mockUserFindByPk.mockResolvedValueOnce({ id: 'u-legacy', name: 'Legacy', email: 'l@x' });
    const out = await getTaskNotificationRecipients({ id: 't-1', assignedTo: 'u-legacy' });
    expect(out.size).toBe(1);
    expect(out.get('u-legacy').id).toBe('u-legacy');
  });

  it('returns empty when no junction rows and no legacy assignedTo', async () => {
    mockTAFindAll.mockResolvedValueOnce([]);
    const out = await getTaskNotificationRecipients({ id: 't-1' });
    expect(out.size).toBe(0);
  });

  it('skips TaskAssignee rows whose user is null (orphaned junction)', async () => {
    mockTAFindAll.mockResolvedValueOnce([
      { user: null },
      { user: { id: 'u-2', name: 'Bob' } },
    ]);
    const out = await getTaskNotificationRecipients({ id: 't-2' });
    expect(out.size).toBe(1);
    expect(out.has('u-2')).toBe(true);
  });

  it('falls back gracefully when TaskAssignee.findAll throws', async () => {
    mockTAFindAll.mockRejectedValueOnce(new Error('db down'));
    mockUserFindByPk.mockResolvedValueOnce({ id: 'u-legacy', name: 'Legacy' });
    const out = await getTaskNotificationRecipients({ id: 't-1', assignedTo: 'u-legacy' });
    // Junction failed but legacy fallback still kicked in.
    expect(out.size).toBe(1);
    expect(out.has('u-legacy')).toBe(true);
  });

  it('returns empty when both junction and legacy lookup throw', async () => {
    mockTAFindAll.mockRejectedValueOnce(new Error('db down'));
    mockUserFindByPk.mockRejectedValueOnce(new Error('also down'));
    const out = await getTaskNotificationRecipients({ id: 't-1', assignedTo: 'u-legacy' });
    expect(out.size).toBe(0);
  });
});
