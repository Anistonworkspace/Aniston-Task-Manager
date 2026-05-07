/**
 * Board Membership Service
 *
 * Manages the lifecycle of auto-added BoardMember rows.
 * When a user is assigned to a task the system adds them to the board.
 * When the last relevant task is unassigned, this service removes the
 * auto-added row so the board disappears from their sidebar.
 */

const { sequelize } = require('../config/db');
const logger = require('../utils/logger');
const { emitToUser, forceUserLeaveBoard } = require('./socketService');

// ── helpers ─────────────────────────────────────────────────────────────────

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

// ── core ────────────────────────────────────────────────────────────────────

/**
 * Auto-add a user to a board's membership with autoAdded=true.
 * Safe to call multiple times — skips if the row already exists.
 *
 * Realtime side-effect: when (and only when) a NEW BoardMembers row is
 * actually inserted, we emit `board:memberAdded` to the user's personal
 * socket room. This drives the assignee's sidebar to refetch the board
 * list immediately without a page reload — closing the long-standing
 * gap where assignment from another user gave them backend access but
 * no UI update until they manually refreshed.
 *
 * The `RETURNING "userId"` clause makes the on-conflict no-op return
 * an empty array, so we can distinguish "newly inserted" from "already
 * a member" and only fire the event in the new-insert case. That keeps
 * task-edit churn from spamming the user with redundant invalidations.
 *
 * The emit is wrapped: if the socket layer isn't initialised (tests),
 * the failure is silently swallowed — the DB write still succeeded.
 */
async function autoAddMember(boardId, userId) {
  try {
    const [rows] = await sequelize.query(
      `INSERT INTO "BoardMembers" ("boardId", "userId", "autoAdded", "createdAt", "updatedAt")
       VALUES (:boardId, :userId, true, NOW(), NOW())
       ON CONFLICT ("boardId", "userId") DO NOTHING
       RETURNING "userId"`,
      { replacements: { boardId, userId } }
    );
    const inserted = Array.isArray(rows) && rows.length > 0;
    if (inserted) {
      logger.info(`[BoardMembership] Auto-added user ${userId} to board ${boardId}`);
      // Targeted user-room emit — never broadcast a board's existence
      // globally from this path. The eventRouter routes board:memberAdded
      // to invalidate `boards.list` + `tasks.assignedTo.me`, which makes
      // the new board appear in the recipient's sidebar after their
      // RBAC-aware refetch.
      try {
        emitToUser(userId, 'board:memberAdded', { boardId, userId });
      } catch (_) { /* socket layer not ready — non-fatal */ }
    }
  } catch (err) {
    // Swallow — the row likely already exists or FK is stale.
    logger.warn(`[BoardMembership] autoAddMember failed (non-fatal): ${err.message?.slice(0, 120)}`);
  }
}

/**
 * Explicitly add a user to a board (via Board Settings / addMember endpoint).
 * Sets autoAdded=false so the row survives task-unassignment cleanup.
 *
 * Realtime side-effect: emit `board:memberAdded` to the user's personal
 * socket room only on a TRUE first insert (xmax = 0 in PostgreSQL means
 * the row was inserted, not updated). Suppresses spurious emits when the
 * caller is just upgrading an existing auto-added row to explicit (a
 * common no-visible-change path triggered by `addMember` re-adds).
 *
 * Note: `boardController.addMember` also emits `board:memberAdded`
 * with `boardName` for richer payload — this fallback ensures the event
 * fires even when explicitAddMember is invoked from elsewhere
 * (templates, board creation auto-add, etc.).
 */
async function explicitAddMember(boardId, userId) {
  try {
    const [rows] = await sequelize.query(
      `INSERT INTO "BoardMembers" ("boardId", "userId", "autoAdded", "createdAt", "updatedAt")
       VALUES (:boardId, :userId, false, NOW(), NOW())
       ON CONFLICT ("boardId", "userId")
       DO UPDATE SET "autoAdded" = false, "updatedAt" = NOW()
       RETURNING "userId", (xmax = 0) AS inserted`,
      { replacements: { boardId, userId } }
    );
    logger.info(`[BoardMembership] Explicitly added user ${userId} to board ${boardId}`);
    const wasNewInsert = Array.isArray(rows) && rows.length > 0 && rows[0].inserted === true;
    if (wasNewInsert) {
      try {
        emitToUser(userId, 'board:memberAdded', { boardId, userId });
      } catch (_) { /* socket layer not ready — non-fatal */ }
    }
  } catch (err) {
    logger.warn(`[BoardMembership] explicitAddMember failed (non-fatal): ${err.message?.slice(0, 120)}`);
  }
}

/**
 * After a task unassignment, check whether the given user still has any
 * reason to remain on the board.  If not — and their membership was
 * auto-added — remove the BoardMember row so the board disappears from
 * their sidebar/dashboard.
 *
 * Safe to call for admins/managers — they see all boards regardless, and
 * the function will simply skip them (they don't rely on BoardMembers).
 *
 * @param {string} userId  - UUID of the user whose membership to evaluate
 * @param {string} boardId - UUID of the board to check
 */
async function cleanupIfNoTasksRemain(userId, boardId) {
  if (!userId || !boardId) return;
  try {
    // 1. Check if user created the board — never remove the creator
    const [creators] = await sequelize.query(
      `SELECT 1 FROM boards WHERE id = :boardId AND "createdBy" = :userId LIMIT 1`,
      { replacements: { boardId, userId } }
    );
    if (creators.length > 0) {
      logger.info(`[BoardMembership] User ${userId} is board ${boardId} creator — skipping cleanup`);
      return;
    }

    // 2. Check if user was explicitly added (autoAdded=false) — never remove
    const [explicit] = await sequelize.query(
      `SELECT 1 FROM "BoardMembers"
       WHERE "boardId" = :boardId AND "userId" = :userId AND "autoAdded" = false
       LIMIT 1`,
      { replacements: { boardId, userId } }
    );
    if (explicit.length > 0) {
      logger.info(`[BoardMembership] User ${userId} explicitly added to board ${boardId} — skipping cleanup`);
      return;
    }

    // 3. Check if user still has tasks on this board (legacy assignedTo)
    const [legacyTasks] = await sequelize.query(
      `SELECT 1 FROM tasks
       WHERE "boardId" = :boardId AND "assignedTo" = :userId
         AND ("isArchived" = false OR "isArchived" IS NULL)
       LIMIT 1`,
      { replacements: { boardId, userId } }
    );
    if (legacyTasks.length > 0) return;

    // 4. Check task_assignees
    if (await _tblExists('task_assignees')) {
      const [taRows] = await sequelize.query(
        `SELECT 1 FROM task_assignees ta
         INNER JOIN tasks t ON t.id = ta."taskId"
         WHERE t."boardId" = :boardId AND ta."userId" = :userId
           AND (t."isArchived" = false OR t."isArchived" IS NULL)
         LIMIT 1`,
        { replacements: { boardId, userId } }
      );
      if (taRows.length > 0) return;
    }

    // 5. Check task_owners
    if (await _tblExists('task_owners')) {
      const [toRows] = await sequelize.query(
        `SELECT 1 FROM task_owners to2
         INNER JOIN tasks t ON t.id = to2."taskId"
         WHERE t."boardId" = :boardId AND to2."userId" = :userId
           AND (t."isArchived" = false OR t."isArchived" IS NULL)
         LIMIT 1`,
        { replacements: { boardId, userId } }
      );
      if (toRows.length > 0) return;
    }

    // 6. No remaining tasks → remove auto-added membership
    const [, meta] = await sequelize.query(
      `DELETE FROM "BoardMembers"
       WHERE "boardId" = :boardId AND "userId" = :userId AND "autoAdded" = true`,
      { replacements: { boardId, userId } }
    );
    const removed = meta?.rowCount ?? 0;
    if (removed > 0) {
      logger.info(`[BoardMembership] Removed auto-added membership: user ${userId} from board ${boardId}`);
      // Phase 4 — drop the user out of the board socket room first, so
      // any in-flight emit doesn't leak. Then notify their UI.
      forceUserLeaveBoard(userId, boardId).catch(() => { /* non-fatal */ });
      try {
        emitToUser(userId, 'board:memberRemoved', { boardId });
      } catch (e) { /* socket may not be ready */ }
    }
  } catch (err) {
    // Fire-and-forget — never crash the request
    logger.warn(`[BoardMembership] cleanupIfNoTasksRemain error (non-fatal): ${err.message?.slice(0, 150)}`);
  }
}

/**
 * Batch cleanup for multiple users on one board (e.g. when multiple
 * assignees are removed in a single task update).
 */
async function cleanupMultiple(userIds, boardId) {
  if (!Array.isArray(userIds) || userIds.length === 0 || !boardId) return;
  const unique = [...new Set(userIds)];
  for (const uid of unique) {
    await cleanupIfNoTasksRemain(uid, boardId);
  }
}

module.exports = {
  autoAddMember,
  explicitAddMember,
  cleanupIfNoTasksRemain,
  cleanupMultiple,
};
