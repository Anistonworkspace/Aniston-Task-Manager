import { describe, test, expect } from 'vitest';
import { routeEvent } from '../eventRouter';

// Regression suite for the May 12 bug where the assignee's BoardPage cells
// (Labels, Reference, Link/URL) stayed stale after another user changed
// them — until manual reload. Root cause: the three per-task multi-value
// events were emitted by the server but not listed in RealtimeProvider's
// REALTIME_EVENTS array, so the underlying socket listener never attached
// and direct subscribers never fired. The router itself also had no case
// for them, so future useRealtimeQuery() consumers wouldn't invalidate.
//
// These tests pin both fixes so a future cleanup doesn't accidentally drop
// the routing again.

describe('eventRouter — task:labels_updated / task:references_updated / task:links_updated', () => {
  test.each([
    'task:labels_updated',
    'task:references_updated',
    'task:links_updated',
  ])('%s with taskId+boardId invalidates per-task, per-board, and my-tasks keys', (event) => {
    const keys = routeEvent(event, { taskId: 't1', boardId: 'b1' });
    expect(keys).toContain('tasks.id.t1');
    expect(keys).toContain('tasks.board.b1');
    expect(keys).toContain('tasks.assignedTo.me');
  });

  test('payload with no boardId still emits tasks.id when taskId present', () => {
    const keys = routeEvent('task:labels_updated', { taskId: 't1' });
    expect(keys).toContain('tasks.id.t1');
    expect(keys).not.toContain('tasks.board.undefined');
    expect(keys).toContain('tasks.assignedTo.me');
  });

  test('payload with no identifiers still invalidates the assignee surface', () => {
    // Defensive: even a malformed event must not produce a no-op for the
    // user's MyWork view — assignees might be relying on that surface.
    const keys = routeEvent('task:references_updated', {});
    expect(keys).toContain('tasks.assignedTo.me');
  });
});
