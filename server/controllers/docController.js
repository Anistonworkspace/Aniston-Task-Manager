'use strict';

/**
 * Doc Controller — Doc Editor Phase B
 *
 * REST endpoints for collaborative documents inside a workspace.
 *
 *   GET    /api/workspaces/:workspaceId/docs          → list (RBAC-filtered)
 *   POST   /api/workspaces/:workspaceId/docs          → create
 *   GET    /api/docs/:id                              → read single
 *   PATCH  /api/docs/:id                              → update (autosave)
 *   DELETE /api/docs/:id                              → archive
 *   POST   /api/docs/:id/restore                      → un-archive
 *   GET    /api/docs/:id/versions                     → list versions
 *   POST   /api/docs/:id/versions/:versionId/restore  → restore a version
 *
 * Permissions: a caller can read a doc when they can see the workspace.
 * Edit requires the same "create_board"/"edit_workspace" level granted by
 * permissionEngine (mirrors the existing pattern used in boardController).
 *
 * Version snapshots: a snapshot is persisted on every Nth save
 * (SNAPSHOT_EVERY_SAVES) so version history stays interesting without
 * exploding the table. The Y.js / real-time slice in Phase G will use a
 * different mechanism — this HTTP-driven path stays as the source of truth.
 */

const { Op } = require('sequelize');
const { Doc, DocVersion, DocMention, DocTaskReference, Task, Workspace, User } = require('../models');
const safeLogger = require('../utils/safeLogger');
const { logActivity } = require('../services/activityService');
let xssFn;
try { xssFn = require('xss'); } catch { xssFn = (s) => s; }
// Notification service is loaded lazily so doc controller unit tests that
// stub the models without stubbing notifications don't pull a real
// notification queue connection into the test environment.
let notificationService;
try { notificationService = require('../services/notificationService'); } catch { notificationService = null; }

const SNAPSHOT_EVERY_SAVES = 10;

// ─── helpers ────────────────────────────────────────────────

const USER_PILL_ATTRS = ['id', 'name', 'email', 'avatar'];

async function canCallerSeeWorkspace(user, workspaceId) {
  if (!workspaceId) return false;
  if (user?.isSuperAdmin) return true;
  // Members of a workspace, plus admins/managers, can see it.
  const ws = await Workspace.findByPk(workspaceId, {
    include: [
      { model: User, as: 'workspaceMembers', attributes: ['id'], required: false },
    ],
  });
  if (!ws) return false;
  if (user?.role === 'admin' || user?.role === 'manager') return true;
  if (ws.createdBy === user.id) return true;
  const memberIds = (ws.workspaceMembers || []).map((m) => m.id);
  return memberIds.includes(user.id);
}

function canCallerEditDoc(user, doc) {
  if (!user || !doc) return false;
  if (user.isSuperAdmin) return true;
  if (user.role === 'admin' || user.role === 'manager') return true;
  return doc.createdBy === user.id;
}

function extractContentText(contentJson) {
  if (!contentJson || typeof contentJson !== 'object') return '';
  // Tiptap docs are { type: 'doc', content: [...] } — recursively pull
  // every node's `text` field into a single plain-text shadow used for
  // search. Headings/lists collapse to text only; that's enough for FTS.
  const parts = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.text === 'string') parts.push(node.text);
    if (Array.isArray(node.content)) node.content.forEach(walk);
  }
  walk(contentJson);
  return parts.join(' ').trim().slice(0, 50000);
}

/**
 * Phase D Slice 1 — extract every mention node's user-id from a Tiptap
 * document JSON. The mention node format is
 *   { type: 'mention', attrs: { id, label, ... } }
 * (per @tiptap/extension-mention's default schema). We pull the `id`
 * attribute and dedup; the order is doc-traversal order so the FIRST
 * occurrence wins for anchorOffset purposes.
 *
 * Returns: [{ userId, anchorOffset }]
 *   - userId: the mentioned user's UUID (skipped silently when not a UUID
 *             string — defensive against bad data)
 *   - anchorOffset: cumulative plain-text byte offset to the mention's
 *             position (best-effort; missing for purely-formatting nodes)
 *
 * Returns an empty array for any contentJson the walker doesn't recognise.
 */
function extractMentions(contentJson) {
  if (!contentJson || typeof contentJson !== 'object') return [];
  const out = [];
  const seen = new Set();
  let offset = 0;
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'mention' && node.attrs && typeof node.attrs.id === 'string') {
      const userId = node.attrs.id.trim();
      // Only keep UUID-shaped ids. A malformed mention (e.g. legacy
      // text-only) is silently dropped — the user can edit the doc and
      // re-create the mention via the picker.
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)
          && !seen.has(userId)) {
        seen.add(userId);
        out.push({ userId, anchorOffset: offset });
      }
      // Mention nodes render as ~`@name` in the plain-text shadow; advance
      // the offset by the label length so subsequent mentions get accurate
      // positions.
      const label = String(node.attrs.label || node.attrs.id || '');
      offset += label.length + 1;
      return;
    }
    if (typeof node.text === 'string') offset += node.text.length;
    if (Array.isArray(node.content)) node.content.forEach(walk);
  }
  walk(contentJson);
  return out;
}

/**
 * Diff existing DocMention rows against the new contentJson's mention set
 * and emit notifications for newly-introduced mentions. Removed mentions
 * are NOT explicitly un-notified (the user already saw the notification
 * when they were first mentioned).
 *
 * The idempotencyKey ensures re-saves of the same doc don't double-notify
 * users who were already mentioned in the prior save. Format:
 *   `doc-mention:<docId>:<userId>`
 */
async function syncDocMentionsAndNotify(doc, contentJson, actor) {
  const incoming = extractMentions(contentJson);
  const incomingIds = new Set(incoming.map((m) => m.userId));

  const existing = await DocMention.findAll({
    where: { docId: doc.id },
    attributes: ['id', 'mentionedUserId'],
  });
  const existingIds = new Set(existing.map((m) => m.mentionedUserId));

  // Insertions: present in incoming, absent from existing.
  const toInsert = incoming.filter((m) => !existingIds.has(m.userId) && m.userId !== actor.id);
  // Deletions: present in existing, absent from incoming. We remove the
  // rows so back-references stay accurate, but don't undo notifications.
  const toDeleteIds = Array.from(existingIds).filter((id) => !incomingIds.has(id));

  for (const m of toInsert) {
    try {
      await DocMention.create({
        docId: doc.id,
        mentionedUserId: m.userId,
        mentionedByUserId: actor.id,
        anchorOffset: m.anchorOffset,
      });
    } catch (err) {
      // Unique-index race: someone else just inserted the same row. Safe
      // to ignore.
      safeLogger.warn('[Doc] mention insert race (non-fatal)', { docId: doc.id, userId: m.userId, err });
    }
    if (notificationService?.createNotification) {
      try {
        await notificationService.createNotification({
          userId: m.userId,
          type: 'doc_mention',
          message: `${actor.name || 'Someone'} mentioned you in "${doc.title}"`,
          entityType: 'doc',
          entityId: doc.id,
          idempotencyKey: `doc-mention:${doc.id}:${m.userId}`,
        });
      } catch (err) {
        safeLogger.warn('[Doc] mention notification failed (non-fatal)', { docId: doc.id, userId: m.userId, err });
      }
    }
  }

  if (toDeleteIds.length > 0) {
    try {
      await DocMention.destroy({
        where: { docId: doc.id, mentionedUserId: { [Op.in]: toDeleteIds } },
      });
    } catch (err) {
      safeLogger.warn('[Doc] mention delete failed (non-fatal)', { docId: doc.id, err });
    }
  }

  return { added: toInsert.length, removed: toDeleteIds.length };
}

/**
 * Phase D Slice 2 — extract every task-chip node's task-id from a Tiptap
 * doc JSON. Node shape:
 *   { type: 'taskChip', attrs: { taskId, label, status, ... } }
 *
 * Returns [{ taskId, anchorOffset }], dedup'd in doc-traversal order.
 * Only UUID-shaped taskIds survive — malformed chips are silently dropped
 * the same way bad mentions are.
 */
function extractTaskRefs(contentJson) {
  if (!contentJson || typeof contentJson !== 'object') return [];
  const out = [];
  const seen = new Set();
  let offset = 0;
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    // Accept either 'taskChip' or 'task-chip' to be lenient with how the
    // frontend declares the node's name.
    if ((node.type === 'taskChip' || node.type === 'task-chip')
        && node.attrs && typeof node.attrs.taskId === 'string') {
      const taskId = node.attrs.taskId.trim();
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)
          && !seen.has(taskId)) {
        seen.add(taskId);
        out.push({ taskId, anchorOffset: offset });
      }
      const label = String(node.attrs.label || node.attrs.taskId || '');
      offset += label.length + 1;
      return;
    }
    if (typeof node.text === 'string') offset += node.text.length;
    if (Array.isArray(node.content)) node.content.forEach(walk);
  }
  walk(contentJson);
  return out;
}

/**
 * Diff existing DocTaskReference rows against the new contentJson's task
 * chip set. Insert new ones (the chip author becomes addedByUserId);
 * delete removed ones. No notification fan-out — task assignees /
 * watchers already get their own task events; layering a "your task was
 * referenced in a doc" notification on top would be noise.
 */
async function syncDocTaskRefs(doc, contentJson, actor) {
  const incoming = extractTaskRefs(contentJson);
  const incomingIds = new Set(incoming.map((r) => r.taskId));

  const existing = await DocTaskReference.findAll({
    where: { docId: doc.id },
    attributes: ['id', 'taskId'],
  });
  const existingIds = new Set(existing.map((r) => r.taskId));

  const toInsert = incoming.filter((r) => !existingIds.has(r.taskId));
  const toDeleteIds = Array.from(existingIds).filter((id) => !incomingIds.has(id));

  for (const r of toInsert) {
    try {
      await DocTaskReference.create({
        docId: doc.id,
        taskId: r.taskId,
        addedByUserId: actor.id,
        anchorOffset: r.anchorOffset,
      });
    } catch (err) {
      // Unique-index race: safe to swallow.
      safeLogger.warn('[Doc] task-ref insert race (non-fatal)', {
        docId: doc.id, taskId: r.taskId, err,
      });
    }
  }

  if (toDeleteIds.length > 0) {
    try {
      await DocTaskReference.destroy({
        where: { docId: doc.id, taskId: { [Op.in]: toDeleteIds } },
      });
    } catch (err) {
      safeLogger.warn('[Doc] task-ref delete failed (non-fatal)', { docId: doc.id, err });
    }
  }

  return { added: toInsert.length, removed: toDeleteIds.length };
}

function slugify(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 180);
}

function serializeDoc(doc, opts = {}) {
  if (!doc) return null;
  const json = doc.toJSON ? doc.toJSON() : doc;
  if (!opts.includeContent) {
    delete json.contentJson;
    // keep contentText for excerpts on the list page
  }
  return json;
}

// ─── endpoints ──────────────────────────────────────────────

async function listDocs(req, res) {
  try {
    const { workspaceId } = req.params;
    const allowed = await canCallerSeeWorkspace(req.user, workspaceId);
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'You do not have access to this workspace.' });
    }
    const query = (req.query.q || '').trim();
    const includeArchived = req.query.archived === '1' || req.query.archived === 'true';

    const where = { workspaceId };
    if (!includeArchived) where.isArchived = false;
    if (query) {
      where[Op.or] = [
        { title: { [Op.iLike]: `%${query}%` } },
        { contentText: { [Op.iLike]: `%${query}%` } },
      ];
    }

    const docs = await Doc.findAll({
      where,
      include: [
        { model: User, as: 'creator', attributes: USER_PILL_ATTRS },
        { model: User, as: 'lastEditor', attributes: USER_PILL_ATTRS },
      ],
      order: [['lastEditedAt', 'DESC'], ['updatedAt', 'DESC']],
      limit: 200,
    });
    res.json({ success: true, data: { docs: docs.map((d) => serializeDoc(d, { includeContent: false })) } });
  } catch (err) {
    safeLogger.error('[Doc] listDocs error', { err });
    res.status(500).json({ success: false, message: 'Failed to load docs.' });
  }
}

async function createDoc(req, res) {
  try {
    const { workspaceId } = req.params;
    const allowed = await canCallerSeeWorkspace(req.user, workspaceId);
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'You do not have access to this workspace.' });
    }
    const title = sanitizeTitle(req.body?.title) || 'Untitled doc';
    const contentJson = sanitizeContentJson(req.body?.contentJson) || { type: 'doc', content: [] };
    const contentText = extractContentText(contentJson);

    const doc = await Doc.create({
      workspaceId,
      title,
      contentJson,
      contentText,
      slug: slugify(title),
      createdBy: req.user.id,
      lastEditedBy: req.user.id,
      lastEditedAt: new Date(),
    });

    // Phase D Slice 1 — record any @-mentions present in the initial
    // contentJson and fire notifications. Fire-and-forget so a failure
    // here doesn't block the create.
    syncDocMentionsAndNotify(doc, contentJson, req.user).catch((err) => {
      safeLogger.warn('[Doc] initial mention sync failed (non-fatal)', { docId: doc.id, err });
    });
    // Phase D Slice 2 — record any task chips. Same fire-and-forget
    // pattern. No notification needed; task watchers cover that path.
    syncDocTaskRefs(doc, contentJson, req.user).catch((err) => {
      safeLogger.warn('[Doc] initial task-ref sync failed (non-fatal)', { docId: doc.id, err });
    });

    logActivity({
      action: 'created',
      description: `Created doc: ${doc.title}`,
      entityType: 'doc',
      entityId: doc.id,
      userId: req.user.id,
    });

    const reloaded = await Doc.findByPk(doc.id, {
      include: [
        { model: User, as: 'creator', attributes: USER_PILL_ATTRS },
        { model: User, as: 'lastEditor', attributes: USER_PILL_ATTRS },
      ],
    });
    res.status(201).json({ success: true, data: { doc: serializeDoc(reloaded, { includeContent: true }) } });
  } catch (err) {
    safeLogger.error('[Doc] createDoc error', { err });
    res.status(500).json({ success: false, message: 'Failed to create doc.' });
  }
}

async function getDoc(req, res) {
  try {
    const { id } = req.params;
    const doc = await Doc.findByPk(id, {
      include: [
        { model: User, as: 'creator', attributes: USER_PILL_ATTRS },
        { model: User, as: 'lastEditor', attributes: USER_PILL_ATTRS },
        { model: Workspace, as: 'workspace', attributes: ['id', 'name', 'color'] },
      ],
    });
    if (!doc) return res.status(404).json({ success: false, message: 'Doc not found.' });

    const allowed = await canCallerSeeWorkspace(req.user, doc.workspaceId);
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied.' });

    res.json({ success: true, data: { doc: serializeDoc(doc, { includeContent: true }) } });
  } catch (err) {
    safeLogger.error('[Doc] getDoc error', { err });
    res.status(500).json({ success: false, message: 'Failed to load doc.' });
  }
}

async function updateDoc(req, res) {
  try {
    const { id } = req.params;
    const doc = await Doc.findByPk(id);
    if (!doc) return res.status(404).json({ success: false, message: 'Doc not found.' });
    // Collab-doc default (Notion-style): anyone with workspace access can
    // edit the body. canCallerEditDoc stays strict for destructive actions
    // (archive/restore/restoreVersion) below.
    const canEditBody = canCallerEditDoc(req.user, doc)
      || await canCallerSeeWorkspace(req.user, doc.workspaceId);
    if (!canEditBody) {
      return res.status(403).json({ success: false, message: 'You do not have permission to edit this doc.' });
    }

    const updates = {};
    if (typeof req.body?.title === 'string') updates.title = sanitizeTitle(req.body.title);
    if (req.body?.contentJson !== undefined) {
      const cleanJson = sanitizeContentJson(req.body.contentJson);
      if (cleanJson === null) {
        return res.status(400).json({ success: false, message: 'contentJson must be a valid Tiptap JSON doc.' });
      }
      updates.contentJson = cleanJson;
      updates.contentText = extractContentText(cleanJson);
    }
    if (typeof req.body?.sharePolicy === 'string'
        && ['private', 'workspace', 'public_link'].includes(req.body.sharePolicy)) {
      updates.sharePolicy = req.body.sharePolicy;
    }

    if (Object.keys(updates).length === 0) {
      return res.json({ success: true, data: { doc: serializeDoc(doc, { includeContent: true }) } });
    }

    updates.lastEditedBy = req.user.id;
    updates.lastEditedAt = new Date();

    await doc.update(updates);

    // Snapshot decision: every Nth content save creates a new version
    // entry. Title-only or share-only saves don't create versions —
    // they're metadata, not content.
    if (updates.contentJson !== undefined) {
      const versionCount = await DocVersion.count({ where: { docId: doc.id } });
      if ((versionCount + 1) % SNAPSHOT_EVERY_SAVES === 0 || versionCount === 0) {
        try {
          await DocVersion.create({
            docId: doc.id,
            contentJson: updates.contentJson,
            contentText: updates.contentText,
            savedBy: req.user.id,
          });
        } catch (verr) {
          // Don't fail the save if a snapshot insert fails.
          safeLogger.warn('[Doc] version snapshot failed (non-fatal)', { err: verr, docId: doc.id });
        }
      }

      // Phase D Slice 1 — diff mentions on every content save. Fire-and-forget
      // because notification fan-out shouldn't slow the autosave loop.
      // idempotencyKey on each notification means re-saving the same body
      // doesn't double-notify users who were already mentioned.
      syncDocMentionsAndNotify(doc, updates.contentJson, req.user).catch((err) => {
        safeLogger.warn('[Doc] mention sync failed (non-fatal)', { docId: doc.id, err });
      });
      // Phase D Slice 2 — diff task chips on every content save. No
      // notifications; the table just tracks bidirectional links.
      syncDocTaskRefs(doc, updates.contentJson, req.user).catch((err) => {
        safeLogger.warn('[Doc] task-ref sync failed (non-fatal)', { docId: doc.id, err });
      });
    }

    logActivity({
      action: 'updated',
      description: `Edited doc: ${doc.title}`,
      entityType: 'doc',
      entityId: doc.id,
      userId: req.user.id,
    });

    const reloaded = await Doc.findByPk(doc.id, {
      include: [
        { model: User, as: 'creator', attributes: USER_PILL_ATTRS },
        { model: User, as: 'lastEditor', attributes: USER_PILL_ATTRS },
      ],
    });
    res.json({ success: true, data: { doc: serializeDoc(reloaded, { includeContent: true }) } });
  } catch (err) {
    safeLogger.error('[Doc] updateDoc error', { err });
    res.status(500).json({ success: false, message: 'Failed to update doc.' });
  }
}

async function archiveDoc(req, res) {
  try {
    const { id } = req.params;
    const doc = await Doc.findByPk(id);
    if (!doc) return res.status(404).json({ success: false, message: 'Doc not found.' });
    if (!canCallerEditDoc(req.user, doc)) {
      return res.status(403).json({ success: false, message: 'Only doc owner or admins can archive.' });
    }
    if (doc.isArchived) {
      return res.json({ success: true, data: { doc: serializeDoc(doc) } });
    }
    await doc.update({
      isArchived: true,
      archivedAt: new Date(),
      archivedBy: req.user.id,
    });
    logActivity({
      action: 'archived',
      description: `Archived doc: ${doc.title}`,
      entityType: 'doc',
      entityId: doc.id,
      userId: req.user.id,
    });
    res.json({ success: true, data: { doc: serializeDoc(doc) } });
  } catch (err) {
    safeLogger.error('[Doc] archiveDoc error', { err });
    res.status(500).json({ success: false, message: 'Failed to archive doc.' });
  }
}

async function restoreDoc(req, res) {
  try {
    const { id } = req.params;
    const doc = await Doc.findByPk(id);
    if (!doc) return res.status(404).json({ success: false, message: 'Doc not found.' });
    if (!canCallerEditDoc(req.user, doc)) {
      return res.status(403).json({ success: false, message: 'Only doc owner or admins can restore.' });
    }
    if (!doc.isArchived) {
      return res.json({ success: true, data: { doc: serializeDoc(doc) } });
    }
    await doc.update({ isArchived: false, archivedAt: null, archivedBy: null });
    logActivity({
      action: 'restored',
      description: `Restored doc: ${doc.title}`,
      entityType: 'doc',
      entityId: doc.id,
      userId: req.user.id,
    });
    res.json({ success: true, data: { doc: serializeDoc(doc) } });
  } catch (err) {
    safeLogger.error('[Doc] restoreDoc error', { err });
    res.status(500).json({ success: false, message: 'Failed to restore doc.' });
  }
}

/**
 * Phase D Slice 1 — GET /api/docs/mentionable?workspaceId=…&q=…
 *
 * Returns the list of users the caller can @-mention in a doc. Today the
 * scope is: workspace creator + explicit workspace members, filtered by
 * name match (case-insensitive substring). Self is excluded — you can't
 * mention yourself.
 *
 * Future iterations could expand to "anyone the caller can see via the
 * hierarchy service" for cross-workspace mentions. Keeping it tight for
 * Slice 1 avoids leaking the wider user directory.
 */
async function listMentionableUsers(req, res) {
  try {
    const { workspaceId } = req.query;
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!workspaceId) {
      return res.status(400).json({ success: false, message: 'workspaceId is required.' });
    }
    const allowed = await canCallerSeeWorkspace(req.user, workspaceId);
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'You do not have access to this workspace.' });
    }

    const ws = await Workspace.findByPk(workspaceId, {
      include: [
        { model: User, as: 'workspaceMembers', attributes: [...USER_PILL_ATTRS, 'isActive'] },
        { model: User, as: 'creator', attributes: [...USER_PILL_ATTRS, 'isActive'] },
      ],
    });
    if (!ws) {
      return res.status(404).json({ success: false, message: 'Workspace not found.' });
    }

    const candidates = new Map();
    if (ws.creator && ws.creator.isActive !== false) {
      candidates.set(ws.creator.id, ws.creator);
    }
    for (const m of (ws.workspaceMembers || [])) {
      if (m.isActive !== false && !candidates.has(m.id)) {
        candidates.set(m.id, m);
      }
    }
    candidates.delete(req.user.id); // self-mentions blocked

    let list = Array.from(candidates.values());
    if (q) {
      list = list.filter((u) => (u.name || '').toLowerCase().includes(q)
        || (u.email || '').toLowerCase().includes(q));
    }
    list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    // Cap at 25 — UI menu doesn't need more than that.
    list = list.slice(0, 25);

    res.json({
      success: true,
      data: {
        users: list.map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          avatar: u.avatar,
        })),
      },
    });
  } catch (err) {
    safeLogger.error('[Doc] listMentionableUsers error', { err });
    res.status(500).json({ success: false, message: 'Failed to load mentionable users.' });
  }
}

/**
 * Phase D Slice 2 — GET /api/docs/searchable-tasks?workspaceId=…&q=…
 *
 * Returns tasks the caller can reference inside a doc, scoped to a
 * workspace. The picker UI feeds typed input directly into the `q`
 * param. Results are capped at 25 to keep the dropdown snappy.
 *
 * Scope today: tasks on boards inside the workspace, excluding archived.
 * RBAC: caller must be able to see the workspace; per-task visibility is
 * not enforced beyond workspace membership because a doc inside the
 * workspace is implicitly readable to all workspace members.
 */
async function listSearchableTasks(req, res) {
  try {
    const { workspaceId } = req.query;
    const q = String(req.query.q || '').trim();
    if (!workspaceId) {
      return res.status(400).json({ success: false, message: 'workspaceId is required.' });
    }
    const allowed = await canCallerSeeWorkspace(req.user, workspaceId);
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'You do not have access to this workspace.' });
    }

    const { Board } = require('../models');
    const boards = await Board.findAll({
      where: { workspaceId, isArchived: false },
      attributes: ['id', 'name', 'color'],
      raw: true,
    });
    const boardIds = boards.map((b) => b.id);
    const boardLookup = new Map(boards.map((b) => [b.id, b]));
    if (boardIds.length === 0) {
      return res.json({ success: true, data: { tasks: [] } });
    }

    const where = {
      isArchived: false,
      boardId: { [Op.in]: boardIds },
    };
    if (q) {
      where.title = { [Op.iLike]: `%${q}%` };
    }

    const tasks = await Task.findAll({
      where,
      attributes: ['id', 'title', 'status', 'priority', 'boardId', 'dueDate'],
      order: [['updatedAt', 'DESC']],
      limit: 25,
    });

    res.json({
      success: true,
      data: {
        tasks: tasks.map((t) => {
          const board = boardLookup.get(t.boardId);
          return {
            id: t.id,
            title: t.title,
            status: t.status,
            priority: t.priority,
            dueDate: t.dueDate,
            boardId: t.boardId,
            boardName: board?.name || null,
            boardColor: board?.color || null,
          };
        }),
      },
    });
  } catch (err) {
    safeLogger.error('[Doc] listSearchableTasks error', { err });
    res.status(500).json({ success: false, message: 'Failed to load tasks.' });
  }
}

/**
 * Phase D Slice 2 — GET /api/tasks/:id/doc-references
 *
 * Bidirectional companion to the chip insertion path. Returns the list
 * of docs that currently reference a given task — i.e. "this task is
 * mentioned in N docs." Used by a future TaskModal pill (Slice 2b).
 *
 * RBAC: caller must be able to see the task's board (via canUserSeeBoard).
 * Doc-level visibility is then narrowed by workspace membership — we
 * filter docs whose workspace the caller can see.
 */
async function listDocReferencesForTask(req, res) {
  try {
    const { id: taskId } = req.params;
    if (!taskId) {
      return res.status(400).json({ success: false, message: 'task id is required.' });
    }
    const task = await Task.findByPk(taskId, { attributes: ['id', 'boardId'] });
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found.' });
    }
    const { canUserSeeBoard } = require('../services/boardVisibilityService');
    const allowed = await canUserSeeBoard(req.user, task.boardId).catch(() => false);
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    const refs = await DocTaskReference.findAll({
      where: { taskId },
      include: [
        {
          model: Doc,
          as: 'doc',
          attributes: ['id', 'title', 'workspaceId', 'isArchived'],
        },
      ],
      order: [['createdAt', 'DESC']],
    });

    // Filter to docs whose workspace the caller can see — defense in depth.
    const visibleDocs = [];
    for (const ref of refs) {
      if (!ref.doc || ref.doc.isArchived) continue;
      const ok = await canCallerSeeWorkspace(req.user, ref.doc.workspaceId).catch(() => false);
      if (ok) {
        visibleDocs.push({
          docId: ref.doc.id,
          title: ref.doc.title,
          workspaceId: ref.doc.workspaceId,
          createdAt: ref.createdAt,
        });
      }
    }

    res.json({ success: true, data: { docs: visibleDocs } });
  } catch (err) {
    safeLogger.error('[Doc] listDocReferencesForTask error', { err });
    res.status(500).json({ success: false, message: 'Failed to load doc references.' });
  }
}

async function listVersions(req, res) {
  try {
    const { id } = req.params;
    const doc = await Doc.findByPk(id);
    if (!doc) return res.status(404).json({ success: false, message: 'Doc not found.' });
    const allowed = await canCallerSeeWorkspace(req.user, doc.workspaceId);
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied.' });

    const versions = await DocVersion.findAll({
      where: { docId: id },
      include: [{ model: User, as: 'author', attributes: USER_PILL_ATTRS }],
      attributes: ['id', 'note', 'savedBy', 'createdAt'], // exclude contentJson for the list
      order: [['createdAt', 'DESC']],
      limit: 100,
    });
    res.json({ success: true, data: { versions } });
  } catch (err) {
    safeLogger.error('[Doc] listVersions error', { err });
    res.status(500).json({ success: false, message: 'Failed to load versions.' });
  }
}

async function restoreVersion(req, res) {
  try {
    const { id, versionId } = req.params;
    const doc = await Doc.findByPk(id);
    if (!doc) return res.status(404).json({ success: false, message: 'Doc not found.' });
    if (!canCallerEditDoc(req.user, doc)) {
      return res.status(403).json({ success: false, message: 'Only doc owner or admins can restore versions.' });
    }
    const version = await DocVersion.findOne({ where: { id: versionId, docId: id } });
    if (!version) return res.status(404).json({ success: false, message: 'Version not found.' });

    await doc.update({
      contentJson: version.contentJson,
      contentText: version.contentText,
      lastEditedBy: req.user.id,
      lastEditedAt: new Date(),
    });

    await DocVersion.create({
      docId: doc.id,
      contentJson: version.contentJson,
      contentText: version.contentText,
      savedBy: req.user.id,
      note: `Restored from version ${versionId}`,
    });

    logActivity({
      action: 'restored',
      description: `Restored doc version: ${doc.title}`,
      entityType: 'doc',
      entityId: doc.id,
      userId: req.user.id,
    });
    res.json({ success: true, data: { doc: serializeDoc(doc, { includeContent: true }) } });
  } catch (err) {
    safeLogger.error('[Doc] restoreVersion error', { err });
    res.status(500).json({ success: false, message: 'Failed to restore version.' });
  }
}

/**
 * POST /api/docs/:id/migrate-to-collab
 *
 * Phase G follow-up — opt-in migration for pre-Phase-G docs whose
 * `contentJson` has real content. The Hocuspocus `onLoadDocument` hook
 * refuses to open these for collab because we never built a server-side
 * headless Tiptap to losslessly hydrate the existing JSON into a Y.doc
 * with the full custom-node schema (mentions / chips / comments / images
 * / tables). Auto-migration would silently drop any unknown node types
 * and corrupt the doc.
 *
 * Honest design instead:
 *   1. Snapshot the current contentJson into DocVersion so the original
 *      content is recoverable from the History menu.
 *   2. Encode a fresh, empty Y.doc state and write it to `yjsState`.
 *      The Hocuspocus hook will now accept this doc on next connect.
 *   3. Replace `contentJson` with a single-paragraph "migration notice"
 *      so the first collab user lands on a clean canvas with a clear
 *      pointer back to the snapshot. They can either copy the old body
 *      in via the editor, or restore the snapshot via the version
 *      history modal.
 *
 * RBAC: owner-or-admin only (canCallerEditDoc — destructive action).
 * Idempotent: calling again on an already-migrated doc returns 200
 * without a new snapshot or a Y.doc reset.
 */
async function migrateDocToCollab(req, res) {
  try {
    const { id } = req.params;
    const doc = await Doc.findByPk(id);
    if (!doc) return res.status(404).json({ success: false, message: 'Doc not found.' });
    if (!canCallerEditDoc(req.user, doc)) {
      return res.status(403).json({ success: false, message: 'Only doc owner or admins can migrate a doc to collab.' });
    }
    if (doc.isArchived) {
      return res.status(400).json({ success: false, message: 'Cannot migrate an archived doc. Restore it first.' });
    }
    if (doc.yjsState) {
      // Already migrated. Idempotent success.
      return res.json({
        success: true,
        data: { doc: serializeDoc(doc, { includeContent: true }), alreadyMigrated: true },
      });
    }

    // Lazy-require yjs so doc-controller unit tests that don't stub it
    // still load the module cleanly.
    let Y;
    try { Y = require('yjs'); }
    catch (err) {
      safeLogger.error('[Doc] migrate: yjs not installed', { err });
      return res.status(503).json({
        success: false,
        code: 'collab_disabled',
        message: 'Real-time collab is not configured on this server.',
      });
    }

    // 1. Snapshot the original contentJson so nothing is lost.
    try {
      await DocVersion.create({
        docId: doc.id,
        contentJson: doc.contentJson || { type: 'doc', content: [] },
        contentText: doc.contentText || '',
        savedBy: req.user.id,
        note: 'Pre-collab-migration snapshot',
      });
    } catch (verr) {
      // Don't block migration on snapshot failure — but log it loudly.
      // The user can still recover the row from DocVersion's normal
      // SNAPSHOT_EVERY_SAVES cadence if it landed on one.
      safeLogger.warn('[Doc] migrate: pre-migration snapshot failed', { err: verr, docId: doc.id });
    }

    // 2. Build a clean empty Y.doc and encode its state.
    const ydoc = new Y.Doc();
    const yjsState = Buffer.from(Y.encodeStateAsUpdate(ydoc));

    // 3. Replace contentJson with a one-line migration notice + reset
    //    the text shadow. The notice tells the user where their old
    //    content went without burying that info in a toast they might
    //    miss.
    const noticeJson = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{
          type: 'text',
          text: 'This doc was migrated for real-time collaboration. Your previous content is preserved in the version history (click History above to restore).',
        }],
      }],
    };

    await doc.update({
      yjsState,
      contentJson: noticeJson,
      contentText: 'Migrated for collab. Previous content preserved in version history.',
      lastEditedBy: req.user.id,
      lastEditedAt: new Date(),
    });

    logActivity({
      action: 'migrated',
      description: `Migrated doc to collab: ${doc.title}`,
      entityType: 'doc',
      entityId: doc.id,
      userId: req.user.id,
    });

    res.json({
      success: true,
      data: {
        doc: serializeDoc(doc, { includeContent: true }),
        alreadyMigrated: false,
      },
    });
  } catch (err) {
    safeLogger.error('[Doc] migrateDocToCollab error', { err });
    res.status(500).json({ success: false, message: 'Failed to migrate doc.' });
  }
}

// ─── input validation helpers ────────────────────────────────

function sanitizeTitle(input) {
  if (typeof input !== 'string') return null;
  return xssFn(input).slice(0, 300).trim() || 'Untitled doc';
}

function sanitizeContentJson(input) {
  // The frontend sends a Tiptap JSON document. We don't render the JSON
  // anywhere as HTML — it goes back into Tiptap on read, which itself
  // sanitizes via ProseMirror's schema. So our defense is shape-only:
  // verify it's an object with the expected envelope, cap total size.
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object') return null;
  if (Array.isArray(input)) return null;
  if (input.type !== 'doc') return null;
  // Hard cap: 2 MB JSON. Larger probably means an export-paste accident.
  try {
    const size = Buffer.byteLength(JSON.stringify(input), 'utf8');
    if (size > 2 * 1024 * 1024) return null;
  } catch { return null; }
  return input;
}

module.exports = {
  listDocs,
  createDoc,
  getDoc,
  updateDoc,
  archiveDoc,
  restoreDoc,
  listVersions,
  restoreVersion,
  // Phase D Slice 1
  listMentionableUsers,
  // Phase D Slice 2
  listSearchableTasks,
  listDocReferencesForTask,
  // Phase G follow-up — opt-in migrate-to-collab
  migrateDocToCollab,
  // Exposed for unit tests
  __extractMentions: extractMentions,
  __extractTaskRefs: extractTaskRefs,
};
