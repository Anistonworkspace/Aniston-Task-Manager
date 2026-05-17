'use strict';

/**
 * Doc Comment Controller — Doc Editor Phase F
 *
 * Notion / Google-Docs-style threaded comments anchored to a snapshot of
 * the selected text inside a doc body.
 *
 *   GET    /api/docs/:id/comments                          → list nested threads
 *   POST   /api/docs/:id/comments                          → create (top-level or reply)
 *   PATCH  /api/docs/:id/comments/:commentId               → edit body (author only)
 *   DELETE /api/docs/:id/comments/:commentId               → soft or hard delete
 *   POST   /api/docs/:id/comments/:commentId/resolve       → mark resolved
 *   POST   /api/docs/:id/comments/:commentId/unresolve     → reopen
 *
 * RBAC:
 *   - Read: anyone who can see the workspace (canCallerSeeWorkspace).
 *   - Create / resolve / unresolve: same — any workspace member.
 *   - Edit: author only (super-admin override).
 *   - Delete: author or super-admin. Comments with replies are soft-
 *     deleted (body rewritten to "[deleted]") so the thread structure
 *     survives.
 *
 * No notifications are fired in v1 — keeping scope tight. A future slice
 * can layer @-mentions inside the comment body and reuse the existing
 * doc_mention notification path.
 */

const { Doc, DocComment, User, Workspace } = require('../models');
const safeLogger = require('../utils/safeLogger');
const { logActivity } = require('../services/activityService');

let xssFn;
try { xssFn = require('xss'); } catch { xssFn = (s) => s; }

// Socket fan-out (Phase F polish v2): on every successful mutation we
// broadcast `doc:comments:changed` to the doc's workspace members so any
// peer who has the doc open refreshes its inline comment-mark highlights
// live. Lazy-loaded same as notificationService so model-only unit tests
// don't pull a real socket.io instance into the test environment.
let socketService;
try { socketService = require('../services/socketService'); } catch { socketService = null; }

/**
 * Fan-out helper — best-effort, fire-and-forget. Loads the doc's
 * workspace member set (creator + explicit members) and emits the event
 * to each. Errors are swallowed so a transient socket / DB hiccup never
 * causes a comment mutation to roll back from the caller's perspective.
 */
async function broadcastCommentsChanged(docId) {
  if (!socketService || typeof socketService.emitToUsers !== 'function') return;
  try {
    const doc = await Doc.findByPk(docId, { attributes: ['id', 'workspaceId'] });
    if (!doc?.workspaceId) return;
    const ws = await Workspace.findByPk(doc.workspaceId, {
      include: [{ model: User, as: 'workspaceMembers', attributes: ['id'], required: false }],
    });
    if (!ws) return;
    const userIds = new Set();
    if (ws.createdBy) userIds.add(ws.createdBy);
    for (const m of (ws.workspaceMembers || [])) {
      if (m?.id) userIds.add(m.id);
    }
    if (userIds.size === 0) return;
    socketService.emitToUsers(
      'doc:comments:changed',
      { docId },
      Array.from(userIds),
    );
  } catch (err) {
    safeLogger.warn('[docComment] broadcastCommentsChanged failed', { err, docId });
  }
}

// Notification fan-out is loaded lazily, mirroring the docController.js
// pattern, so tests that mock the models without stubbing the notification
// service still load this controller cleanly.
let docCommentNotificationService;
try {
  docCommentNotificationService = require('../services/docCommentNotificationService');
} catch (err) {
  docCommentNotificationService = null;
}

const AUTHOR_ATTRS = ['id', 'name', 'email', 'avatar'];
const MAX_BODY_LEN = 4000;
const MAX_ANCHOR_LEN = 2000;
const DELETED_MARKER = '[deleted]';

// ─── helpers ───────────────────────────────────────────────────────────

/**
 * Workspace-membership check — copied (in spirit) from docController. We
 * intentionally re-implement instead of importing the private helper so a
 * future change in docController.canCallerSeeWorkspace doesn't silently
 * widen / narrow comment access in surprising ways.
 */
async function canCallerSeeWorkspace(user, workspaceId) {
  if (!workspaceId) return false;
  if (user?.isSuperAdmin) return true;
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

async function loadDocAndAuthorize(req, res) {
  const { id } = req.params;
  const doc = await Doc.findByPk(id);
  if (!doc) {
    res.status(404).json({ success: false, message: 'Doc not found.' });
    return null;
  }
  const allowed = await canCallerSeeWorkspace(req.user, doc.workspaceId);
  if (!allowed) {
    res.status(403).json({ success: false, message: 'You do not have access to this doc.' });
    return null;
  }
  return doc;
}

function sanitizeBody(input) {
  if (typeof input !== 'string') return null;
  const cleaned = xssFn(input).trim();
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_BODY_LEN);
}

function sanitizeAnchorText(input) {
  if (typeof input !== 'string') return null;
  const cleaned = xssFn(input);
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_ANCHOR_LEN);
}

function toPositiveIntOrNull(v) {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function serializeComment(row) {
  if (!row) return null;
  const json = row.toJSON ? row.toJSON() : row;
  // Don't ship the resolver association unless it's relevant.
  return json;
}

/**
 * Group a flat comment list into nested threads.
 *
 *   [top1, top2, reply1OfTop1, reply2OfTop1, reply1OfTop2]
 *
 * becomes
 *
 *   [
 *     { ...top1, replies: [reply1OfTop1, reply2OfTop1] },
 *     { ...top2, replies: [reply1OfTop2] },
 *   ]
 *
 * Replies inside a thread are sorted by createdAt ASC (oldest first —
 * the natural reading order). Top-level threads keep the caller-supplied
 * order (we sort by createdAt DESC in the query — newest first).
 */
function nestThreads(rows) {
  const tops = [];
  const replyMap = new Map(); // parentId → [replies]
  for (const row of rows) {
    const c = serializeComment(row);
    if (c.parentId) {
      if (!replyMap.has(c.parentId)) replyMap.set(c.parentId, []);
      replyMap.get(c.parentId).push(c);
    } else {
      tops.push(c);
    }
  }
  for (const top of tops) {
    const replies = replyMap.get(top.id) || [];
    replies.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    top.replies = replies;
  }
  return tops;
}

// ─── endpoints ─────────────────────────────────────────────────────────

async function listComments(req, res) {
  try {
    const doc = await loadDocAndAuthorize(req, res);
    if (!doc) return undefined;

    const rows = await DocComment.findAll({
      where: { docId: doc.id },
      include: [
        { model: User, as: 'author', attributes: AUTHOR_ATTRS },
        { model: User, as: 'resolver', attributes: AUTHOR_ATTRS, required: false },
      ],
      // Top-level threads newest-first; replies are sorted ASC inside
      // nestThreads. Doing both sorts in JS keeps the SQL simple.
      order: [['createdAt', 'DESC']],
      limit: 500,
    });

    const threads = nestThreads(rows);
    return res.json({ success: true, data: { threads } });
  } catch (err) {
    safeLogger.error('[DocComment] listComments error', { err });
    return res.status(500).json({ success: false, message: 'Failed to load comments.' });
  }
}

async function createComment(req, res) {
  try {
    const doc = await loadDocAndAuthorize(req, res);
    if (!doc) return undefined;

    const body = sanitizeBody(req.body?.body);
    if (!body) {
      return res.status(400).json({ success: false, message: 'body is required.' });
    }
    const anchorText = sanitizeAnchorText(req.body?.anchorText);
    if (anchorText === null) {
      return res.status(400).json({ success: false, message: 'anchorText is required.' });
    }
    const anchorFrom = toPositiveIntOrNull(req.body?.anchorFrom);
    const anchorTo = toPositiveIntOrNull(req.body?.anchorTo);
    const parentIdRaw = req.body?.parentId;
    let parentId = null;
    // Keep the parent row around so we can pass it into the notification
    // helper without paying for a second findByPk.
    let parentRow = null;
    if (parentIdRaw) {
      // Validate the parent: must exist on the same doc and itself be a
      // top-level comment (no nested replies — flat threads only).
      const parent = await DocComment.findByPk(parentIdRaw);
      if (!parent || parent.docId !== doc.id) {
        return res.status(400).json({ success: false, message: 'parentId is invalid.' });
      }
      if (parent.parentId) {
        return res.status(400).json({ success: false, message: 'Replies cannot have replies.' });
      }
      parentId = parent.id;
      parentRow = parent;
    }

    const created = await DocComment.create({
      docId: doc.id,
      parentId,
      authorId: req.user.id,
      body,
      anchorText,
      anchorFrom,
      anchorTo,
      resolved: false,
    });

    logActivity({
      action: parentId ? 'replied' : 'commented',
      description: parentId
        ? `Replied to a comment on doc: ${doc.title}`
        : `Commented on doc: ${doc.title}`,
      entityType: 'doc',
      entityId: doc.id,
      userId: req.user.id,
    });

    // Fire-and-forget notification fan-out — mirrors docController's
    // syncDocMentionsAndNotify pattern so a queue/db blip can't fail the
    // POST. We pass the workspace row through when we already have it
    // (avoids a second query inside the helper for the mention resolver).
    if (docCommentNotificationService?.syncCommentNotifications) {
      // Pull workspace with members so the mention resolver can stay
      // scoped to workspace participants. Best-effort — failure here is
      // logged but never bubbled.
      Workspace.findByPk(doc.workspaceId, {
        include: [
          { model: User, as: 'workspaceMembers', attributes: ['id'], required: false },
        ],
      })
        .then((workspace) => docCommentNotificationService.syncCommentNotifications({
          comment: created,
          doc,
          authorName: req.user?.name,
          workspace,
          parent: parentRow,
        }))
        .catch((err) => {
          safeLogger.warn('[DocComment] notification fan-out failed (non-fatal)', {
            commentId: created.id, docId: doc.id, err,
          });
        });
    }

    const reloaded = await DocComment.findByPk(created.id, {
      include: [
        { model: User, as: 'author', attributes: AUTHOR_ATTRS },
      ],
    });
    broadcastCommentsChanged(doc.id);
    return res.status(201).json({ success: true, data: { comment: serializeComment(reloaded) } });
  } catch (err) {
    safeLogger.error('[DocComment] createComment error', { err });
    return res.status(500).json({ success: false, message: 'Failed to create comment.' });
  }
}

async function updateComment(req, res) {
  try {
    const doc = await loadDocAndAuthorize(req, res);
    if (!doc) return undefined;

    const { commentId } = req.params;
    const comment = await DocComment.findByPk(commentId);
    if (!comment || comment.docId !== doc.id) {
      return res.status(404).json({ success: false, message: 'Comment not found.' });
    }
    // Edit is restricted to the author. Super-admin override mirrors the
    // pattern in other doc controllers.
    if (!req.user.isSuperAdmin && comment.authorId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Only the comment author can edit it.' });
    }

    const body = sanitizeBody(req.body?.body);
    if (!body) {
      return res.status(400).json({ success: false, message: 'body is required.' });
    }

    await comment.update({ body });

    const reloaded = await DocComment.findByPk(comment.id, {
      include: [
        { model: User, as: 'author', attributes: AUTHOR_ATTRS },
        { model: User, as: 'resolver', attributes: AUTHOR_ATTRS, required: false },
      ],
    });
    broadcastCommentsChanged(doc.id);
    return res.json({ success: true, data: { comment: serializeComment(reloaded) } });
  } catch (err) {
    safeLogger.error('[DocComment] updateComment error', { err });
    return res.status(500).json({ success: false, message: 'Failed to update comment.' });
  }
}

async function deleteComment(req, res) {
  try {
    const doc = await loadDocAndAuthorize(req, res);
    if (!doc) return undefined;

    const { commentId } = req.params;
    const comment = await DocComment.findByPk(commentId);
    if (!comment || comment.docId !== doc.id) {
      return res.status(404).json({ success: false, message: 'Comment not found.' });
    }
    if (!req.user.isSuperAdmin && comment.authorId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Only the comment author can delete it.' });
    }

    // If the comment is a top-level thread WITH replies, soft-delete it
    // so the children's `parentId` stays valid. Otherwise (childless or
    // already a reply) we hard-delete.
    let mode = 'hard';
    if (!comment.parentId) {
      const replyCount = await DocComment.count({ where: { parentId: comment.id } });
      if (replyCount > 0) mode = 'soft';
    }

    if (mode === 'soft') {
      await comment.update({ body: DELETED_MARKER });
    } else {
      await comment.destroy();
    }

    logActivity({
      action: 'deleted',
      description: `Deleted comment on doc: ${doc.title}`,
      entityType: 'doc',
      entityId: doc.id,
      userId: req.user.id,
    });

    broadcastCommentsChanged(doc.id);
    return res.json({ success: true, data: { mode, commentId: comment.id } });
  } catch (err) {
    safeLogger.error('[DocComment] deleteComment error', { err });
    return res.status(500).json({ success: false, message: 'Failed to delete comment.' });
  }
}

async function resolveComment(req, res) {
  try {
    const doc = await loadDocAndAuthorize(req, res);
    if (!doc) return undefined;

    const { commentId } = req.params;
    const comment = await DocComment.findByPk(commentId);
    if (!comment || comment.docId !== doc.id) {
      return res.status(404).json({ success: false, message: 'Comment not found.' });
    }

    if (!comment.resolved) {
      await comment.update({
        resolved: true,
        resolvedAt: new Date(),
        resolvedBy: req.user.id,
      });
    }

    const reloaded = await DocComment.findByPk(comment.id, {
      include: [
        { model: User, as: 'author', attributes: AUTHOR_ATTRS },
        { model: User, as: 'resolver', attributes: AUTHOR_ATTRS, required: false },
      ],
    });
    broadcastCommentsChanged(doc.id);
    return res.json({ success: true, data: { comment: serializeComment(reloaded) } });
  } catch (err) {
    safeLogger.error('[DocComment] resolveComment error', { err });
    return res.status(500).json({ success: false, message: 'Failed to resolve comment.' });
  }
}

async function unresolveComment(req, res) {
  try {
    const doc = await loadDocAndAuthorize(req, res);
    if (!doc) return undefined;

    const { commentId } = req.params;
    const comment = await DocComment.findByPk(commentId);
    if (!comment || comment.docId !== doc.id) {
      return res.status(404).json({ success: false, message: 'Comment not found.' });
    }

    if (comment.resolved) {
      await comment.update({
        resolved: false,
        resolvedAt: null,
        resolvedBy: null,
      });
    }

    const reloaded = await DocComment.findByPk(comment.id, {
      include: [
        { model: User, as: 'author', attributes: AUTHOR_ATTRS },
        { model: User, as: 'resolver', attributes: AUTHOR_ATTRS, required: false },
      ],
    });
    broadcastCommentsChanged(doc.id);
    return res.json({ success: true, data: { comment: serializeComment(reloaded) } });
  } catch (err) {
    safeLogger.error('[DocComment] unresolveComment error', { err });
    return res.status(500).json({ success: false, message: 'Failed to unresolve comment.' });
  }
}

module.exports = {
  listComments,
  createComment,
  updateComment,
  deleteComment,
  resolveComment,
  unresolveComment,
  // Exposed for unit tests
  __nestThreads: nestThreads,
  __sanitizeBody: sanitizeBody,
};
