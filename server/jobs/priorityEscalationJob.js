const cron = require('node-cron');
const { Op } = require('sequelize');
const { Task, Notification } = require('../models');
const { emitToUser } = require('../services/socketService');
const { logActivity } = require('../services/activityService');

/**
 * Start the priority escalation cron job.
 * Runs daily at midnight to auto-escalate tasks with progress >= 80%
 * to critical priority (if not already done/review/critical).
 */
function startPriorityEscalationJob() {
  cron.schedule('0 0 * * *', async () => {
    console.log('[PriorityEscalation] Running daily priority escalation check...');
    try {
      const tasks = await Task.findAll({
        where: {
          progress: { [Op.gte]: 80 },
          status: { [Op.notIn]: ['done', 'review'] },
          priority: { [Op.ne]: 'critical' },
          isArchived: false,
        },
      });

      for (const task of tasks) {
        const previousPriority = task.priority;
        await task.update({ priority: 'critical' });

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
            message: `Task "${task.title}" has been auto-escalated to Critical priority (${task.progress}% complete)`,
            entityType: 'task',
            entityId: task.id,
            userId: task.assignedTo,
          });
          emitToUser(task.assignedTo, 'notification:new', { notification });
        }
      }

      if (tasks.length > 0) {
        console.log(`[PriorityEscalation] Auto-escalated ${tasks.length} tasks to critical priority`);
      }
    } catch (err) {
      console.error('[PriorityEscalation] Job error:', err);
    }
  });

  console.log('[PriorityEscalation] Cron job started (daily at midnight)');
}

module.exports = { startPriorityEscalationJob };
