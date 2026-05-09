const xss = require('xss');
const { Op } = require('sequelize');
const { Task, Board, User, DependencyRequest } = require('../models');
const depService = require('../services/dependencyService');
const { logActivity } = require('../services/activityService');
const perm = require('../middleware/dependencyRequestPermissions');

// State machine for assignee-driven transitions. Cancellation is not in this
// map because it is reached via DELETE /api/dependencies/:id and uses the
// requester-side permission check.
const STATUS_TRANSITIONS = {
  pending:        ['accepted', 'working_on_it', 'rejected'],
  accepted:       ['working_on_it', 'rejected'],
  working_on_it:  ['done', 'rejected'],
  done:           [],
  rejected:       [],
  cancelled:      [],
};

const ASSIGNEE_TRANSITIONS = new Set(['accepted', 'working_on_it', 'done', 'rejected']);

const DEFAULT_INCLUDE = [
  {
    model: Task, as: 'parentTask',
    attributes: ['id', 'title', 'status', 'priority', 'dueDate', 'boardId', 'assignedTo'],
    include: [
      { model: Board, as: 'board', attributes: ['id', 'name', 'color'] },
      { model: User,  as: 'assignee', attributes: ['id', 'name', 'avatar'] },
    ],
  },
  { model: User, as: 'requestedBy',      attributes: ['id', 'name', 'avatar', 'role'] },
  { model: User, as: 'assignedTo',       attributes: ['id', 'name', 'avatar', 'role'] },
  { model: User, as: 'originalAssigner', attributes: ['id', 'name', 'avatar', 'role'] },
  { model: User, as: 'completedBy',      attributes: ['id', 'name', 'avatar'] },
];

/**
 * State-machine + actor check. Lives here (not in middleware) because it
 * needs to read req.body.status — middleware runs before that's parsed in
 * a useful way. `perm.isElevated` / `perm.isAssignee` cover the actor side.
 */
function canTransitionRequest(user, dep, newStatus) {
  if (!user || !dep) return false;
  if (!STATUS_TRANSITIONS[dep.status]?.includes(newStatus)) return false;
  if (perm.isElevated(user)) return true;
  if (ASSIGNEE_TRANSITIONS.has(newStatus) && perm.isAssignee(user, dep)) return true;
  return false;
}

function shape(dep) {
  if (!dep) return null;
  return typeof dep.toJSON === 'function' ? dep.toJSON() : dep;
}

/**
 * POST /api/tasks/:taskId/dependencies
 * POST /api/tasks/:taskId/dependencies/assign  (legacy URL — same handler)
 *
 * Creates a DependencyRequest. Does NOT create a Task — that was the bug
 * this whole refactor exists to fix.
 *
 * Accepted body shapes:
 *   - new:    { title, blockingReason?, assignedToUserId, dueDate?, priority? }
 *   - legacy: { title, description?, assignToUserId, dependencyType? }  (from
 *             the existing DependencySelector dialog — `assignToUserId` and
 *             `description` are accepted as aliases for backwards compat).
 */
const createDependencyRequest = async (req, res) => {
  try {
    const { taskId } = req.params;
    const body = req.body || {};

    // Backwards-compat aliasing for the existing frontend dialog.
    const assignedToUserId = body.assignedToUserId || body.assignToUserId;
    const blockingReason = body.blockingReason || body.description || null;
    const title = (body.title || '').trim();
    const dueDate = body.dueDate || null;
    const priority = body.priority || 'medium';

    if (!title)             return res.status(400).json({ success: false, message: 'Title is required.' });
    if (!assignedToUserId)  return res.status(400).json({ success: false, message: 'assignedToUserId is required.' });
    if (assignedToUserId === req.user.id) {
      return res.status(400).json({ success: false, message: 'You cannot assign a dependency to yourself.' });
    }
    if (!DependencyRequest.PRIORITIES.includes(priority)) {
      return res.status(400).json({ success: false, message: `priority must be one of: ${DependencyRequest.PRIORITIES.join(', ')}` });
    }

    // Parent-task existence + access already verified by loadParentTask +
    // requireParentTaskCreateAccess middleware. Re-fetch with the workspace
    // relation we need at create time. Keeps the middleware load lean and
    // avoids include-in-middleware coupling.
    const parent = await Task.findByPk(taskId, {
      attributes: ['id', 'title', 'boardId', 'status', 'isArchived', 'createdBy', 'assignedTo'],
      include: [{ model: Board, as: 'board', attributes: ['id', 'workspaceId'] }],
    });
    if (!parent) return res.status(404).json({ success: false, message: 'Parent task not found.' });

    // Assignee must exist and be active.
    const assignee = await User.findByPk(assignedToUserId, { attributes: ['id', 'name', 'isActive'] });
    if (!assignee) return res.status(404).json({ success: false, message: 'Assignee not found.' });
    if (assignee.isActive === false) {
      return res.status(400).json({ success: false, message: 'Dependency assignee is inactive. Please choose another user.' });
    }

    // Active duplicate guard. The DB has a partial unique index that backstops
    // this, but checking here gives the user a clean 400 instead of a 500.
    const dup = await DependencyRequest.findOne({
      where: {
        parentTaskId: taskId,
        assignedToUserId,
        status: { [Op.in]: DependencyRequest.ACTIVE_STATUSES },
        archivedAt: null,
        title: { [Op.iLike]: title },
      },
    });
    if (dup) {
      return res.status(409).json({ success: false, message: 'An active dependency request with this title already exists for that assignee.' });
    }

    const dep = await DependencyRequest.create({
      parentTaskId: taskId,
      title: xss(title),
      blockingReason: blockingReason ? xss(blockingReason) : null,
      requestedByUserId: req.user.id,
      assignedToUserId,
      // Snapshot the parent's current owner-of-record so the chain survives
      // parent reassignment. Falls back to the parent's creator if no current
      // assignee is set.
      originalAssignerUserId: parent.assignedTo || parent.createdBy || null,
      boardId: parent.boardId || null,
      workspaceId: parent.board?.workspaceId || null,
      status: 'pending',
      priority,
      dueDate,
    });

    // Recompute block state — this is a new active blocker, parent flips to stuck.
    await depService.recomputeParentBlockState(taskId);

    // Notify the assignee.
    await depService.dispatchDependencyEvent('requested', dep, req.user);

    logActivity({
      action: 'dependency_request_created',
      description: `${req.user.name} requested dependency "${title}" from ${assignee.name} on "${parent.title}"`,
      entityType: 'task',
      entityId: taskId,
      taskId,
      boardId: parent.boardId,
      userId: req.user.id,
      meta: { dependencyRequestId: dep.id, assignedToUserId },
    });

    const full = await DependencyRequest.findByPk(dep.id, { include: DEFAULT_INCLUDE });
    res.status(201).json({
      success: true,
      message: `Dependency request sent to ${assignee.name}.`,
      data: { dependencyRequest: shape(full) },
    });
  } catch (err) {
    if (err?.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, message: 'An active dependency request with this title already exists for that assignee.' });
    }
    console.error('[DependencyRequest] create error:', err);
    res.status(500).json({ success: false, message: 'Server error creating dependency request.' });
  }
};

/**
 * GET /api/tasks/:taskId/dependency-requests
 * Returns the dependency requests rooted at this parent task.
 */
const listForTask = async (req, res) => {
  try {
    const { taskId } = req.params;
    const includeArchived = req.query.includeArchived === 'true';
    const where = { parentTaskId: taskId };
    if (!includeArchived) where.archivedAt = null;

    const rows = await DependencyRequest.findAll({
      where,
      include: DEFAULT_INCLUDE,
      order: [['createdAt', 'DESC']],
    });

    res.json({ success: true, data: { dependencyRequests: rows.map(shape) } });
  } catch (err) {
    console.error('[DependencyRequest] listForTask error:', err);
    res.status(500).json({ success: false, message: 'Server error fetching dependency requests.' });
  }
};

/**
 * GET /api/dependencies/assigned-to-me
 */
const listAssignedToMe = async (req, res) => {
  try {
    const { status, includeArchived } = req.query;
    const where = { assignedToUserId: req.user.id };
    if (!includeArchived || includeArchived !== 'true') where.archivedAt = null;
    if (status) where.status = status;

    const rows = await DependencyRequest.findAll({
      where, include: DEFAULT_INCLUDE, order: [['createdAt', 'DESC']],
    });
    res.json({ success: true, data: { dependencyRequests: rows.map(shape) } });
  } catch (err) {
    console.error('[DependencyRequest] listAssignedToMe error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * GET /api/dependencies/created-by-me
 */
const listCreatedByMe = async (req, res) => {
  try {
    const { status, includeArchived } = req.query;
    const where = { requestedByUserId: req.user.id };
    if (!includeArchived || includeArchived !== 'true') where.archivedAt = null;
    if (status) where.status = status;

    const rows = await DependencyRequest.findAll({
      where, include: DEFAULT_INCLUDE, order: [['createdAt', 'DESC']],
    });
    res.json({ success: true, data: { dependencyRequests: rows.map(shape) } });
  } catch (err) {
    console.error('[DependencyRequest] listCreatedByMe error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * GET /api/dependencies/:dependencyId
 * Visibility (canViewRequest) is enforced by requireRequestParty middleware.
 * Re-fetch with the full include set the response shape expects.
 */
const getOne = async (req, res) => {
  try {
    const dep = await DependencyRequest.findByPk(req.params.dependencyId, { include: DEFAULT_INCLUDE });
    if (!dep) return res.status(404).json({ success: false, message: 'Dependency request not found.' });
    res.json({ success: true, data: { dependencyRequest: shape(dep) } });
  } catch (err) {
    console.error('[DependencyRequest] getOne error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * PATCH /api/dependencies/:dependencyId/status
 * Row pre-loaded by loadDependencyRequest middleware → req.dependencyRequest.
 */
const updateStatus = async (req, res) => {
  try {
    const dep = req.dependencyRequest;

    const newStatus = req.body?.status;
    if (!newStatus) return res.status(400).json({ success: false, message: 'status is required.' });
    if (!DependencyRequest.STATUSES.includes(newStatus)) {
      return res.status(400).json({ success: false, message: `status must be one of: ${DependencyRequest.STATUSES.join(', ')}` });
    }

    if (!canTransitionRequest(req.user, dep, newStatus)) {
      // Disambiguate "not allowed at all" vs "valid sender, invalid transition".
      if (!STATUS_TRANSITIONS[dep.status]?.includes(newStatus)) {
        return res.status(400).json({ success: false, message: `Cannot transition from ${dep.status} to ${newStatus}.` });
      }
      return res.status(403).json({ success: false, message: 'You do not have permission to update this dependency.' });
    }

    const fromStatus = dep.status;
    // Capture override flag BEFORE mutating — the 'done' transition sets
    // completedByUserId = req.user.id, which would retroactively make an
    // admin a "party" to the dep and mask the override in the audit log.
    const wasOverride = perm.isAdminOverride(req.user, dep);

    if (newStatus === 'rejected') {
      const reason = (req.body.reason || req.body.rejectionReason || '').trim();
      if (!reason) return res.status(400).json({ success: false, message: 'rejectionReason is required when rejecting.' });
      dep.rejectionReason = xss(reason);
      dep.rejectedAt = new Date();
    }
    if (newStatus === 'accepted')      dep.acceptedAt = dep.acceptedAt || new Date();
    if (newStatus === 'working_on_it') {
      dep.acceptedAt = dep.acceptedAt || new Date();
      dep.startedAt  = dep.startedAt  || new Date();
    }
    if (newStatus === 'done') {
      dep.completedAt = new Date();
      dep.completedByUserId = req.user.id;
    }

    dep.status = newStatus;
    await dep.save();

    // Block-state side effects.
    await depService.recomputeParentBlockState(dep.parentTaskId);

    // Phase 13 — make the assignee's board reflect the dep work. On the
    // first transition out of pending we materialize a shadow Task on
    // the parent's board owned by the assignee; subsequent transitions
    // sync that task; reject/cancel archives it. The helper is idempotent
    // (uses dep.linkedTaskId as the key) and never throws — wrap in
    // try/catch so a materialization failure can't 500 the status update.
    try {
      await depService.syncLinkedTaskFromDependency(dep, req.user);
    } catch (err) {
      console.error('[DependencyRequest] syncLinkedTaskFromDependency failed:', err.message);
    }

    // Lifecycle notification.
    const eventName =
      newStatus === 'accepted'      ? 'accepted'  :
      newStatus === 'working_on_it' ? 'started'   :
      newStatus === 'done'          ? 'done'      :
      newStatus === 'rejected'      ? 'rejected'  :
      null;
    if (eventName) await depService.dispatchDependencyEvent(eventName, dep, req.user);

    logActivity({
      action: `dependency_request_${newStatus}`,
      description: `${req.user.name} marked dependency "${dep.title}" as ${newStatus}`,
      entityType: 'dependency_request',
      entityId: dep.id,
      taskId: dep.parentTaskId,
      boardId: dep.boardId,
      userId: req.user.id,
      meta: {
        from: fromStatus,
        to: newStatus,
        adminOverride: wasOverride,
      },
    });

    const full = await DependencyRequest.findByPk(dep.id, { include: DEFAULT_INCLUDE });
    res.json({ success: true, message: 'Dependency request updated.', data: { dependencyRequest: shape(full) } });
  } catch (err) {
    console.error('[DependencyRequest] updateStatus error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * PATCH /api/dependencies/:dependencyId
 * Edit details: title, blockingReason, dueDate, priority, assignedToUserId.
 * Status changes go through the status endpoint. Auth via requireRequestManager
 * middleware; row pre-loaded by loadDependencyRequest.
 */
const updateDetails = async (req, res) => {
  try {
    const dep = req.dependencyRequest;
    if (dep.status === 'done') {
      return res.status(400).json({ success: false, message: 'This dependency is already completed.' });
    }
    if (dep.status === 'cancelled') {
      return res.status(400).json({ success: false, message: 'This dependency is already cancelled.' });
    }
    // Capture pre-mutation — reassign-to-self by an admin would make them
    // a party after the update and mask the override flag in the audit log.
    const wasOverride = perm.isAdminOverride(req.user, dep);

    const updates = {};
    if (req.body.title !== undefined) {
      const t = String(req.body.title || '').trim();
      if (!t) return res.status(400).json({ success: false, message: 'title cannot be empty.' });
      updates.title = xss(t);
    }
    if (req.body.blockingReason !== undefined) {
      updates.blockingReason = req.body.blockingReason ? xss(String(req.body.blockingReason)) : null;
    }
    if (req.body.dueDate !== undefined) {
      updates.dueDate = req.body.dueDate || null;
    }
    if (req.body.priority !== undefined) {
      if (!DependencyRequest.PRIORITIES.includes(req.body.priority)) {
        return res.status(400).json({ success: false, message: `priority must be one of: ${DependencyRequest.PRIORITIES.join(', ')}` });
      }
      updates.priority = req.body.priority;
    }

    let reassigned = false;
    if (req.body.assignedToUserId && req.body.assignedToUserId !== dep.assignedToUserId) {
      const newAssignee = await User.findByPk(req.body.assignedToUserId, { attributes: ['id', 'name', 'isActive'] });
      if (!newAssignee) return res.status(404).json({ success: false, message: 'New assignee not found.' });
      if (newAssignee.isActive === false) {
        return res.status(400).json({ success: false, message: 'Dependency assignee is inactive. Please choose another user.' });
      }
      if (newAssignee.id === req.user.id && !perm.isElevated(req.user)) {
        return res.status(400).json({ success: false, message: 'You cannot reassign a dependency to yourself.' });
      }
      updates.assignedToUserId = newAssignee.id;
      reassigned = true;
    }

    await dep.update(updates);

    if (reassigned) {
      await depService.dispatchDependencyEvent('reassigned', dep, req.user);
    }

    logActivity({
      action: 'dependency_request_updated',
      description: `${req.user.name} edited dependency "${dep.title}"`,
      entityType: 'dependency_request',
      entityId: dep.id,
      taskId: dep.parentTaskId,
      boardId: dep.boardId,
      userId: req.user.id,
      meta: {
        fields: Object.keys(updates),
        reassigned,
        adminOverride: wasOverride,
      },
    });

    const full = await DependencyRequest.findByPk(dep.id, { include: DEFAULT_INCLUDE });
    res.json({ success: true, data: { dependencyRequest: shape(full) } });
  } catch (err) {
    if (err?.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, message: 'An active dependency with this title already exists for that assignee.' });
    }
    console.error('[DependencyRequest] updateDetails error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * DELETE /api/dependencies/:dependencyId
 * Soft-cancel — moves the row to status='cancelled' and recomputes parent
 * block state. Auth via requireRequestManager middleware.
 */
const cancelDependency = async (req, res) => {
  try {
    const dep = req.dependencyRequest;
    if (dep.status === 'done') {
      return res.status(400).json({ success: false, message: 'This dependency is already completed.' });
    }
    if (dep.status === 'cancelled') {
      return res.status(400).json({ success: false, message: 'This dependency is already cancelled.' });
    }

    // Capture pre-mutation for audit consistency (cancel doesn't currently
    // mutate party-relevant fields, but keep the pattern uniform).
    const wasOverride = perm.isAdminOverride(req.user, dep);

    dep.status = 'cancelled';
    dep.cancelledAt = new Date();
    if (req.body?.reason) dep.cancellationReason = xss(String(req.body.reason));
    await dep.save();

    await depService.recomputeParentBlockState(dep.parentTaskId);
    // Phase 13 — if a shadow task was materialized on accept/start/done,
    // archive it now so the assignee's board removes the row. No-op if
    // the dep was cancelled straight from pending (no shadow ever made).
    try {
      await depService.syncLinkedTaskFromDependency(dep, req.user);
    } catch (err) {
      console.error('[DependencyRequest] syncLinkedTaskFromDependency (cancel) failed:', err.message);
    }
    await depService.dispatchDependencyEvent('cancelled', dep, req.user);

    logActivity({
      action: 'dependency_request_cancelled',
      description: `${req.user.name} cancelled dependency "${dep.title}"`,
      entityType: 'dependency_request',
      entityId: dep.id,
      taskId: dep.parentTaskId,
      boardId: dep.boardId,
      userId: req.user.id,
      meta: { adminOverride: wasOverride },
    });

    res.json({ success: true, message: 'Dependency request cancelled.' });
  } catch (err) {
    console.error('[DependencyRequest] cancelDependency error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * PUT /api/dependencies/:dependencyId/archive
 * Soft-hide a closed (done/cancelled/rejected) request from active views.
 * Auth via requireRequestArchiver middleware (allows assignee in addition
 * to manager).
 */
const archiveDependency = async (req, res) => {
  try {
    const dep = req.dependencyRequest;
    const wasOverride = perm.isAdminOverride(req.user, dep);
    await dep.update({ archivedAt: new Date(), archivedBy: req.user.id });
    await depService.recomputeParentBlockState(dep.parentTaskId);

    logActivity({
      action: 'dependency_request_archived',
      description: `${req.user.name} archived dependency "${dep.title}"`,
      entityType: 'dependency_request',
      entityId: dep.id,
      taskId: dep.parentTaskId,
      boardId: dep.boardId,
      userId: req.user.id,
      meta: { adminOverride: wasOverride },
    });

    res.json({ success: true, message: 'Dependency request archived.' });
  } catch (err) {
    console.error('[DependencyRequest] archive error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

module.exports = {
  createDependencyRequest,
  listForTask,
  listAssignedToMe,
  listCreatedByMe,
  getOne,
  updateStatus,
  updateDetails,
  cancelDependency,
  archiveDependency,
};
