'use strict';

/**
 * Board Visibility Service — single source of truth for "which boards can a
 * user see in their sidebar / board library / search / exports".
 *
 * Why this exists: previously every controller (boardController, searchController,
 * boardOrderController, workspaceController) implemented its own slightly-
 * different filter, and `assistant_manager` was incorrectly grouped with
 * admin/manager so they bypassed scoping entirely. That leaked every board
 * name in the org to assistant managers regardless of whether they had any
 * relationship to the board. Bringing the rule into one place — and using
 * `hierarchyService.getDescendantIds` for the subtree — guarantees the
 * sidebar, REST list, search, and direct-URL access agree.
 *
 * Visibility rule:
 *   - super_admin / admin / manager → unrestricted (sees every active board).
 *   - assistant_manager / member    → only boards where ANY of these holds:
 *       1. board.createdBy ∈ {self ∪ descendants}                (creator)
 *       2. BoardMembers row with autoAdded=false for ∈ {self}    (explicit
 *                                                                 member)
 *       3. tasks.assignedTo or tasks.createdBy ∈ {self ∪ desc.}  (visible task)
 *       4. task_assignees.userId ∈ {self ∪ desc.}                (multi-assign)
 *       5. task_owners.userId    ∈ {self ∪ desc.}                (multi-owner)
 *
 *   Note: `manager` is intentionally kept unrestricted to preserve existing
 *   behavior — only assistant_manager and member are scoped to subtree. If
 *   the product later wants managers scoped, change `getVisibleUserIdsForBoardScope`.
 *
 *   Note: stale BoardMembers rows where autoAdded=true are NEVER used for
 *   visibility — they are an internal cache that lags behind task
 *   reassignment. Only autoAdded=false (explicit add via Board Settings)
 *   counts. If the column is missing on a very old DB, we fall back to
 *   "any BoardMembers row" — but that should not happen in this codebase
 *   where BoardMember.autoAdded is part of the model definition.
 */

const { Op } = require('sequelize');
const { sequelize } = require('../config/db');
const hierarchyService = require('./hierarchyService');
const { safeUUIDList } = require('../utils/safeSql');
const logger = require('../utils/logger');

// ── existence caches ────────────────────────────────────────────────────────
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

const _columnCache = {};
async function _colExists(table, column) {
  const key = `${table}.${column}`;
  if (_columnCache[key] !== undefined) return _columnCache[key];
  try {
    await sequelize.query(`SELECT "${column}" FROM "${table}" LIMIT 0`);
    _columnCache[key] = true;
  } catch {
    _columnCache[key] = false;
  }
  return _columnCache[key];
}

// ── scope ───────────────────────────────────────────────────────────────────

/**
 * Returns the set of user ids whose work grants the viewer board access.
 *
 * Shape:
 *   { unrestricted: true }                 // admin / manager / super_admin
 *   { unrestricted: false, userIds: [..] } // self + descendants
 */
async function getVisibleUserIdsForBoardScope(viewer) {
  if (!viewer) return { unrestricted: false, userIds: [] };
  if (viewer.isSuperAdmin || viewer.role === 'admin' || viewer.role === 'manager') {
    return { unrestricted: true };
  }
  const ids = new Set([viewer.id]);
  try {
    const descendants = await hierarchyService.getDescendantIds(viewer.id);
    for (const id of descendants) ids.add(id);
  } catch (err) {
    logger.warn('[BoardVisibility] descendant resolution failed:', err.message);
  }
  return { unrestricted: false, userIds: Array.from(ids) };
}

// ── WHERE-fragment builder ──────────────────────────────────────────────────

/**
 * Build a Sequelize WHERE fragment that restricts a Board query to boards the
 * viewer is allowed to see. Returns `{}` when unrestricted so callers can
 * spread it unconditionally.
 *
 *   const visWhere = await buildBoardVisibilityWhere(req.user);
 *   const where = { isArchived: false, ...visWhere };
 *   const boards = await Board.findAndCountAll({ where, ... });
 *
 * The fragment uses a single [Op.or] block to union the five visibility
 * sources. Junction-table sources are included only if the underlying table
 * exists.
 */
async function buildBoardVisibilityWhere(viewer, options = {}) {
  const scope = await getVisibleUserIdsForBoardScope(viewer);
  if (scope.unrestricted) return {};

  const ids = scope.userIds;
  if (!ids.length) {
    // Defensive — viewer.id is always in the set, but if something blew up
    // upstream, deny access rather than leak everything.
    return { id: { [Op.in]: [] } };
  }

  const idList = safeUUIDList(ids, 'boardScopeUserIds');
  const boardAlias = options.boardAlias || 'Board';
  const boardId = `"${boardAlias}"."id"`;

  const orFilters = [
    // 1. Creator in subtree.
    { createdBy: { [Op.in]: ids } },
  ];

  // 2. Explicit (non-auto-added) board member.
  const hasAutoAddedCol = await _colExists('BoardMembers', 'autoAdded');
  if (hasAutoAddedCol) {
    // Only the viewer themselves counts as an explicit member — descendants'
    // explicit memberships are NOT inherited (a manager doesn't get to see a
    // board just because their report was explicitly added to it; they need
    // their own explicit add or a task-based reason).
    const selfList = safeUUIDList([viewer.id], 'boardScopeSelf');
    orFilters.push(
      sequelize.literal(
        `${boardId} IN (SELECT "boardId" FROM "BoardMembers" WHERE "userId" IN (${selfList}) AND "autoAdded" = false)`
      )
    );
  } else {
    // Pre-migration fallback — any BoardMembers row counts. (Shouldn't happen
    // on this codebase; BoardMember.autoAdded is in the model definition.)
    const selfList = safeUUIDList([viewer.id], 'boardScopeSelf');
    orFilters.push(
      sequelize.literal(
        `${boardId} IN (SELECT "boardId" FROM "BoardMembers" WHERE "userId" IN (${selfList}))`
      )
    );
  }

  // 3. Tasks assigned to / created by anyone in subtree.
  orFilters.push(
    sequelize.literal(
      `${boardId} IN (SELECT DISTINCT "boardId" FROM tasks WHERE "assignedTo" IN (${idList}) AND ("isArchived" = false OR "isArchived" IS NULL))`
    )
  );
  orFilters.push(
    sequelize.literal(
      `${boardId} IN (SELECT DISTINCT "boardId" FROM tasks WHERE "createdBy" IN (${idList}) AND ("isArchived" = false OR "isArchived" IS NULL))`
    )
  );

  // 4. task_assignees junction (multi-assignee + supervisor).
  if (await _tblExists('task_assignees')) {
    orFilters.push(
      sequelize.literal(
        `${boardId} IN (SELECT DISTINCT t."boardId" FROM tasks t INNER JOIN task_assignees ta ON ta."taskId" = t.id WHERE ta."userId" IN (${idList}) AND (t."isArchived" = false OR t."isArchived" IS NULL))`
      )
    );
  }
  // 5. task_owners junction.
  if (await _tblExists('task_owners')) {
    orFilters.push(
      sequelize.literal(
        `${boardId} IN (SELECT DISTINCT t."boardId" FROM tasks t INNER JOIN task_owners towners ON towners."taskId" = t.id WHERE towners."userId" IN (${idList}) AND (t."isArchived" = false OR t."isArchived" IS NULL))`
      )
    );
  }

  return { [Op.or]: orFilters };
}

// ── per-board check ─────────────────────────────────────────────────────────

/**
 * Returns true iff `viewer` is allowed to reach this board (sidebar visibility
 * + direct URL access). Use before serving GET /api/boards/:id to enforce the
 * SAME rule as the list filter.
 *
 * @param {object} viewer  - req.user
 * @param {string} boardId - UUID of the board
 * @returns {Promise<boolean>}
 */
async function canUserSeeBoard(viewer, boardId) {
  if (!viewer || !boardId) return false;
  const scope = await getVisibleUserIdsForBoardScope(viewer);
  if (scope.unrestricted) return true;
  if (!scope.userIds.length) return false;

  const ids = scope.userIds;
  const idList = safeUUIDList(ids, 'boardScopeUserIds');
  const selfList = safeUUIDList([viewer.id], 'boardScopeSelf');

  // 1. Creator in subtree.
  const [creatorRows] = await sequelize.query(
    `SELECT 1 FROM boards WHERE id = :boardId AND "createdBy" IN (${idList}) AND ("isArchived" = false OR "isArchived" IS NULL) LIMIT 1`,
    { replacements: { boardId } }
  );
  if (creatorRows.length > 0) return true;

  // 2. Explicit board member (autoAdded=false), self only.
  const hasAutoAddedCol = await _colExists('BoardMembers', 'autoAdded');
  const memberQuery = hasAutoAddedCol
    ? `SELECT 1 FROM "BoardMembers" WHERE "boardId" = :boardId AND "userId" IN (${selfList}) AND "autoAdded" = false LIMIT 1`
    : `SELECT 1 FROM "BoardMembers" WHERE "boardId" = :boardId AND "userId" IN (${selfList}) LIMIT 1`;
  const [memberRows] = await sequelize.query(memberQuery, { replacements: { boardId } });
  if (memberRows.length > 0) return true;

  // 3. Visible tasks (assignedTo or createdBy in subtree).
  const [taskRows] = await sequelize.query(
    `SELECT 1 FROM tasks
       WHERE "boardId" = :boardId
         AND ("assignedTo" IN (${idList}) OR "createdBy" IN (${idList}))
         AND ("isArchived" = false OR "isArchived" IS NULL)
       LIMIT 1`,
    { replacements: { boardId } }
  );
  if (taskRows.length > 0) return true;

  // 4. task_assignees junction.
  if (await _tblExists('task_assignees')) {
    const [taRows] = await sequelize.query(
      `SELECT 1 FROM task_assignees ta
         INNER JOIN tasks t ON t.id = ta."taskId"
         WHERE t."boardId" = :boardId
           AND ta."userId" IN (${idList})
           AND (t."isArchived" = false OR t."isArchived" IS NULL)
         LIMIT 1`,
      { replacements: { boardId } }
    );
    if (taRows.length > 0) return true;
  }

  // 5. task_owners junction.
  if (await _tblExists('task_owners')) {
    const [toRows] = await sequelize.query(
      `SELECT 1 FROM task_owners towners
         INNER JOIN tasks t ON t.id = towners."taskId"
         WHERE t."boardId" = :boardId
           AND towners."userId" IN (${idList})
           AND (t."isArchived" = false OR t."isArchived" IS NULL)
         LIMIT 1`,
      { replacements: { boardId } }
    );
    if (toRows.length > 0) return true;
  }

  return false;
}

/**
 * Convenience: returns the full set of board IDs visible to a viewer. Used
 * when a controller needs to filter an in-memory collection rather than at
 * query time. For large data sets prefer buildBoardVisibilityWhere; this
 * runs a single distinct query that scales with org size.
 *
 * @returns {Promise<Set<string>>}
 */
async function getVisibleBoardIdsForUser(viewer, options = {}) {
  const scope = await getVisibleUserIdsForBoardScope(viewer);
  if (scope.unrestricted) {
    const where = options.includeArchived ? {} : { isArchived: false };
    const { Board } = require('../models');
    const rows = await Board.findAll({ where, attributes: ['id'], raw: true });
    return new Set(rows.map((r) => r.id));
  }

  const visWhere = await buildBoardVisibilityWhere(viewer, options);
  const where = options.includeArchived
    ? { ...visWhere }
    : { isArchived: false, ...visWhere };

  const { Board } = require('../models');
  const rows = await Board.findAll({ where, attributes: ['id'], raw: true });
  return new Set(rows.map((r) => r.id));
}

module.exports = {
  getVisibleUserIdsForBoardScope,
  buildBoardVisibilityWhere,
  canUserSeeBoard,
  getVisibleBoardIdsForUser,
};
