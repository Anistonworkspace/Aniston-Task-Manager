const xss = require('xss');
const { TaskLink, Task, TaskAssignee } = require('../models');
const { logActivity } = require('../services/activityService');
const { resolveTier, TIER_1, TIER_2 } = require('../config/tiers');
const { emitToBoard } = require('../services/socketService');

// Mirror of the references gate — Tier 1/2 always, otherwise the user must
// be linked to the task (assignee, creator, or in task_assignees).
async function canEditTaskLinks(user, task) {
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

// Strict URL validation: require an http(s) scheme + a host. We reject
// other schemes (javascript:, data:, file:) so that nothing the user enters
// can be turned into a script-execution surface when rendered as <a href>.
// Render side ALSO sets rel="noopener noreferrer" target="_blank" — defense
// in depth, since a future template author could forget that.
function validateUrl(input) {
  if (!input || typeof input !== 'string') return { ok: false, reason: 'URL is required.' };
  let value = input.trim();
  if (!value) return { ok: false, reason: 'URL is required.' };
  if (value.length > 2048) return { ok: false, reason: 'URL must be 2048 characters or fewer.' };
  // Auto-prefix http:// when the user pastes a bare host like "drive.google.com/x".
  // We do this BEFORE the URL constructor so it doesn't throw on schemeless input.
  if (!/^https?:\/\//i.test(value)) {
    value = `https://${value}`;
  }
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { ok: false, reason: 'Only http(s) URLs are allowed.' };
    }
    if (!parsed.hostname) return { ok: false, reason: 'URL must include a host.' };
    return { ok: true, url: parsed.toString() };
  } catch {
    return { ok: false, reason: 'Invalid URL.' };
  }
}

exports.listLinks = async (req, res) => {
  try {
    const { taskId } = req.params;
    const task = await Task.findByPk(taskId);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
    const links = await TaskLink.findAll({
      where: { taskId },
      order: [['position', 'ASC'], ['createdAt', 'ASC']],
    });
    return res.json({ success: true, data: { links } });
  } catch (err) {
    console.error('[TaskLink] list error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch links.' });
  }
};

exports.createLink = async (req, res) => {
  try {
    const { taskId } = req.body;
    if (!taskId) return res.status(400).json({ success: false, message: 'taskId is required.' });

    const urlCheck = validateUrl(req.body.url);
    if (!urlCheck.ok) return res.status(400).json({ success: false, message: urlCheck.reason });

    // Title is optional. Sanitize even though we'll render as text, in case
    // a future change tries to use it inside an attribute.
    const rawTitle = (req.body.title || '').toString();
    const title = rawTitle ? xss(rawTitle).trim().slice(0, 200) : null;

    const task = await Task.findByPk(taskId);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
    if (!(await canEditTaskLinks(req.user, task))) {
      return res.status(403).json({ success: false, message: 'You do not have permission to edit links on this task.' });
    }

    const maxPos = await TaskLink.max('position', { where: { taskId } });
    const position = (Number.isFinite(maxPos) ? maxPos : -1) + 1;

    const link = await TaskLink.create({
      taskId, url: urlCheck.url, title, position, createdBy: req.user.id,
    });

    logActivity({
      action: 'link_added',
      description: `Added link: ${(title || urlCheck.url).slice(0, 80)}`,
      entityType: 'task', entityId: taskId, taskId, boardId: task.boardId, userId: req.user.id,
    });
    try { emitToBoard(task.boardId, 'task:links_updated', { taskId }); } catch {}

    return res.status(201).json({ success: true, data: { link } });
  } catch (err) {
    console.error('[TaskLink] create error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create link.' });
  }
};

exports.updateLink = async (req, res) => {
  try {
    const link = await TaskLink.findByPk(req.params.id);
    if (!link) return res.status(404).json({ success: false, message: 'Link not found.' });
    const task = await Task.findByPk(link.taskId);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
    if (!(await canEditTaskLinks(req.user, task))) {
      return res.status(403).json({ success: false, message: 'You do not have permission to edit links on this task.' });
    }

    const updates = {};
    if (req.body.url !== undefined) {
      const urlCheck = validateUrl(req.body.url);
      if (!urlCheck.ok) return res.status(400).json({ success: false, message: urlCheck.reason });
      updates.url = urlCheck.url;
    }
    if (req.body.title !== undefined) {
      const rawTitle = (req.body.title || '').toString();
      updates.title = rawTitle ? xss(rawTitle).trim().slice(0, 200) : null;
    }
    await link.update(updates);

    try { emitToBoard(task.boardId, 'task:links_updated', { taskId: task.id }); } catch {}

    return res.json({ success: true, data: { link } });
  } catch (err) {
    console.error('[TaskLink] update error:', err);
    return res.status(500).json({ success: false, message: 'Failed to update link.' });
  }
};

exports.deleteLink = async (req, res) => {
  try {
    const link = await TaskLink.findByPk(req.params.id);
    if (!link) return res.status(404).json({ success: false, message: 'Link not found.' });
    const task = await Task.findByPk(link.taskId);
    if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
    if (!(await canEditTaskLinks(req.user, task))) {
      return res.status(403).json({ success: false, message: 'You do not have permission to edit links on this task.' });
    }
    const url = link.url;
    await link.destroy();

    logActivity({
      action: 'link_removed',
      description: `Removed link: ${(url || '').slice(0, 80)}`,
      entityType: 'task', entityId: task.id, taskId: task.id, boardId: task.boardId, userId: req.user.id,
    });
    try { emitToBoard(task.boardId, 'task:links_updated', { taskId: task.id }); } catch {}

    return res.json({ success: true, message: 'Link removed.' });
  } catch (err) {
    console.error('[TaskLink] delete error:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete link.' });
  }
};
