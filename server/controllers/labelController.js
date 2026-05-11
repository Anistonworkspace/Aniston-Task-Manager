const { Label, TaskLabel, Task, User, Board } = require('../models');
const { sequelize } = require('../config/db');
const { emitToBoard } = require('../services/socketService');
const { sanitizeInput } = require('../utils/sanitize');
const taskVisibility = require('../services/taskVisibilityService');
const boardVisibility = require('../services/boardVisibilityService');
const metrics = require('../services/metricsService');
const logger = require('../utils/logger');

// Hex color allowlist — labels render the color straight into a style
// attribute on the frontend (style={{ backgroundColor: l.color }}).
// Without server-side validation a user could store CSS that breaks the
// downstream renderer (e.g. `red; background: url(...)`). xss() doesn't
// catch this because the value is plain text. The allowlist matches the
// frontend's preset palette plus general 3/6-digit hex.
const COLOR_HEX = /^#(?:[0-9a-f]{3}){1,2}$/i;
function normalizeColor(input, fallback = '#579bfc') {
  if (typeof input !== 'string') return fallback;
  const v = input.trim();
  return COLOR_HEX.test(v) ? v : fallback;
}

// S-H6 — Board management check. Mirrors the pattern in automationController:
// admin / super admin pass unconditionally; everyone else must be the creator.
// Route-level role gates keep raw members out; this is the second line of
// defence (manager-on-stranger-board case).
function canManageBoard(user, board) {
  if (!user || !board) return false;
  if (user.isSuperAdmin) return true;
  if (user.role === 'admin') return true;
  if (board.createdBy === user.id) return true;
  return false;
}

// Helper: look up the boardId for a task and emit task:labels_updated to
// the board room. The frontend BoardPage listener picks this up and
// refetches just that task's labels, keeping every open tab / open modal
// in sync without a full board reload. Wrapped in try/catch so a socket
// dispatch failure can't break the underlying CRUD response.
async function emitLabelsUpdated(taskId) {
  try {
    const task = await Task.findByPk(taskId, { attributes: ['id', 'boardId'] });
    if (task && task.boardId) {
      emitToBoard(task.boardId, 'task:labels_updated', { taskId });
    }
  } catch { /* non-fatal */ }
}

// GET /api/labels?boardId=...
// P0-6 fix: scope to board visibility. Without this, any authenticated user
// could pass an arbitrary boardId and enumerate every label on every board.
exports.getLabels = async (req, res) => {
  try {
    const where = {};
    if (req.query.boardId) {
      // Board-scoped query: caller must be able to see the board.
      if (!(await boardVisibility.canUserSeeBoard(req.user, req.query.boardId))) {
        return res.status(403).json({ success: false, message: 'Forbidden.' });
      }
      where.boardId = req.query.boardId;
    } else {
      // Global query (no boardId) — only ever return labels with
      // boardId = NULL (true global). Don't leak board-scoped labels
      // here because we can't cheaply filter them by per-board visibility.
      where.boardId = null;
    }
    const labels = await Label.findAll({ where, order: [['name', 'ASC']] });
    res.json({ success: true, data: { labels } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch labels.' });
  }
};

// POST /api/labels
exports.createLabel = async (req, res) => {
  try {
    const { name, color, boardId } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Name is required.' });

    // S-H6 — if a boardId is supplied, verify the board exists and the actor
    // can manage it. Global labels (boardId === null) are kept as-is — the
    // route-level role gate already restricts them.
    if (boardId) {
      const board = await Board.findByPk(boardId);
      if (!board) return res.status(404).json({ success: false, message: 'Board not found.' });
      if (!canManageBoard(req.user, board)) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to manage labels on this board.',
        });
      }
    }

    // P2-2 — optional atomic "create + assign" path. The frontend used
    // to do this as two separate API calls; if the assign failed, the
    // freshly-created label was orphaned in the DB. When the client
    // passes assignToTaskId, we now do both in a single transaction so
    // a failed assign rolls back the create.
    const assignToTaskId = req.body.assignToTaskId;
    let label;
    if (assignToTaskId) {
      const task = await Task.findByPk(assignToTaskId, { attributes: ['id', 'boardId'] });
      if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
      if (boardId && task.boardId !== boardId) {
        return res.status(400).json({ success: false, message: 'Task is not on the requested board.' });
      }
      if (!(await taskVisibility.canViewTask(req.user, task))) {
        return res.status(403).json({ success: false, message: 'Forbidden.' });
      }
      label = await sequelize.transaction(async (t) => {
        const created = await Label.create({
          name: sanitizeInput(name),
          color: normalizeColor(color),
          boardId: boardId || task.boardId || null,
          createdBy: req.user.id,
        }, { transaction: t });
        await TaskLabel.create({ taskId: assignToTaskId, labelId: created.id }, { transaction: t });
        return created;
      });
      emitLabelsUpdated(assignToTaskId);
    } else {
      label = await Label.create({
        name: sanitizeInput(name),
        color: normalizeColor(color),
        boardId: boardId || null,
        createdBy: req.user.id,
      });
    }
    res.status(201).json({ success: true, data: { label } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to create label.' });
  }
};

// PUT /api/labels/:id
exports.updateLabel = async (req, res) => {
  try {
    const label = await Label.findByPk(req.params.id);
    if (!label) return res.status(404).json({ success: false, message: 'Label not found.' });

    // S-H6 — board access check. A label tied to a board can only be edited
    // by someone with management rights on that board.
    if (label.boardId) {
      const board = await Board.findByPk(label.boardId);
      if (!board) return res.status(404).json({ success: false, message: 'Board not found.' });
      if (!canManageBoard(req.user, board)) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to manage labels on this board.',
        });
      }
    }

    const { name, color } = req.body;
    await label.update({
      ...(name !== undefined && { name: sanitizeInput(name) }),
      // P1-3 — normalize color to a hex code; reject anything else by
      // falling back to the safe default so we never persist user-supplied
      // CSS into a style attribute.
      ...(color !== undefined && { color: normalizeColor(color, label.color) }),
    });
    res.json({ success: true, data: { label } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update label.' });
  }
};

// DELETE /api/labels/:id
// P2-3 — wrap junction-delete + label-delete in a transaction so a partial
// failure no longer leaves an orphan Label row in the DB.
exports.deleteLabel = async (req, res) => {
  try {
    // Phase 7 — Tier-2 destructive guard.
    const { assertCanDelete } = require('../services/tierEnforcement');
    const { sendIfTierError } = require('../utils/tierResponseHelpers');
    if (sendIfTierError(res, () => assertCanDelete(req.user, 'label', { isOwnResource: false }))) return;

    const labelId = req.params.id;
    const label = await Label.findByPk(labelId);
    if (!label) return res.status(404).json({ success: false, message: 'Label not found.' });

    // Board management gate (mirrors update/create).
    if (label.boardId) {
      const board = await Board.findByPk(label.boardId);
      if (!board) return res.status(404).json({ success: false, message: 'Board not found.' });
      if (!canManageBoard(req.user, board)) {
        return res.status(403).json({ success: false, message: 'You do not have permission to delete labels on this board.' });
      }
    }

    await sequelize.transaction(async (t) => {
      await TaskLabel.destroy({ where: { labelId }, transaction: t });
      await Label.destroy({ where: { id: labelId }, transaction: t });
    });
    res.json({ success: true, message: 'Label deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete label.' });
  }
};

// POST /api/labels/assign — assign label to task
// P0-1 fix: previously this took { taskId, labelId } and called
// findOrCreate with zero validation. That allowed:
//   • a Tier 1/2 user to assign a label from board A to a task on board B
//   • any caller to write a TaskLabel row for a task they have NO view
//     access to (silent cross-tenant data attachment)
// Now we verify task + label both exist, the label's boardId matches the
// task's boardId (or is null for a global label), and the caller can see
// the task via the canonical visibility service.
exports.assignLabel = async (req, res) => {
  const started = Date.now();
  metrics.increment('labels.assign.requests');
  try {
    const { taskId, labelId } = req.body;
    if (!taskId || !labelId) {
      metrics.increment('labels.assign.bad_request');
      return res.status(400).json({ success: false, message: 'taskId and labelId are required.' });
    }
    const [task, label] = await Promise.all([
      Task.findByPk(taskId, { attributes: ['id', 'boardId'] }),
      Label.findByPk(labelId, { attributes: ['id', 'boardId'] }),
    ]);
    if (!task) { metrics.increment('labels.assign.not_found'); return res.status(404).json({ success: false, message: 'Task not found.' }); }
    if (!label) { metrics.increment('labels.assign.not_found'); return res.status(404).json({ success: false, message: 'Label not found.' }); }
    if (label.boardId && label.boardId !== task.boardId) {
      metrics.increment('labels.assign.cross_board_blocked');
      logger.warn('[labels.assign] cross-board attempt blocked', { userId: req.user.id, taskId, labelId, labelBoardId: label.boardId, taskBoardId: task.boardId });
      return res.status(400).json({ success: false, message: 'Label does not belong to this task\'s board.' });
    }
    if (!(await taskVisibility.canViewTask(req.user, task))) {
      metrics.increment('labels.assign.forbidden');
      logger.warn('[labels.assign] view-access denied', { userId: req.user.id, taskId });
      return res.status(403).json({ success: false, message: 'Forbidden.' });
    }
    const [tl, created] = await TaskLabel.findOrCreate({ where: { taskId, labelId } });
    emitLabelsUpdated(taskId);
    metrics.observe('labels.assign.latency_ms', Date.now() - started);
    res.json({ success: true, data: { taskLabel: tl, created } });
  } catch (err) {
    metrics.increment('labels.assign.errors');
    logger.error('[labels.assign] error', { error: err.message });
    res.status(500).json({ success: false, message: 'Failed to assign label.' });
  }
};

// DELETE /api/labels/unassign — remove label from task
// P0-2 fix: same IDOR shape as assignLabel.
exports.unassignLabel = async (req, res) => {
  try {
    const { taskId, labelId } = req.body;
    if (!taskId || !labelId) {
      return res.status(400).json({ success: false, message: 'taskId and labelId are required.' });
    }
    const task = await Task.findByPk(taskId, { attributes: ['id', 'boardId'] });
    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
    if (!(await taskVisibility.canViewTask(req.user, task))) {
      return res.status(403).json({ success: false, message: 'Forbidden.' });
    }
    await TaskLabel.destroy({ where: { taskId, labelId } });
    emitLabelsUpdated(taskId);
    res.json({ success: true, message: 'Label removed from task.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to remove label.' });
  }
};

// GET /api/labels/task/:taskId — get labels for a task
// P0-3 fix: previously any authenticated user could read labels on any
// task. Now we gate on canViewTask.
exports.getTaskLabels = async (req, res) => {
  try {
    const task = await Task.findByPk(req.params.taskId, {
      attributes: ['id', 'boardId'],
      include: [{ model: Label, as: 'labels', through: { attributes: [] } }],
    });
    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
    if (!(await taskVisibility.canViewTask(req.user, task))) {
      return res.status(403).json({ success: false, message: 'Forbidden.' });
    }
    res.json({ success: true, data: { labels: task.labels || [] } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch task labels.' });
  }
};
