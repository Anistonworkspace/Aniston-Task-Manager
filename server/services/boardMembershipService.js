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
const { emitToUser } = require('./socketService');

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
 */
async function autoAddMember(boardId, userId) {
  try {
    // Use raw upsert so we never flip autoAdded=false → true on an
    // explicitly-added member.
    await sequelize.query(
      `INSERT INTO "BoardMembers" ("boardId", "userId", "autoAdded", "createdAt", "updatedAt")
       VALUES (:boardId, :userId, true, NOW(), NOW())
       ON CONFLICT ("boardId", "userId") DO NOTHING`,
      { replacements: { boardId, userId } }
    );
    logger.info(`[BoardMembership] Auto-added user ${userId} to board ${boardId}`);
  } catch (err) {
    // Swallow — the row likely already exists or FK is stale.
    logger.warn(`[BoardMembership] autoAddMember failed (non-fatal): ${err.message?.slice(0, 120)}`);
  }
}

/**
 * Explicitly add a user to a board (via Board Settings / addMember endpoint).
 * Sets autoAdded=false so the row survives task-unassignment cleanup.
 */
async function explicitAddMember(boardId, userId) {
  try {
    await sequelize.query(
      `INSERT INTO "BoardMembers" ("boardId", "userId", "autoAdded", "createdAt", "updatedAt")
       VALUES (:boardId, :userId, false, NOW(), NOW())
       ON CONFLICT ("boardId", "userId")
       DO UPDATE SET "autoAdded" = false, "updatedAt" = NOW()`,
      { replacements: { boardId, userId } }
    );
    logger.info(`[BoardMembership] Explicitly added user ${userId} to board ${boardId}`);
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
      // Notify the user's sidebar to refresh — emit board:memberRemoved so
      // the frontend re-fetches the board list and drops this board.
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
