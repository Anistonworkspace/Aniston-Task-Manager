/**
 * Approval workflow notification orchestrator.
 *
 * Single entry point per event type. Handles:
 *   1. In-app notification (DB row + Socket.io push) via notificationService
 *   2. Web push (VAPID) via pushService
 *   3. Microsoft Teams Adaptive Card via teamsNotificationService
 *
 * All channels are best-effort and fire-and-forget — failures in one channel
 * never block the others or the controller response.
 */

const { User, TaskWatcher } = require('../models');
const { sendNotification } = require('./notificationService');
const { sendPushToUser } = require('./pushService');
const { sendTeamsCard } = require('./teamsNotificationService');

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function loadRecipient(userId) {
  if (!userId) return null;
  return User.findByPk(userId, {
    attributes: ['id', 'name', 'email', 'teamsUserId', 'teamsNotificationsEnabled'],
  });
}

function taskUrl(task) {
  // Boards UI deep-links by task id via the board route.
  return `${CLIENT_URL}/boards/${task.boardId}?task=${task.id}`;
}

// Generic Adaptive Card builder for approval events. Uses color/title to
// differentiate the visual signal (Accent for action-needed, Good for approval,
// Attention for reject, Warning for changes_requested, Default for completed).
function buildApprovalCard({ headline, color, task, body, actorName, comment }) {
  const facts = [{ title: 'Task:', value: task.title }];
  if (actorName) facts.push({ title: 'By:', value: actorName });
  if (comment) facts.push({ title: 'Note:', value: String(comment).slice(0, 300) });

  return {
    type: 'AdaptiveCard',
    version: '1.4',
    body: [
      { type: 'TextBlock', text: headline, weight: 'Bolder', size: 'Medium', color },
      { type: 'TextBlock', text: body, wrap: true, spacing: 'Small' },
      { type: 'FactSet', facts },
    ],
    actions: [
      {
        type: 'Action.OpenUrl',
        title: 'Open Task',
        url: taskUrl(task),
      },
    ],
  };
}

/**
 * Multi-channel dispatch to a single recipient. Internally this is the only
 * place that knows about all three channels — every event function below
 * funnels through here.
 */
async function dispatchTo(recipientId, payload) {
  if (!recipientId) return;
  const user = await loadRecipient(recipientId);
  if (!user) return;

  // 1. In-app + email (notificationService handles email if SMTP configured).
  await sendNotification(
    user.id,
    payload.title,
    payload.message,
    payload.notificationType,
    payload.task.id,
    { email: user.email, userName: user.name }
  );

  // 2. Web push (silently no-ops if user has no push subscriptions).
  await sendPushToUser(user.id, {
    title: payload.title,
    body: payload.message,
    tag: `approval-${payload.task.id}-${payload.notificationType}`,
    url: taskUrl(payload.task),
  }).catch((e) => console.warn('[ApprovalNotif] push failed:', e.message));

  // 3. Teams Adaptive Card (only if user has Teams enabled — service checks).
  if (user.teamsNotificationsEnabled && user.teamsUserId) {
    // event_id column is varchar(100) and unique. Format keeps the type readable
    // but truncates UUIDs to their leading 8 chars (collisions across our keyspace
    // are negligible inside a single ms timestamp window).
    const tsKey = Date.now().toString(36);
    const eventId = `${payload.notificationType}:${payload.task.id.slice(0, 8)}:${user.id.slice(0, 8)}:${tsKey}`;
    await sendTeamsCard(user.id, payload.card, eventId, payload.notificationType, payload.task.id)
      .catch((e) => console.warn('[ApprovalNotif] Teams send failed:', e.message));
  }
}

// ─── Event-specific functions ────────────────────────────────────────────────

/**
 * A submission was made and the chain begins. Notify the level-1 approver
 * that they have something to review.
 */
async function notifySubmitted({ task, submitterName, nextApprover, comment }) {
  if (!nextApprover?.userId) return;
  await dispatchTo(nextApprover.userId, {
    notificationType: 'approval_submitted',
    title: 'Approval needed',
    message: `${submitterName} submitted "${task.title}" for your approval.`,
    task,
    card: buildApprovalCard({
      headline: 'Approval needed',
      color: 'Accent',
      body: `${submitterName} has submitted a task for your approval.`,
      task,
      actorName: submitterName,
      comment,
    }),
  });
}

/**
 * A level approved and the chain advanced. Notify the next approver in line.
 */
async function notifyAdvanced({ task, fromApproverName, nextApprover }) {
  if (!nextApprover?.userId) return;
  await dispatchTo(nextApprover.userId, {
    notificationType: 'approval_approved',
    title: 'Approval needed',
    message: `"${task.title}" advanced to your approval level.`,
    task,
    card: buildApprovalCard({
      headline: 'Your approval is needed',
      color: 'Accent',
      body: `${fromApproverName} approved this task — it has now advanced to your level.`,
      task,
      actorName: fromApproverName,
    }),
  });
}

/**
 * A rejection happened. Bounces back one level — recipient is the previous
 * approver if `toLevel >= 1`, or the submitter if the rejection was at L1.
 */
async function notifyRejected({ task, rejecterName, recipient, comment, toLevel }) {
  if (!recipient?.userId) return;
  const isBackToSubmitter = toLevel === 0;
  await dispatchTo(recipient.userId, {
    notificationType: 'approval_rejected',
    title: isBackToSubmitter ? 'Your approval submission was rejected' : 'Reconsider this approval',
    message: isBackToSubmitter
      ? `${rejecterName} rejected "${task.title}". Reason: ${comment || '(no reason given)'}`
      : `${rejecterName} rejected "${task.title}". Please re-review.`,
    task,
    card: buildApprovalCard({
      headline: isBackToSubmitter ? 'Submission rejected' : 'Re-review requested',
      color: 'Attention',
      body: isBackToSubmitter
        ? 'Your approval submission was rejected. Address the feedback and resubmit.'
        : 'A higher-level approver rejected this task. Please reconsider your approval.',
      task,
      actorName: rejecterName,
      comment,
    }),
  });
}

/**
 * Changes requested — always bounces back to the submitter.
 */
async function notifyChangesRequested({ task, requesterName, submitter, comment }) {
  if (!submitter?.userId) return;
  await dispatchTo(submitter.userId, {
    notificationType: 'approval_changes_requested',
    title: 'Changes requested on your task',
    message: `${requesterName} requested changes on "${task.title}". Note: ${comment || '(no note)'}`,
    task,
    card: buildApprovalCard({
      headline: 'Changes requested',
      color: 'Warning',
      body: 'An approver has requested changes. Please review their note and resubmit.',
      task,
      actorName: requesterName,
      comment,
    }),
  });
}

/**
 * Final approval — chain is fully approved, task is done. Notify the submitter
 * (and creator if different) so they know it's complete.
 */
async function notifyCompleted({ task, finalApproverName, submitter, creatorId }) {
  const recipientIds = new Set();
  if (submitter?.userId) recipientIds.add(submitter.userId);
  if (creatorId) recipientIds.add(creatorId);

  for (const uid of recipientIds) {
    await dispatchTo(uid, {
      notificationType: 'approval_completed',
      title: 'Task fully approved',
      message: `"${task.title}" has been fully approved${finalApproverName ? ` by ${finalApproverName}` : ''}.`,
      task,
      card: buildApprovalCard({
        headline: 'Task fully approved',
        color: 'Good',
        body: 'All approval levels have signed off. The task is now complete.',
        task,
        actorName: finalApproverName,
      }),
    });
  }
}

/**
 * Auto-approve short-circuit (super admin self-submit, no senior reviewer).
 * Just inform the submitter that it landed as approved.
 */
async function notifyAutoApproved({ task, submitter }) {
  if (!submitter?.userId) return;
  await dispatchTo(submitter.userId, {
    notificationType: 'approval_completed',
    title: 'Task auto-approved',
    message: `"${task.title}" was auto-approved (no senior reviewer in your chain).`,
    task,
    card: buildApprovalCard({
      headline: 'Task auto-approved',
      color: 'Good',
      body: 'No senior reviewer was found in your approval chain, so the task was auto-approved.',
      task,
    }),
  });
}

/**
 * Passive ping for everyone watching the task — fired on every event so
 * watchers stay in the loop without us spamming with bespoke per-event copy.
 */
async function notifyWatchers({ task, actorId, eventType, actorName }) {
  try {
    const watchers = await TaskWatcher.findAll({
      where: { taskId: task.id },
      attributes: ['userId'],
      raw: true,
    });
    for (const w of watchers) {
      if (w.userId === actorId) continue;
      // Watchers get in-app only — no push / no Teams to avoid notification fatigue
      // when a watcher is also a primary recipient for another channel.
      await sendNotification(
        w.userId,
        'Task approval updated',
        `"${task.title}" approval status changed (${eventType}) by ${actorName}.`,
        'task_updated',
        task.id
      ).catch((e) => console.warn('[ApprovalNotif] watcher in-app notif failed:', e.message));
    }
  } catch (e) {
    console.error('[ApprovalNotif] notifyWatchers error:', e.message);
  }
}

module.exports = {
  notifySubmitted,
  notifyAdvanced,
  notifyRejected,
  notifyChangesRequested,
  notifyCompleted,
  notifyAutoApproved,
  notifyWatchers,
};
