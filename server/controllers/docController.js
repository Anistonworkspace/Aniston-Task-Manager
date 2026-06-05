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
const { Doc, DocVersion, DocMention, DocTaskReference, DocAccess, Task, Workspace, User, Board } = require('../models');
const safeLogger = require('../utils/safeLogger');
const { logActivity } = require('../services/activityService');
// feat/docs-personal-notion Phase 2 — canonical access resolver.
const docAccessSvc = require('../services/docAccessService');
// June 2026 — archive / restore / permanent-delete are Tier 1/2 (admin)
// actions. The tier helpers are the single source of truth for that gate.
const { hasTierAtLeast, TIER_2 } = require('../config/tiers');
// Doc visibility must match `/workspaces/mine` visibility: a Tier 4 user
// who only reaches a workspace via board membership (no explicit
// WorkspaceMember row) still sees the workspace in the sidebar, so they
// must be able to open its docs too. The board-visibility service is the
// single source of truth for "which boards can this user see"; we project
// that into "which workspaces" by union over the boards' workspaceIds.
const boardVisibility = require('../services/boardVisibilityService');
let xssFn;
try { xssFn = require('xss'); } catch { xssFn = (s) => s; }
// Notification service is loaded lazily so doc controller unit tests that
// stub the models without stubbing notifications don't pull a real
// notification queue connection into the test environment.
let notificationService;
try { notificationService = require('../services/notificationService'); } catch { notificationService = null; }
// Socket service is loaded lazily for the same reason as notifications —
// doc-controller unit tests stub the models without a live Socket.io
// instance. All emit calls are best-effort and guarded.
let socketService;
try { socketService = require('../services/socketService'); } catch { socketService = null; }

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
  if (memberIds.includes(user.id)) return true;

  // Board-membership path. Aligns docs visibility with `getMyWorkspaces`
  // (server/controllers/workspaceController.js) so a Tier 4 user who only
  // reaches a workspace via board access can still open its docs.
  // Without this, the workspace shows up in the sidebar but every docs
  // request returns 403 — the bug the May 2026 audit flagged.
  try {
    const visibleBoardIds = await boardVisibility.getVisibleBoardIdsForUser(user, { includeArchived: false });
    if (visibleBoardIds && visibleBoardIds.size > 0) {
      const wsBoards = await Board.findAll({
        where: { workspaceId, isArchived: false },
        attributes: ['id'],
        raw: true,
      });
      if (wsBoards.some((b) => visibleBoardIds.has(b.id))) return true;
    }
  } catch (err) {
    safeLogger.warn('[Doc] canCallerSeeWorkspace board-visibility fallback failed', { err, workspaceId, userId: user.id });
  }
  return false;
}

/**
 * feat/docs-personal-notion Phase 3 — ownership check used for destructive
 * actions (archive, restore, permanent-delete, migrate-to-collab,
 * restoreVersion, share management).
 *
 * Owner-only by the new rule. The old admin/manager role bypass is GONE
 * (the user explicitly chose super-admin as the only role-based bypass in
 * decision 17.7a). Admins/managers who could previously archive any doc by
 * role can still see those docs through `legacy_workspace` doc_access rows,
 * but must request owner privilege via the Share panel to mutate.
 *
 * `ownerUserId` is the canonical field after the Phase 2 backfill. Legacy
 * rows where `ownerUserId IS NULL` fall back to `createdBy` for safety.
 */
function canCallerEditDoc(user, doc) {
  if (!user || !doc) return false;
  if (user.isSuperAdmin) return true;
  const owner = doc.ownerUserId || doc.createdBy;
  return owner === user.id;
}

/**
 * Resolve every user who currently has access to a doc (owner + every
 * doc_access grant). Used to fan out the `doc:updated` realtime event so
 * open viewers/collaborators see edits without a manual refresh.
 *
 * Best-effort: a query failure returns just the owner so the emit still
 * reaches the most important recipient. De-dupes via Set.
 */
async function getDocRecipientUserIds(doc) {
  const ids = new Set();
  const ownerId = doc.ownerUserId || doc.createdBy;
  if (ownerId) ids.add(ownerId);
  try {
    const rows = await DocAccess.findAll({
      where: { docId: doc.id },
      attributes: ['userId'],
      raw: true,
    });
    for (const r of rows) if (r.userId) ids.add(r.userId);
  } catch (err) {
    safeLogger.warn('[Doc] getDocRecipientUserIds failed (non-fatal)', { docId: doc.id, err });
  }
  return Array.from(ids);
}

/**
 * Fan out a `doc:collaborators:changed` signal to everyone who currently
 * has access to the doc (owner + every doc_access grant). Drives the live
 * "Shared with" bar + Share panel so adding/removing a collaborator —
 * whether via @mention in the body OR the Share panel — reflects without a
 * refresh, for the author and every other viewer alike. Fire-and-forget.
 */
async function emitDocCollaboratorsChanged(doc) {
  if (!socketService?.emitToUsers) return;
  try {
    const ids = await getDocRecipientUserIds(doc);
    if (ids.length > 0) {
      socketService.emitToUsers('doc:collaborators:changed', { docId: doc.id }, ids);
    }
  } catch (err) {
    safeLogger.warn('[Doc] doc:collaborators:changed emit failed (non-fatal)', { docId: doc.id, err });
  }
}

/**
 * Phase 3 helper — load a doc and gate the request by access level.
 *
 *   const result = await loadDocAndAssertAccess(req, res, 'view');
 *   if (!result) return;
 *   const { doc, level } = result;
 *
 * Sends the appropriate HTTP error (404 / 403) on the response if the doc
 * is missing or the caller lacks the required level. Returns null in that
 * case so the caller's `if (!result) return;` aborts cleanly.
 *
 * `requiredLevel` ∈ 'view' | 'comment' | 'edit' | 'owner'.
 */
async function loadDocAndAssertAccess(req, res, requiredLevel = 'view', options = {}) {
  const { id } = req.params;
  const doc = await Doc.findByPk(id, options.include ? { include: options.include } : undefined);
  if (!doc) {
    res.status(404).json({ success: false, message: 'Doc not found.' });
    return null;
  }
  const level = await docAccessSvc.getDocAccessLevel(req.user, doc);
  if (!level) {
    res.status(403).json({ success: false, message: 'You do not have access to this doc.' });
    return null;
  }
  if (docAccessSvc.levelRank(level) < docAccessSvc.levelRank(requiredLevel)) {
    res.status(403).json({
      success: false,
      code: 'insufficient_access',
      message: `This action requires ${requiredLevel} access (you have ${level}).`,
    });
    return null;
  }
  return { doc, level };
}

function extractContentText(contentJson) {
  if (!contentJson || typeof contentJson !== 'object') return '';
  // feat/docs-personal-notion Phase 6 — handles both shapes:
  //   - Tiptap: `{ type: 'doc', content: [{ ..., text: '...' }, ...] }`
  //   - BlockNote: `[{ type, content: [{ type: 'text', text: '...' }, ...], children: [...] }, ...]`
  //
  // The walker pulls every node's `text` field regardless of where in the
  // tree it lives. BlockNote nests `children` (lists, toggles), so we
  // recurse on both `content` AND `children`. Both formats produce the
  // same flat plain-text shadow used by the FTS trigram index.
  const parts = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.text === 'string') parts.push(node.text);
    if (Array.isArray(node.content)) node.content.forEach(walk);
    if (Array.isArray(node.children)) node.children.forEach(walk);
  }
  if (Array.isArray(contentJson)) {
    // BlockNote: top-level array.
    contentJson.forEach(walk);
  } else {
    walk(contentJson);
  }
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
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'mention') {
      // Tiptap stores id under .attrs.id; BlockNote (Phase 6+) uses
      // .props.userId. Handle both shapes so the same doc save path
      // works for legacy and new editors.
      const rawId = node.attrs?.id || node.props?.userId;
      const rawLabel = node.attrs?.label || node.props?.label;
      if (typeof rawId === 'string') {
        const userId = rawId.trim();
        if (UUID_RE.test(userId) && !seen.has(userId)) {
          seen.add(userId);
          out.push({ userId, anchorOffset: offset });
        }
        const label = String(rawLabel || userId || '');
        offset += label.length + 1;
        return;
      }
    }
    if (typeof node.text === 'string') offset += node.text.length;
    if (Array.isArray(node.content)) node.content.forEach(walk);
    // BlockNote nests blocks under .children (lists/toggles); recurse so
    // mentions inside nested items are caught.
    if (Array.isArray(node.children)) node.children.forEach(walk);
  }
  // BlockNote contentJson is a top-level Block[]; Tiptap is an envelope.
  if (Array.isArray(contentJson)) {
    contentJson.forEach(walk);
  } else {
    walk(contentJson);
  }
  return out;
}

/**
 * Diff existing DocMention rows against the new contentJson's mention set.
 *
 * feat/docs-personal-notion Phase 5: mention is now a SHARING action.
 *
 * Insertion flow per newly-mentioned user:
 *   1. Active-user filter — discard any mention whose target is not active
 *      + approved. Mention rows are never created for inactive users.
 *   2. INSERT `doc_mentions` row (index + back-ref).
 *   3. UPSERT `doc_access` row with `source='mention'`, `accessLevel='comment'`.
 *      `upsertAccess` never DOWNGRADES — if the user already has 'edit' or
 *      'owner' via manual_share / legacy_workspace, that grant survives.
 *   4. Fire `doc:access:granted` realtime event to the mentioned user only.
 *   5. Fire `doc_mention` notification (idempotent — re-saving the same body
 *      will not double-notify thanks to the partial-unique index).
 *
 * Removal flow per un-mentioned user (safe rule from §17.5 + Phase 5 plan):
 *   1. DELETE `doc_mentions` row.
 *   2. Look up the user's `doc_access` row for this doc.
 *      - If source = 'mention' → DELETE it (the row existed ONLY because
 *        of the mention being removed).
 *      - If source = 'owner' / 'manual_share' / 'legacy_workspace' → keep
 *        it. The user still has access for an unrelated reason.
 *   3. If we deleted the access row, fire `doc:access:revoked` to the
 *      (formerly-)mentioned user so their /docs list refreshes.
 *
 * Idempotency: re-saving the same body re-runs the diff but the insert /
 * delete sets are both empty, so no spurious notifications or events fire.
 */
async function syncDocMentionsAndNotify(doc, contentJson, actor) {
  const incoming = extractMentions(contentJson);

  // Phase 5 — validate that each incoming mention points at an active +
  // approved user. Discards mentions pointing at deactivated employees,
  // pending accounts, or freshly-deleted users. We DO NOT touch existing
  // DocMention rows whose target became inactive after they were created;
  // an owner can prune those via the Share panel.
  let validIncomingIds = new Set();
  if (incoming.length > 0) {
    try {
      const activeRows = await User.findAll({
        where: {
          id: { [Op.in]: incoming.map((m) => m.userId) },
          isActive: true,
          accountStatus: 'approved',
        },
        attributes: ['id'],
        raw: true,
      });
      validIncomingIds = new Set(activeRows.map((u) => u.id));
    } catch (err) {
      // If the validation query fails (DB hiccup), bail out of the whole
      // sync rather than silently writing rows for unverified user-ids.
      safeLogger.warn('[Doc] mention sync — active-user check failed', { err, docId: doc.id });
      return { added: 0, removed: 0 };
    }
  }
  const validIncoming = incoming.filter((m) => validIncomingIds.has(m.userId));
  const incomingIds = new Set(validIncoming.map((m) => m.userId));

  const existing = await DocMention.findAll({
    where: { docId: doc.id },
    attributes: ['id', 'mentionedUserId'],
  });
  const existingIds = new Set(existing.map((m) => m.mentionedUserId));

  // Insertions: present in incoming, absent from existing. Self-mentions
  // skipped (owner already has 'owner' access anyway).
  const toInsert = validIncoming.filter((m) => !existingIds.has(m.userId) && m.userId !== actor.id);
  // Deletions: present in existing, absent from incoming.
  const toDeleteIds = Array.from(existingIds).filter((id) => !incomingIds.has(id));

  // Lazy require — Phase 5 additions. Both are best-effort; failures in
  // either path are logged but never block the doc save.
  let docAccessSvc;
  try { docAccessSvc = require('../services/docAccessService'); } catch { docAccessSvc = null; }
  let socketService;
  try { socketService = require('../services/socketService'); } catch { socketService = null; }

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

    // Phase 5 — grant 'comment' access via doc_access. upsertAccess never
    // downgrades, so an existing 'edit'/'owner' grant survives a mention.
    let accessChanged = false;
    if (docAccessSvc?.upsertAccess) {
      try {
        const result = await docAccessSvc.upsertAccess({
          docId: doc.id,
          userId: m.userId,
          accessLevel: 'comment',
          source: 'mention',
          grantedByUserId: actor.id,
        });
        accessChanged = !!(result?.created || result?.upgraded);
      } catch (err) {
        safeLogger.warn('[Doc] mention upsertAccess failed (non-fatal)', { docId: doc.id, userId: m.userId, err });
      }
    }

    // Phase 5 — realtime ping the mentioned user so their /docs list
    // updates without a refresh. Targeted, not broadcast.
    if (accessChanged && socketService?.emitToUsers) {
      try {
        socketService.emitToUsers(
          'doc:access:granted',
          { docId: doc.id, docTitle: doc.title, source: 'mention' },
          [m.userId],
        );
      } catch (err) {
        safeLogger.warn('[Doc] doc:access:granted emit failed (non-fatal)', { docId: doc.id, userId: m.userId, err });
      }
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

    // Phase 5 — safe-rule access removal. Per (docId, removedUserId), we
    // only DELETE the doc_access row when source='mention'. Owner / manual /
    // legacy_workspace rows survive. Done in a single batch query.
    if (toDeleteIds.length > 0) {
      try {
        const removedRows = await DocAccess.findAll({
          where: {
            docId: doc.id,
            userId: { [Op.in]: toDeleteIds },
            source: 'mention',
          },
          attributes: ['userId'],
          raw: true,
        });
        const removedUserIds = removedRows.map((r) => r.userId);
        if (removedUserIds.length > 0) {
          await DocAccess.destroy({
            where: {
              docId: doc.id,
              userId: { [Op.in]: removedUserIds },
              source: 'mention',
            },
          });
          // Realtime fan-out to the un-mentioned users only. Owners /
          // manual-share recipients whose access survived are intentionally
          // NOT notified because nothing changed for them.
          if (socketService?.emitToUsers) {
            try {
              socketService.emitToUsers(
                'doc:access:revoked',
                { docId: doc.id, docTitle: doc.title, source: 'mention' },
                removedUserIds,
              );
            } catch (err) {
              safeLogger.warn('[Doc] doc:access:revoked emit failed (non-fatal)', { docId: doc.id, err });
            }
          }
        }
      } catch (err) {
        safeLogger.warn('[Doc] mention-derived doc_access removal failed (non-fatal)', { docId: doc.id, err });
      }
    }
  }

  // Live-refresh the "Shared with" bar / Share panel for everyone on the
  // doc whenever the mention-derived collaborator set actually changed.
  if (toInsert.length > 0 || toDeleteIds.length > 0) {
    emitDocCollaboratorsChanged(doc).catch(() => { /* non-fatal */ });
  }

  return {
    added: toInsert.length,
    removed: toDeleteIds.length,
    skippedInactive: incoming.length - validIncoming.length,
  };
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
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    // Tiptap: 'taskChip' / 'task-chip' with .attrs.taskId
    // BlockNote (Phase 6+): 'task' inline content with .props.taskId
    if (node.type === 'taskChip' || node.type === 'task-chip' || node.type === 'task') {
      const rawId = node.attrs?.taskId || node.props?.taskId;
      const rawLabel = node.attrs?.label || node.props?.label;
      if (typeof rawId === 'string') {
        const taskId = rawId.trim();
        if (UUID_RE.test(taskId) && !seen.has(taskId)) {
          seen.add(taskId);
          out.push({ taskId, anchorOffset: offset });
        }
        const label = String(rawLabel || taskId || '');
        offset += label.length + 1;
        return;
      }
    }
    if (typeof node.text === 'string') offset += node.text.length;
    if (Array.isArray(node.content)) node.content.forEach(walk);
    if (Array.isArray(node.children)) node.children.forEach(walk);
  }
  if (Array.isArray(contentJson)) {
    contentJson.forEach(walk);
  } else {
    walk(contentJson);
  }
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

/**
 * GET /api/docs/archived — archived docs across every workspace the caller
 * can see. Used by the global /archive page so docs share the same
 * archive UX as boards / tasks / dependencies / help requests instead of
 * living as a hidden toggle on each workspace's Docs list.
 *
 * Visibility rule mirrors canCallerSeeWorkspace (including the
 * board-membership branch added in May 2026) — the caller only sees
 * archived docs for workspaces they could open the active docs list of.
 */
async function listArchivedDocsForCaller(req, res) {
  try {
    // feat/docs-personal-notion Phase 3 — switch from workspace-visibility
    // resolution to docAccessSvc.getMyVisibleDocIds. The list narrows to
    // docs the caller actually has explicit access to (owner + doc_access
    // grants); workspace / board / role no longer auto-grant.
    const visibleIds = await docAccessSvc.getMyVisibleDocIds(req.user);
    if (visibleIds.length === 0) {
      return res.json({ success: true, data: { docs: [] } });
    }

    const docs = await Doc.findAll({
      where: { isArchived: true, id: { [Op.in]: visibleIds } },
      include: [
        { model: User, as: 'creator', attributes: USER_PILL_ATTRS },
        { model: User, as: 'owner', attributes: USER_PILL_ATTRS, required: false },
        { model: User, as: 'lastEditor', attributes: USER_PILL_ATTRS },
        { model: User, as: 'archiver', attributes: USER_PILL_ATTRS, required: false },
        { model: Workspace, as: 'workspace', attributes: ['id', 'name', 'color'], required: false },
      ],
      order: [['archivedAt', 'DESC'], ['updatedAt', 'DESC']],
      limit: 200,
    });

    res.json({
      success: true,
      data: {
        docs: docs.map((d) => serializeDoc(d, { includeContent: false })),
      },
    });
  } catch (err) {
    safeLogger.error('[Doc] listArchivedDocsForCaller error', { err });
    res.status(500).json({ success: false, message: 'Failed to load archived docs.' });
  }
}

/**
 * DELETE /api/docs/:id/permanent — permanent delete an already-archived
 * doc. Mirrors the affordance the global /archive page surfaces for
 * boards & tasks. Only doc owner / admins / super-admins; the doc must
 * already be soft-archived (defense in depth so a misclick doesn't drop
 * a live doc).
 */
async function permanentDeleteDoc(req, res) {
  try {
    // June 2026 — permanent delete is a Tier 1/2 action surfaced from the
    // global Archive page. Caller must see the doc AND be Tier 1 or 2.
    const result = await loadDocAndAssertAccess(req, res, 'view');
    if (!result) return;
    const { doc } = result;
    if (!hasTierAtLeast(req.user, TIER_2)) {
      return res.status(403).json({
        success: false,
        code: 'insufficient_tier',
        message: 'Only Tier 1 and Tier 2 can permanently delete docs.',
      });
    }
    if (!doc.isArchived) {
      return res.status(400).json({
        success: false,
        message: 'Archive the doc first before permanent deletion.',
      });
    }
    const deletedId = doc.id;
    await doc.destroy();
    logActivity({
      action: 'deleted',
      description: `Permanently deleted doc: ${doc.title}`,
      entityType: 'doc',
      entityId: deletedId,
      userId: req.user.id,
    });
    res.json({ success: true, data: { id: deletedId } });
  } catch (err) {
    safeLogger.error('[Doc] permanentDeleteDoc error', { err });
    res.status(500).json({ success: false, message: 'Failed to delete doc.' });
  }
}

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

// ─── feat/docs-personal-notion Phase 2 — personal docs surface ────
//
// Two new endpoints replace the workspace-nested list/create:
//   GET  /api/docs           → listPersonalDocs  (returns docs visible to me)
//   POST /api/docs           → createPersonalDoc (creates a private personal doc)
//
// Visibility is resolved by docAccessSvc.getMyVisibleDocIds — super-admin
// bypass per 17.7 (a), otherwise owner + explicit doc_access rows. No
// workspace/board/role fallback (those were backfilled into doc_access at
// migration time, see server.js Phase 2 block).
//
// Phase 3 will switch the remaining endpoints (read / update / delete /
// archive / restore / comments / AI / versions / migrate) from
// canCallerSeeWorkspace to docAccessSvc.hasDocAccess.

async function listPersonalDocs(req, res) {
  try {
    const q = (req.query.q || '').trim();
    const includeArchived = req.query.archived === '1' || req.query.archived === 'true';
    const filter = (req.query.filter || 'all').toString();

    // feat/docs-personal-notion Phase 8 — when filter is 'shared' or
    // 'mentioned', we narrow visibleIds by the caller's doc_access source
    // before the visibility intersection. For 'all' / 'owned' the wider
    // getMyVisibleDocIds union (owner + every doc_access source) is fine.
    let visibleIds;
    let userAccessRows = null;
    if (filter === 'shared' || filter === 'mentioned') {
      const accessRows = await DocAccess.findAll({
        where: {
          userId: req.user.id,
          source: filter === 'mentioned' ? 'mention' : { [Op.in]: ['manual_share', 'legacy_workspace'] },
        },
        attributes: ['docId', 'accessLevel', 'source'],
        raw: true,
      });
      userAccessRows = accessRows;
      visibleIds = accessRows.map((r) => r.docId);
    } else {
      visibleIds = await docAccessSvc.getMyVisibleDocIds(req.user);
      // For badge rendering on 'all' we also need the caller's per-doc
      // access rows (so the UI can decide between "Owner" / "Shared" /
      // "Mentioned" pills). Cheap single query keyed on the user.
      try {
        userAccessRows = await DocAccess.findAll({
          where: { userId: req.user.id },
          attributes: ['docId', 'accessLevel', 'source'],
          raw: true,
        });
      } catch (_) { userAccessRows = []; }
    }

    if (visibleIds.length === 0) {
      return res.json({ success: true, data: { docs: [] } });
    }

    const where = { id: { [Op.in]: visibleIds } };
    if (!includeArchived) where.isArchived = false;

    if (filter === 'owned') {
      where.ownerUserId = req.user.id;
    }

    if (q) {
      where[Op.or] = [
        { title: { [Op.iLike]: `%${q}%` } },
        { contentText: { [Op.iLike]: `%${q}%` } },
      ];
    }

    const docs = await Doc.findAll({
      where,
      include: [
        { model: User, as: 'creator', attributes: USER_PILL_ATTRS },
        // June 2026 — include the owner's department so the Tier 1/2
        // department-grouped docs view + department filter can render
        // without a second round-trip.
        { model: User, as: 'owner', attributes: [...USER_PILL_ATTRS, 'department'], required: false },
        { model: User, as: 'lastEditor', attributes: USER_PILL_ATTRS },
      ],
      order: [['lastEditedAt', 'DESC'], ['updatedAt', 'DESC']],
      limit: 200,
    });

    // Phase 8 — surface the caller's per-doc relationship so the UI can
    // render the right badge (Owner / Shared / Mentioned). We do this
    // server-side so the client doesn't need a second round-trip.
    const accessByDoc = new Map();
    for (const row of (userAccessRows || [])) {
      accessByDoc.set(row.docId, row);
    }

    // June 2026 — Tier 1/2 are doc admins (see docAccessService.isDocAdmin):
    // they see every doc with owner-level access. Used for the admin badge +
    // callerAccessLevel fallback below.
    const isAdminViewer = req.user?.isSuperAdmin || hasTierAtLeast(req.user, TIER_2);

    const serialized = docs.map((d) => {
      const json = serializeDoc(d, { includeContent: false });
      const access = accessByDoc.get(json.id);
      // Owner's department for the Tier 1/2 grouped view (flattened so the
      // client doesn't have to dig into the nested owner object).
      json.ownerDepartment = d.owner?.department || null;
      if (json.ownerUserId === req.user.id || (json.createdBy === req.user.id && !json.ownerUserId)) {
        json.callerRelation = 'owner';
      } else if (access?.source === 'mention') {
        json.callerRelation = 'mentioned';
      } else if (access?.source === 'manual_share') {
        json.callerRelation = 'shared';
      } else if (access?.source === 'legacy_workspace') {
        json.callerRelation = 'legacy';
      } else if (req.user?.isSuperAdmin) {
        json.callerRelation = 'super_admin';
      } else if (isAdminViewer) {
        json.callerRelation = 'admin';
      } else {
        json.callerRelation = null;
      }
      json.callerAccessLevel = access?.accessLevel
        || (json.callerRelation === 'owner' ? 'owner' : (isAdminViewer ? 'owner' : null));
      return json;
    });

    res.json({
      success: true,
      data: { docs: serialized },
    });
  } catch (err) {
    safeLogger.error('[Doc] listPersonalDocs error', { err });
    res.status(500).json({ success: false, message: 'Failed to load docs.' });
  }
}

async function createPersonalDoc(req, res) {
  try {
    const title = sanitizeTitle(req.body?.title) || 'Untitled doc';
    // feat/docs-personal-notion Phase 6 — new docs default to BlockNote.
    // Empty seed is `[]` (BlockNote treats this as "create a single empty
    // paragraph on mount"). If the client passes `contentFormat: 'tiptap_json'`
    // explicitly (e.g. an importer), we honor it and seed the Tiptap envelope.
    const reqFormat = req.body?.contentFormat;
    const contentFormat = (reqFormat === 'tiptap_json')
      ? 'tiptap_json'
      : 'blocknote_json';
    const emptySeed = contentFormat === 'blocknote_json'
      ? []
      : { type: 'doc', content: [] };
    const contentJson = sanitizeContentJson(req.body?.contentJson) || emptySeed;
    const contentText = extractContentText(contentJson);

    const doc = await Doc.create({
      // workspaceId intentionally omitted — personal docs are workspace-less.
      title,
      contentJson,
      contentText,
      contentFormat, // Phase 6: 'blocknote_json' by default; 'tiptap_json' on explicit opt-in
      slug: slugify(title),
      sharePolicy: 'private',
      visibility: 'private',
      ownerUserId: req.user.id,
      createdBy: req.user.id,
      lastEditedBy: req.user.id,
      lastEditedAt: new Date(),
    });

    // Owner access row. Fire after create so the FK lands cleanly. Failure
    // here is logged but non-fatal — getMyVisibleDocIds also checks
    // ownerUserId so the doc is still findable.
    try {
      await DocAccess.create({
        docId: doc.id,
        userId: req.user.id,
        accessLevel: 'owner',
        source: 'owner',
      });
    } catch (err) {
      safeLogger.warn('[Doc] owner doc_access insert failed (non-fatal)', { docId: doc.id, err });
    }

    // Mention + task-ref extraction kept identical to legacy createDoc so
    // a paste-with-mentions creates the right downstream rows. Mention →
    // doc_access wiring lands in Phase 5; today these are notification +
    // back-ref rows only.
    syncDocMentionsAndNotify(doc, contentJson, req.user).catch((err) => {
      safeLogger.warn('[Doc] initial mention sync failed (non-fatal)', { docId: doc.id, err });
    });
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
        { model: User, as: 'owner', attributes: USER_PILL_ATTRS, required: false },
        { model: User, as: 'lastEditor', attributes: USER_PILL_ATTRS },
      ],
    });
    const json = serializeDoc(reloaded, { includeContent: true });
    // Surface the caller's access level on the create response too.
    // Without this the brand-new doc's first paint on the editor side
    // would have `callerAccessLevel` undefined → the new permission gate
    // in DocPage would treat the owner as read-only until the follow-up
    // GET /docs/:id arrives. Owner of a freshly-created doc is always 'owner'.
    json.callerAccessLevel = 'owner';
    res.status(201).json({ success: true, data: { doc: json } });
  } catch (err) {
    safeLogger.error('[Doc] createPersonalDoc error', { err });
    res.status(500).json({ success: false, message: 'Failed to create doc.' });
  }
}

// ─── (legacy endpoints below — workspace-scoped, kept for Phase 3 reference)

async function getDoc(req, res) {
  try {
    const result = await loadDocAndAssertAccess(req, res, 'view', {
      include: [
        { model: User, as: 'creator', attributes: USER_PILL_ATTRS },
        { model: User, as: 'owner', attributes: USER_PILL_ATTRS, required: false },
        { model: User, as: 'lastEditor', attributes: USER_PILL_ATTRS },
        { model: Workspace, as: 'workspace', attributes: ['id', 'name', 'color'], required: false },
      ],
    });
    if (!result) return;
    const { doc, level } = result;
    const json = serializeDoc(doc, { includeContent: true });
    // Surface the caller's effective access level so the editor can decide
    // whether to render the Save button, archive icon, etc. without a
    // second roundtrip.
    json.callerAccessLevel = level;
    res.json({ success: true, data: { doc: json } });
  } catch (err) {
    safeLogger.error('[Doc] getDoc error', { err });
    res.status(500).json({ success: false, message: 'Failed to load doc.' });
  }
}

async function updateDoc(req, res) {
  try {
    // Body / title edits require 'edit' or higher. Note 'comment' is NOT
    // enough — comment-level users can leave comments but not mutate the
    // doc body (matches the share-panel semantics).
    const result = await loadDocAndAssertAccess(req, res, 'edit');
    if (!result) return;
    const { doc, level } = result;

    const updates = {};
    if (typeof req.body?.title === 'string') updates.title = sanitizeTitle(req.body.title);
    if (req.body?.contentJson !== undefined) {
      const cleanJson = sanitizeContentJson(req.body.contentJson);
      if (cleanJson === null) {
        return res.status(400).json({ success: false, message: 'contentJson must be a valid Tiptap or BlockNote doc.' });
      }
      updates.contentJson = cleanJson;
      updates.contentText = extractContentText(cleanJson);
    }
    // contentFormat change drives the legacy Tiptap → BlockNote migration.
    // June 2026: every doc now opens in BlockNote, and DocPage auto-migrates
    // legacy docs on load. The flip is allowed for any caller who can edit
    // the body (the outer loadDocAndAssertAccess already required 'edit'),
    // because the migration is lossless — we auto-snapshot the existing
    // contentJson into legacyContentJson + version history so the original
    // Tiptap source is always recoverable. Comment/view callers never reach
    // this code path.
    if (typeof req.body?.contentFormat === 'string'
        && ['tiptap_json', 'blocknote_json'].includes(req.body.contentFormat)
        && req.body.contentFormat !== doc.contentFormat) {
      // Preserve the pre-conversion contentJson exactly once. We only
      // snapshot if legacyContentJson is currently NULL — re-converting a
      // doc twice should not overwrite the original snapshot.
      if (!doc.legacyContentJson && doc.contentJson) {
        updates.legacyContentJson = doc.contentJson;
      }
      updates.contentFormat = req.body.contentFormat;
    }
    // sharePolicy is owner-only — it changes who else can read the doc.
    if (typeof req.body?.sharePolicy === 'string'
        && ['private', 'workspace', 'public_link'].includes(req.body.sharePolicy)) {
      if (level !== 'owner') {
        return res.status(403).json({
          success: false,
          code: 'insufficient_access',
          message: 'Only the doc owner can change the share policy.',
        });
      }
      updates.sharePolicy = req.body.sharePolicy;
    }

    if (Object.keys(updates).length === 0) {
      const json = serializeDoc(doc, { includeContent: true });
      json.callerAccessLevel = level;
      return res.json({ success: true, data: { doc: json } });
    }

    updates.lastEditedBy = req.user.id;
    updates.lastEditedAt = new Date();

    await doc.update(updates);

    // Snapshot decision: every Nth content save creates a new version
    // entry for the owner's own typing (so we don't bloat history with
    // "still typing" rows). Title-only or share-only saves don't create
    // versions — they're metadata, not content.
    //
    // Audit carve-out (May 2026): when the actor is NOT the doc owner
    // (delegated edit-level collaborator OR super-admin acting via
    // override), force a snapshot on every content save regardless of
    // cadence. Without this, override edits could land between
    // landmarks (1st, 10th, 20th save) and never appear in History,
    // breaking the audit trail for cross-user access. `savedBy` is
    // already the actor (req.user.id); `note` carries the override
    // reason so the History UI can label it.
    if (updates.contentJson !== undefined) {
      const ownerId = doc.ownerUserId || doc.createdBy;
      const actorIsOwner = ownerId && ownerId === req.user.id;
      const adminOverride = !!req.user.isSuperAdmin && ownerId && ownerId !== req.user.id;
      const versionCount = await DocVersion.count({ where: { docId: doc.id } });
      const cadenceFires =
        (versionCount + 1) % SNAPSHOT_EVERY_SAVES === 0 || versionCount === 0;
      const shouldSnapshot = cadenceFires || !actorIsOwner;
      if (shouldSnapshot) {
        try {
          await DocVersion.create({
            docId: doc.id,
            contentJson: updates.contentJson,
            contentText: updates.contentText,
            savedBy: req.user.id,
            note: adminOverride
              ? 'Edit via super admin override'
              : (!actorIsOwner ? `Edit by collaborator (${level})` : null),
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

    // Real-time fan-out: notify every OTHER user with access to this doc
    // that the content/title changed, so their open editor (viewers) or
    // docs list refreshes without a manual reload. The payload is a
    // lightweight signal — recipients re-fetch via the access-gated
    // GET /docs/:id so RBAC is preserved and we never push doc bodies over
    // the socket. Fire-and-forget; never blocks the save response.
    if (updates.contentJson !== undefined || updates.title !== undefined) {
      getDocRecipientUserIds(doc).then((ids) => {
        const recipients = ids.filter((uid) => uid !== req.user.id);
        if (recipients.length > 0 && socketService?.emitToUsers) {
          socketService.emitToUsers('doc:updated', {
            docId: doc.id,
            actorId: req.user.id,
            title: doc.title,
            lastEditedAt: doc.lastEditedAt,
          }, recipients);
        }
      }).catch((err) => {
        safeLogger.warn('[Doc] doc:updated emit failed (non-fatal)', { docId: doc.id, err });
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
    const json = serializeDoc(reloaded, { includeContent: true });
    // Preserve the caller's access level across the autosave roundtrip so
    // the editor's `onSaved` merge doesn't accidentally undefine it.
    json.callerAccessLevel = level;
    res.json({ success: true, data: { doc: json } });
  } catch (err) {
    safeLogger.error('[Doc] updateDoc error', { err });
    res.status(500).json({ success: false, message: 'Failed to update doc.' });
  }
}

async function archiveDoc(req, res) {
  try {
    // June 2026 — archive is a Tier 1/2 (admin/manager) capability. The
    // caller must be able to SEE the doc (view access) AND be Tier 1 or 2.
    // Owners below Tier 2 no longer self-archive; archived docs route to the
    // global Archive surface for admins to restore / permanently delete.
    const result = await loadDocAndAssertAccess(req, res, 'view');
    if (!result) return;
    const { doc } = result;
    if (!hasTierAtLeast(req.user, TIER_2)) {
      return res.status(403).json({
        success: false,
        code: 'insufficient_tier',
        message: 'Only Tier 1 and Tier 2 can archive docs.',
      });
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
    // Restore mirrors archive — a Tier 1/2 action from the global Archive
    // surface. Caller must be able to see the doc AND be Tier 1 or 2.
    const result = await loadDocAndAssertAccess(req, res, 'view');
    if (!result) return;
    const { doc } = result;
    if (!hasTierAtLeast(req.user, TIER_2)) {
      return res.status(403).json({
        success: false,
        code: 'insufficient_tier',
        message: 'Only Tier 1 and Tier 2 can restore docs.',
      });
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
 * GET /api/docs/mentionable?q=…  (legacy alias — Phase 4 delegation)
 *
 * Pre-Phase-4 this returned workspace-scoped users (workspace creator +
 * explicit workspace members). The user explicitly chose option 17.5 to
 * allow mentioning ANY active user in the app, so this endpoint now
 * delegates to the global picker at /api/users/mentions.
 *
 * The legacy `workspaceId` query param is silently IGNORED — old clients
 * keep working and just get the broader result set. New clients should
 * call /api/users/mentions directly. We'll drop this alias in a future
 * release once telemetry shows no caller still uses it.
 */
async function listMentionableUsers(req, res) {
  const { searchMentionableUsers } = require('./userMentionController');
  return searchMentionableUsers(req, res);
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

    // feat/docs-personal-notion Phase 3 — filter by docAccessSvc instead of
    // workspace visibility. A user seeing a task's "referenced in N docs"
    // pill should ONLY count docs they themselves can open.
    const visibleDocs = [];
    for (const ref of refs) {
      if (!ref.doc || ref.doc.isArchived) continue;
      const ok = await docAccessSvc.hasDocAccess(req.user, ref.doc).catch(() => false);
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
    const result = await loadDocAndAssertAccess(req, res, 'view');
    if (!result) return;
    const { doc } = result;

    const versions = await DocVersion.findAll({
      where: { docId: doc.id },
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
    // Restoring a snapshot mutates the live doc body — requires edit or
    // owner. (Reads on /versions allow view-level so anyone can browse.)
    const result = await loadDocAndAssertAccess(req, res, 'edit');
    if (!result) return;
    const { doc } = result;
    const { versionId } = req.params;
    const version = await DocVersion.findOne({ where: { id: versionId, docId: doc.id } });
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
    const result = await loadDocAndAssertAccess(req, res, 'owner');
    if (!result) return;
    const { doc } = result;
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

// ─── feat/docs-personal-notion Phase 3 — manual share surface ─────
//
// Owner-only CRUD on the doc_access table. Powers the Share panel:
//
//   GET    /api/docs/:id/collaborators                  → list
//   POST   /api/docs/:id/collaborators                  → add (or upgrade)
//   PATCH  /api/docs/:id/collaborators/:userId          → change level
//   DELETE /api/docs/:id/collaborators/:userId          → revoke
//
// Auth model:
//   - List requires any access to the doc (so collaborators can see who
//     else is on the doc).
//   - Add/update/revoke require owner-level access (owner OR super-admin).
//
// Mention sources are respected — see Phase 5 mention-removal logic for
// the safe-rule semantics. For Phase 3 the share panel writes/deletes the
// row directly; if a mention still names the user in the doc body, the
// next save's mention-sync (Phase 5) will re-add the access row.

const COLLAB_LEVELS = ['view', 'comment', 'edit'];

function serializeAccessRow(row) {
  if (!row) return null;
  const json = row.toJSON ? row.toJSON() : row;
  return {
    id: json.id,
    user: json.user || null,
    accessLevel: json.accessLevel,
    source: json.source,
    grantedBy: json.grantedBy || null,
    createdAt: json.createdAt,
    updatedAt: json.updatedAt,
  };
}

async function listCollaborators(req, res) {
  try {
    const result = await loadDocAndAssertAccess(req, res, 'view');
    if (!result) return;
    const { doc } = result;

    const [ownerUser, grants] = await Promise.all([
      doc.ownerUserId
        ? User.findByPk(doc.ownerUserId, { attributes: USER_PILL_ATTRS })
        : Promise.resolve(null),
      DocAccess.findAll({
        where: { docId: doc.id },
        include: [
          { model: User, as: 'user', attributes: USER_PILL_ATTRS },
          { model: User, as: 'grantedBy', attributes: USER_PILL_ATTRS, required: false },
        ],
        order: [['createdAt', 'ASC']],
      }),
    ]);

    res.json({
      success: true,
      data: {
        owner: ownerUser ? {
          id: ownerUser.id, name: ownerUser.name, email: ownerUser.email, avatar: ownerUser.avatar,
        } : null,
        // Exclude the owner from the collaborators list (they're already
        // surfaced via `owner`). Mention/legacy_workspace/manual_share rows
        // all appear here with their `source` so the UI can label them.
        collaborators: grants
          .filter((g) => g.userId !== doc.ownerUserId)
          .map(serializeAccessRow),
      },
    });
  } catch (err) {
    safeLogger.error('[Doc] listCollaborators error', { err });
    res.status(500).json({ success: false, message: 'Failed to load collaborators.' });
  }
}

async function addCollaborator(req, res) {
  try {
    const result = await loadDocAndAssertAccess(req, res, 'owner');
    if (!result) return;
    const { doc } = result;

    const userId = req.body?.userId;
    const accessLevel = req.body?.accessLevel || 'comment';
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ success: false, message: 'userId is required.' });
    }
    if (!COLLAB_LEVELS.includes(accessLevel)) {
      return res.status(400).json({
        success: false,
        message: `accessLevel must be one of: ${COLLAB_LEVELS.join(', ')}.`,
      });
    }
    if (userId === doc.ownerUserId) {
      return res.status(400).json({ success: false, message: 'The doc owner already has full access.' });
    }

    const target = await User.findByPk(userId, { attributes: [...USER_PILL_ATTRS, 'isActive'] });
    if (!target || target.isActive === false) {
      return res.status(404).json({ success: false, message: 'User not found or inactive.' });
    }

    await docAccessSvc.upsertAccess({
      docId: doc.id,
      userId,
      accessLevel,
      source: 'manual_share',
      grantedByUserId: req.user.id,
    });

    // Best-effort notification + activity. Mirrors the mention path.
    let notificationService;
    try { notificationService = require('../services/notificationService'); } catch { notificationService = null; }
    if (notificationService?.createNotification) {
      notificationService.createNotification({
        userId,
        type: 'doc_shared',
        message: `${req.user.name || 'Someone'} shared "${doc.title}" with you`,
        entityType: 'doc',
        entityId: doc.id,
        idempotencyKey: `doc-share:${doc.id}:${userId}`,
      }).catch((err) => {
        safeLogger.warn('[Doc] share notification failed (non-fatal)', { docId: doc.id, userId, err });
      });
    }

    // Real-time push to the recipient so the shared doc appears in their
    // /docs list and any open DocPage flips to the granted access level —
    // no manual refresh needed. Mirrors the mention-sync emit.
    if (socketService?.emitToUsers) {
      try {
        socketService.emitToUsers(
          'doc:access:granted',
          { docId: doc.id, docTitle: doc.title, source: 'manual_share', accessLevel },
          [userId],
        );
      } catch (err) {
        safeLogger.warn('[Doc] doc:access:granted emit failed (non-fatal)', { docId: doc.id, userId, err });
      }
    }
    // Live-refresh the shared-with bar / Share panel for the author + every
    // other collaborator.
    emitDocCollaboratorsChanged(doc).catch(() => { /* non-fatal */ });

    logActivity({
      action: 'shared',
      description: `Shared doc "${doc.title}" with ${target.name || target.email || userId} (${accessLevel})`,
      entityType: 'doc',
      entityId: doc.id,
      userId: req.user.id,
    });

    const reloaded = await DocAccess.findOne({
      where: { docId: doc.id, userId },
      include: [
        { model: User, as: 'user', attributes: USER_PILL_ATTRS },
        { model: User, as: 'grantedBy', attributes: USER_PILL_ATTRS, required: false },
      ],
    });
    res.status(201).json({ success: true, data: { collaborator: serializeAccessRow(reloaded) } });
  } catch (err) {
    safeLogger.error('[Doc] addCollaborator error', { err });
    res.status(500).json({ success: false, message: 'Failed to add collaborator.' });
  }
}

async function updateCollaborator(req, res) {
  try {
    const result = await loadDocAndAssertAccess(req, res, 'owner');
    if (!result) return;
    const { doc } = result;
    const { userId } = req.params;
    const accessLevel = req.body?.accessLevel;
    if (!COLLAB_LEVELS.includes(accessLevel)) {
      return res.status(400).json({
        success: false,
        message: `accessLevel must be one of: ${COLLAB_LEVELS.join(', ')}.`,
      });
    }
    if (userId === doc.ownerUserId) {
      return res.status(400).json({
        success: false,
        message: 'The doc owner\'s access level cannot be changed from the Share panel — transfer ownership instead.',
      });
    }
    const row = await DocAccess.findOne({ where: { docId: doc.id, userId } });
    if (!row) {
      return res.status(404).json({ success: false, message: 'Collaborator not found.' });
    }
    // Manual edit converts the row's source to manual_share so the Phase 5
    // mention-removal logic won't auto-strip it later. (If the underlying
    // mention is later removed, the row survives because source !== 'mention'.)
    await row.update({
      accessLevel,
      source: 'manual_share',
      grantedByUserId: req.user.id,
    });

    // Real-time push so the recipient's open DocPage re-fetches and flips
    // between read-only / editable as their level changes. Reuses the same
    // event the /docs list already listens on for a self-refresh.
    if (socketService?.emitToUsers) {
      try {
        socketService.emitToUsers(
          'doc:access:granted',
          { docId: doc.id, docTitle: doc.title, source: 'manual_share', accessLevel },
          [userId],
        );
      } catch (err) {
        safeLogger.warn('[Doc] doc:access:granted (level change) emit failed (non-fatal)', { docId: doc.id, userId, err });
      }
    }
    emitDocCollaboratorsChanged(doc).catch(() => { /* non-fatal */ });

    const reloaded = await DocAccess.findOne({
      where: { docId: doc.id, userId },
      include: [
        { model: User, as: 'user', attributes: USER_PILL_ATTRS },
        { model: User, as: 'grantedBy', attributes: USER_PILL_ATTRS, required: false },
      ],
    });
    res.json({ success: true, data: { collaborator: serializeAccessRow(reloaded) } });
  } catch (err) {
    safeLogger.error('[Doc] updateCollaborator error', { err });
    res.status(500).json({ success: false, message: 'Failed to update collaborator.' });
  }
}

async function removeCollaborator(req, res) {
  try {
    const result = await loadDocAndAssertAccess(req, res, 'owner');
    if (!result) return;
    const { doc } = result;
    const { userId } = req.params;
    if (userId === doc.ownerUserId) {
      return res.status(400).json({ success: false, message: 'The doc owner cannot be removed.' });
    }
    const row = await DocAccess.findOne({ where: { docId: doc.id, userId } });
    if (!row) {
      return res.status(404).json({ success: false, message: 'Collaborator not found.' });
    }
    await row.destroy();

    // Real-time push so the removed user's /docs list drops the doc and any
    // open DocPage for it bounces them back to the list.
    if (socketService?.emitToUsers) {
      try {
        socketService.emitToUsers(
          'doc:access:revoked',
          { docId: doc.id, docTitle: doc.title, source: 'manual_share' },
          [userId],
        );
      } catch (err) {
        safeLogger.warn('[Doc] doc:access:revoked emit failed (non-fatal)', { docId: doc.id, userId, err });
      }
    }
    emitDocCollaboratorsChanged(doc).catch(() => { /* non-fatal */ });

    logActivity({
      action: 'unshared',
      description: `Removed access to doc "${doc.title}" for user ${userId}`,
      entityType: 'doc',
      entityId: doc.id,
      userId: req.user.id,
    });
    res.json({ success: true, data: { docId: doc.id, userId } });
  } catch (err) {
    safeLogger.error('[Doc] removeCollaborator error', { err });
    res.status(500).json({ success: false, message: 'Failed to remove collaborator.' });
  }
}

// ─── input validation helpers ────────────────────────────────

function sanitizeTitle(input) {
  if (typeof input !== 'string') return null;
  return xssFn(input).slice(0, 300).trim() || 'Untitled doc';
}

function sanitizeContentJson(input) {
  // feat/docs-personal-notion Phase 6 — accept two shapes:
  //   - Tiptap: `{ type: 'doc', content: [...] }` (legacy)
  //   - BlockNote: `Block[]` — top-level array of block objects
  // Both are stored as-is in `docs.contentJson` JSONB; the read path
  // branches on `docs.contentFormat`. Neither is ever rendered as HTML
  // on the server — Tiptap and BlockNote both re-parse their own schemas
  // on the client, so our defense is shape-only.
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object') return null;
  if (Array.isArray(input)) {
    // BlockNote: array of Block objects. Each element must be an object
    // (defensive — reject arrays of primitives/nulls).
    if (input.length > 0 && !input.every((b) => b && typeof b === 'object')) return null;
  } else {
    // Tiptap envelope.
    if (input.type !== 'doc') return null;
  }
  // Hard cap: 2 MB JSON. Larger probably means an export-paste accident.
  try {
    const size = Buffer.byteLength(JSON.stringify(input), 'utf8');
    if (size > 2 * 1024 * 1024) return null;
  } catch { return null; }
  return input;
}

module.exports = {
  // feat/docs-personal-notion Phase 2 — new personal-docs surface.
  listPersonalDocs,
  createPersonalDoc,
  // Phase 3 — manual share endpoints.
  listCollaborators,
  addCollaborator,
  updateCollaborator,
  removeCollaborator,
  // Legacy workspace-scoped endpoints — kept temporarily so the workspace
  // route handlers can return 410 with a deprecation message.
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
  // May 2026 — global /archive page integration.
  listArchivedDocsForCaller,
  permanentDeleteDoc,
  // Exposed for unit tests
  __extractMentions: extractMentions,
  __extractTaskRefs: extractTaskRefs,
};
