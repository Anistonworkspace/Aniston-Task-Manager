const { DirectorPlan, User } = require('../models');
const { buildAdaptiveCard, sendCard } = require('./teamsWebhook');

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';

// Track sent notifications to avoid duplicates across cron runs.
// Keyed by `${planId}-${categoryId}-${taskIndex}-${threshold}`
const sentNotifications = new Set();

// Clear stale entries daily (entries older than 24h are irrelevant)
let lastCleanup = Date.now();
function cleanupSentNotifications() {
  const ONE_DAY = 24 * 60 * 60 * 1000;
  if (Date.now() - lastCleanup > ONE_DAY) {
    sentNotifications.clear();
    lastCleanup = Date.now();
  }
}

/**
 * Check all DirectorPlan records for today and send Teams deadline notifications
 * at 48-hour and 2-hour thresholds.
 */
async function checkDirectorPlanDeadlines() {
  cleanupSentNotifications();

  const today = new Date().toISOString().slice(0, 10);

  try {
    const plans = await DirectorPlan.findAll({
      where: { date: today },
      include: [
        { model: User, as: 'director', attributes: ['id', 'name', 'email'] },
      ],
    });

    if (!plans.length) return;

    const now = new Date();
    let notificationCount = 0;

    for (const plan of plans) {
      const categories = plan.categories;
      if (!Array.isArray(categories)) continue;

      const directorName = plan.director?.name || 'Director';

      for (const category of categories) {
        if (!Array.isArray(category.tasks)) continue;

        for (let taskIndex = 0; taskIndex < category.tasks.length; taskIndex++) {
          const task = category.tasks[taskIndex];
          if (!task.deadline || task.done) continue;

          // Parse the deadline — could be ISO datetime string or time-only (HH:MM)
          let deadlineDate;
          if (task.deadline.includes('T') || task.deadline.includes('-')) {
            // Full ISO datetime
            deadlineDate = new Date(task.deadline);
          } else if (task.deadline.includes(':')) {
            // Time-only (e.g. "14:30") — treat as today at that time
            const [hours, minutes] = task.deadline.split(':').map(Number);
            deadlineDate = new Date(today);
            deadlineDate.setHours(hours, minutes, 0, 0);
          } else {
            continue; // Unrecognized format
          }

          if (isNaN(deadlineDate.getTime())) continue;

          const hoursRemaining = (deadlineDate.getTime() - now.getTime()) / (1000 * 60 * 60);

          // Check 48-hour threshold (between 47.5 and 48.5 hours to catch within a 30-min cron window)
          if (hoursRemaining > 0 && hoursRemaining <= 48.5 && hoursRemaining > 47.5) {
            const key = `${plan.id}-${category.id}-${taskIndex}-48h`;
            if (!sentNotifications.has(key)) {
              await sendDeadlineNotification({
                planId: plan.id,
                planDate: plan.date,
                directorName,
                categoryName: category.label,
                taskName: task.text || task.name || `Task ${taskIndex + 1}`,
                deadline: deadlineDate,
                assigneeName: task.assignee || directorName,
                priority: task.priority || category.color || 'Normal',
                threshold: '2 days',
                urgency: 'warning',
              });
              sentNotifications.add(key);
              notificationCount++;
            }
          }

          // Check 2-hour threshold (between 1.5 and 2.5 hours to catch within a 30-min cron window)
          if (hoursRemaining > 0 && hoursRemaining <= 2.5 && hoursRemaining > 1.5) {
            const key = `${plan.id}-${category.id}-${taskIndex}-2h`;
            if (!sentNotifications.has(key)) {
              await sendDeadlineNotification({
                planId: plan.id,
                planDate: plan.date,
                directorName,
                categoryName: category.label,
                taskName: task.text || task.name || `Task ${taskIndex + 1}`,
                deadline: deadlineDate,
                assigneeName: task.assignee || directorName,
                priority: task.priority || category.color || 'Normal',
                threshold: '2 hours',
                urgency: 'urgent',
              });
              sentNotifications.add(key);
              notificationCount++;
            }
          }
        }
      }
    }

    if (notificationCount > 0) {
      console.log(`[DeadlineNotification] Sent ${notificationCount} director plan deadline notification(s)`);
    }
  } catch (error) {
    console.error('[DeadlineNotification] Error checking deadlines:', error.message);
  }
}

/**
 * Send a deadline alert card to the Teams webhook.
 */
async function sendDeadlineNotification({ planDate, directorName, categoryName, taskName, deadline, assigneeName, priority, threshold, urgency }) {
  const isUrgent = urgency === 'urgent';
  const title = isUrgent
    ? '\u23F0 URGENT - Task Deadline Alert (2 hours remaining)'
    : '\u23F0 Task Deadline Alert';

  const subtitle = isUrgent
    ? `A Director Plan task has only ${threshold} remaining before its deadline!`
    : `A Director Plan task is due in ${threshold}.`;

  const deadlineStr = deadline instanceof Date
    ? deadline.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
    : String(deadline);

  const card = buildAdaptiveCard({
    title,
    subtitle,
    facts: [
      { title: 'Task', value: taskName },
      { title: 'Category', value: categoryName },
      { title: 'Deadline', value: deadlineStr },
      { title: 'Assignee', value: assigneeName },
      { title: 'Priority', value: priority },
      { title: 'Plan Date', value: planDate },
      { title: 'Director', value: directorName },
    ],
    actionUrl: `${CLIENT_URL}/director-plan`,
    actionLabel: 'Open Director Plan',
  });

  await sendCard(card);
}

module.exports = { checkDirectorPlanDeadlines };
