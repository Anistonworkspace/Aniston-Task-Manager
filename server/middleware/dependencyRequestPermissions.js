/**
 * Permissions middleware for the Dependency Request system.
 *
 * Pulled out of dependencyRequestController.js so the routing layer enforces
 * access centrally and the controller stays focused on business logic.
 *
 * Reuses the canonical task-permission logic in `taskPermissions.js` for
 * "can this user see/edit the parent task?" rather than re-implementing it.
 */

const { Op } = require('sequelize');
const { sequelize } = require('../config/db');
const {
  Task, TaskAssignee, TaskOwner, DependencyRequest,
} = require('../models');

// ─── Cached existence probes ─────────────────────────────────
// Mirrors the pattern in taskPermissions.js — junction tables may or may not
// exist on a given DB depending on which migrations have been applied.
const _tableCache = {};
async function _tableExists(name) {
  if (_tableCache[name] !== undefined) return _tableCache[name];
  try {
    await sequelize.query(`SELECT 1 FROM "${name}" LIMIT 0`);
    _tableCache[name] = true;
  } catch (e) {
    _tableCache[name] = false;
  }
  return _tableCache[name];
}

// ─── Pure helpers (synchronous, no DB) ───────────────────────
function isElevated(user) {
  return !!user && (
    user.isSuperAdmin === true ||
    ['admin', 'manager'].includes(user.role)
  );
}

function isAssistantManager(user) {
  return !!user && user.role === 'assistant_manager';
}

function isPartyToRequest(user, dep) {
  if (!user || !dep) return false;
  if (dep.requestedByUserId === user.id) return true;
  if (dep.assignedToUserId === user.id) return true;
  if (dep.originalAssignerUserId === user.id) return true;
  if (dep.completedByUserId === user.id) return true;
  return false;
}

function isRequester(user, dep) {
  return !!user && !!dep && dep.requestedByUserId === user.id;
}

function isAssignee(user, dep) {
  return !!user && !!dep && dep.assignedToUserId === user.id;
}

/**
 * Manager rights on a dependency request — edit details, cancel, reassign,
 * archive, admin override of status. Requester is treated as manager of
 * their own request.
 */
function canManageRequest(user, dep) {
  if (isElevated(user)) return true;
  if (isAssistantManager(user)) return true;
  return isRequester(user, dep);
}

/**
 * "Did this elevated user just bypass a check a non-elevated user would have
 * failed?" — used to tag activity-log entries with adminOverride=true for
 * the audit trail.
 */
function isAdminOverride(user, dep) {
  if (!isElevated(user)) return false;
  if (!dep) return false;
  // If the user has a normal claim on the row (requester / assignee / parent
  // owner), it's not an override — they would have been allowed regardless.
  if (isPartyToRequest(user, dep)) return false;
  return true;
}

// ─── DB-backed helpers ───────────────────────────────────────
/**
 * Is this user linked to the parent task in any way that grants them
 * task-level access? Mirrors `canViewTask` in taskPermissions.js but works
 * on a Task object you already have so we don't double-fetch.
 */
async function userIsLinkedToTask(user, task) {
  if (!user || !task) return false;
  if (task.assignedTo === user.id) return true;
  if (task.createdBy === user.id) return true;

  if (await _tableExists('task_assignees')) {
    const a = await TaskAssignee.findOne({ where: { taskId: task.id, userId: user.id } });
    if (a) return true;
  }
  if (await _tableExists('task_owners')) {
    const o = await TaskOwner.findOne({ where: { taskId: task.id, userId: user.id } });
    if (o) return true;
  }
  return false;
}

async function canViewParentTask(user, task) {
  if (!user || !task) return false;
  if (isElevated(user)) return true;
  if (isAssistantManager(user)) return true;
  return userIsLinkedToTask(user, task);
}

/**
 * Authorisation for creating a dependency request on a parent task.
 *
 * Spec rules 1 & 2: parent task owner/assignee, or admin/manager/super
 * admin, or assistant_manager (mirrors task-edit gate).
 */
async function canCreateOnTask(user, task) {
  if (!user || !task) return false;
  if (task.isArchived) return false;
  if (task.status === 'done') return false;
  if (isElevated(user)) return true;
  if (isAssistantManager(user)) return true;
  return userIsLinkedToTask(user, task);
}

async function canViewRequest(user, dep) {
  if (!user || !dep) return false;
  if (isElevated(user)) return true;
  if (isAssistantManager(user)) return true;
  if (isPartyToRequest(user, dep)) return true;
  // Parent-task owner is also allowed — load the parent if not already loaded.
  const parent = dep.parentTask
    || (dep.parentTaskId ? await Task.findByPk(dep.parentTaskId, { attributes: ['id', 'assignedTo', 'createdBy'] }) : null);
  if (!parent) return false;
  return userIsLinkedToTask(user, parent);
}

// ─── Express middleware ──────────────────────────────────────
async function loadDependencyRequest(req, res, next) {
  try {
    const dep = await DependencyRequest.findByPk(req.params.dependencyId);
    if (!dep) {
      return res.status(404).json({ success: false, message: 'Dependency request not found.' });
    }
    req.dependencyRequest = dep;
    next();
  } catch (err) {
    console.error('[depReqPerm] loadDependencyRequest error:', err);
    res.status(500).json({ success: false, message: 'Server error loading dependency request.' });
  }
}

async function loadParentTask(req, res, next) {
  try {
    const task = await Task.findByPk(req.params.taskId);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Parent task not found.' });
    }
    req.parentTask = task;
    next();
  } catch (err) {
    console.error('[depReqPerm] loadParentTask error:', err);
    res.status(500).json({ success: false, message: 'Server error loading parent task.' });
  }
}

function requireParentTaskView(req, res, next) {
  Promise.resolve(canViewParentTask(req.user, req.parentTask))
    .then((ok) => {
      if (ok) return next();
      return res.status(403).json({ success: false, message: 'Not authorized to view this task\'s dependencies.' });
    })
    .catch((err) => {
      console.error('[depReqPerm] requireParentTaskView error:', err);
      res.status(500).json({ success: false, message: 'Server error.' });
    });
}

function requireParentTaskCreateAccess(req, res, next) {
  Promise.resolve(canCreateOnTask(req.user, req.parentTask))
    .then((ok) => {
      if (ok) return next();
      // 403 vs 400 — task-level state errors (archived/done) are 400, real
      // permission failures are 403. canCreateOnTask returns false for both;
      // we report the most actionable reason for the requester.
      if (req.parentTask?.isArchived) {
        return res.status(400).json({ success: false, message: 'Cannot add a dependency to an archived task.' });
      }
      if (req.parentTask?.status === 'done') {
        return res.status(400).json({ success: false, message: 'Cannot add a dependency to a completed task. Reopen it first.' });
      }
      return res.status(403).json({ success: false, message: 'Not authorized to add a dependency to this task.' });
    })
    .catch((err) => {
      console.error('[depReqPerm] requireParentTaskCreateAccess error:', err);
      res.status(500).json({ success: false, message: 'Server error.' });
    });
}

function requireRequestParty(req, res, next) {
  Promise.resolve(canViewRequest(req.user, req.dependencyRequest))
    .then((ok) => {
      if (ok) return next();
      return res.status(403).json({ success: false, message: 'Not authorized to view this dependency request.' });
    })
    .catch((err) => {
      console.error('[depReqPerm] requireRequestParty error:', err);
      res.status(500).json({ success: false, message: 'Server error.' });
    });
}

function requireRequestManager(req, res, next) {
  if (canManageRequest(req.user, req.dependencyRequest)) return next();
  return res.status(403).json({ success: false, message: 'You do not have permission to update this dependency.' });
}

/**
 * Archive is allowed for managers AND for the dependency owner — the
 * assignee may want to clear a closed item from their list.
 */
function requireRequestArchiver(req, res, next) {
  const dep = req.dependencyRequest;
  if (canManageRequest(req.user, dep)) return next();
  if (isAssignee(req.user, dep)) return next();
  return res.status(403).json({ success: false, message: 'Not authorized to archive this dependency request.' });
}

module.exports = {
  // pure helpers — exported for controller use too
  isElevated,
  isAssistantManager,
  isPartyToRequest,
  isRequester,
  isAssignee,
  canManageRequest,
  isAdminOverride,
  // db-backed helpers
  userIsLinkedToTask,
  canViewParentTask,
  canCreateOnTask,
  canViewRequest,
  // middleware
  loadDependencyRequest,
  loadParentTask,
  requireParentTaskView,
  requireParentTaskCreateAccess,
  requireRequestParty,
  requireRequestManager,
  requireRequestArchiver,
};
