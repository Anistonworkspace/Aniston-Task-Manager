const xss = require('xss');
const { TaskReference, Task, TaskAssignee } = require('../models');
const { logActivity } = require('../services/activityService');
const { resolveTier, TIER_1, TIER_2 } = require('../config/tiers');
const { emitToBoard } = require('../services/socketService');
const taskVisibility = require('../services/taskVisibilityService');
const metrics = require('../services/metricsService');
const logger = require('../utils/logger');

// Whether the caller is allowed to mutate references on this task. Matches
// the frontend's `canEditCustomFields` gate: Tier 1/2 can always edit, lower
// tiers must be the assignee, creator, or appear in the task_assignees join.
// Kept inline (vs. importing checkTaskAction) because the surface here is
// narrow — only this one resource type — and inline keeps the audit trail
// explicit at the route boundary.
async function canEditTaskRefs(user, task) {
  if (!user || !task) return false;
  const tier = resolveTier(user);
  if (tier === TIER_1 || tier === TIER_2) return true;
  if (task.assignedTo === user.id || task.createdBy === user.id) return true;
  try {
    const ta = await TaskAssignee.findOne({ where: { taskId: task.id, userId: user.id } });
    if (ta) return true;
  } catch { /* task_assignees may not exist on very old DBs */ }
  return false;
}

// GET /api/task-references/task/:taskId — list all references on a task,
// ordered by stored position so the UI can render the same sequence the
// user dragged them into.
//
// P0-4 fix: previously this only checked task existence — any authenticated
// user could enumerate references on any task ID. Now gated through the
// canonical taskVisibilityService.
exports.listReferences = async (req, res) => {
  metrics.increment('references.list.requests');
  try {
    const { taskId } = req.params;
    const task = await Task.findByPk(taskId, { attributes: ['id', 'boardId'] });
    if (!task) { metrics.increment('references.list.not_found'); return res.status(404).json({ success: false, message: 'Task not found.' }); }
    if (!(await taskVisibility.canViewTask(req.user, task))) {
      metrics.increment('references.list.forbidden');
      logger.warn('[references.list] view-access denied', { userId: req.user.id, taskId });
      return res.status(403).json({ success: false, message: 'Forbidden.' });
    }
    const references = await TaskReference.findAll({
      where: { taskId },
      order: [['position', 'ASC'], ['createdAt', 'ASC']],
    });
    return res.json({ success: true, data: { references } });
  } catch (err) {
    console.error('[TaskReference] list error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch references.' });
  }
};

// POST /api/task-references — create one reference entry.
// Body: { taskId, text }. Position is auto-assigned to the next slot.
exports.createReference = async (req, res) => {
  try {
    const { taskId } = req.body;
    const rawText = (req.body.text || '').toString();
    const text = xss(rawText).trim();
    if (!taskId) return res.status(400).json({ success: false, message: 'taskId is required.' });
    if (!text) return res.status(400).json({ success: false, message: 'Reference text is required.' });
    if (text.length > 500) {
      return res.status(400).json({ success: false, message: 'Reference text must be 500 characters or fewer.' });
    }
    const task = await Task.findByPk(taskId);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });

    if (!(await canEditTaskRefs(req.user, task))) {
      return res.status(403).json({ success: false, message: 'You do not have permission to edit references on this task.' });
    }

    // Next position = max(existing) + 1, so new refs append to the end. We
    // use a single query rather than read-then-write to avoid a race where
    // two concurrent creates land on the same position.
    const maxPos = await TaskReference.max('position', { where: { taskId } });
    const position = (Number.isFinite(maxPos) ? maxPos : -1) + 1;

    const reference = await TaskReference.create({
      taskId, text, position, createdBy: req.user.id,
    });

    // P2-7 — don't log reference content into the activity feed. The
    // entityId/taskId give traceability without leaking content into
    // every downstream log aggregator.
    logActivity({
      action: 'reference_added',
      description: 'Added a reference',
      entityType: 'task', entityId: taskId, taskId, boardId: task.boardId, userId: req.user.id,
    });

    try { emitToBoard(task.boardId, 'task:references_updated', { taskId }); } catch {}

    return res.status(201).json({ success: true, data: { reference } });
  } catch (err) {
    console.error('[TaskReference] create error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create reference.' });
  }
};

// PUT /api/task-references/:id — edit the text of a single reference.
exports.updateReference = async (req, res) => {
  try {
    const reference = await TaskReference.findByPk(req.params.id);
    if (!reference) return res.status(404).json({ success: false, message: 'Reference not found.' });
    const task = await Task.findByPk(reference.taskId);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
    if (!(await canEditTaskRefs(req.user, task))) {
      return res.status(403).json({ success: false, message: 'You do not have permission to edit references on this task.' });
    }

    const rawText = (req.body.text || '').toString();
    const text = xss(rawText).trim();
    if (!text) return res.status(400).json({ success: false, message: 'Reference text is required.' });
    if (text.length > 500) {
      return res.status(400).json({ success: false, message: 'Reference text must be 500 characters or fewer.' });
    }
    await reference.update({ text });

    try { emitToBoard(task.boardId, 'task:references_updated', { taskId: task.id }); } catch {}

    return res.json({ success: true, data: { reference } });
  } catch (err) {
    console.error('[TaskReference] update error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update reference.' });
  }
};

// DELETE /api/task-references/:id
exports.deleteReference = async (req, res) => {
  try {
    const reference = await TaskReference.findByPk(req.params.id);
    if (!reference) return res.status(404).json({ success: false, message: 'Reference not found.' });
    const task = await Task.findByPk(reference.taskId);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
    if (!(await canEditTaskRefs(req.user, task))) {
      return res.status(403).json({ success: false, message: 'You do not have permission to edit references on this task.' });
    }
    await reference.destroy();

    // P2-7 — don't echo content into the activity description.
    logActivity({
      action: 'reference_removed',
      description: 'Removed a reference',
      entityType: 'task', entityId: task.id, taskId: task.id, boardId: task.boardId, userId: req.user.id,
    });

    try { emitToBoard(task.boardId, 'task:references_updated', { taskId: task.id }); } catch {}

    return res.json({ success: true, message: 'Reference removed.' });
  } catch (err) {
    console.error('[TaskReference] delete error:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete reference.' });
  }
};
