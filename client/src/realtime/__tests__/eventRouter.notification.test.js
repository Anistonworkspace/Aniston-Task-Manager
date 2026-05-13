import { describe, test, expect } from 'vitest';
import { routeEvent } from '../eventRouter';

// Storm-mitigation (May 2026): `notification:new` used to unconditionally
// invalidate four cache keys — including `approvals.pendingCounts` and
// `dependencies.assignedActiveCount`. A burst of 30 recurring-missed
// escalations therefore caused 60 unrelated GETs to the approvals + deps
// endpoints. We now gate those two invalidations on the notification type
// so only domain-relevant notifications trigger the corresponding refetch.
//
// These tests pin the new contract so future router edits can't silently
// re-introduce the storm.

describe('eventRouter — notification:new type-aware invalidation', () => {
  test('always invalidates the bell list + unread count', () => {
    const keys = routeEvent('notification:new', { notification: { type: 'task_assigned' } });
    expect(keys).toContain('notifications.list');
    expect(keys).toContain('notifications.unreadCount');
  });

  test.each([
    ['approval_submitted'],
    ['approval_approved'],
    ['approval_rejected'],
    ['approval_changes_requested'],
    ['approval_completed'],
    ['extension_requested'],
    ['extension_approved'],
    ['extension_rejected'],
    ['help_requested'],
    ['help_responded'],
    ['access_requested'],
    ['access_approved'],
    ['access_rejected'],
  ])('type=%s invalidates approvals.pendingCounts', (t) => {
    const keys = routeEvent('notification:new', { notification: { type: t } });
    expect(keys).toContain('approvals.pendingCounts');
  });

  test.each([
    ['dependency_requested'],
    ['dependency_accepted'],
    ['dependency_rejected'],
    ['dependency_done'],
    ['task_unblocked'],
  ])('type=%s invalidates dependencies.assignedActiveCount', (t) => {
    const keys = routeEvent('notification:new', { notification: { type: t } });
    expect(keys).toContain('dependencies.assignedActiveCount');
  });

  test.each([
    'task_assigned',
    'task_supervisor_added',
    'task_role_changed',
    'task_removed',
    'task_updated',
    'comment_added',
    'due_date',
    'mention',
    'promotion',
    'priority_change',
    'deadline_2day',
    'deadline_2hour',
    'recurring_generated',
    'recurring_missed',
  ])('type=%s does NOT invalidate approvals.pendingCounts or dependencies counters', (t) => {
    const keys = routeEvent('notification:new', { notification: { type: t } });
    expect(keys).not.toContain('approvals.pendingCounts');
    expect(keys).not.toContain('dependencies.assignedActiveCount');
  });

  test('missing notification payload still invalidates the bell list', () => {
    // Defensive: the SUT must not blow up if the payload lacks `notification`.
    const keys = routeEvent('notification:new', {});
    expect(keys).toContain('notifications.list');
    expect(keys).toContain('notifications.unreadCount');
    // And, by extension, the type-gated keys are absent because the type is.
    expect(keys).not.toContain('approvals.pendingCounts');
    expect(keys).not.toContain('dependencies.assignedActiveCount');
  });
});
