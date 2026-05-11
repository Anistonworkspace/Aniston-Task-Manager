const xss = require('xss');
const { TaskLink, Task, TaskAssignee } = require('../models');
const { logActivity } = require('../services/activityService');
const { resolveTier, TIER_1, TIER_2 } = require('../config/tiers');
const { emitToBoard } = require('../services/socketService');
const taskVisibility = require('../services/taskVisibilityService');
const metrics = require('../services/metricsService');
const logger = require('../utils/logger');

// P1-4 — hostname blocklist. The current UX never fetches these URLs
// server-side, so this isn't actively exploitable today. But if any
// future feature adds preview/metadata fetching (Open Graph thumbnails,
// link expansion, etc.) the same URLs become an SSRF surface — internal
// services on localhost/RFC1918 ranges would suddenly be reachable from
// the server. Reject them now so we never accidentally enable that path.
const BLOCKED_HOSTNAMES = new Set([
  'localhost', '0.0.0.0', '::1', '::',
  '169.254.169.254',           // AWS / Azure / GCP instance metadata
  'metadata.google.internal',  // GCP metadata
]);
function isPrivateIPv4(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
  if (a === 10) return true;                         // 10.0.0.0/8
  if (a === 127) return true;                        // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true;           // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
  if (a === 192 && b === 168) return true;           // 192.168.0.0/16
  if (a === 0) return true;                          // 0.0.0.0/8
  return false;
}
function isPrivateIPv6(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true;  // fc00::/7 ULA
  if (h.startsWith('fe80')) return true;                       // link-local
  return false;
}

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
  // Reject known-unsafe schemes BEFORE auto-prefix. Without this guard,
  // input like `file:///etc/passwd` or `javascript:alert(1)` would be
  // auto-prefixed to `https://file:///etc/passwd`, bypassing the
  // protocol check below entirely. We match any leading `<scheme>:`
  // that isn't http or https.
  const schemeMatch = value.match(/^([a-z][a-z0-9+.\-]*):/i);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      return { ok: false, reason: 'Only http(s) URLs are allowed.' };
    }
  }
  // Auto-prefix https:// when the user pastes a bare host like "drive.google.com/x".
  if (!/^https?:\/\//i.test(value)) {
    value = `https://${value}`;
  }
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { ok: false, reason: 'Only http(s) URLs are allowed.' };
    }
    if (!parsed.hostname) return { ok: false, reason: 'URL must include a host.' };
    // P1-4 — defense-in-depth against future SSRF. Reject any URL whose
    // host resolves textually to a loopback / private / link-local /
    // cloud-metadata address. We do NOT do a DNS lookup here (that's
    // expensive + introduces TOCTOU); textual rejection catches the
    // common cases and the network layer would still need a separate
    // pin if true SSRF protection ever ships.
    const host = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTNAMES.has(host) || isPrivateIPv4(host) || isPrivateIPv6(host)) {
      return { ok: false, reason: 'Internal or private hostnames are not allowed.' };
    }
    return { ok: true, url: parsed.toString() };
  } catch {
    return { ok: false, reason: 'Invalid URL.' };
  }
}

// P0-5 fix: previously this endpoint returned links for ANY task by ID
// without verifying the caller had view access. Now gated through the
// canonical taskVisibilityService.
exports.listLinks = async (req, res) => {
  metrics.increment('links.list.requests');
  try {
    const { taskId } = req.params;
    const task = await Task.findByPk(taskId, { attributes: ['id', 'boardId'] });
    if (!task) { metrics.increment('links.list.not_found'); return res.status(404).json({ success: false, message: 'Task not found.' }); }
    if (!(await taskVisibility.canViewTask(req.user, task))) {
      metrics.increment('links.list.forbidden');
      logger.warn('[links.list] view-access denied', { userId: req.user.id, taskId });
      return res.status(403).json({ success: false, message: 'Forbidden.' });
    }
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
    if (!urlCheck.ok) {
      // Useful abuse-detection signal — a spike of validation failures
      // from one user could indicate a scanner probing the SSRF surface.
      metrics.increment('links.create.url_rejected');
      logger.info('[links.create] URL rejected', { userId: req.user?.id, reason: urlCheck.reason });
      return res.status(400).json({ success: false, message: urlCheck.reason });
    }

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

    // P2-7 — don't echo URL/title content into activity log description.
    logActivity({
      action: 'link_added',
      description: 'Added a link',
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
    await link.destroy();

    // P2-7 — don't echo URL content into activity description.
    logActivity({
      action: 'link_removed',
      description: 'Removed a link',
      entityType: 'task', entityId: task.id, taskId: task.id, boardId: task.boardId, userId: req.user.id,
    });
    try { emitToBoard(task.boardId, 'task:links_updated', { taskId: task.id }); } catch {}

    return res.json({ success: true, message: 'Link removed.' });
  } catch (err) {
    console.error('[TaskLink] delete error:', err);
    return res.status(500).json({ success: false, message: 'Failed to delete link.' });
  }
};
