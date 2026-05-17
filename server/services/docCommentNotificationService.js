'use strict';

/**
 * Doc Comment Notification Service — Phase F follow-up
 *
 * Centralised fan-out for the notifications produced when a doc comment is
 * created. Three event classes:
 *
 *   1. doc_comment           — someone left a top-level comment on a doc.
 *                              Recipient: the doc creator (unless they are
 *                              the comment author).
 *
 *   2. doc_comment_reply     — someone replied to a comment. Recipients:
 *                              the parent comment's author AND the doc
 *                              creator (each skipped if they would notify
 *                              the reply author themselves, and the doc
 *                              creator skipped again if they are the parent
 *                              author — no double-notify).
 *
 *   3. doc_comment_mention   — `@name` appears in the plain-text body of a
 *                              comment. Resolves to a workspace member by
 *                              case-insensitive name match. Unresolved
 *                              tokens are silently dropped. The comment
 *                              author never notifies themselves.
 *
 * Every notification carries a stable `idempotencyKey` shaped after the
 * existing `doc-mention:<docId>:<userId>` convention so retries (or the
 * same comment being processed twice) dedup at the DB level via the
 * partial unique index on notifications.idempotencyKey.
 *
 * Failure model: this helper is fire-and-forget from the controller. It
 * never throws back to the caller — every per-recipient failure is logged
 * via safeLogger.warn and processing continues for remaining recipients.
 *
 * The notificationService dependency is loaded LAZILY (same pattern as
 * docController.js) so unit tests that don't stub it never pull a real
 * queue connection into the test environment.
 */

const safeLogger = require('../utils/safeLogger');

// Lazy load so test files that mock '../../models' but NOT the
// notification service still load this module cleanly. See docController.js
// for the equivalent pattern.
let notificationService;
try {
  notificationService = require('./notificationService');
} catch (err) {
  notificationService = null;
}

// Lazy User model lookup — same reason. Some controller tests mock the
// models module without exporting User; we tolerate that by treating the
// resolver as "no candidate users" rather than crashing.
let User;
try {
  ({ User } = require('../models'));
} catch (err) {
  User = null;
}

// Sequelize's Op is only used in the LIKE query for the mention resolver;
// guarded require keeps the test surface tiny.
let Op;
try {
  ({ Op } = require('sequelize'));
} catch (err) {
  Op = null;
}

// Match `@username`-style tokens. Allowed chars match what the frontend
// mention picker emits today (alphanumerics + `_`, `.`, `-`). Stops at
// whitespace/punctuation. Capped at 64 chars to bound resolver work.
const MENTION_REGEX = /@([a-zA-Z0-9_.-]{1,64})/g;

// Cap on how many distinct @-mentions per single comment we'll fan out.
// A comment with 50 mentions is almost certainly spam or a paste accident.
const MAX_MENTIONS_PER_COMMENT = 25;

/**
 * Extract a deduped list of mention tokens from a plain-text comment body.
 * Returns the tokens as supplied (case preserved) for resolver debugging;
 * the resolver itself does the case-insensitive match.
 */
function extractMentionTokens(body) {
  if (!body || typeof body !== 'string') return [];
  const seen = new Set();
  const out = [];
  let match;
  // Reset lastIndex defensively — the regex is module-scoped.
  MENTION_REGEX.lastIndex = 0;
  while ((match = MENTION_REGEX.exec(body)) !== null) {
    const token = match[1];
    const key = token.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(token);
      if (out.length >= MAX_MENTIONS_PER_COMMENT) break;
    }
  }
  return out;
}

/**
 * Resolve mention tokens to User rows scoped to the doc's workspace.
 *
 * Strategy: a single bulk query with `LOWER(name) IN (...)` + a fallback
 * `LIKE` for prefix matches when an exact lowercased name doesn't hit. The
 * fallback is intentionally tight (LOWER(name) LIKE 'token%') so a token
 * like `@a` doesn't pull every user whose name starts with `a` — we cap
 * the candidate list at MAX_MENTIONS_PER_COMMENT.
 *
 * Workspace scoping: callers MUST pass the array of workspace member
 * user-ids. We restrict matched users to that set so a mention can never
 * pull a user from outside the doc's workspace.
 *
 * Returns: Map<lowerToken, userRow>. Tokens that don't resolve are simply
 * absent from the map; callers should treat absence as "silent skip".
 */
async function resolveMentionTokensToUsers(tokens, workspaceMemberIds) {
  const map = new Map();
  if (!tokens || tokens.length === 0) return map;
  if (!User || typeof User.findAll !== 'function' || !Op) return map;
  if (!Array.isArray(workspaceMemberIds) || workspaceMemberIds.length === 0) return map;

  const lower = tokens.map((t) => t.toLowerCase());

  try {
    // Pull all candidates for the workspace whose lowercased name either
    // EQUALS a token or starts with one. We do the final dedup/selection
    // in JS to keep the SQL portable across Sequelize dialects.
    const orClauses = [];
    for (const t of lower) {
      orClauses.push({ name: { [Op.iLike]: t } });          // exact (case-insensitive)
      orClauses.push({ name: { [Op.iLike]: `${t}%` } });     // prefix
    }

    const users = await User.findAll({
      where: {
        id: { [Op.in]: workspaceMemberIds },
        isActive: true,
        [Op.or]: orClauses,
      },
      attributes: ['id', 'name', 'email'],
      // Bound the result set — we never need more matches than tokens.
      limit: workspaceMemberIds.length,
    });

    // Pick the best (deterministic) candidate per token:
    //   1. exact case-insensitive name match wins,
    //   2. otherwise the first prefix match in alphabetical order.
    const byLowerName = new Map();      // exact name → user
    const prefixCandidates = new Map(); // first token prefix → user[]
    for (const u of users) {
      const lname = (u.name || '').toLowerCase();
      if (!byLowerName.has(lname)) byLowerName.set(lname, u);
      for (const t of lower) {
        if (lname.startsWith(t)) {
          if (!prefixCandidates.has(t)) prefixCandidates.set(t, []);
          prefixCandidates.get(t).push(u);
        }
      }
    }

    for (let i = 0; i < lower.length; i += 1) {
      const t = lower[i];
      if (byLowerName.has(t)) {
        map.set(t, byLowerName.get(t));
        continue;
      }
      const arr = prefixCandidates.get(t);
      if (arr && arr.length > 0) {
        // Stable pick: alphabetical by name so the same `@al` resolves
        // the same way across repeat saves.
        arr.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        map.set(t, arr[0]);
      }
    }
  } catch (err) {
    safeLogger.warn('[DocCommentNotifications] mention resolver query failed (non-fatal)', { err });
  }

  return map;
}

/**
 * Workspace-member id resolution. Walks the workspace's `workspaceMembers`
 * association if pre-loaded; falls back to a fresh query otherwise. Always
 * includes the workspace creator. Returns a deduped array of user-ids.
 *
 * Doc creator is implicitly included too — the doc author is always
 * eligible to be @-mentioned in a comment on their own doc by another
 * workspace member.
 */
async function loadWorkspaceMemberIds(doc, workspace) {
  const ids = new Set();
  if (doc?.createdBy) ids.add(doc.createdBy);
  if (workspace?.createdBy) ids.add(workspace.createdBy);
  const members = workspace?.workspaceMembers;
  if (Array.isArray(members)) {
    for (const m of members) {
      if (m?.id) ids.add(m.id);
    }
    return Array.from(ids);
  }
  // No pre-loaded members — fall back to a fresh User query scoped to the
  // workspace. Best-effort; if it fails the caller just sees fewer matches.
  if (User && typeof User.findAll === 'function' && doc?.workspaceId) {
    try {
      const rows = await User.findAll({
        where: { workspaceId: doc.workspaceId, isActive: true },
        attributes: ['id'],
      });
      for (const r of rows) ids.add(r.id);
    } catch (err) {
      safeLogger.warn('[DocCommentNotifications] workspace member fallback failed (non-fatal)', { err });
    }
  }
  return Array.from(ids);
}

/**
 * Fire one notification, swallowing all errors. Centralised so the three
 * event types share the same error-handling shape.
 */
async function fireNotification({ userId, type, message, entityId, idempotencyKey }) {
  if (!notificationService?.createNotification) {
    // Notification service unavailable (e.g. test environment without the
    // mock). Skip silently — fan-out is best-effort.
    return;
  }
  try {
    await notificationService.createNotification({
      userId,
      type,
      message,
      entityType: 'doc',
      entityId,
      idempotencyKey,
    });
  } catch (err) {
    safeLogger.warn('[DocCommentNotifications] createNotification failed (non-fatal)', {
      userId, type, idempotencyKey, err,
    });
  }
}

/**
 * Main entry point — called fire-and-forget from docCommentController
 * after a new DocComment row has been persisted.
 *
 * @param {object} args
 * @param {object} args.comment   The freshly created DocComment row (must
 *                                expose at least id, docId, parentId,
 *                                authorId, body).
 * @param {object} args.doc       The Doc row (must expose at least id,
 *                                title, createdBy, workspaceId). Loaded
 *                                once by the controller.
 * @param {string} args.authorName Display name of the comment author.
 *                                Used for human-friendly message strings.
 * @param {object} [args.workspace] Optional pre-loaded Workspace row with
 *                                its `workspaceMembers` association. Saves
 *                                an extra query when the controller has
 *                                it; we fall back to a fresh lookup
 *                                otherwise.
 * @param {object} [args.parent]  Optional pre-loaded parent DocComment row
 *                                (only relevant when comment.parentId is
 *                                set). The controller already fetches this
 *                                during parent validation — passing it
 *                                through avoids a duplicate findByPk.
 * @returns {Promise<{ fired: number, type: string }>}
 *          Best-effort summary. `fired` counts notifications attempted
 *          (which may be deduped to zero new rows by the idempotency
 *          index — the counter just reflects fan-out attempts, not
 *          DB inserts).
 */
async function syncCommentNotifications(args = {}) {
  const { comment, doc, authorName, workspace = null, parent = null } = args;

  if (!comment || !doc) {
    safeLogger.warn('[DocCommentNotifications] missing comment or doc (non-fatal)', {
      hasComment: !!comment, hasDoc: !!doc,
    });
    return { fired: 0, type: 'none' };
  }

  const docTitle = doc.title || 'Untitled doc';
  const safeAuthorName = authorName || 'Someone';
  let fired = 0;

  // Track which recipients we've already notified for THIS comment event
  // so a person who fits multiple roles (e.g. doc creator AND parent
  // author) only gets one row. The DB idempotency key would catch the
  // double-fire anyway, but skipping the second createNotification call
  // saves an unnecessary round-trip.
  const notified = new Set();

  // ─── Case A: top-level comment ───────────────────────────────────────
  if (!comment.parentId) {
    // Notify the doc creator unless they wrote the comment.
    if (doc.createdBy && doc.createdBy !== comment.authorId && !notified.has(doc.createdBy)) {
      notified.add(doc.createdBy);
      await fireNotification({
        userId: doc.createdBy,
        type: 'doc_comment',
        message: `${safeAuthorName} commented on "${docTitle}"`,
        entityId: doc.id,
        idempotencyKey: `doc-comment:${comment.id}:${doc.createdBy}`,
      });
      fired += 1;
    }
  } else {
    // ─── Case B: reply ─────────────────────────────────────────────────
    // Notify the parent comment's author unless they are the reply author.
    let parentAuthorId = parent?.authorId || null;
    if (!parentAuthorId) {
      // No pre-loaded parent — best-effort lookup. We only attempt this if
      // the DocComment model is available; tests that mock without it just
      // see zero parent-author notifications.
      try {
        const { DocComment } = require('../models');
        if (DocComment && typeof DocComment.findByPk === 'function') {
          const found = await DocComment.findByPk(comment.parentId, {
            attributes: ['id', 'authorId'],
          });
          parentAuthorId = found?.authorId || null;
        }
      } catch (err) {
        safeLogger.warn('[DocCommentNotifications] parent lookup failed (non-fatal)', { err });
      }
    }
    if (parentAuthorId && parentAuthorId !== comment.authorId && !notified.has(parentAuthorId)) {
      notified.add(parentAuthorId);
      await fireNotification({
        userId: parentAuthorId,
        type: 'doc_comment_reply',
        message: `${safeAuthorName} replied to your comment on "${docTitle}"`,
        entityId: doc.id,
        idempotencyKey: `doc-comment-reply:${comment.id}:${parentAuthorId}`,
      });
      fired += 1;
    }
    // Also notify the doc creator (unless they're the reply author OR
    // they were already the parent author — they get a single, more
    // specific "you got a reply" notification in that case, not a second
    // generic doc-creator one).
    if (doc.createdBy
        && doc.createdBy !== comment.authorId
        && !notified.has(doc.createdBy)) {
      notified.add(doc.createdBy);
      await fireNotification({
        userId: doc.createdBy,
        type: 'doc_comment_reply',
        message: `${safeAuthorName} replied to a comment on "${docTitle}"`,
        entityId: doc.id,
        idempotencyKey: `doc-comment-reply:${comment.id}:${doc.createdBy}`,
      });
      fired += 1;
    }
  }

  // ─── @-mentions in the comment body ─────────────────────────────────
  const tokens = extractMentionTokens(comment.body);
  if (tokens.length > 0) {
    const memberIds = await loadWorkspaceMemberIds(doc, workspace);
    if (memberIds.length > 0) {
      const resolved = await resolveMentionTokensToUsers(tokens, memberIds);
      for (const [, user] of resolved) {
        if (!user?.id) continue;
        if (user.id === comment.authorId) continue;       // never self-notify
        if (notified.has(user.id)) continue;              // dedup across event types
        notified.add(user.id);
        await fireNotification({
          userId: user.id,
          type: 'doc_comment_mention',
          message: `${safeAuthorName} mentioned you in a comment on "${docTitle}"`,
          entityId: doc.id,
          idempotencyKey: `doc-comment-mention:${comment.id}:${user.id}`,
        });
        fired += 1;
      }
    }
  }

  return { fired, type: comment.parentId ? 'reply' : 'top-level' };
}

module.exports = {
  syncCommentNotifications,
  // Exposed for unit tests
  __extractMentionTokens: extractMentionTokens,
  __resolveMentionTokensToUsers: resolveMentionTokensToUsers,
  __loadWorkspaceMemberIds: loadWorkspaceMemberIds,
};
