const cron = require('node-cron');
const { Op } = require('sequelize');
const { Task, Notification } = require('../models');
const { emitToUser } = require('../services/socketService');

/**
 * Recurring Task Cron Job
 * Runs every hour — checks for tasks with recurrence.nextRun <= now,
 * creates a duplicate task, and schedules the next run.
 */
function startRecurringTaskJob() {
  // Run every hour at minute 15
  cron.schedule('15 * * * *', async () => {
    try {
      const now = new Date();

      // Find tasks with recurrence set and nextRun <= now
      const tasks = await Task.findAll({
        where: {
          recurrence: { [Op.ne]: null },
          isArchived: false,
        },
      });

      for (const task of tasks) {
        const rec = task.recurrence;
        if (!rec || !rec.nextRun) continue;

        const nextRun = new Date(rec.nextRun);
        if (nextRun > now) continue;

        // Check end date
        if (rec.endDate && new Date(rec.endDate) < now) {
          await task.update({ recurrence: null });
          continue;
        }

        // Create new task instance
        const newTask = await Task.create({
          title: task.title,
          description: task.description,
          status: 'not_started',
          priority: task.priority,
          groupId: task.groupId,
          boardId: task.boardId,
          assignedTo: task.assignedTo,
          createdBy: task.createdBy,
          tags: task.tags,
          estimatedHours: task.estimatedHours,
          dueDate: calculateNextDueDate(task.dueDate, rec),
          startDate: calculateNextDueDate(task.startDate, rec),
        });

        // Calculate next recurrence
        let newNextRun;
        const int = rec.interval || 1;
        if (rec.type === 'daily') {
          newNextRun = new Date(nextRun.getTime() + int * 24 * 60 * 60 * 1000);
        } else if (rec.type === 'weekly') {
          newNextRun = new Date(nextRun.getTime() + int * 7 * 24 * 60 * 60 * 1000);
        } else if (rec.type === 'monthly') {
          newNextRun = new Date(nextRun);
          newNextRun.setMonth(newNextRun.getMonth() + int);
        }

        await task.update({
          recurrence: { ...rec, nextRun: newNextRun.toISOString() },
          lastRecurrenceAt: now,
        });

        // Notify assignee
        if (task.assignedTo) {
          await Notification.create({
            type: 'task_assigned',
            message: `Recurring task "${task.title}" has been created`,
            entityType: 'task',
            entityId: newTask.id,
            userId: task.assignedTo,
          });
          emitToUser(task.assignedTo, 'notification:new', {
            message: `Recurring task "${task.title}" created`,
          });
        }

        console.log(`[RecurringJob] Created recurring instance of "${task.title}" (${newTask.id})`);
      }
    } catch (err) {
      console.error('[RecurringJob] Error:', err.message);
    }
  });

  console.log('[RecurringJob] Recurring task job scheduled (every hour at :15)');
}

function calculateNextDueDate(originalDate, recurrence) {
  if (!originalDate) return null;
  const d = new Date(originalDate);
  const int = recurrence.interval || 1;
  if (recurrence.type === 'daily') d.setDate(d.getDate() + int);
  else if (recurrence.type === 'weekly') d.setDate(d.getDate() + int * 7);
  else if (recurrence.type === 'monthly') d.setMonth(d.getMonth() + int);
  return d.toISOString().split('T')[0];
}

module.exports = { startRecurringTaskJob };
