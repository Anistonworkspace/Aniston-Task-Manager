const { Task, TaskDependency, User, Notification } = require('../models');
const { Op } = require('sequelize');
const { emitToUser, emitToBoard } = require('./socketService');
const { logActivity } = require('./activityService');

/**
 * Check if a task is blocked (has incomplete blocking dependencies).
 */
async function isTaskBlocked(taskId) {
  const deps = await TaskDependency.findAll({
    where: { taskId, dependencyType: { [Op.in]: ['blocks', 'required_for'] } },
    include: [{ model: Task, as: 'dependsOnTask', attributes: ['id', 'status'] }],
  });

  return deps.some(d => d.dependsOnTask && d.dependsOnTask.status !== 'done');
}

/**
 * Get all tasks blocking this task (incomplete blockers).
 */
async function getBlockingTasks(taskId) {
  const deps = await TaskDependency.findAll({
    where: { taskId, dependencyType: { [Op.in]: ['blocks', 'required_for'] } },
    include: [{
      model: Task, as: 'dependsOnTask',
      attributes: ['id', 'title', 'status', 'priority', 'assignedTo'],
      include: [{ model: User, as: 'assignee', attributes: ['id', 'name', 'avatar'] }],
    }],
  });

  return deps.filter(d => d.dependsOnTask && d.dependsOnTask.status !== 'done')
    .map(d => d.dependsOnTask);
}

/**
 * Get all tasks that this task is blocking.
 */
async function getBlockedTasks(taskId) {
  const deps = await TaskDependency.findAll({
    where: { dependsOnTaskId: taskId, dependencyType: { [Op.in]: ['blocks', 'required_for'] } },
    include: [{
      model: Task, as: 'task',
      attributes: ['id', 'title', 'status', 'assignedTo', 'boardId'],
      include: [{ model: User, as: 'assignee', attributes: ['id', 'name', 'avatar'] }],
    }],
  });

  return deps;
}

/**
 * When a task is completed, process auto-assignment of dependent tasks.
 */
async function processTaskCompletion(completedTaskId, completedByUserId) {
  try {
    const completedTask = await Task.findByPk(completedTaskId, {
      include: [{ model: User, as: 'assignee', attributes: ['id', 'name'] }],
    });
    if (!completedTask) return;

    // Find all dependencies where this task is the blocker
    const dependents = await TaskDependency.findAll({
      where: { dependsOnTaskId: completedTaskId },
      include: [
        {
          model: Task, as: 'task',
          attributes: ['id', 'title', 'status', 'assignedTo', 'boardId', 'autoAssigned'],
        },
        { model: User, as: 'autoAssignTo', attributes: ['id', 'name'] },
      ],
    });

    for (const dep of dependents) {
      const depTask = dep.task;
      if (!depTask || depTask.status === 'done') continue;

      // Check if ALL blockers for this task are now done
      const stillBlocked = await isTaskBlocked(depTask.id);
      if (stillBlocked) continue;

      // Task is now unblocked!
      const updates = { status: 'not_started' };

      // Auto-assign if configured
      if (dep.autoAssignOnComplete && dep.autoAssignToUserId) {
        updates.assignedTo = dep.autoAssignToUserId;
        updates.autoAssigned = true;
      }

      await depTask.update(updates);

      // Notify the assignee
      const assigneeId = updates.assignedTo || depTask.assignedTo;
      if (assigneeId) {
        const notification = await Notification.create({
          type: 'task_assigned',
          message: `Task "${depTask.title}" is now unblocked and ready to work on${updates.assignedTo ? ' (auto-assigned to you)' : ''}`,
          entityType: 'task',
          entityId: depTask.id,
          userId: assigneeId,
        });
        emitToUser(assigneeId, 'notification:new', { notification });
        emitToUser(assigneeId, 'task:unblocked', { taskId: depTask.id, title: depTask.title });
      }

      // Emit board update
      if (depTask.boardId) {
        emitToBoard(depTask.boardId, 'task:updated', { task: { ...depTask.toJSON(), ...updates } });
      }

      logActivity({
        action: 'task_unblocked',
        description: `Task "${depTask.title}" auto-unblocked after "${completedTask.title}" was completed`,
        entityType: 'task',
        entityId: depTask.id,
        taskId: depTask.id,
        boardId: depTask.boardId,
        userId: completedByUserId,
        meta: { autoAssigned: !!updates.assignedTo, completedTaskId },
      });
    }
  } catch (err) {
    console.error('[DependencyService] processTaskCompletion error:', err);
  }
}

/**
 * Check for circular dependency before creating one.
 * Returns true if adding taskId -> dependsOnTaskId would create a cycle.
 */
async function checkCircularDependency(taskId, dependsOnTaskId, visited = new Set()) {
  if (taskId === dependsOnTaskId) return true;
  if (visited.has(dependsOnTaskId)) return false;

  visited.add(dependsOnTaskId);

  // Get all tasks that dependsOnTaskId depends on
  const deps = await TaskDependency.findAll({
    where: { taskId: dependsOnTaskId },
    attributes: ['dependsOnTaskId'],
  });

  for (const dep of deps) {
    if (dep.dependsOnTaskId === taskId) return true;
    const hasCycle = await checkCircularDependency(taskId, dep.dependsOnTaskId, visited);
    if (hasCycle) return true;
  }

  return false;
}

/**
 * Create a dependency link between tasks.
 */
async function createDependency({ taskId, dependsOnTaskId, dependencyType, autoAssignOnComplete, autoAssignToUserId, createdById }) {
  // Check circular
  const circular = await checkCircularDependency(taskId, dependsOnTaskId);
  if (circular) {
    throw new Error('Cannot create dependency: would create a circular reference.');
  }

  // Check duplicate
  const existing = await TaskDependency.findOne({
    where: { taskId, dependsOnTaskId },
  });
  if (existing) {
    throw new Error('This dependency already exists.');
  }

  const dep = await TaskDependency.create({
    taskId,
    dependsOnTaskId,
    dependencyType: dependencyType || 'blocks',
    autoAssignOnComplete: autoAssignOnComplete !== false,
    autoAssignToUserId: autoAssignToUserId || null,
    createdById,
  });

  return dep;
}

module.exports = {
  isTaskBlocked,
  getBlockingTasks,
  getBlockedTasks,
  processTaskCompletion,
  checkCircularDependency,
  createDependency,
};
