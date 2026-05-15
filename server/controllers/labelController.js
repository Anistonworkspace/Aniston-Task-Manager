const { Label, TaskLabel, Task, User, Board } = require('../models');
const { sequelize } = require('../config/db');
const { emitToBoard, emitToBoardAndUsers } = require('../services/socketService');
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

// Board-library management check (used by UPDATE, DELETE, and the no-task
// board-library CREATE path). Label management is now a Tier-1 / Tier-2
// surface across any board they can see — managers no longer need to be the
// board creator to mint/rename/delete a label. (Earlier S-H6 boundary kept
// managers scoped to their own boards; product feedback widened this so
// any T1/T2 can curate the board's label library.) Lower tiers still hit
// 403 here — they create labels exclusively through the task-scoped path,
// which is authorised by `taskVisibility.canViewTask` further down. The
// board-creator fallback is preserved so a T3/T4 user who personally
// created a board can still manage its labels.
function canManageBoard(user, board) {
  if (!user || !board) return false;
  if (user.isSuperAdmin) return true;
  if (user.role === 'admin' || user.role === 'manager') return true;
  if (board.createdBy === user.id) return true;
  return false;
}

// Helper: look up the boardId for a task and emit task:labels_updated to
// the board room AND every directly-affected user (assignees, owners,
// creator) who is not currently in that board room — so the assignee
// sitting on MyWork / Home / Tasks pages also sees the label change live.
// Wrapped in try/catch so a socket dispatch failure can't break the
// underlying CRUD response.
async function emitLabelsUpdated(taskId) {
  try {
    const task = await Task.findByPk(taskId, { attributes: ['id', 'boardId'] });
    if (!task || !task.boardId) return;
    let recipients = [];
    try {
      recipients = await taskVisibility.getAuthorizedRealtimeRecipients(task);
    } catch { /* non-fatal — falls back to board-room only */ }
    if (typeof emitToBoardAndUsers === 'function' && recipients.length > 0) {
      await emitToBoardAndUsers(task.boardId, 'task:labels_updated', { taskId }, recipients);
    } else {
      emitToBoard(task.boardId, 'task:labels_updated', { taskId });
    }
  } catch (err) {
    logger.warn('[labels.emit] socket dispatch failed', { taskId, err: err?.message });
  }
}

// Build the developer-safe error envelope for a 500 response. In dev
// (NODE_ENV !== 'production') we include the actual error message + name
// so the UI surfaces a useful toast instead of the generic "Failed to ...".
// Prod still returns the generic message — but logger.error() captures the
// full detail server-side regardless of environment.
function envelope500(message, err) {
  const body = { success: false, message };
  if (process.env.NODE_ENV !== 'production' && err && err.message) {
    body.detail = err.message;
    if (err.name) body.errorName = err.name;
  }
  return body;
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
    logger.error('[labels.list] error', { error: err.message, name: err.name, stack: err.stack });
    res.status(500).json(envelope500('Failed to fetch labels.', err));
  }
};

// POST /api/labels
//
// Two distinct paths, separated by whether the request carries
// `assignToTaskId`:
//
// 1. TASK-SCOPED (assignToTaskId present) — "create a label and attach it
//    to THIS task in one transaction." Open to any authenticated user who
//    can see the task. The visibility gate is the same one that decides
//    whether the task row renders for them at all — so a Tier 4 member who
//    owns the task, a Tier 3 supervisor on the parent task, and a Tier 2/1
//    admin all pass. This is the path the LabelCell uses in both the board
//    table and the task modal. The DB write is wrapped in a transaction so
//    a failed TaskLabel insert rolls back the parent Label insert — no
//    orphan rows on partial failure (P2-2).
//
// 2. BOARD-LIBRARY (no assignToTaskId, boardId only) — "create a label in
//    the board's label library, do not attach it anywhere yet." This is a
//    shared-resource mutation: the resulting label appears in every user's
//    picker on that board. Stays admin-only via `canManageBoard` to match
//    the audit's S-H6 boundary (the same boundary preserved on PUT/DELETE).
//    No assignToTaskId means we have no per-task visibility hook to lean on,
//    so the board-management check is the right gate here.
exports.createLabel = async (req, res) => {
  try {
    const { name, color, boardId } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Name is required.' });

    const assignToTaskId = req.body.assignToTaskId;
    let label;

    if (assignToTaskId) {
      // ── Path 1: TASK-SCOPED create + assign ──────────────────────────
      const task = await Task.findByPk(assignToTaskId, { attributes: ['id', 'boardId'] });
      if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
      if (boardId && task.boardId !== boardId) {
        return res.status(400).json({ success: false, message: 'Task is not on the requested board.' });
      }
      // Per-task visibility is the gate. Lower-tier users (T3/T4) pass
      // when they own, were assigned to, created, or supervise the task —
      // matching the same predicate that lets them see the row in the
      // first place. Users who CANNOT see the task get a 403, same as a
      // direct GET would.
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
      // ── Path 2: BOARD-LIBRARY create (admin-only) ───────────────────
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
      label = await Label.create({
        name: sanitizeInput(name),
        color: normalizeColor(color),
        boardId: boardId || null,
        createdBy: req.user.id,
      });
    }
    res.status(201).json({ success: true, data: { label } });
  } catch (err) {
    logger.error('[labels.create] error', {
      error: err.message,
      name: err.name,
      sql: err.parent?.message || err.original?.message,
      stack: err.stack,
      userId: req.user?.id,
      body: { name: req.body?.name, color: req.body?.color, boardId: req.body?.boardId, assignToTaskId: req.body?.assignToTaskId },
    });
    res.status(500).json(envelope500('Failed to create label.', err));
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
    logger.error('[labels.update] error', { error: err.message, name: err.name, sql: err.parent?.message || err.original?.message });
    res.status(500).json(envelope500('Failed to update label.', err));
  }
};

// DELETE /api/labels/:id
// P2-3 — wrap junction-delete + label-delete in a transaction so a partial
// failure no longer leaves an orphan Label row in the DB.
exports.deleteLabel = async (req, res) => {
  try {
    // Labels are explicitly admitted to Tier 2 destructive scope per product
    // decision (May 2026): they are easily-recreatable metadata and a manager
    // curating their team's board library should not need to escalate to a
    // Tier-1 admin to delete a stale label. `canManageBoard` below is the
    // authoritative gate — Tier 3/4 still get 403 there. The tier-enforcement
    // service's strict-T2 rule continues to protect every other destructive
    // surface (tasks, boards, users, etc.).
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
    logger.error('[labels.delete] error', { error: err.message, name: err.name, sql: err.parent?.message || err.original?.message });
    res.status(500).json(envelope500('Failed to delete label.', err));
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
    // Phase 7 — granular `labels.add_to_task` gate (umbrella → labels.create).
    const { denyIfNoPermission } = require('../utils/permissionGate');
    if (await denyIfNoPermission(res, req.user, 'labels', 'add_to_task',
        'You do not have permission to add labels to tasks.')) return;
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
    // Phase 7 — granular `labels.remove_from_task` gate (umbrella → labels.edit).
    const { denyIfNoPermission } = require('../utils/permissionGate');
    if (await denyIfNoPermission(res, req.user, 'labels', 'remove_from_task',
        'You do not have permission to remove labels from tasks.')) return;
    await TaskLabel.destroy({ where: { taskId, labelId } });
    emitLabelsUpdated(taskId);
    res.json({ success: true, message: 'Label removed from task.' });
  } catch (err) {
    logger.error('[labels.unassign] error', { error: err.message, name: err.name, sql: err.parent?.message || err.original?.message });
    res.status(500).json(envelope500('Failed to remove label.', err));
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
    logger.error('[labels.taskLabels] error', { error: err.message, name: err.name, sql: err.parent?.message || err.original?.message });
    res.status(500).json(envelope500('Failed to fetch task labels.', err));
  }
};
