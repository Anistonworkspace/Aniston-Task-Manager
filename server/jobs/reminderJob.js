const cron = require('node-cron');
const { Op } = require('sequelize');
const { Task, User, Board, Notification } = require('../models');
const { emitToUser } = require('../services/socketService');

/**
 * Start the reminder cron job.
 * Runs every hour to check for:
 * - Tasks due in the next 24 hours → notify assignee
 * - Overdue tasks → notify assignee + task creator/manager
 * - Tasks due in 3 days → soft reminder (once per day at 9 AM)
 */
function startReminderJob() {
  // Run every hour at minute 0
  cron.schedule('0 * * * *', async () => {
    console.log('[Reminder] Running reminder check...');
    try {
      await checkDueSoon();
      await checkOverdue();
    } catch (err) {
      console.error('[Reminder] Job error:', err);
    }
  });

  // Run daily at 9 AM for 3-day reminders
  cron.schedule('0 9 * * *', async () => {
    try {
      await checkDueIn3Days();
    } catch (err) {
      console.error('[Reminder] 3-day check error:', err);
    }
  });

  console.log('[Reminder] Cron jobs started (hourly due-soon + overdue, daily 3-day reminder)');
}

/**
 * Notify assignees of tasks due within the next 24 hours.
 */
async function checkDueSoon() {
  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const today = now.toISOString().slice(0, 10);
  const tomorrow = in24h.toISOString().slice(0, 10);

  const tasks = await Task.findAll({
    where: {
      status: { [Op.notIn]: ['done'] },
      isArchived: false,
      assignedTo: { [Op.ne]: null },
      dueDate: { [Op.in]: [today, tomorrow] },
    },
    include: [
      { model: User, as: 'assignee', attributes: ['id', 'name'] },
      { model: Board, as: 'board', attributes: ['id', 'name'] },
    ],
  });

  for (const task of tasks) {
    if (!task.assignee) continue;

    // Check if we already sent a due-soon notification today
    const existing = await Notification.findOne({
      where: {
        userId: task.assignee.id,
        entityType: 'task',
        entityId: task.id,
        type: 'due_date',
        createdAt: { [Op.gte]: new Date(today) },
      },
    });
    if (existing) continue;

    const isToday = task.dueDate === today;
    const notification = await Notification.create({
      type: 'due_date',
      message: `Task "${task.title}" is due ${isToday ? 'today' : 'tomorrow'}${task.board ? ` on board "${task.board.name}"` : ''}`,
      entityType: 'task',
      entityId: task.id,
      userId: task.assignee.id,
    });
    emitToUser(task.assignee.id, 'notification:new', { notification });
  }

  if (tasks.length > 0) {
    console.log(`[Reminder] Sent due-soon reminders for ${tasks.length} task(s)`);
  }
}

/**
 * Notify assignees and creators of overdue tasks.
 */
async function checkOverdue() {
  const today = new Date().toISOString().slice(0, 10);

  const tasks = await Task.findAll({
    where: {
      status: { [Op.notIn]: ['done'] },
      isArchived: false,
      assignedTo: { [Op.ne]: null },
      dueDate: { [Op.lt]: today },
    },
    include: [
      { model: User, as: 'assignee', attributes: ['id', 'name'] },
      { model: User, as: 'creator', attributes: ['id', 'name'] },
      { model: Board, as: 'board', attributes: ['id', 'name'] },
    ],
  });

  for (const task of tasks) {
    if (!task.assignee) continue;

    // Check if we already sent an overdue notification today
    const existing = await Notification.findOne({
      where: {
        userId: task.assignee.id,
        entityType: 'task',
        entityId: task.id,
        type: 'task_updated',
        message: { [Op.like]: '%overdue%' },
        createdAt: { [Op.gte]: new Date(today) },
      },
    });
    if (existing) continue;

    // Notify assignee
    const notification = await Notification.create({
      type: 'task_updated',
      message: `Task "${task.title}" is overdue (due ${task.dueDate})${task.board ? ` on board "${task.board.name}"` : ''}`,
      entityType: 'task',
      entityId: task.id,
      userId: task.assignee.id,
    });
    emitToUser(task.assignee.id, 'notification:new', { notification });

    // Also notify creator/manager if different
    if (task.creator && task.creator.id !== task.assignee.id) {
      const mgrNotif = await Notification.create({
        type: 'task_updated',
        message: `${task.assignee.name}'s task "${task.title}" is overdue (due ${task.dueDate})`,
        entityType: 'task',
        entityId: task.id,
        userId: task.creator.id,
      });
      emitToUser(task.creator.id, 'notification:new', { notification: mgrNotif });
    }
  }

  if (tasks.length > 0) {
    console.log(`[Reminder] Sent overdue reminders for ${tasks.length} task(s)`);
  }
}

/**
 * Soft reminder for tasks due in 3 days.
 */
async function checkDueIn3Days() {
  const now = new Date();
  const in3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);

  const tasks = await Task.findAll({
    where: {
      status: { [Op.notIn]: ['done'] },
      isArchived: false,
      assignedTo: { [Op.ne]: null },
      dueDate: in3Days,
    },
    include: [
      { model: User, as: 'assignee', attributes: ['id', 'name'] },
      { model: Board, as: 'board', attributes: ['id', 'name'] },
    ],
  });

  for (const task of tasks) {
    if (!task.assignee) continue;

    const existing = await Notification.findOne({
      where: {
        userId: task.assignee.id,
        entityType: 'task',
        entityId: task.id,
        type: 'due_date',
        createdAt: { [Op.gte]: new Date(today) },
      },
    });
    if (existing) continue;

    const notification = await Notification.create({
      type: 'due_date',
      message: `Heads up: "${task.title}" is due in 3 days (${task.dueDate})`,
      entityType: 'task',
      entityId: task.id,
      userId: task.assignee.id,
    });
    emitToUser(task.assignee.id, 'notification:new', { notification });
  }

  if (tasks.length > 0) {
    console.log(`[Reminder] Sent 3-day reminders for ${tasks.length} task(s)`);
  }
}

module.exports = { startReminderJob };
