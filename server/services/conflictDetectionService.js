/**
 * Conflict Detection & Auto-Rescheduling Service
 *
 * Detects scheduling conflicts between tasks assigned to the same user
 * and provides auto-rescheduling capabilities to resolve overlaps.
 */
const { Task, User } = require('../models');
const { Op } = require('sequelize');

/**
 * Check for scheduling conflicts for a given user within a time range.
 *
 * @param {string} userId - The user whose schedule to check
 * @param {Date|string} startTime - Start of the proposed time range
 * @param {Date|string} endTime - End of the proposed time range
 * @param {string|null} excludeTaskId - Task ID to exclude (e.g., the task being scheduled)
 * @returns {Array} Array of conflicting task objects
 */
async function checkConflicts(userId, startTime, endTime, excludeTaskId = null) {
  const where = {
    assignedTo: userId,
    dueDate: { [Op.not]: null },
    status: { [Op.notIn]: ['done', 'review'] },
    isArchived: false,
  };
  if (excludeTaskId) where.id = { [Op.ne]: excludeTaskId };

  const tasks = await Task.findAll({
    where,
    attributes: ['id', 'title', 'dueDate', 'startDate', 'estimatedHours', 'plannedStartTime', 'plannedEndTime', 'priority', 'status', 'boardId'],
  });

  const conflicts = [];
  const newStart = new Date(startTime).getTime();
  const newEnd = new Date(endTime).getTime();

  for (const task of tasks) {
    // Use planned times if available, otherwise fall back to dueDate
    let taskStart, taskEnd;

    if (task.plannedStartTime && task.plannedEndTime) {
      taskStart = new Date(task.plannedStartTime).getTime();
      taskEnd = new Date(task.plannedEndTime).getTime();
    } else {
      taskStart = new Date(task.dueDate).getTime();
      taskEnd = taskStart + (parseFloat(task.estimatedHours) || 1) * 60 * 60 * 1000;
    }

    // Check overlap: two ranges overlap if newStart < taskEnd AND newEnd > taskStart
    if (newStart < taskEnd && newEnd > taskStart) {
      conflicts.push({
        taskId: task.id,
        title: task.title,
        dueDate: task.dueDate,
        startDate: task.startDate,
        estimatedHours: parseFloat(task.estimatedHours) || 1,
        priority: task.priority,
        status: task.status,
        boardId: task.boardId,
        plannedStartTime: task.plannedStartTime,
        plannedEndTime: task.plannedEndTime,
      });
    }
  }

  return conflicts;
}

/**
 * Auto-reschedule a conflicting task to start after a given time.
 * Adds a 15-minute buffer between the end of the blocking task and the start of the rescheduled task.
 *
 * @param {string} conflictingTaskId - The task to reschedule
 * @param {Date|string} afterTime - The time after which to reschedule
 * @returns {object|null} The rescheduled task info, or null if task not found
 */
async function autoReschedule(conflictingTaskId, afterTime) {
  const task = await Task.findByPk(conflictingTaskId);
  if (!task) return null;

  // Add 15-minute buffer
  const newStart = new Date(new Date(afterTime).getTime() + 15 * 60 * 1000);

  // Update the due date (keep just the date portion for DATEONLY field)
  const newDueDate = newStart.toISOString().split('T')[0];

  const updateData = { dueDate: newDueDate };

  // If the task has planned times, update those too
  if (task.plannedStartTime || task.plannedEndTime) {
    const duration = (parseFloat(task.estimatedHours) || 1) * 60 * 60 * 1000;
    updateData.plannedStartTime = newStart;
    updateData.plannedEndTime = new Date(newStart.getTime() + duration);
  }

  await task.update(updateData);

  return {
    taskId: task.id,
    title: task.title,
    newDueDate: newDueDate,
    newPlannedStartTime: updateData.plannedStartTime || null,
    newPlannedEndTime: updateData.plannedEndTime || null,
  };
}

/**
 * Get a scheduling summary for a user on a given date.
 * Returns all tasks scheduled for that date with their time blocks.
 *
 * @param {string} userId - The user to check
 * @param {string} date - The date to check (YYYY-MM-DD)
 * @returns {object} Schedule summary with tasks and total hours
 */
async function getScheduleSummary(userId, date) {
  const tasks = await Task.findAll({
    where: {
      assignedTo: userId,
      dueDate: date,
      status: { [Op.notIn]: ['done', 'review'] },
      isArchived: false,
    },
    attributes: ['id', 'title', 'dueDate', 'estimatedHours', 'plannedStartTime', 'plannedEndTime', 'priority', 'status'],
    order: [['plannedStartTime', 'ASC'], ['dueDate', 'ASC']],
  });

  const totalHours = tasks.reduce((sum, t) => sum + (parseFloat(t.estimatedHours) || 1), 0);

  return {
    date,
    tasks: tasks.map(t => ({
      taskId: t.id,
      title: t.title,
      estimatedHours: parseFloat(t.estimatedHours) || 1,
      plannedStartTime: t.plannedStartTime,
      plannedEndTime: t.plannedEndTime,
      priority: t.priority,
      status: t.status,
    })),
    totalHours,
    isOverloaded: totalHours > 8,
  };
}

module.exports = { checkConflicts, autoReschedule, getScheduleSummary };
