const { Task, User } = require('../models');
const { logActivity } = require('../services/activityService');

// PUT /api/tasks/:id/recurrence — set/update recurrence
exports.setRecurrence = async (req, res) => {
  try {
    const task = await Task.findByPk(req.params.id);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });

    const { type, interval, endDate } = req.body;
    // type: daily | weekly | monthly
    // interval: number (every N days/weeks/months)

    if (!type) {
      // Remove recurrence
      await task.update({ recurrence: null, lastRecurrenceAt: null });
      return res.json({ success: true, data: { task }, message: 'Recurrence removed.' });
    }

    const now = new Date();
    let nextRun;
    const int = interval || 1;

    if (type === 'daily') {
      nextRun = new Date(now.getTime() + int * 24 * 60 * 60 * 1000);
    } else if (type === 'weekly') {
      nextRun = new Date(now.getTime() + int * 7 * 24 * 60 * 60 * 1000);
    } else if (type === 'monthly') {
      nextRun = new Date(now);
      nextRun.setMonth(nextRun.getMonth() + int);
    }

    const recurrence = {
      type,
      interval: int,
      nextRun: nextRun.toISOString(),
      endDate: endDate || null,
    };

    await task.update({ recurrence });

    logActivity({
      action: 'task_recurrence_set',
      description: `${req.user.name} set ${type} recurrence on "${task.title}"`,
      entityType: 'task',
      entityId: task.id,
      taskId: task.id,
      boardId: task.boardId,
      userId: req.user.id,
      meta: { recurrence },
    });

    res.json({ success: true, data: { task } });
  } catch (err) {
    console.error('[Recurring] setRecurrence error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to set recurrence.' });
  }
};

// GET /api/tasks/:id/recurrence
exports.getRecurrence = async (req, res) => {
  try {
    const task = await Task.findByPk(req.params.id, { attributes: ['id', 'title', 'recurrence', 'lastRecurrenceAt'] });
    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
    res.json({ success: true, data: { recurrence: task.recurrence, lastRecurrenceAt: task.lastRecurrenceAt } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to get recurrence.' });
  }
};
