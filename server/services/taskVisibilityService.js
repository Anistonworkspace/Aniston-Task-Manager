'use strict';

/**
 * Task Visibility Service — single source of truth for "who can see which task".
 *
 * RBAC rule (CP-3, locked-down):
 *   - super_admin / admin             → unrestricted (see every task)
 *   - manager / assistant_manager     → self + descendants only (org subtree)
 *   - member                          → self + descendants only (a member can
 *                                        still have direct reports via
 *                                        User.managerId; if they don't, the
 *                                        set degenerates to {self})
 *
 * A task is visible to a viewer if ANY of these task relations references a
 * user inside the viewer's allowed-id set:
 *   - tasks.assignedTo        (legacy single assignee)
 *   - tasks.createdBy
 *   - task_assignees.userId   (new multi-assignee + supervisor table)
 *   - task_owners.userId      (multi-owner table)
 *
 * Board membership grants BOARD ACCESS only — never task-row visibility.
 *
 * This service is the ONLY place visibility is decided. Every controller that
 * lists / fetches / broadcasts tasks must call into here. Inlining the rule
 * elsewhere is what caused the original leak (Shubhanshu, an assistant
 * manager, seeing Muskan's manager-only task).
 */

const { Op } = require('sequelize');
const { sequelize } = require('../config/db');
const { Task, TaskAssignee, TaskOwner, User } = require('../models');
const { safeUUID, safeUUIDList } = require('../utils/safeSql');
const hierarchyService = require('./hierarchyService');
const { hasTierAtLeast, TIER_2 } = require('../config/tiers');
const logger = require('../utils/logger');

// ── table existence cache (some deployments lag on migrations) ──────────────
const _tableCache = {};
async function _tblExists(name) {
  if (_tableCache[name] !== undefined) return _tableCache[name];
  try {
    await sequelize.query(`SELECT 1 FROM "${name}" LIMIT 0`);
    _tableCache[name] = true;
  } catch {
    _tableCache[name] = false;
  }
  return _tableCache[name];
}

const hasTaskAssignees = () => _tblExists('task_assignees');
const hasTaskOwners = () => _tblExists('task_owners');

// ── feature flag: Tier 2 unrestricted task visibility ───────────────────────
//
// When TASK_VISIBILITY_TIER2_UNRESTRICTED is "true" (default), Tier 1 AND
// Tier 2 viewers are treated as unrestricted for task-row visibility — they
// see every task in the system. When "false", the kernel falls back to the
// legacy strict check (only isSuperAdmin or role === 'admin' is unrestricted;
// role === 'manager' is subtree-scoped).
//
// Why this exists: the strict-subtree behaviour was deliberately tightened
// in May 2026 but turned out to over-hide tasks for managers in production
// installations whose org-chart (User.managerId / manager_relations) was not
// fully populated. This flag lets ops revert to the strict behaviour with a
// single env-var flip + container restart, without a code revert.
//
// Read once at module load — flipping the env var requires restarting the
// backend. The flag is consumed by isUnrestrictedTaskViewer(), which is the
// single decision point for every read path.
const TIER2_UNRESTRICTED =
  (process.env.TASK_VISIBILITY_TIER2_UNRESTRICTED ?? 'true').toLowerCase() !== 'false';

/**
 * Single decision point: "is this viewer permitted to see every task in the
 * system?" Used by getVisibleUserIdsForViewer (list queries) and canViewTask
 * (per-row checks) here, plus the canViewTask middleware short-circuit and
 * the boardController.getBoard filter trigger — so all four read paths agree.
 *
 * Pure function, no DB I/O.
 */
function isUnrestrictedTaskViewer(viewer) {
  if (!viewer) return false;
  if (TIER2_UNRESTRICTED) return hasTierAtLeast(viewer, TIER_2);
  // Legacy / rollback path — preserves pre-hotfix behaviour exactly.
  return !!viewer.isSuperAdmin || viewer.role === 'admin';
}

// ── viewer scope ────────────────────────────────────────────────────────────

/**
 * Returns the set of user ids whose tasks `viewer` is permitted to read.
 *
 * Shape:
 *   { unrestricted: true }                  // admin/super_admin — see all
 *   { unrestricted: false, userIds: [..] }  // explicit allow-list (always
 *                                              includes viewer.id)
 *
 * Pure read — never mutates anything. Used by both the SQL-WHERE builder
 * (list endpoints) and the per-row checker (detail endpoints, socket
 * recipient resolution).
 */
async function getVisibleUserIdsForViewer(viewer) {
  if (!viewer) return { unrestricted: false, userIds: [] };
  if (isUnrestrictedTaskViewer(viewer)) {
    return { unrestricted: true };
  }
  const descendants = await hierarchyService.getDescendantIds(viewer.id);
  const set = new Set([viewer.id, ...descendants]);
  return { unrestricted: false, userIds: Array.from(set) };
}

// ── WHERE clause builder ────────────────────────────────────────────────────

/**
 * Builds a Sequelize WHERE fragment that restricts a Task query to rows the
 * viewer is permitted to see. Returns an empty object when the viewer is
 * unrestricted (admin/super_admin) so callers can spread it unconditionally.
 *
 * Caller must merge the returned fragment using AND, e.g.:
 *
 *   const visibility = await buildTaskVisibilityWhere(req.user);
 *   const where = { boardId, isArchived: false };
 *   if (visibility[Op.and]) where[Op.and] = [...(where[Op.and]||[]), ...visibility[Op.and]];
 *
 * The fragment uses `sequelize.literal` for the junction-table subqueries
 * because Sequelize cannot express `Task.id IN (subquery)` cleanly without
 * pulling in a full include. UUIDs are validated via safeSql before
 * interpolation — defense in depth.
 *
 * Important: this filter is INTENTIONALLY independent of board membership.
 * A user can have a board open but still see zero rows if no task on it
 * touches their subtree.
 */
async function buildTaskVisibilityWhere(viewer, options = {}) {
  const scope = await getVisibleUserIdsForViewer(viewer);
  if (scope.unrestricted) return {};

  const ids = scope.userIds;
  if (!ids.length) {
    // Defensive — should never happen because viewer.id is always in the set.
    return { id: { [Op.in]: [] } };
  }

  // Use the table-qualified column name when callers run with includes that
  // could shadow `assignedTo` / `createdBy`. Sequelize prepends the model's
  // table alias (Task) automatically for top-level fields, but the literal
  // subqueries need explicit qualification.
  const literals = [
    { assignedTo: { [Op.in]: ids } },
    { createdBy: { [Op.in]: ids } },
  ];

  const idList = safeUUIDList(ids, 'visibleUserIds');

  if (await hasTaskAssignees()) {
    literals.push(
      sequelize.literal(
        `"${options.taskAlias || 'Task'}"."id" IN (SELECT "taskId" FROM task_assignees WHERE "userId" IN (${idList}))`
      )
    );
  }
  if (await hasTaskOwners()) {
    literals.push(
      sequelize.literal(
        `"${options.taskAlias || 'Task'}"."id" IN (SELECT "taskId" FROM task_owners WHERE "userId" IN (${idList}))`
      )
    );
  }

  // Wrap in [Op.and] so the caller can merge cleanly with other AND clauses.
  return { [Op.and]: [{ [Op.or]: literals }] };
}

// ── per-row check ───────────────────────────────────────────────────────────

/**
 * Returns true if `viewer` is permitted to see `task`. Accepts either a
 * hydrated Sequelize Task instance (with taskAssignees / owners associations
 * loaded) or a plain task-id string. When given just an id, the missing
 * associations are queried.
 *
 * Use this in middleware before returning a single task's full payload, in
 * realtime recipient resolution, and as a defensive double-check anywhere
 * that bypassed the SQL filter.
 */
async function canViewTask(viewer, taskOrId) {
  if (!viewer) return false;
  if (isUnrestrictedTaskViewer(viewer)) return true;

  let task = null;
  let taskId = null;
  if (typeof taskOrId === 'string') {
    taskId = taskOrId;
  } else if (taskOrId && typeof taskOrId === 'object') {
    task = taskOrId.toJSON ? taskOrId.toJSON() : taskOrId;
    taskId = task.id;
  }
  if (!taskId) return false;

  const scope = await getVisibleUserIdsForViewer(viewer);
  const allowed = new Set(scope.userIds || []);

  // Fast path — check whatever's already on the hydrated task.
  if (task) {
    if (task.assignedTo && allowed.has(task.assignedTo)) return true;
    if (task.createdBy && allowed.has(task.createdBy)) return true;
    for (const ta of task.taskAssignees || []) {
      if (ta?.userId && allowed.has(ta.userId)) return true;
    }
    for (const o of task.owners || []) {
      const id = o?.id || o?.userId;
      if (id && allowed.has(id)) return true;
    }
  } else {
    // Pull only the columns we need.
    const t = await Task.findByPk(taskId, { attributes: ['id', 'assignedTo', 'createdBy'] });
    if (!t) return false;
    if (t.assignedTo && allowed.has(t.assignedTo)) return true;
    if (t.createdBy && allowed.has(t.createdBy)) return true;
  }

  // Fall back to junction-table checks. These run only when the hydrated
  // path didn't hit (or we didn't have a hydrated task at all).
  if (await hasTaskAssignees()) {
    const taHit = await TaskAssignee.findOne({
      where: { taskId, userId: { [Op.in]: Array.from(allowed) } },
      attributes: ['id'],
    });
    if (taHit) return true;
  }
  if (await hasTaskOwners()) {
    const toHit = await TaskOwner.findOne({
      where: { taskId, userId: { [Op.in]: Array.from(allowed) } },
      attributes: ['id'],
    });
    if (toHit) return true;
  }

  return false;
}

// ── post-query in-memory filter (fallback) ──────────────────────────────────

/**
 * Filter an array of already-fetched tasks down to those the viewer can see.
 * Use ONLY when the upstream query couldn't apply the WHERE filter (e.g. the
 * tasks were eager-loaded as part of a board fetch). Prefer
 * buildTaskVisibilityWhere when you control the query.
 *
 * Accepts hydrated tasks; expects assignees / owners associations to be
 * loaded if you want sub-second behaviour. Falls back to a per-task DB check
 * for any task that doesn't carry the associations.
 */
async function filterVisibleTasks(viewer, tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return tasks || [];
  const scope = await getVisibleUserIdsForViewer(viewer);
  if (scope.unrestricted) return tasks;
  const allowed = new Set(scope.userIds || []);

  const result = [];
  const needsLookup = [];

  for (const t of tasks) {
    const plain = t.toJSON ? t.toJSON() : t;
    let visible = false;
    if (plain.assignedTo && allowed.has(plain.assignedTo)) visible = true;
    else if (plain.createdBy && allowed.has(plain.createdBy)) visible = true;
    else if ((plain.taskAssignees || []).some((ta) => ta?.userId && allowed.has(ta.userId))) visible = true;
    else if ((plain.owners || []).some((o) => allowed.has(o?.id || o?.userId))) visible = true;

    if (visible) {
      result.push(t);
    } else if (!plain.taskAssignees && !plain.owners) {
      // Associations weren't loaded — defer to a definitive DB check.
      needsLookup.push(t);
    }
  }

  for (const t of needsLookup) {
    const plain = t.toJSON ? t.toJSON() : t;
    if (await canViewTask(viewer, plain.id)) result.push(t);
  }

  return result;
}

// ── realtime recipient resolution ───────────────────────────────────────────

/**
 * Compute the user-ids that should receive a realtime task event.
 *
 * Recipient set = directly-affected users
 *                 ∪ ancestors of every affected user (so each ancestor's
 *                   subtree-scoped view stays in sync)
 *                 ∪ all admins / super admins (unrestricted readers).
 *
 * "Directly-affected users" come from the hydrated task: createdBy +
 * assignedTo + task_assignees.userId + task_owners.userId. Watchers /
 * supervisors inherit from task_assignees rows that carry role='supervisor'.
 *
 * Critical: this never returns the entire board membership. The previous
 * realtime layer broadcast to everyone in the board room, which is exactly
 * how Shubhanshu (an assistant manager who joined the board room) was
 * receiving Muskan's task events.
 */
async function getAuthorizedRealtimeRecipients(taskOrId, opts = {}) {
  const recipients = new Set();
  let task = null;
  let taskId = null;

  if (typeof taskOrId === 'string') {
    taskId = taskOrId;
  } else if (taskOrId && typeof taskOrId === 'object' && taskOrId.id) {
    taskId = taskOrId.id;
    task = taskOrId.toJSON ? taskOrId.toJSON() : taskOrId;
  }
  if (!taskId) return [];

  // Directly-affected users from the hydrated payload.
  const direct = new Set();
  if (task) {
    if (task.createdBy) direct.add(task.createdBy);
    if (task.assignedTo) direct.add(task.assignedTo);
    for (const ta of task.taskAssignees || []) {
      if (ta?.userId) direct.add(ta.userId);
    }
    for (const o of task.owners || []) {
      const id = o?.id || o?.userId;
      if (id) direct.add(id);
    }
  }
  if (!task || !direct.size) {
    // Either no hydrated task, or it was hydrated without associations —
    // fall back to DB.
    try {
      const t = await Task.findByPk(taskId, { attributes: ['createdBy', 'assignedTo'] });
      if (t?.createdBy) direct.add(t.createdBy);
      if (t?.assignedTo) direct.add(t.assignedTo);
    } catch { /* non-fatal */ }
    if (await hasTaskAssignees()) {
      try {
        const tas = await TaskAssignee.findAll({ where: { taskId }, attributes: ['userId'] });
        for (const r of tas) if (r.userId) direct.add(r.userId);
      } catch { /* non-fatal */ }
    }
    if (await hasTaskOwners()) {
      try {
        const tos = await TaskOwner.findAll({ where: { taskId }, attributes: ['userId'] });
        for (const r of tos) if (r.userId) direct.add(r.userId);
      } catch { /* non-fatal */ }
    }
  }

  // Optional explicit extras (e.g. previous assignee on a reassign — must
  // still be told to drop the row from their MyWork).
  if (Array.isArray(opts.extraUserIds)) {
    for (const id of opts.extraUserIds) if (id) direct.add(id);
  }

  for (const id of direct) recipients.add(id);

  // Ancestors of each affected user — every ancestor up to root has visibility
  // into this task (the subtree-scoped view rule). Walk the manager chain via
  // hierarchyService.getPrimaryManagerId to honour both User.managerId and
  // manager_relations.
  for (const uid of direct) {
    let cursor = uid;
    const visited = new Set();
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      let parent = null;
      try {
        parent = await hierarchyService.getPrimaryManagerId(cursor);
      } catch { /* non-fatal */ }
      if (!parent) break;
      recipients.add(parent);
      cursor = parent;
    }
  }

  // All admins / super admins — unrestricted readers always see live updates.
  try {
    const adminRows = await User.findAll({
      where: {
        isActive: true,
        [Op.or]: [{ role: 'admin' }, { isSuperAdmin: true }],
      },
      attributes: ['id'],
      raw: true,
    });
    for (const r of adminRows) recipients.add(r.id);
  } catch (e) {
    logger.warn('[TaskVisibility] admin recipient lookup failed:', e.message);
  }

  if (opts.excludeUserId) recipients.delete(opts.excludeUserId);

  return Array.from(recipients);
}

module.exports = {
  getVisibleUserIdsForViewer,
  buildTaskVisibilityWhere,
  canViewTask,
  filterVisibleTasks,
  getAuthorizedRealtimeRecipients,
  isUnrestrictedTaskViewer,
};
