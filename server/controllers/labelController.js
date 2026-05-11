const { Label, TaskLabel, Task, User } = require('../models');
const { emitToBoard } = require('../services/socketService');

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
exports.getLabels = async (req, res) => {
  try {
    const where = {};
    if (req.query.boardId) where.boardId = req.query.boardId;
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
    const label = await Label.create({ name, color: color || '#579bfc', boardId: boardId || null, createdBy: req.user.id });
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
    const { name, color } = req.body;
    await label.update({ ...(name && { name }), ...(color && { color }) });
    res.json({ success: true, data: { label } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update label.' });
  }
};

// DELETE /api/labels/:id
exports.deleteLabel = async (req, res) => {
  try {
    // Phase 7 — Tier-2 destructive guard.
    const { assertCanDelete } = require('../services/tierEnforcement');
    const { sendIfTierError } = require('../utils/tierResponseHelpers');
    if (sendIfTierError(res, () => assertCanDelete(req.user, 'label', { isOwnResource: false }))) return;

    await TaskLabel.destroy({ where: { labelId: req.params.id } });
    await Label.destroy({ where: { id: req.params.id } });
    res.json({ success: true, message: 'Label deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete label.' });
  }
};

// POST /api/labels/assign — assign label to task
exports.assignLabel = async (req, res) => {
  try {
    const { taskId, labelId } = req.body;
    const [tl, created] = await TaskLabel.findOrCreate({ where: { taskId, labelId } });
    // Fire-and-forget realtime nudge to every tab on this board so the
    // Labels column + open task modal both refresh without manual reload.
    emitLabelsUpdated(taskId);
    res.json({ success: true, data: { taskLabel: tl, created } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to assign label.' });
  }
};

// DELETE /api/labels/unassign — remove label from task
exports.unassignLabel = async (req, res) => {
  try {
    const { taskId, labelId } = req.body;
    await TaskLabel.destroy({ where: { taskId, labelId } });
    emitLabelsUpdated(taskId);
    res.json({ success: true, message: 'Label removed from task.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to remove label.' });
  }
};

// GET /api/labels/task/:taskId — get labels for a task
exports.getTaskLabels = async (req, res) => {
  try {
    const task = await Task.findByPk(req.params.taskId, {
      include: [{ model: Label, as: 'labels', through: { attributes: [] } }],
    });
    res.json({ success: true, data: { labels: task?.labels || [] } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch task labels.' });
  }
};
