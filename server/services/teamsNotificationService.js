/**
 * Teams Notification Service
 *
 * Sends rich Adaptive Card notifications to users' Microsoft Teams chats
 * when task events occur (assignment, deletion, deadline changes, etc.).
 *
 * All sends are async/fire-and-forget with retry logic and duplicate prevention.
 */

const { getUserTeamsId, sendChatMessage, checkConnection } = require('./teamsGraphClient');
const logger = require('../utils/logger');

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';

// Bulk assignment batching: userId → { tasks[], timer, assignedByUserId }
const bulkBatchMap = new Map();
const BULK_BATCH_WINDOW_MS = 60000; // 60 seconds
const BULK_THRESHOLD = 3; // 3+ tasks → batch into summary

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Lazy-load models to avoid circular deps at startup.
 */
function getModels() {
  return require('../models');
}

/**
 * Format a date for display in cards.
 */
function formatDate(date) {
  if (!date) return 'Not set';
  const d = new Date(date);
  return d.toLocaleString('en-US', {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Generate a unique event ID for duplicate prevention.
 */
function makeEventId(type, taskId, userId, extra = '') {
  return `${type}:${taskId}:${userId}:${extra || Date.now()}`;
}

/**
 * Check if a user has Teams notifications enabled and has a Teams ID.
 * Returns { enabled, teamsUserId } or { enabled: false }.
 */
async function checkUserEligibility(userId) {
  const { User } = getModels();
  const user = await User.findByPk(userId, {
    attributes: ['id', 'email', 'teamsUserId', 'teamsNotificationsEnabled'],
  });

  if (!user || !user.teamsNotificationsEnabled) {
    return { enabled: false };
  }

  // If we don't have a cached teamsUserId, try to resolve from email
  let teamsUserId = user.teamsUserId;
  if (!teamsUserId) {
    try {
      teamsUserId = await getUserTeamsId(user.email);
      if (teamsUserId) {
        await user.update({ teamsUserId });
      }
    } catch (err) {
      logger.warn(`[TeamsNotif] Failed to resolve Teams ID for ${user.email}:`, err.message);
      return { enabled: false };
    }
  }

  if (!teamsUserId) return { enabled: false };

  return { enabled: true, teamsUserId };
}

/**
 * Log a notification attempt and check for duplicates.
 * Returns the log record if created, or null if duplicate.
 */
async function logNotification(eventId, taskId, userId, notificationType, cardPayload) {
  const { TeamsNotificationLog } = getModels();

  try {
    const record = await TeamsNotificationLog.create({
      eventId,
      taskId,
      userId,
      notificationType,
      cardPayload,
      status: 'pending',
    });
    return record;
  } catch (err) {
    // Unique constraint violation = duplicate
    if (err.name === 'SequelizeUniqueConstraintError') {
      logger.info(`[TeamsNotif] Duplicate event skipped: ${eventId}`);
      return null;
    }
    throw err;
  }
}

/**
 * Core send function. Checks eligibility, deduplicates, sends card, retries on failure.
 *
 * @param {string} userId - Target user UUID
 * @param {object} adaptiveCard - Adaptive Card JSON
 * @param {string} eventId - Unique event identifier for dedup
 * @param {string} notificationType - e.g. 'task_assigned'
 * @param {string|null} taskId - Related task UUID (nullable)
 */
async function sendTeamsCard(userId, adaptiveCard, eventId, notificationType, taskId = null) {
  try {
    // 1. Check user eligibility
    const { enabled, teamsUserId } = await checkUserEligibility(userId);
    if (!enabled) return;

    // 2. Log + deduplicate
    const logRecord = await logNotification(eventId, taskId, userId, notificationType, adaptiveCard);
    if (!logRecord) return; // duplicate

    // 3. Send via Graph API
    try {
      await sendChatMessage(teamsUserId, adaptiveCard);
      await logRecord.update({ status: 'sent', sentAt: new Date() });
    } catch (sendErr) {
      // Mark as failed, schedule retry
      await logRecord.update({
        status: 'failed',
        errorMessage: sendErr.message,
      });

      // If user not found in Teams (404), mark their teamsUserId as invalid
      if (sendErr.response?.status === 404) {
        const { User } = getModels();
        await User.update({ teamsUserId: null }, { where: { id: userId } });
        logger.warn(`[TeamsNotif] User ${userId} not found in Teams, cleared teamsUserId`);
        return; // Don't retry 404s
      }

      // Schedule retry with exponential backoff
      scheduleRetry(logRecord.id, 1);
    }
  } catch (err) {
    logger.error(`[TeamsNotif] sendTeamsCard error for user ${userId}:`, err);
  }
}

/**
 * Retry a failed notification with exponential backoff.
 * Delays: 1 min, 5 min, 15 min (max 3 retries).
 */
function scheduleRetry(logId, attempt) {
  const MAX_RETRIES = 3;
  if (attempt > MAX_RETRIES) {
    logger.warn(`[TeamsNotif] Max retries exceeded for log ${logId}`);
    return;
  }

  const delays = [60000, 300000, 900000]; // 1m, 5m, 15m
  const delay = delays[attempt - 1] || delays[delays.length - 1];

  setTimeout(async () => {
    try {
      const { TeamsNotificationLog } = getModels();
      const record = await TeamsNotificationLog.findByPk(logId);
      if (!record || record.status === 'sent' || record.status === 'cancelled') return;

      const { enabled, teamsUserId } = await checkUserEligibility(record.userId);
      if (!enabled) {
        await record.update({ status: 'skipped', errorMessage: 'User not eligible' });
        return;
      }

      await sendChatMessage(teamsUserId, record.cardPayload);
      await record.update({ status: 'sent', sentAt: new Date(), retryCount: attempt });
    } catch (err) {
      const { TeamsNotificationLog } = getModels();
      const record = await TeamsNotificationLog.findByPk(logId);
      if (record) {
        await record.update({
          status: 'failed',
          errorMessage: err.message,
          retryCount: attempt,
        });
      }
      scheduleRetry(logId, attempt + 1);
    }
  }, delay);
}

// ─── Card Builders ──────────────────────────────────────────────

function buildTaskAssignedCard({ taskTitle, boardName, assignedBy, role, deadline, priority, taskId }) {
  return {
    type: 'AdaptiveCard',
    version: '1.4',
    body: [
      {
        type: 'TextBlock',
        text: 'New Task Assigned',
        weight: 'Bolder',
        size: 'Medium',
        color: 'Accent',
      },
      {
        type: 'FactSet',
        facts: [
          { title: 'Task:', value: taskTitle },
          { title: 'Board:', value: boardName },
          { title: 'Assigned By:', value: assignedBy },
          { title: 'Your Role:', value: role === 'supervisor' ? 'Supervisor' : 'Assignee' },
          { title: 'Deadline:', value: formatDate(deadline) },
          { title: 'Priority:', value: (priority || 'medium').charAt(0).toUpperCase() + (priority || 'medium').slice(1) },
        ],
      },
    ],
    actions: [
      {
        type: 'Action.OpenUrl',
        title: 'Open Task',
        url: `${CLIENT_URL}/tasks/${taskId}`,
      },
    ],
  };
}

function buildTaskDeletedCard({ taskTitle, boardName, deletedBy }) {
  return {
    type: 'AdaptiveCard',
    version: '1.4',
    body: [
      {
        type: 'TextBlock',
        text: 'Task Removed',
        weight: 'Bolder',
        size: 'Medium',
        color: 'Attention',
      },
      {
        type: 'TextBlock',
        text: `The task '${taskTitle}' on board '${boardName}' has been removed by ${deletedBy}. No further action is needed.`,
        wrap: true,
      },
    ],
  };
}

function buildDeadlineUpdatedCard({ taskTitle, oldDeadline, newDeadline, changedBy, taskId }) {
  return {
    type: 'AdaptiveCard',
    version: '1.4',
    body: [
      {
        type: 'TextBlock',
        text: 'Deadline Updated',
        weight: 'Bolder',
        size: 'Medium',
        color: 'Warning',
      },
      {
        type: 'FactSet',
        facts: [
          { title: 'Task:', value: taskTitle },
          { title: 'Old Deadline:', value: formatDate(oldDeadline) },
          { title: 'New Deadline:', value: formatDate(newDeadline) },
          { title: 'Changed By:', value: changedBy },
        ],
      },
    ],
    actions: [
      {
        type: 'Action.OpenUrl',
        title: 'Open Task',
        url: `${CLIENT_URL}/tasks/${taskId}`,
      },
    ],
  };
}

function buildMemberRemovedCard({ taskTitle, boardName }) {
  return {
    type: 'AdaptiveCard',
    version: '1.4',
    body: [
      {
        type: 'TextBlock',
        text: 'Removed from Task',
        weight: 'Bolder',
        size: 'Medium',
      },
      {
        type: 'TextBlock',
        text: `You have been removed from the task '${taskTitle}' on board '${boardName}'. If you believe this is an error, please contact your manager.`,
        wrap: true,
      },
    ],
  };
}

function buildStatusChangedCard({ taskTitle, newStatus, changedBy, priority, taskId }) {
  return {
    type: 'AdaptiveCard',
    version: '1.4',
    body: [
      {
        type: 'TextBlock',
        text: 'Task Status Updated',
        weight: 'Bolder',
        size: 'Medium',
        color: 'Accent',
      },
      {
        type: 'FactSet',
        facts: [
          { title: 'Task:', value: taskTitle },
          { title: 'New Status:', value: newStatus.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) },
          { title: 'Priority:', value: (priority || 'medium').charAt(0).toUpperCase() + (priority || 'medium').slice(1) },
          { title: 'Changed By:', value: changedBy },
        ],
      },
    ],
    actions: [
      {
        type: 'Action.OpenUrl',
        title: 'Open Task',
        url: `${CLIENT_URL}/tasks/${taskId}`,
      },
    ],
  };
}

function buildNewCommentCard({ taskTitle, commenterName, commentPreview, taskId }) {
  return {
    type: 'AdaptiveCard',
    version: '1.4',
    body: [
      {
        type: 'TextBlock',
        text: 'New Comment on Task',
        weight: 'Bolder',
        size: 'Medium',
        color: 'Accent',
      },
      {
        type: 'FactSet',
        facts: [
          { title: 'Task:', value: taskTitle },
          { title: 'Comment By:', value: commenterName },
        ],
      },
      {
        type: 'TextBlock',
        text: commentPreview,
        wrap: true,
        isSubtle: true,
      },
    ],
    actions: [
      {
        type: 'Action.OpenUrl',
        title: 'Open Task',
        url: `${CLIENT_URL}/tasks/${taskId}`,
      },
    ],
  };
}

function buildBulkAssignmentCard({ assignedBy, tasks }) {
  const taskList = tasks
    .map(t => `\u2022 ${t.title} \u2014 Due ${formatDate(t.dueDate)}`)
    .join('\n');

  return {
    type: 'AdaptiveCard',
    version: '1.4',
    body: [
      {
        type: 'TextBlock',
        text: 'New Tasks Assigned',
        weight: 'Bolder',
        size: 'Medium',
        color: 'Accent',
      },
      {
        type: 'TextBlock',
        text: `${assignedBy} has assigned you ${tasks.length} new tasks:`,
        wrap: true,
      },
      {
        type: 'TextBlock',
        text: taskList,
        wrap: true,
      },
    ],
    actions: [
      {
        type: 'Action.OpenUrl',
        title: 'View All Tasks',
        url: `${CLIENT_URL}/dashboard`,
      },
    ],
  };
}

// ─── Public Notification Functions ──────────────────────────────

/**
 * Fetch task context (title, board name, due date, priority, status, assigned members).
 */
async function getTaskContext(taskId) {
  const { Task, Board, TaskAssignee } = getModels();
  const task = await Task.findByPk(taskId, {
    include: [
      { model: Board, as: 'board', attributes: ['id', 'name'] },
      { model: TaskAssignee, as: 'taskAssignees' },
    ],
    attributes: ['id', 'title', 'dueDate', 'priority', 'status', 'isArchived', 'boardId'],
  });
  if (!task) return null;
  return {
    id: task.id,
    title: task.title,
    boardName: task.board ? task.board.name : 'Unknown Board',
    dueDate: task.dueDate,
    priority: task.priority,
    status: task.status,
    isArchived: task.isArchived,
    assigneeIds: (task.taskAssignees || []).filter(ta => ta.role === 'assignee').map(ta => ta.userId),
    supervisorIds: (task.taskAssignees || []).filter(ta => ta.role === 'supervisor').map(ta => ta.userId),
  };
}

/**
 * Get user name by ID.
 */
async function getUserName(userId) {
  if (!userId) return 'Someone';
  const { User } = getModels();
  const user = await User.findByPk(userId, { attributes: ['id', 'name'] });
  return user ? user.name : 'Someone';
}

/**
 * Notify users when they are assigned to a task.
 * Supports bulk batching: if the same user gets 3+ assignments within 60s, sends a summary.
 *
 * @param {string} taskId - Task UUID
 * @param {string[]} userIds - Users to notify
 * @param {string} role - 'assignee' or 'supervisor'
 * @param {string} assignedByUserId - Who made the assignment
 */
async function notifyTaskAssigned(taskId, userIds, role, assignedByUserId) {
  if (!userIds || userIds.length === 0) return;

  try {
    const ctx = await getTaskContext(taskId);
    if (!ctx || ctx.isArchived || ctx.status === 'done') return;

    const assignerName = await getUserName(assignedByUserId);

    for (const uid of userIds) {
      // Skip self-assignment
      if (uid === assignedByUserId) continue;

      // Check if we should batch this (bulk assignment detection)
      const batchKey = uid;
      let batch = bulkBatchMap.get(batchKey);

      if (batch) {
        // Add to existing batch
        batch.tasks.push({ id: taskId, title: ctx.title, dueDate: ctx.dueDate });

        // If we've hit threshold, the timer will handle sending
        if (batch.tasks.length >= BULK_THRESHOLD) {
          // Clear existing timer and send immediately
          clearTimeout(batch.timer);
          const tasksToSend = [...batch.tasks];
          const assignedBy = batch.assignedByName;
          bulkBatchMap.delete(batchKey);

          const card = buildBulkAssignmentCard({ assignedBy, tasks: tasksToSend });
          const eventId = makeEventId('bulk_assignment', 'multi', uid, Date.now().toString());
          process.nextTick(() => sendTeamsCard(uid, card, eventId, 'bulk_assignment', null));
        }
        continue;
      }

      // Start a new batch window
      const newBatch = {
        tasks: [{ id: taskId, title: ctx.title, dueDate: ctx.dueDate }],
        assignedByName: assignerName,
        assignedByUserId,
        timer: null,
      };

      newBatch.timer = setTimeout(() => {
        const currentBatch = bulkBatchMap.get(batchKey);
        if (!currentBatch) return;
        bulkBatchMap.delete(batchKey);

        if (currentBatch.tasks.length >= BULK_THRESHOLD) {
          // Send bulk summary
          const card = buildBulkAssignmentCard({
            assignedBy: currentBatch.assignedByName,
            tasks: currentBatch.tasks,
          });
          const eventId = makeEventId('bulk_assignment', 'multi', uid, Date.now().toString());
          sendTeamsCard(uid, card, eventId, 'bulk_assignment', null);
        } else {
          // Send individual cards
          for (const t of currentBatch.tasks) {
            const card = buildTaskAssignedCard({
              taskTitle: t.title,
              boardName: ctx.boardName,
              assignedBy: currentBatch.assignedByName,
              role,
              deadline: t.dueDate,
              priority: ctx.priority,
              taskId: t.id,
            });
            const eventId = makeEventId('task_assigned', t.id, uid);
            sendTeamsCard(uid, card, eventId, role === 'supervisor' ? 'task_supervisor_added' : 'task_assigned', t.id);
          }
        }
      }, BULK_BATCH_WINDOW_MS);

      bulkBatchMap.set(batchKey, newBatch);
    }
  } catch (err) {
    logger.error('[TeamsNotif] notifyTaskAssigned error:', err);
  }
}

/**
 * Notify assigned members that a task has been deleted.
 * Also cancels any pending notifications for this task.
 *
 * @param {string} taskId - Task UUID
 * @param {string} taskTitle - Task title (task may be about to be destroyed)
 * @param {string} boardName - Board name
 * @param {string[]} userIds - Previously assigned user IDs
 * @param {string} deletedByUserId - Who deleted the task
 */
async function notifyTaskDeleted(taskId, taskTitle, boardName, userIds, deletedByUserId) {
  try {
    // Cancel any pending notifications for this task
    await cancelPendingNotifications(taskId);

    const deletedByName = await getUserName(deletedByUserId);
    const card = buildTaskDeletedCard({ taskTitle, boardName, deletedBy: deletedByName });

    for (const uid of userIds) {
      if (uid === deletedByUserId) continue;
      const eventId = makeEventId('task_deleted', taskId, uid);
      process.nextTick(() => sendTeamsCard(uid, card, eventId, 'task_deleted', null));
    }
  } catch (err) {
    logger.error('[TeamsNotif] notifyTaskDeleted error:', err);
  }
}

/**
 * Cancel all pending/queued Teams notifications for a task.
 * Called when a task is archived or deleted.
 */
async function cancelPendingNotifications(taskId) {
  try {
    const { TeamsNotificationLog } = getModels();
    await TeamsNotificationLog.update(
      { status: 'cancelled' },
      { where: { taskId, status: 'pending' } }
    );
  } catch (err) {
    logger.error('[TeamsNotif] cancelPendingNotifications error:', err);
  }
}

/**
 * Handle task archival — cancel pending notifications, do NOT send any new ones.
 */
async function notifyTaskArchived(taskId) {
  await cancelPendingNotifications(taskId);
}

/**
 * Notify assigned members and supervisors of a deadline change.
 */
async function notifyDeadlineChanged(taskId, oldDeadline, newDeadline, changedByUserId) {
  try {
    const ctx = await getTaskContext(taskId);
    if (!ctx || ctx.isArchived || ctx.status === 'done') return;

    const changedByName = await getUserName(changedByUserId);
    const allUserIds = [...new Set([...ctx.assigneeIds, ...ctx.supervisorIds])];

    const card = buildDeadlineUpdatedCard({
      taskTitle: ctx.title,
      oldDeadline,
      newDeadline,
      changedBy: changedByName,
      taskId,
    });

    for (const uid of allUserIds) {
      if (uid === changedByUserId) continue;
      const eventId = makeEventId('deadline_updated', taskId, uid);
      process.nextTick(() => sendTeamsCard(uid, card, eventId, 'deadline_updated', taskId));
    }
  } catch (err) {
    logger.error('[TeamsNotif] notifyDeadlineChanged error:', err);
  }
}

/**
 * Notify assigned members of a status change.
 */
async function notifyStatusChanged(taskId, newStatus, changedByUserId) {
  try {
    const ctx = await getTaskContext(taskId);
    if (!ctx || ctx.isArchived) return;
    // Don't notify for completion — that has its own flow
    if (newStatus === 'done') return;

    const changedByName = await getUserName(changedByUserId);
    const allUserIds = [...new Set([...ctx.assigneeIds, ...ctx.supervisorIds])];

    const card = buildStatusChangedCard({
      taskTitle: ctx.title,
      newStatus,
      changedBy: changedByName,
      priority: ctx.priority,
      taskId,
    });

    for (const uid of allUserIds) {
      if (uid === changedByUserId) continue;
      const eventId = makeEventId('status_changed', taskId, uid, newStatus);
      process.nextTick(() => sendTeamsCard(uid, card, eventId, 'status_changed', taskId));
    }
  } catch (err) {
    logger.error('[TeamsNotif] notifyStatusChanged error:', err);
  }
}

/**
 * Notify removed users that they were removed from a task.
 */
async function notifyMemberRemoved(taskId, userIds) {
  if (!userIds || userIds.length === 0) return;

  try {
    const ctx = await getTaskContext(taskId);
    if (!ctx || ctx.isArchived || ctx.status === 'done') return;

    const card = buildMemberRemovedCard({ taskTitle: ctx.title, boardName: ctx.boardName });

    for (const uid of userIds) {
      const eventId = makeEventId('task_removed', taskId, uid);
      process.nextTick(() => sendTeamsCard(uid, card, eventId, 'task_removed', taskId));
    }
  } catch (err) {
    logger.error('[TeamsNotif] notifyMemberRemoved error:', err);
  }
}

/**
 * Notify assigned members about a new comment from a manager.
 */
async function notifyNewComment(taskId, commenterUserId, commentContent) {
  try {
    const ctx = await getTaskContext(taskId);
    if (!ctx || ctx.isArchived || ctx.status === 'done') return;

    const commenterName = await getUserName(commenterUserId);
    const preview = commentContent.length > 120
      ? commentContent.substring(0, 120) + '...'
      : commentContent;

    const allUserIds = [...new Set([...ctx.assigneeIds, ...ctx.supervisorIds])];

    const card = buildNewCommentCard({
      taskTitle: ctx.title,
      commenterName,
      commentPreview: preview,
      taskId,
    });

    for (const uid of allUserIds) {
      if (uid === commenterUserId) continue;
      const eventId = makeEventId('new_comment', taskId, uid, Date.now().toString());
      process.nextTick(() => sendTeamsCard(uid, card, eventId, 'new_comment', taskId));
    }
  } catch (err) {
    logger.error('[TeamsNotif] notifyNewComment error:', err);
  }
}

/**
 * Get notification stats for admin dashboard.
 * Returns { sentToday, failedToday, pending }
 */
async function getNotificationStats() {
  const { TeamsNotificationLog } = getModels();
  const { Op } = require('sequelize');

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [sentToday, failedToday, pending] = await Promise.all([
    TeamsNotificationLog.count({
      where: { status: 'sent', sentAt: { [Op.gte]: todayStart } },
    }),
    TeamsNotificationLog.count({
      where: { status: 'failed', updated_at: { [Op.gte]: todayStart } },
    }),
    TeamsNotificationLog.count({
      where: { status: 'pending' },
    }),
  ]);

  const connection = await checkConnection();

  return { sentToday, failedToday, pending, ...connection };
}

module.exports = {
  sendTeamsCard,
  notifyTaskAssigned,
  notifyTaskDeleted,
  notifyTaskArchived,
  notifyDeadlineChanged,
  notifyStatusChanged,
  notifyMemberRemoved,
  notifyNewComment,
  cancelPendingNotifications,
  getNotificationStats,
};
