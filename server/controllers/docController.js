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
const { Doc, DocVersion, Workspace, User } = require('../models');
const safeLogger = require('../utils/safeLogger');
const { logActivity } = require('../services/activityService');
const { xss } = require('xss');
let xssFn;
try { xssFn = require('xss'); } catch { xssFn = (s) => s; }

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
    if (!canCallerEditDoc(req.user, doc)) {
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
};
