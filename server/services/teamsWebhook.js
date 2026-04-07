const axios = require('axios');

const WEBHOOK_URL = process.env.TEAMS_WEBHOOK_URL;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';

/**
 * Send an Adaptive Card payload to the configured Microsoft Teams incoming webhook.
 * Silently fails if the webhook URL is not configured (non-blocking).
 */
const sendCard = async (card) => {
  if (!WEBHOOK_URL) {
    return;
  }
  try {
    await axios.post(WEBHOOK_URL, card, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    });
  } catch (error) {
    console.error('[TeamsWebhook] Failed to send card:', error.message);
  }
};

/**
 * Build the standard Adaptive Card wrapper used by all notification types.
 */
const buildAdaptiveCard = ({ title, subtitle, facts, actionUrl, actionLabel }) => ({
  type: 'message',
  attachments: [
    {
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          {
            type: 'TextBlock',
            text: title,
            weight: 'Bolder',
            size: 'Medium',
            wrap: true,
          },
          {
            type: 'TextBlock',
            text: subtitle,
            isSubtle: true,
            wrap: true,
          },
          {
            type: 'FactSet',
            facts: facts.filter((f) => f.value),
          },
        ],
        actions: actionUrl
          ? [
              {
                type: 'Action.OpenUrl',
                title: actionLabel || 'View in Project Hub',
                url: actionUrl,
              },
            ]
          : [],
      },
    },
  ],
});

/**
 * Notify Teams that a new task has been created.
 */
const sendTaskCreated = async ({ task, boardName, creatorName, assigneeName }) => {
  const card = buildAdaptiveCard({
    title: 'New Task Created',
    subtitle: `${creatorName} created a task on board "${boardName}"`,
    facts: [
      { title: 'Task', value: task.title },
      { title: 'Board', value: boardName },
      { title: 'Priority', value: task.priority },
      { title: 'Assigned To', value: assigneeName || 'Unassigned' },
      { title: 'Due Date', value: task.dueDate || 'Not set' },
    ],
    actionUrl: `${CLIENT_URL}/boards/${task.boardId}/tasks/${task.id}`,
    actionLabel: 'Open Task',
  });
  await sendCard(card);
};

/**
 * Notify Teams that a task has been updated.
 */
const sendTaskUpdated = async ({ task, boardName, updaterName, changes }) => {
  const changeSummary = Object.entries(changes)
    .map(([key, val]) => `${key}: ${val}`)
    .join(', ');

  const card = buildAdaptiveCard({
    title: 'Task Updated',
    subtitle: `${updaterName} updated a task on board "${boardName}"`,
    facts: [
      { title: 'Task', value: task.title },
      { title: 'Board', value: boardName },
      { title: 'Changes', value: changeSummary },
      { title: 'Status', value: task.status },
      { title: 'Priority', value: task.priority },
    ],
    actionUrl: `${CLIENT_URL}/boards/${task.boardId}/tasks/${task.id}`,
    actionLabel: 'Open Task',
  });
  await sendCard(card);
};

/**
 * Notify Teams that a task has been marked as done.
 */
const sendTaskCompleted = async ({ task, boardName, completedByName }) => {
  const card = buildAdaptiveCard({
    title: 'Task Completed',
    subtitle: `${completedByName} completed a task on board "${boardName}"`,
    facts: [
      { title: 'Task', value: task.title },
      { title: 'Board', value: boardName },
      { title: 'Completed By', value: completedByName },
    ],
    actionUrl: `${CLIENT_URL}/boards/${task.boardId}/tasks/${task.id}`,
    actionLabel: 'Open Task',
  });
  await sendCard(card);
};

/**
 * Notify Teams that a comment was added to a task.
 */
const sendCommentAdded = async ({ task, boardName, commenterName, commentPreview }) => {
  const card = buildAdaptiveCard({
    title: 'New Comment',
    subtitle: `${commenterName} commented on a task in "${boardName}"`,
    facts: [
      { title: 'Task', value: task.title },
      { title: 'Board', value: boardName },
      { title: 'Comment', value: commentPreview },
    ],
    actionUrl: `${CLIENT_URL}/boards/${task.boardId}/tasks/${task.id}`,
    actionLabel: 'Open Task',
  });
  await sendCard(card);
};

/**
 * Unified notification dispatcher used by n8n webhook routes.
 * Accepts a `type` field and routes to the appropriate handler,
 * including a generic `custom` type for arbitrary messages.
 */
const sendTeamsNotification = async (payload) => {
  const { type } = payload;

  switch (type) {
    case 'task_created': {
      const { task } = payload;
      await sendTaskCreated({
        task,
        boardName: task.board?.name || 'Unknown Board',
        creatorName: task.creator?.name || 'n8n Automation',
        assigneeName: task.assignee?.name || 'Unassigned',
      });
      break;
    }

    case 'task_updated': {
      const { task, changes } = payload;
      await sendTaskUpdated({
        task,
        boardName: task.board?.name || 'Unknown Board',
        updaterName: 'n8n Automation',
        changes: changes || {},
      });
      break;
    }

    case 'task_completed': {
      const { task } = payload;
      await sendTaskCompleted({
        task,
        boardName: task.board?.name || 'Unknown Board',
        completedByName: 'n8n Automation',
      });
      break;
    }

    case 'custom': {
      const { title, message, taskId } = payload;
      const card = buildAdaptiveCard({
        title: title || 'Notification',
        subtitle: message || '',
        facts: [
          { title: 'Source', value: 'n8n Automation' },
          ...(taskId ? [{ title: 'Task ID', value: taskId }] : []),
        ],
        actionUrl: taskId ? `${CLIENT_URL}/tasks/${taskId}` : null,
        actionLabel: taskId ? 'Open Task' : undefined,
      });
      await sendCard(card);
      break;
    }

    default:
      console.warn(`[TeamsWebhook] Unknown notification type: ${type}`);
  }
};

module.exports = {
  sendCard,
  buildAdaptiveCard,
  sendTaskCreated,
  sendTaskUpdated,
  sendTaskCompleted,
  sendCommentAdded,
  sendTeamsNotification,
};
