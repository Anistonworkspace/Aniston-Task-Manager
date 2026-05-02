const { Task, TaskDependency, DependencyRequest, User, Notification, Board } = require('../models');
const { Op } = require('sequelize');
const { emitToUser, emitToBoard } = require('./socketService');
const { logActivity } = require('./activityService');

// Dependency-request statuses that keep the parent task blocked. Rejected
// counts as blocking on purpose: the parent owner needs to see the dependency
// is stuck so they can remove/cancel/reassign it (per Phase 5 spec).
const BLOCKING_DR_STATUSES = ['pending', 'accepted', 'working_on_it', 'rejected'];

/**
 * Check if a task is blocked. A task is blocked if either:
 *   - it has any active legacy TaskDependency link whose blocker is not done, or
 *   - it has any DependencyRequest row in pending/accepted/working_on_it/rejected.
 *
 * Rejected dependency requests intentionally count as "still blocking" — the
 * requester must explicitly remove/cancel/reassign them.
 */
async function isTaskBlocked(taskId) {
  const deps = await TaskDependency.findAll({
    where: {
      taskId,
      dependencyType: { [Op.in]: ['blocks', 'required_for'] },
      [Op.or]: [{ isArchived: false }, { isArchived: null }],
    },
    include: [{ model: Task, as: 'dependsOnTask', attributes: ['id', 'status'] }],
  });

  if (deps.some(d => d.dependsOnTask && d.dependsOnTask.status !== 'done')) {
    return true;
  }

  const drCount = await DependencyRequest.count({
    where: {
      parentTaskId: taskId,
      status: { [Op.in]: BLOCKING_DR_STATUSES },
      archivedAt: null,
    },
  });
  return drCount > 0;
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

      // Task is now unblocked. Use the shared unblock helper so the captured
      // statusBeforeDependencyBlock is restored consistently with the
      // DependencyRequest path. Layer auto-assignment on top of those updates.
      const updates = buildUnblockUpdates(depTask);

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
        meta: {
          autoAssigned: !!updates.assignedTo,
          completedTaskId,
          restoredStatus: updates.status || depTask.status,
        },
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
 * Force a task into 'stuck' status and flag it as blocked by dependency.
 * Called when a blocking dependency is created and the blocker is not yet done.
 *
 * Captures the task's pre-block status into customFields.statusBeforeDependencyBlock
 * the FIRST time we lock it. Never overwrites a captured value — back-to-back
 * lock cycles (e.g. add dep → cancel → add another) would otherwise lose the
 * original. The captured value is consumed and removed by the unblock helper.
 */
async function lockTaskAsDependencyBlocked(taskId) {
  const task = await Task.findByPk(taskId);
  if (!task || task.status === 'done') return;

  const cf = task.customFields || {};
  const customFields = { ...cf, blockedByDependency: true };

  // Only capture if (a) we haven't already, and (b) the current status is
  // something other than 'stuck' (otherwise we'd memorise our own lock state).
  if (cf.statusBeforeDependencyBlock === undefined && task.status !== 'stuck') {
    customFields.statusBeforeDependencyBlock = task.status;
  }

  await task.update({ status: 'stuck', customFields });

  // Emit real-time update so all connected clients see the status change.
  if (task.boardId) {
    emitToBoard(task.boardId, 'task:updated', { task: task.toJSON() });
  }
}

/**
 * Build the field updates for unblocking a task. Restores the captured
 * pre-block status (if any) and clears both flags. Shared between
 * recomputeParentBlockState (DependencyRequest path) and
 * processTaskCompletion (legacy TaskDependency auto-unblock) so the
 * "restore previous status" semantics are consistent across both flows.
 */
function buildUnblockUpdates(task) {
  const cf = task.customFields || {};
  const previousStatus = cf.statusBeforeDependencyBlock;

  const customFields = { ...cf, blockedByDependency: false };
  delete customFields.statusBeforeDependencyBlock;

  const updates = { customFields };
  // Only override status if it's currently 'stuck' (we set it that way on
  // lock). If the user manually moved off 'stuck' between lock and unlock,
  // respect their choice.
  if (task.status === 'stuck') {
    updates.status = previousStatus || 'not_started';
  }
  return updates;
}

/**
 * Check if a task is still blocked after a dependency is removed.
 * If no longer blocked, clear the blockedByDependency flag so the user can edit status again.
 */
async function unlockTaskIfUnblocked(taskId) {
  const stillBlocked = await isTaskBlocked(taskId);
  if (stillBlocked) return;

  const task = await Task.findByPk(taskId);
  if (!task) return;

  const currentCustomFields = task.customFields || {};
  if (!currentCustomFields.blockedByDependency) return; // Not flagged, nothing to do

  await task.update({
    customFields: { ...currentCustomFields, blockedByDependency: false },
  });

  // Emit update so frontend re-enables status editing
  if (task.boardId) {
    emitToBoard(task.boardId, 'task:updated', { task: task.toJSON() });
  }
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

  // If this is a blocking dependency and the blocker is not yet done,
  // force the blocked task into 'stuck' status immediately
  const effectiveType = dependencyType || 'blocks';
  if (['blocks', 'required_for'].includes(effectiveType)) {
    const blockerTask = await Task.findByPk(dependsOnTaskId, { attributes: ['id', 'status'] });
    if (blockerTask && blockerTask.status !== 'done') {
      await lockTaskAsDependencyBlocked(taskId);
    }
  }

  // Auto-set startDate on the blocked task when a dependency is created (set-if-empty).
  // A dependency means the task has entered its active lifecycle.
  if (['blocks', 'required_for'].includes(effectiveType)) {
    const blockedTask = await Task.findByPk(taskId, { attributes: ['id', 'startDate', 'boardId'] });
    if (blockedTask && !blockedTask.startDate) {
      const today = new Date().toISOString().slice(0, 10);
      await blockedTask.update({ startDate: today });
      if (blockedTask.boardId) {
        emitToBoard(blockedTask.boardId, 'task:updated', { task: blockedTask.toJSON() });
      }
    }
  }

  return dep;
}

/**
 * Lock or unlock a parent task based on its current set of blockers
 * (DependencyRequests + legacy TaskDependency links). Single entry point so
 * controllers don't have to remember the lock/unlock pair on every change.
 *
 * Phase 5: on unblock, restores the captured pre-block status via
 * buildUnblockUpdates and notifies the parent owner.
 */
async function recomputeParentBlockState(parentTaskId) {
  if (!parentTaskId) return;

  const blocked = await isTaskBlocked(parentTaskId);
  const task = await Task.findByPk(parentTaskId);
  if (!task) return;

  const cf = task.customFields || {};
  const wasFlagged = !!cf.blockedByDependency;

  if (blocked && !wasFlagged) {
    await lockTaskAsDependencyBlocked(parentTaskId);
    return;
  }

  if (!blocked && wasFlagged) {
    // Becoming unblocked. Don't touch a task that has been independently
    // marked done — clearing the flag is enough.
    if (task.status === 'done') {
      await task.update({ customFields: { ...cf, blockedByDependency: false } });
    } else {
      const updates = buildUnblockUpdates(task);
      await task.update(updates);

      // Notify the parent task owner so they know they can resume work. Use
      // 'task_updated' (already in the enum) instead of adding another enum
      // value. Don't notify if the actor is the owner themselves — they
      // already know.
      if (task.assignedTo) {
        try {
          const restoredStatus = updates.status || task.status;
          const restoredLabel = (restoredStatus || 'not_started').replace(/_/g, ' ');
          const notification = await Notification.create({
            type: 'task_updated',
            message: `Your task "${task.title}" is no longer blocked. Status restored to ${restoredLabel}.`,
            entityType: 'task',
            entityId: task.id,
            userId: task.assignedTo,
          });
          emitToUser(task.assignedTo, 'notification:new', { notification });
          emitToUser(task.assignedTo, 'task:unblocked', { taskId: task.id, title: task.title });
        } catch (err) {
          console.error('[DependencyService] task:unblocked notification failed:', err.message);
        }
      }
    }

    if (task.boardId) {
      emitToBoard(task.boardId, 'task:updated', { task: task.toJSON() });
    }
  }
}

/**
 * Centralised lifecycle notifier for DependencyRequest events. Keeps in-app
 * Notification rows + socket events in one place so the controller stays
 * focused on validation/state machine logic.
 *
 * Phase 9 refinements:
 *   - For terminal/transition events that affect the parent task, also
 *     notify the original assigner (the person who originally handed the
 *     parent task to the current owner) when distinct from the other
 *     recipients. Mirrors the spec rule about supervisor/original-assigner
 *     visibility into the chain.
 *   - "done" message now reflects the ACTUAL post-recompute parent state:
 *     "is now unblocked." vs "still has other dependencies." vs the dep
 *     belonged to a parent that no longer exists.
 */
async function dispatchDependencyEvent(event, dep, actor) {
  if (!dep) return;

  // Resolve recipients. parentOwner / originalAssigner may equal requester
  // or each other — final dedupe handles that below.
  const requesterId = dep.requestedByUserId;
  const assigneeId = dep.assignedToUserId;
  const originalAssignerId = dep.originalAssignerUserId || null;
  const parent = dep.parentTaskId
    ? await Task.findByPk(dep.parentTaskId, { attributes: ['id', 'title', 'assignedTo', 'boardId', 'customFields'] })
    : null;
  const parentOwnerId = parent?.assignedTo || null;
  const actorName = actor?.name || 'Someone';
  const title = dep.title || 'a dependency';

  // For "done", read the parent's CURRENT block flag — recomputeParentBlockState
  // has already been called by the controller before this dispatch, so the
  // value reflects whether THIS dep was the last blocker.
  const parentStillBlocked = !!parent?.customFields?.blockedByDependency;
  const doneSuffix = parent
    ? parentStillBlocked
      ? `. Parent task "${parent.title}" still has other dependencies.`
      : `. Parent task "${parent.title}" is now unblocked.`
    : '.';

  // (notificationType, message, recipientIds[]) per event.
  const plan = {
    requested: {
      type: 'dependency_requested',
      message: `${actorName} requested dependency work from you: "${title}".`,
      // Just the assignee — no supervisor cc on the initial ask, the
      // requester already knows since they made it.
      recipients: [assigneeId],
    },
    accepted: {
      type: 'dependency_accepted',
      message: `${actorName} accepted dependency: "${title}".`,
      recipients: [requesterId, parentOwnerId, originalAssignerId],
    },
    started: {
      type: 'dependency_started',
      message: `${actorName} started working on dependency: "${title}".`,
      recipients: [requesterId, parentOwnerId, originalAssignerId],
    },
    done: {
      type: 'dependency_done',
      message: `${actorName} completed dependency: "${title}"${doneSuffix}`,
      recipients: [requesterId, parentOwnerId, originalAssignerId],
    },
    rejected: {
      type: 'dependency_rejected',
      message: `${actorName} rejected dependency: "${title}"${dep.rejectionReason ? `. Reason: ${dep.rejectionReason}` : '.'}`,
      // Original assigner gets cc'd on rejection — they may need to step in
      // when the assignee can't / won't deliver and the parent owner needs
      // help finding another path.
      recipients: [requesterId, parentOwnerId, originalAssignerId],
    },
    cancelled: {
      type: 'dependency_cancelled',
      message: `${actorName} cancelled dependency: "${title}".`,
      // Cancellation is a requester-side action; loop in the assignee (so
      // they know the work is no longer needed) and the parent owner.
      // Original assigner not cc'd — internal lifecycle, not their concern.
      recipients: [assigneeId, parentOwnerId],
    },
    reassigned: {
      type: 'dependency_requested',
      message: `${actorName} reassigned dependency to you: "${title}".`,
      recipients: [assigneeId],
    },
  };

  const entry = plan[event];
  if (!entry) return;

  // Dedupe + drop self-notifications + drop nulls.
  const seen = new Set();
  const targets = (entry.recipients || []).filter(uid => {
    if (!uid) return false;
    if (uid === actor?.id) return false;
    if (seen.has(uid)) return false;
    seen.add(uid);
    return true;
  });

  for (const userId of targets) {
    try {
      const notification = await Notification.create({
        type: entry.type,
        message: entry.message,
        entityType: 'dependency_request',
        entityId: dep.id,
        userId,
      });
      emitToUser(userId, 'notification:new', { notification });
      emitToUser(userId, `dependency:${event}`, {
        dependencyId: dep.id,
        parentTaskId: dep.parentTaskId,
      });
    } catch (err) {
      // Swallow notification failures so they never break the parent
      // controller's response. Log and continue.
      console.error(`[DependencyService] dispatchDependencyEvent(${event}) failed for user ${userId}:`, err.message);
    }
  }

  // Board-level socket so anyone viewing the parent's board sees the change live.
  if (parent?.boardId) {
    emitToBoard(parent.boardId, `dependency:${event}`, {
      dependencyId: dep.id,
      parentTaskId: dep.parentTaskId,
      status: dep.status,
    });
  }
}

module.exports = {
  isTaskBlocked,
  getBlockingTasks,
  getBlockedTasks,
  processTaskCompletion,
  checkCircularDependency,
  createDependency,
  lockTaskAsDependencyBlocked,
  unlockTaskIfUnblocked,
  recomputeParentBlockState,
  dispatchDependencyEvent,
  BLOCKING_DR_STATUSES,
};
