const { Task, TaskDependency, DependencyRequest, User, Notification, Board, TaskAssignee } = require('../models');
const { sequelize } = require('../config/db');
const { Op } = require('sequelize');
const { emitToUser, emitToBoard } = require('./socketService');
const { logActivity } = require('./activityService');
const { createNotification, buildIdempotencyKey } = require('./notificationService');
// Realtime + board-membership are loaded lazily from inside the materializer
// to avoid the circular import (boardMembershipService → socketService →
// dependencyService) that boots when this module is required.
let _realtime;
let _boardMembership;
function realtime() {
  if (!_realtime) _realtime = require('./realtimeService');
  return _realtime;
}
function boardMembership() {
  if (!_boardMembership) _boardMembership = require('./boardMembershipService');
  return _boardMembership;
}

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

      // Notify the assignee. Idempotent on the dep id + assignee so a
      // re-completion of the same blocker doesn't double-notify if the
      // dependency processor is invoked twice (which can happen if
      // processTaskCompletion is called from both controller and service).
      const assigneeId = updates.assignedTo || depTask.assignedTo;
      if (assigneeId) {
        await createNotification({
          userId: assigneeId,
          type: 'task_assigned',
          message: `Task "${depTask.title}" is now unblocked and ready to work on${updates.assignedTo ? ' (auto-assigned to you)' : ''}`,
          entityType: 'task',
          entityId: depTask.id,
          boardId: depTask.boardId,
          idempotencyKey: buildIdempotencyKey('dep-unblock', dep.id, assigneeId),
        });
        // createNotification already fired the 'notification:new' socket
        // event; we only need the targeted "task:unblocked" event here so
        // TaskModal/MyWork can show a banner.
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
          await createNotification({
            userId: task.assignedTo,
            type: 'task_updated',
            message: `Your task "${task.title}" is no longer blocked. Status restored to ${restoredLabel}.`,
            entityType: 'task',
            entityId: task.id,
            boardId: task.boardId,
            idempotencyKey: buildIdempotencyKey('dep-restored', task.id, task.assignedTo, Math.floor(Date.now() / 60000)),
          });
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

// ─── Phase 13: shadow-task materialization ───────────────────────────────
//
// A DependencyRequest is the system of record for "blocker work I'm asking
// you to do for me". The lifecycle (pending → accepted → working_on_it →
// done | rejected | cancelled) lives on the dep row and never created a
// Task — that was the original bug this whole subsystem was built to fix.
//
// What it didn't solve: the assignee had no way to see the dep work in the
// Main Table view of their board. Their dependencies page showed it, but
// the work itself was invisible alongside their regular tasks.
//
// Fix: when the assignee transitions OUT of pending (accept / start / done),
// materialize ONE Task on the parent's board owned by the assignee — a
// "shadow" of the dep work. The dep row stays the source of truth for
// status; the shadow Task is just the assignee's board surface.
//
// Idempotency: dep.linkedTaskId is the key. Set on first transition, never
// cleared. Subsequent dep status changes UPDATE the existing task — they
// never create a second one. A pending → rejected dep never gets a task
// (nothing was ever shown, nothing to clean up).

// dep.status → linked-task status. Returning null means "leave the task
// status alone" (e.g. on accepted, the assignee may have already moved
// the task forward independently).
function _depStatusToTaskStatus(depStatus) {
  if (depStatus === 'done')          return 'done';
  if (depStatus === 'working_on_it') return 'working_on_it';
  if (depStatus === 'accepted')      return 'not_started';
  return null;
}

/**
 * Create the shadow Task for a dep that has no linked task yet. Called only
 * by `syncLinkedTaskFromDependency`; never call directly — that's where the
 * "should we even materialize?" decision lives.
 *
 * Side effects:
 *   - INSERT tasks + INSERT task_assignees (atomic in one transaction)
 *   - UPDATE dependency_requests.linkedTaskId = new task id
 *   - autoAddMember(boardId, assignee) so the board appears in the
 *     assignee's sidebar if they weren't already a member
 *   - realtime emitTaskCreated → drives the assignee's Board page +
 *     MyWork list to refresh without a manual reload
 */
async function _materializeDependencyTask(dep, actor) {
  if (!dep || dep.linkedTaskId) return null;

  const parent = await Task.findByPk(dep.parentTaskId, {
    attributes: ['id', 'groupId', 'boardId', 'isArchived'],
  });
  // No parent (deleted) or no boardId — we have nothing to attach to. Bail
  // silently; the dep lifecycle still works without a shadow surface.
  const boardId = dep.boardId || parent?.boardId;
  if (!boardId) {
    console.warn(`[DependencyService] materialize: dep ${dep.id} has no boardId, skipping`);
    return null;
  }

  const groupId = parent?.groupId || 'new';
  const taskStatus = _depStatusToTaskStatus(dep.status) || 'not_started';
  const isDone = dep.status === 'done';

  // Append to the end of the parent's group so the shadow row sits visually
  // near its parent on the Main Table.
  const maxPosition = await Task.max('position', { where: { boardId, groupId } });

  let created;
  try {
    created = await sequelize.transaction(async (t) => {
      const task = await Task.create({
        title: dep.title,
        description: dep.blockingReason || '',
        status: taskStatus,
        priority: dep.priority || 'medium',
        groupId,
        dueDate: dep.dueDate || null,
        progress: isDone ? 100 : 0,
        completedAt: isDone ? new Date() : null,
        position: (Number.isFinite(maxPosition) ? maxPosition : 0) + 1,
        tags: ['dependency'],
        // Back-pointer in customFields too — gives the frontend (and any
        // future export) a way to recognise a shadow task without joining
        // the dep table. The board UI doesn't render this any differently
        // today; it's there for future affordances (e.g. "open parent dep").
        customFields: {
          sourceDependencyRequestId: dep.id,
          sourceParentTaskId: dep.parentTaskId,
        },
        boardId,
        assignedTo: dep.assignedToUserId,
        createdBy: dep.requestedByUserId,
        // Skip approval gate: the dep itself is the system of record for
        // completion. A dep marked 'done' must be reflected on the board
        // immediately, not held behind another approval round.
        approvalStatus: isDone ? 'approved' : null,
      }, { transaction: t });

      // Mirror the controller's TaskAssignee insert so visibility filters
      // and downstream "is this user an assignee?" checks find the row.
      await TaskAssignee.bulkCreate([{
        taskId: task.id,
        userId: dep.assignedToUserId,
        role: 'assignee',
        assignedAt: new Date(),
        assignerId: dep.requestedByUserId,
      }], { ignoreDuplicates: true, transaction: t });

      // Persist the back-pointer atomically with the task creation so a
      // crash between the two cannot leave an orphan task that a retry
      // would duplicate.
      dep.linkedTaskId = task.id;
      await dep.save({ transaction: t });

      return task;
    });
  } catch (err) {
    console.error('[DependencyService] _materializeDependencyTask transaction failed:', err.message);
    return null;
  }

  // Auto-add the assignee as a board member so the board shows up in their
  // sidebar. Idempotent (ON CONFLICT DO NOTHING). Outside the transaction
  // because boardMembershipService runs its own SQL and can't share a tx.
  try {
    await boardMembership().autoAddMember(boardId, dep.assignedToUserId);
  } catch (err) {
    // Non-fatal — board visibility may already be granted via hierarchy.
    console.warn('[DependencyService] autoAddMember failed (non-fatal):', err.message);
  }

  // Fan out the create. realtimeService figures out which authorized users
  // (assignee, creator, watchers, ancestors, admins) to deliver to and
  // emits 'task:created' which the eventRouter routes to
  // tasks.board.<boardId> + tasks.assignedTo.me — so the assignee's
  // BoardPage + MyWork refresh without a reload.
  try {
    realtime().emitTaskCreated(created, { actorId: actor?.id });
  } catch (err) {
    console.warn('[DependencyService] emitTaskCreated failed (non-fatal):', err.message);
  }

  return created;
}

/**
 * Update the existing shadow task to mirror the dep's current state.
 * Called only by `syncLinkedTaskFromDependency` when dep.linkedTaskId is
 * already set. If the user manually deleted the shadow task between
 * transitions, we no-op (don't resurrect — they explicitly removed it).
 */
async function _syncExistingLinkedTask(dep, actor) {
  if (!dep?.linkedTaskId) return null;

  const task = await Task.findByPk(dep.linkedTaskId);
  if (!task) return null;

  // Cancel/reject — soft-archive so the row disappears from the board but
  // the audit trail (parent, assignee, history) is preserved. Use the
  // standard isArchived flag so the existing board query (which excludes
  // archived rows by default) handles visibility automatically.
  if (dep.status === 'rejected' || dep.status === 'cancelled') {
    if (task.isArchived) return task;
    await task.update({
      isArchived: true,
      archivedAt: new Date(),
      archivedBy: actor?.id || null,
    });
    try {
      // Treat archive as an update so the board page can drop the row via
      // its existing 'task:updated' handler (it refetches the list, which
      // now excludes archived). Avoids a separate task:deleted code path.
      realtime().emitTaskUpdated(task, {
        actorId: actor?.id,
        changedFields: ['isArchived'],
      });
    } catch (err) {
      console.warn('[DependencyService] emitTaskUpdated (archive) failed:', err.message);
    }
    return task;
  }

  // Active states — sync status/progress from dep. We deliberately DON'T
  // touch the task back to 'not_started' on accepted (the assignee may
  // have moved it forward independently); only 'working_on_it' and 'done'
  // force a forward transition.
  const targetStatus = _depStatusToTaskStatus(dep.status);
  const updates = {};
  if (targetStatus && targetStatus !== task.status) {
    if (dep.status === 'working_on_it' && task.status === 'done') {
      // Edge case: dep was done, then re-opened (cancel-and-recreate path).
      // Don't downgrade a 'done' task to working_on_it automatically — the
      // user may have a separate "completed" view of it. Leave it alone.
    } else if (dep.status === 'accepted') {
      // Accept-after-already-materialized: leave whatever status the
      // assignee is on. They may have already started it.
    } else {
      updates.status = targetStatus;
    }
  }
  if (dep.status === 'done') {
    if (task.progress !== 100) updates.progress = 100;
    if (!task.completedAt) updates.completedAt = new Date();
    // If a non-super-admin previously set approvalStatus, accept the
    // approval implicitly — the dep is the source of truth for completion.
    if (task.approvalStatus !== 'approved') updates.approvalStatus = 'approved';
  }

  if (Object.keys(updates).length === 0) return task;

  await task.update(updates);
  try {
    realtime().emitTaskUpdated(task, {
      actorId: actor?.id,
      changedFields: Object.keys(updates),
    });
  } catch (err) {
    console.warn('[DependencyService] emitTaskUpdated (sync) failed:', err.message);
  }
  return task;
}

/**
 * Single entry point for "after a dep status changed, make the shadow task
 * reflect that". Called by the controller from updateStatus + cancel paths.
 * Safe to call on any status transition; it figures out whether to create,
 * update, archive, or no-op.
 *
 * @param {DependencyRequest} dep   The dep instance AFTER the status change
 *                                  has been persisted.
 * @param {object}            actor The user driving the transition.
 * @returns {Promise<Task|null>}    The shadow task (created or updated), or
 *                                  null if no shadow exists / was needed.
 */
async function syncLinkedTaskFromDependency(dep, actor) {
  if (!dep) return null;

  // Pending — nothing to surface yet. The work is queued; the dep card on
  // the dependencies page is enough.
  if (dep.status === 'pending') return null;

  // Already-materialized path: just sync.
  if (dep.linkedTaskId) {
    return _syncExistingLinkedTask(dep, actor);
  }

  // No shadow yet, dep was rejected/cancelled straight from pending — nothing
  // to materialize, nothing to clean up.
  if (dep.status === 'rejected' || dep.status === 'cancelled') return null;

  // Active state, no shadow yet → materialize.
  return _materializeDependencyTask(dep, actor);
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
      // Idempotent on (event, dependency, recipient) so a dependency
      // lifecycle event re-dispatched (e.g. from a retry) doesn't double-
      // notify each recipient.
      await createNotification({
        userId,
        type: entry.type,
        message: entry.message,
        entityType: 'dependency_request',
        entityId: dep.id,
        idempotencyKey: buildIdempotencyKey('dep-event', event, dep.id, userId),
      });
      // Targeted dep event so the recipient's TaskModal / cross-team page
      // can update without a full refetch. createNotification already fired
      // 'notification:new' for the bell.
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
  syncLinkedTaskFromDependency,
  BLOCKING_DR_STATUSES,
};
