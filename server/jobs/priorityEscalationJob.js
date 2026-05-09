const cron = require('node-cron');
const { Op } = require('sequelize');
const { Task, Notification } = require('../models');
const { emitToUser } = require('../services/socketService');
const { logActivity } = require('../services/activityService');
const { sanitizeNotificationField, sanitizeNotificationMessage } = require('../utils/sanitize');
const { withCronLock } = require('./cronLock');

/**
 * Start the priority escalation cron job.
 *
 * Runs daily at midnight to auto-escalate tasks with progress >= 80%
 * to critical priority (if not already done/review/critical).
 *
 * Multi-replica safety:
 *  - `withCronLock` ensures one replica owns the tick.
 *  - Per-task race: a conditional UPDATE (`priority='critical' WHERE
 *    priority != 'critical'`) ensures the priority flip + notification
 *    fires at most once even under unlikely lock collisions.
 */
function startPriorityEscalationJob() {
  cron.schedule('0 0 * * *', async () => {
    try {
      await withCronLock('priorityEscalationJob', async () => {
        console.log('[PriorityEscalation] Running daily priority escalation check...');
        const tasks = await Task.findAll({
          where: {
            progress: { [Op.gte]: 80 },
            status: { [Op.notIn]: ['done', 'review'] },
            priority: { [Op.ne]: 'critical' },
            isArchived: false,
          },
        });

        let escalated = 0;
        for (const task of tasks) {
          try {
            const previousPriority = task.priority;
            // Conditional UPDATE: only the worker that flips the row from
            // non-critical → critical proceeds to notify. If two replicas
            // ever hit the same row before either commits, the second one's
            // affectedCount is 0 and we silently skip without sending.
            const [affected] = await Task.update(
              { priority: 'critical' },
              { where: { id: task.id, priority: { [Op.ne]: 'critical' } } }
            );
            if (!affected) continue;

            logActivity({
              action: 'priority_auto_escalated',
              description: `Task "${task.title}" auto-escalated to critical (progress: ${task.progress}%, was: ${previousPriority})`,
              entityType: 'task',
              entityId: task.id,
              taskId: task.id,
              boardId: task.boardId,
              userId: task.assignedTo || task.createdBy,
            });

            // Send notification to assignee
            if (task.assignedTo) {
              const notification = await Notification.create({
                type: 'priority_change',
                message: sanitizeNotificationMessage(
                  `Task "${sanitizeNotificationField(task.title)}" has been auto-escalated ` +
                  `to Critical priority (${task.progress}% complete)`
                ),
                entityType: 'task',
                entityId: task.id,
                userId: task.assignedTo,
              });
              emitToUser(task.assignedTo, 'notification:new', { notification });
            }
            escalated += 1;
          } catch (err) {
            // One bad row must not abort the whole batch.
            console.error(`[PriorityEscalation] row failed for task ${task?.id}:`, err?.message || err);
          }
        }

        if (escalated > 0) {
          console.log(`[PriorityEscalation] Auto-escalated ${escalated} tasks to critical priority`);
        }
      });
    } catch (err) {
      console.error('[PriorityEscalation] Job error:', err);
    }
  });

  console.log('[PriorityEscalation] Cron job started (daily at midnight)');
}

module.exports = { startPriorityEscalationJob };
