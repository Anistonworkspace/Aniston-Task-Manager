/**
 * Task receipt (WhatsApp-style read receipt) per assignee.
 *
 * Writes are idempotent:
 *   - deliveredAt is set only when currently NULL
 *   - seenAt is set only when currently NULL (also fills deliveredAt if NULL)
 *
 * Visibility rule for the row icon:
 *   Only the task "assigner" sees the receipt icon. Assigner = task.createdBy.
 *   If the viewer is both creator AND listed as an assignee, we do not show
 *   the icon (consistent with "assignee should not see it").
 *
 * Aggregation rules (exactly as specified):
 *   total          = rows where role='assignee'
 *   deliveredCount = rows where deliveredAt IS NOT NULL
 *   seenCount      = rows where seenAt IS NOT NULL
 *   single      → deliveredCount === 0 AND seenCount === 0
 *   double_grey → (deliveredCount > 0 OR seenCount > 0) AND seenCount < total
 *   double_blue → total > 0 AND seenCount === total
 */

const { Op } = require('sequelize');
const { TaskAssignee, User } = require('../models');
const { sequelize } = require('../config/db');
const logger = require('../utils/logger');

let _columnsAvailable = null;
async function receiptColumnsAvailable() {
  if (_columnsAvailable !== null) return _columnsAvailable;
  try {
    await sequelize.query(`SELECT "deliveredAt", "seenAt", "assignerId" FROM task_assignees LIMIT 0`);
    _columnsAvailable = true;
  } catch (e) {
    logger.warn('[TaskReceipt] task_assignees receipt columns unavailable — receipt features disabled');
    _columnsAvailable = false;
  }
  return _columnsAvailable;
}

/**
 * Mark a set of tasks delivered for the given user. Only updates rows where
 * the user is an assignee (role='assignee') and deliveredAt is currently NULL.
 * Returns the list of taskIds that were actually transitioned.
 */
async function markDelivered(userId, taskIds) {
  if (!userId || !Array.isArray(taskIds) || taskIds.length === 0) return [];
  if (!(await receiptColumnsAvailable())) return [];
  try {
    // Find candidate rows first so we can return which tasks actually transitioned.
    const candidates = await TaskAssignee.findAll({
      where: {
        userId,
        role: 'assignee',
        taskId: { [Op.in]: taskIds },
        deliveredAt: null,
      },
      attributes: ['taskId'],
      raw: true,
    });
    if (candidates.length === 0) return [];
    const now = new Date();
    await TaskAssignee.update(
      { deliveredAt: now },
      {
        where: {
          userId,
          role: 'assignee',
          taskId: { [Op.in]: candidates.map(c => c.taskId) },
          deliveredAt: null,
        },
      }
    );
    return candidates.map(c => c.taskId);
  } catch (err) {
    logger.warn('[TaskReceipt] markDelivered failed:', err.message);
    return [];
  }
}

/**
 * Mark a task seen (and delivered if not yet) for the given user.
 * Returns { changed, deliveredNow, seenNow } — changed is true iff any write occurred.
 */
async function markSeen(userId, taskId) {
  if (!userId || !taskId) return { changed: false };
  if (!(await receiptColumnsAvailable())) return { changed: false };
  try {
    const row = await TaskAssignee.findOne({
      where: { userId, taskId, role: 'assignee' },
    });
    if (!row) return { changed: false, notAssignee: true };
    const now = new Date();
    const update = {};
    let deliveredNow = false;
    let seenNow = false;
    if (!row.deliveredAt) {
      update.deliveredAt = now;
      deliveredNow = true;
    }
    if (!row.seenAt) {
      update.seenAt = now;
      seenNow = true;
    }
    if (Object.keys(update).length === 0) return { changed: false };
    await row.update(update);
    return { changed: true, deliveredNow, seenNow };
  } catch (err) {
    logger.warn('[TaskReceipt] markSeen failed:', err.message);
    return { changed: false };
  }
}

/**
 * Build the { state, counts, details } block from an already-loaded task's
 * taskAssignees array. No extra DB calls — callers must include taskAssignees.
 *
 * Returns `null` when the viewer should not see the receipt (e.g. viewer is
 * an assignee, or there are no assignees, or viewer is not the assigner).
 */
function buildSummary(task, viewerId) {
  if (!task || !viewerId) return null;

  // Only the task creator (= assigner) sees the receipt row-icon.
  const assignerId = task.createdBy;
  if (!assignerId || String(assignerId) !== String(viewerId)) return null;

  const taskAssignees = Array.isArray(task.taskAssignees) ? task.taskAssignees : [];

  // Legacy safety: if the table has no row yet, fall back to assignedTo
  // so the creator still sees *something* without crashing.
  const assigneeRows = taskAssignees.filter(ta => ta.role === 'assignee');
  const virtualAssignees = assigneeRows.length === 0 && task.assignedTo
    ? [{
      userId: typeof task.assignedTo === 'string' ? task.assignedTo : task.assignedTo?.id,
      user: task.assignee || null,
      deliveredAt: null,
      seenAt: null,
    }]
    : assigneeRows;

  if (virtualAssignees.length === 0) return null;

  // If the viewer is ALSO an assignee on this task, hide the icon — per spec,
  // the tick must not be visible to assigned members.
  const viewerIsAssignee = virtualAssignees.some(ta => String(ta.userId) === String(viewerId));
  if (viewerIsAssignee) return null;

  const total = virtualAssignees.length;
  let deliveredCount = 0;
  let seenCount = 0;
  const details = virtualAssignees.map(ta => {
    const u = ta.user || {};
    if (ta.deliveredAt) deliveredCount += 1;
    if (ta.seenAt) seenCount += 1;
    return {
      userId: ta.userId,
      name: u.name || 'Unknown',
      email: u.email || null,
      avatar: u.avatar || null,
      deliveredAt: ta.deliveredAt || null,
      seenAt: ta.seenAt || null,
    };
  });

  let state;
  if (deliveredCount === 0 && seenCount === 0) state = 'single';
  else if (total > 0 && seenCount === total) state = 'double_blue';
  else state = 'double_grey';

  return {
    state,
    total,
    deliveredCount,
    seenCount,
    details,
  };
}

/**
 * Fetch a fresh receipt summary for a single task by id — used by the
 * POST /receipt endpoint to return the updated state to the caller without
 * forcing a full task re-fetch on the client.
 */
async function fetchSummary(taskId, viewerId) {
  if (!(await receiptColumnsAvailable())) return null;
  try {
    const rows = await TaskAssignee.findAll({
      where: { taskId, role: 'assignee' },
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'avatar'] }],
    });
    // Caller must know task.createdBy to scope visibility. Fetch minimally.
    const { Task } = require('../models');
    const task = await Task.findByPk(taskId, { attributes: ['id', 'createdBy', 'assignedTo'] });
    if (!task) return null;
    const plainTask = task.toJSON();
    plainTask.taskAssignees = rows.map(r => r.toJSON());
    return buildSummary(plainTask, viewerId);
  } catch (err) {
    logger.warn('[TaskReceipt] fetchSummary failed:', err.message);
    return null;
  }
}

module.exports = {
  receiptColumnsAvailable,
  markDelivered,
  markSeen,
  buildSummary,
  fetchSummary,
};
