'use strict';

/**
 * Tests for server/services/approvalNotificationService.js — Phase 2.7 of
 * the QA remediation plan (docs/qa-audit-2026-05-17.md → §22 P0 item #7).
 * Previously 0% coverage.
 *
 * Each event function funnels through a shared `dispatchTo` that fans out
 * to in-app, web-push, and Teams channels. Test scope:
 *   - dispatchTo fan-out: in-app always, push always, Teams conditional
 *   - dispatchTo no-op when recipientId / user missing
 *   - dispatchTo absorbs push + Teams failures (channel failures must
 *     never block the controller response)
 *   - each public function maps its event → notificationType + title +
 *     adaptive-card color correctly
 *   - notifyRejected differentiates toLevel=0 (back to submitter) vs >0
 *     (re-review request)
 *   - notifyCompleted dispatches to submitter AND creator (deduped)
 *   - notifyWatchers skips the actor and uses in-app only
 */

// CLIENT_URL is captured at module-load time (top-level const in the
// service). Set it BEFORE the service is required so taskUrl uses our
// test domain consistently.
process.env.CLIENT_URL = 'https://test.example';

jest.mock('../../models', () => ({
  User: { findByPk: jest.fn() },
  TaskWatcher: { findAll: jest.fn() },
}));
jest.mock('../../services/notificationService', () => ({
  sendNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../services/pushService', () => ({
  sendPushToUser: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../services/teamsNotificationService', () => ({
  sendTeamsCard: jest.fn().mockResolvedValue(undefined),
}));

const { User, TaskWatcher } = require('../../models');
const { sendNotification } = require('../../services/notificationService');
const { sendPushToUser } = require('../../services/pushService');
const { sendTeamsCard } = require('../../services/teamsNotificationService');
const svc = require('../../services/approvalNotificationService');

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) so the mockResolvedValueOnce queue
  // does not leak between tests — a clearAllMocks-only approach left
  // queued values in User.findByPk that the next test ate by mistake.
  jest.resetAllMocks();
  // Re-establish the defaults that resetAllMocks just wiped.
  sendNotification.mockResolvedValue(undefined);
  sendPushToUser.mockResolvedValue(undefined);
  sendTeamsCard.mockResolvedValue(undefined);
  process.env.CLIENT_URL = 'https://test.example';
});

const TASK = {
  id: '11111111-2222-3333-4444-555555555555',
  title: 'Ship the thing',
  boardId: 'bbbbbbbb-1111-2222-3333-444444444444',
};
const teamsUser = (id) => ({
  id, name: `User ${id}`, email: `${id}@example`,
  teamsUserId: `teams-${id}`, teamsNotificationsEnabled: true,
});
const localUser = (id) => ({
  id, name: `User ${id}`, email: `${id}@example`,
  teamsUserId: null, teamsNotificationsEnabled: false,
});

// ─── dispatchTo (via notifySubmitted as the proxy) ──────────────

describe('dispatchTo — multi-channel fan-out', () => {
  it('no-ops when recipient userId is missing', async () => {
    await svc.notifySubmitted({
      task: TASK, submitterName: 'Alice', nextApprover: null,
    });
    expect(sendNotification).not.toHaveBeenCalled();
    expect(sendPushToUser).not.toHaveBeenCalled();
    expect(sendTeamsCard).not.toHaveBeenCalled();
  });

  it('no-ops when User.findByPk returns null (user not loadable)', async () => {
    User.findByPk.mockResolvedValueOnce(null);
    await svc.notifySubmitted({
      task: TASK, submitterName: 'Alice', nextApprover: { userId: 'u-ghost' },
    });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('sends in-app + push for a local user (no Teams when teamsNotificationsEnabled=false)', async () => {
    User.findByPk.mockResolvedValueOnce(localUser('u-1'));
    await svc.notifySubmitted({
      task: TASK, submitterName: 'Alice', nextApprover: { userId: 'u-1' },
    });
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    expect(sendTeamsCard).not.toHaveBeenCalled();
  });

  it('also sends a Teams card when user has teamsUserId + notifications enabled', async () => {
    User.findByPk.mockResolvedValueOnce(teamsUser('u-2'));
    await svc.notifySubmitted({
      task: TASK, submitterName: 'Alice', nextApprover: { userId: 'u-2' },
    });
    expect(sendTeamsCard).toHaveBeenCalledTimes(1);
    const [userId, card, eventId, notifType, taskId] = sendTeamsCard.mock.calls[0];
    expect(userId).toBe('u-2');
    expect(card.type).toBe('AdaptiveCard');
    expect(notifType).toBe('approval_submitted');
    expect(taskId).toBe(TASK.id);
    // eventId encodes notificationType + truncated ids + timestamp for uniqueness
    // (taskId and userId are sliced to 8 chars; short test ids stay verbatim)
    expect(eventId).toMatch(/^approval_submitted:[^:]+:[^:]+:[a-z0-9]+$/);
  });

  it('absorbs a push-send failure without throwing or blocking Teams', async () => {
    User.findByPk.mockResolvedValueOnce(teamsUser('u-3'));
    sendPushToUser.mockRejectedValueOnce(new Error('push gateway down'));
    // Silence the [ApprovalNotif] push failed console.warn
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(svc.notifySubmitted({
      task: TASK, submitterName: 'Alice', nextApprover: { userId: 'u-3' },
    })).resolves.toBeUndefined();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendTeamsCard).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('absorbs a Teams-send failure without throwing', async () => {
    User.findByPk.mockResolvedValueOnce(teamsUser('u-4'));
    sendTeamsCard.mockRejectedValueOnce(new Error('graph 500'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(svc.notifySubmitted({
      task: TASK, submitterName: 'Alice', nextApprover: { userId: 'u-4' },
    })).resolves.toBeUndefined();
    warnSpy.mockRestore();
  });

  it('builds a tag scoped to (task, notificationType) so the same push refreshes in place', async () => {
    User.findByPk.mockResolvedValueOnce(localUser('u-5'));
    await svc.notifySubmitted({
      task: TASK, submitterName: 'Alice', nextApprover: { userId: 'u-5' },
    });
    const [, pushPayload] = sendPushToUser.mock.calls[0];
    expect(pushPayload.tag).toBe(`approval-${TASK.id}-approval_submitted`);
    expect(pushPayload.url).toBe(`https://test.example/boards/${TASK.boardId}?task=${TASK.id}`);
  });

  // (We don't test the `|| 'http://localhost:3000'` fallback at runtime
  // because CLIENT_URL is captured once at module-load time — testing it
  // would require resetModules + brittle re-mock plumbing. The fallback
  // literal itself is reviewed at code-review time.)
});

// ─── notifySubmitted ───────────────────────────────────────────

describe('notifySubmitted', () => {
  it('emits approval_submitted to the level-1 approver with the right title', async () => {
    User.findByPk.mockResolvedValueOnce(localUser('approver-1'));
    await svc.notifySubmitted({
      task: TASK, submitterName: 'Alice', nextApprover: { userId: 'approver-1' }, comment: 'urgent',
    });
    const [recipient, title, message, notifType] = sendNotification.mock.calls[0];
    expect(recipient).toBe('approver-1');
    expect(title).toBe('Approval needed');
    expect(message).toMatch(/Alice submitted ".*Ship the thing.*" for your approval/);
    expect(notifType).toBe('approval_submitted');
  });
});

// ─── notifyAdvanced ────────────────────────────────────────────

describe('notifyAdvanced', () => {
  it('emits approval_approved to the next approver', async () => {
    User.findByPk.mockResolvedValueOnce(localUser('approver-2'));
    await svc.notifyAdvanced({
      task: TASK, fromApproverName: 'Bob', nextApprover: { userId: 'approver-2' },
    });
    const [, title, , notifType] = sendNotification.mock.calls[0];
    expect(title).toBe('Approval needed');
    expect(notifType).toBe('approval_approved');
  });

  it('no-ops when there is no next approver (end of chain handled elsewhere)', async () => {
    await svc.notifyAdvanced({ task: TASK, fromApproverName: 'Bob', nextApprover: null });
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

// ─── notifyRejected ────────────────────────────────────────────

describe('notifyRejected', () => {
  it('uses "submission was rejected" copy when toLevel === 0 (back to submitter)', async () => {
    User.findByPk.mockResolvedValueOnce(localUser('submitter'));
    await svc.notifyRejected({
      task: TASK, rejecterName: 'Mgr', recipient: { userId: 'submitter' }, comment: 'missing context', toLevel: 0,
    });
    const [, title, message] = sendNotification.mock.calls[0];
    expect(title).toBe('Your approval submission was rejected');
    expect(message).toContain('missing context');
  });

  it('uses "reconsider" copy when toLevel >= 1 (bounce back to prior approver)', async () => {
    User.findByPk.mockResolvedValueOnce(localUser('lower-approver'));
    await svc.notifyRejected({
      task: TASK, rejecterName: 'Admin', recipient: { userId: 'lower-approver' }, comment: '', toLevel: 1,
    });
    const [, title] = sendNotification.mock.calls[0];
    expect(title).toBe('Reconsider this approval');
  });

  it('substitutes "(no reason given)" for missing comment in the submitter copy', async () => {
    User.findByPk.mockResolvedValueOnce(localUser('submitter'));
    await svc.notifyRejected({
      task: TASK, rejecterName: 'Mgr', recipient: { userId: 'submitter' }, comment: '', toLevel: 0,
    });
    const [, , message] = sendNotification.mock.calls[0];
    expect(message).toContain('(no reason given)');
  });

  it('no-ops when recipient is missing', async () => {
    await svc.notifyRejected({ task: TASK, rejecterName: 'M', recipient: null, comment: '', toLevel: 0 });
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

// ─── notifyChangesRequested ────────────────────────────────────

describe('notifyChangesRequested', () => {
  it('emits approval_changes_requested to the submitter', async () => {
    User.findByPk.mockResolvedValueOnce(localUser('sub'));
    await svc.notifyChangesRequested({
      task: TASK, requesterName: 'Mgr', submitter: { userId: 'sub' }, comment: 'add docs',
    });
    const [, title, message, notifType] = sendNotification.mock.calls[0];
    expect(title).toBe('Changes requested on your task');
    expect(message).toContain('add docs');
    expect(notifType).toBe('approval_changes_requested');
  });

  it('substitutes "(no note)" for empty comment', async () => {
    User.findByPk.mockResolvedValueOnce(localUser('sub'));
    await svc.notifyChangesRequested({
      task: TASK, requesterName: 'Mgr', submitter: { userId: 'sub' }, comment: '',
    });
    expect(sendNotification.mock.calls[0][2]).toContain('(no note)');
  });

  it('no-ops when submitter is missing', async () => {
    await svc.notifyChangesRequested({ task: TASK, requesterName: 'M', submitter: null, comment: '' });
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

// ─── notifyCompleted ───────────────────────────────────────────

describe('notifyCompleted', () => {
  it('dispatches to BOTH submitter and creator when they differ', async () => {
    User.findByPk
      .mockResolvedValueOnce(localUser('sub'))     // dispatchTo for submitter
      .mockResolvedValueOnce(localUser('creator')); // dispatchTo for creator
    await svc.notifyCompleted({
      task: TASK, finalApproverName: 'SuperAdmin', submitter: { userId: 'sub' }, creatorId: 'creator',
    });
    expect(sendNotification).toHaveBeenCalledTimes(2);
    const recipients = sendNotification.mock.calls.map((c) => c[0]).sort();
    expect(recipients).toEqual(['creator', 'sub']);
  });

  it('dedupes when submitter is also the creator', async () => {
    User.findByPk.mockResolvedValueOnce(localUser('same'));
    await svc.notifyCompleted({
      task: TASK, finalApproverName: 'SA', submitter: { userId: 'same' }, creatorId: 'same',
    });
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification.mock.calls[0][0]).toBe('same');
  });

  it('handles missing submitter gracefully (still notifies creator)', async () => {
    User.findByPk.mockResolvedValueOnce(localUser('creator'));
    await svc.notifyCompleted({
      task: TASK, finalApproverName: 'SA', submitter: null, creatorId: 'creator',
    });
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification.mock.calls[0][0]).toBe('creator');
  });

  it('no-ops when both submitter and creator are missing', async () => {
    await svc.notifyCompleted({
      task: TASK, finalApproverName: 'SA', submitter: null, creatorId: null,
    });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('omits "by X" suffix when finalApproverName is missing', async () => {
    User.findByPk.mockResolvedValueOnce(localUser('sub'));
    await svc.notifyCompleted({
      task: TASK, finalApproverName: undefined, submitter: { userId: 'sub' }, creatorId: null,
    });
    const [, , message] = sendNotification.mock.calls[0];
    expect(message).toMatch(/has been fully approved\.$/); // no "by X"
  });
});

// ─── notifyAutoApproved ────────────────────────────────────────

describe('notifyAutoApproved', () => {
  it('emits approval_completed to the submitter with the auto-approve copy', async () => {
    User.findByPk.mockResolvedValueOnce(localUser('sub'));
    await svc.notifyAutoApproved({ task: TASK, submitter: { userId: 'sub' } });
    const [, title, message, notifType] = sendNotification.mock.calls[0];
    expect(title).toBe('Task auto-approved');
    expect(message).toContain('no senior reviewer');
    expect(notifType).toBe('approval_completed');
  });

  it('no-ops when submitter is missing', async () => {
    await svc.notifyAutoApproved({ task: TASK, submitter: null });
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

// ─── notifyWatchers ────────────────────────────────────────────

describe('notifyWatchers', () => {
  it('sends in-app only to every watcher except the actor', async () => {
    TaskWatcher.findAll.mockResolvedValueOnce([
      { userId: 'w1' }, { userId: 'w2' }, { userId: 'actor' }, // actor excluded
    ]);
    await svc.notifyWatchers({
      task: TASK, actorId: 'actor', eventType: 'approval_approved', actorName: 'Mgr',
    });
    const ids = sendNotification.mock.calls.map((c) => c[0]);
    expect(ids).toEqual(['w1', 'w2']);
    expect(sendPushToUser).not.toHaveBeenCalled();
    expect(sendTeamsCard).not.toHaveBeenCalled();
  });

  it('sends each watcher a task_updated notification type (not the event-specific type)', async () => {
    TaskWatcher.findAll.mockResolvedValueOnce([{ userId: 'w1' }]);
    await svc.notifyWatchers({
      task: TASK, actorId: 'actor', eventType: 'approval_rejected', actorName: 'Mgr',
    });
    expect(sendNotification.mock.calls[0][3]).toBe('task_updated');
  });

  it('absorbs a TaskWatcher.findAll failure without throwing', async () => {
    TaskWatcher.findAll.mockRejectedValueOnce(new Error('table missing'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(svc.notifyWatchers({
      task: TASK, actorId: 'actor', eventType: 'x', actorName: 'M',
    })).resolves.toBeUndefined();
    errSpy.mockRestore();
  });

  it('absorbs a per-watcher send failure without aborting the rest', async () => {
    TaskWatcher.findAll.mockResolvedValueOnce([{ userId: 'w1' }, { userId: 'w2' }]);
    sendNotification.mockRejectedValueOnce(new Error('w1 failed')).mockResolvedValueOnce(undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await svc.notifyWatchers({ task: TASK, actorId: 'a', eventType: 'x', actorName: 'M' });
    expect(sendNotification).toHaveBeenCalledTimes(2); // both attempted
    warnSpy.mockRestore();
  });
});
