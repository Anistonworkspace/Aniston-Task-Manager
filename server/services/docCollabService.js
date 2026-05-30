'use strict';

/**
 * Doc Editor Phase G — Real-time collaboration via Hocuspocus + Y.js.
 *
 * This service:
 *   1. Builds a Hocuspocus server instance with auth + load + store hooks
 *      wired against the existing Doc model.
 *   2. Attaches a WebSocket upgrade handler on `/api/docs-collab/ws` so it
 *      coexists with both Socket.io (`/socket.io/*`) and the meeting-mode
 *      audio bridge (`/api/meeting-stream/ws`). Each `upgrade` listener
 *      ignores paths it doesn't own.
 *
 * Auth: the client first POSTs `/api/docs-collab/ticket` to mint a 60s JWT
 * with `purpose: 'doc-collab-ws'` and `docId`. Hocuspocus forwards that
 * token to onAuthenticate, which verifies signature, purpose, doc match,
 * and re-checks workspace visibility. Tickets cannot be replayed across
 * docs and expire fast — same posture as `/api/meeting-stream/ws`.
 *
 * Migration policy (v1 — explicit + honest):
 *   - yjsState IS NULL + contentJson is empty/trivial → fresh Y.doc.
 *   - yjsState IS NULL + contentJson has real content → REJECT. The
 *     client falls back to the existing HTTP autosave path. A separate
 *     admin migrate endpoint (Phase G v2) will hydrate non-empty docs
 *     server-side using a real Tiptap/ProseMirror schema.
 *   - yjsState non-null → apply update into a fresh Y.doc and serve.
 */

const jwt = require('jsonwebtoken');
const { URL } = require('url');
const safeLogger = require('../utils/safeLogger');

const WS_PATH = '/api/docs-collab/ws';
const TICKET_PURPOSE = 'doc-collab-ws';

// ─── pure helpers (exported for unit tests) ───────────────────────────

/**
 * True when contentJson represents an empty Tiptap document or a single
 * empty paragraph (Tiptap's default starter state). Anything richer is
 * considered "real content" and blocks the no-auto-migrate path.
 */
function isContentJsonEmptyOrTrivial(contentJson) {
  if (!contentJson || typeof contentJson !== 'object') return true;
  const top = Array.isArray(contentJson.content) ? contentJson.content : null;
  if (!top || top.length === 0) return true;
  if (top.length === 1) {
    const node = top[0];
    if (!node) return true;
    // Single empty paragraph (`{type:'paragraph'}` or with empty content).
    if (node.type === 'paragraph') {
      if (!node.content || (Array.isArray(node.content) && node.content.length === 0)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Workspace visibility check — must accept the same (user, workspaceId)
 * pairs as `docController.canCallerSeeWorkspace`. The board-visibility
 * branch is what lets a Tier 4 user reach the workspace's docs when they
 * only have membership via a board (not an explicit workspaceMembers row).
 *
 * `Board` and `boardVisibility` are optional deps so existing unit tests
 * that pass `{ Workspace, User }` only continue to work — they just skip
 * the board-visibility branch.
 *
 * Resolves to `true` when:
 *   - user is super-admin
 *   - user is admin/manager (org-wide visibility)
 *   - user created the workspace
 *   - user is in the workspace's explicit member list
 *   - user can see any board in the workspace (board-visibility branch)
 */
async function canSeeWorkspace(deps, user, workspaceId) {
  if (!user || !workspaceId) return false;
  if (user.isSuperAdmin) return true;
  if (user.role === 'admin' || user.role === 'manager') return true;
  const { Workspace, User, Board, boardVisibility } = deps || {};
  const ws = await Workspace.findByPk(workspaceId, {
    include: [
      { model: User, as: 'workspaceMembers', attributes: ['id'], required: false },
    ],
  });
  if (!ws) return false;
  if (ws.createdBy === user.id) return true;
  const memberIds = (ws.workspaceMembers || []).map((m) => m.id);
  if (memberIds.includes(user.id)) return true;

  // Board-membership path. Mirrors docController.canCallerSeeWorkspace so a
  // Tier 4 user who reaches the workspace via board access can still open
  // its docs in collab mode. Optional — tests that don't provide Board /
  // boardVisibility skip this branch.
  if (Board && boardVisibility && typeof boardVisibility.getVisibleBoardIdsForUser === 'function') {
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
      safeLogger.warn('[DocCollab] canSeeWorkspace board-visibility fallback failed', { err, workspaceId, userId: user.id });
    }
  }
  return false;
}

/**
 * Factory that returns the four hocuspocus hooks
 * (onAuthenticate / onLoadDocument / onStoreDocument). Pure functions —
 * no Hocuspocus runtime needed — so tests can drive each hook directly
 * with mock models. The real attach helper passes its own deps in.
 *
 * deps = { Y, jwt, Doc, Workspace, User, jwtSecret, Board?, boardVisibility? }
 *
 * `Board` and `boardVisibility` are optional: when present, the workspace
 * visibility check honors the board-membership branch so a Tier 4 user who
 * reaches the workspace via board access can open collab sessions on its
 * docs. Tests that don't supply them fall back to membership-only checks.
 */
function buildHocuspocusConfig(deps) {
  const { Y, jwt: jwtLib, Doc, Workspace, User, jwtSecret, Board, boardVisibility } = deps;

  async function onAuthenticate({ token, documentName }) {
    if (!token) throw new Error('Missing token');
    let payload;
    try {
      payload = jwtLib.verify(token, jwtSecret);
    } catch {
      throw new Error('Invalid token');
    }
    if (!payload || payload.purpose !== TICKET_PURPOSE) {
      throw new Error('Wrong token purpose');
    }
    if (!documentName || payload.docId !== documentName) {
      throw new Error('Token/document mismatch');
    }

    // Re-load the doc + verify visibility. A grant that was valid when
    // the ticket was minted might have been revoked in the meantime; an
    // archived doc must not accept new collab sessions either.
    const doc = await Doc.findByPk(documentName);
    if (!doc) throw new Error('Doc not found');
    if (doc.isArchived) throw new Error('Doc is archived');

    const minimalUser = { id: payload.id, isSuperAdmin: payload.isSuperAdmin === true, role: payload.role };
    // Best-effort: if the ticket payload didn't carry role/isSuperAdmin
    // (older clients), fall back to loading the user record so the
    // workspace visibility check has the right inputs.
    let user = minimalUser;
    if (!user.role && User?.findByPk) {
      try {
        const fresh = await User.findByPk(payload.id, { attributes: ['id', 'role', 'isSuperAdmin', 'isActive'] });
        if (!fresh || !fresh.isActive) throw new Error('User inactive');
        user = { id: fresh.id, role: fresh.role, isSuperAdmin: !!fresh.isSuperAdmin };
      } catch (err) {
        if (err && err.message === 'User inactive') throw err;
        // soft failure — fall back to the minimal user
      }
    }

    // feat/docs-personal-notion Phase 3 — gate the collab handshake on
    // docAccessSvc.hasDocAccess instead of workspace visibility. A user
    // whose explicit doc_access row was revoked between ticket mint and
    // WS upgrade now fails the handshake. Lazy-required so unit tests that
    // exercise the hook factory with their own deps continue to work.
    let visible;
    try {
      const docAccessSvc = require('./docAccessService');
      visible = await docAccessSvc.hasDocAccess(user, doc);
    } catch (_) {
      // Fallback to the legacy workspace check if docAccessSvc isn't loaded
      // (e.g. in older unit tests that mock the models without it).
      visible = await canSeeWorkspace({ Workspace, User, Board, boardVisibility }, user, doc.workspaceId);
    }
    if (!visible) throw new Error('Access denied');

    return { user: { id: payload.id }, docId: documentName };
  }

  async function onLoadDocument({ documentName }) {
    const row = await Doc.findByPk(documentName);
    if (!row) {
      // A doc that vanished between auth and load is exceptional but not
      // catastrophic — return a fresh Y.doc so the (now-stale) client
      // sees an empty editor rather than a crash.
      return new Y.Doc();
    }

    if (row.yjsState) {
      const ydoc = new Y.Doc();
      // BLOB returns a Buffer; Y.applyUpdate wants Uint8Array. Buffer
      // IS a Uint8Array but be explicit so the call site is portable.
      const bytes = row.yjsState instanceof Uint8Array
        ? row.yjsState
        : new Uint8Array(row.yjsState);
      Y.applyUpdate(ydoc, bytes);
      return ydoc;
    }

    // No CRDT state yet. Decide based on contentJson:
    //   - empty/trivial → fresh Y.doc; first connecting user writes the
    //     initial content and the next onStoreDocument flush will create
    //     the row's yjsState.
    //   - real content → refuse. This is the explicit "no auto-migrate"
    //     stance for Phase G v1. The client should drop back to HTTP
    //     autosave; a future admin migrate endpoint will hydrate it.
    if (!isContentJsonEmptyOrTrivial(row.contentJson)) {
      throw new Error('Doc not migrated for collab. Open in single-user mode.');
    }
    return new Y.Doc();
  }

  async function onStoreDocument({ documentName, document }) {
    try {
      const state = Y.encodeStateAsUpdate(document);
      // Persist the binary CRDT state — Y.js's source of truth between peers.
      const update = { yjsState: Buffer.from(state) };
      // Best-effort: also refresh `contentText` from the Y.doc's XmlFragment
      // so search + AI Sidekick context don't go stale when the client
      // HTTP-autosave path lags. The Tiptap collab extension stores its
      // doc under the 'default' XmlFragment by convention; if the doc
      // doesn't expose one (e.g. corrupted state), we just skip the
      // shadow-update and keep the existing contentText.
      try {
        const xml = document.getXmlFragment && document.getXmlFragment('default');
        if (xml) {
          const text = xml.toString().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          if (text) update.contentText = text.slice(0, 50000);
        }
      } catch (_) { /* shadow-update is best-effort */ }
      update.lastEditedAt = new Date();
      await Doc.update(update, { where: { id: documentName } });
    } catch (err) {
      safeLogger.error('[DocCollab] persist failed', { err, docId: documentName });
      throw err;
    }
  }

  return { onAuthenticate, onLoadDocument, onStoreDocument };
}

// ─── Hocuspocus server + WS attach ────────────────────────────────────

let hocuspocusInstance = null;

/**
 * Lazily construct the Hocuspocus Server. Constructed once per process
 * (idempotent). Kept separate from `attachDocCollab` so unit tests that
 * exercise only the hook factory don't have to instantiate the server.
 */
function getHocuspocusServer() {
  if (hocuspocusInstance) return hocuspocusInstance;

  const Y = require('yjs');
  const { Server } = require('@hocuspocus/server');
  const { Doc, Workspace, User, Board } = require('../models');
  const boardVisibility = require('./boardVisibilityService');

  const hooks = buildHocuspocusConfig({
    Y,
    jwt,
    Doc,
    Workspace,
    User,
    Board,
    boardVisibility,
    jwtSecret: process.env.JWT_SECRET,
  });

  hocuspocusInstance = Server.configure({
    // Per Hocuspocus v2 convention, hooks are top-level options.
    onAuthenticate: hooks.onAuthenticate,
    onLoadDocument: hooks.onLoadDocument,
    onStoreDocument: hooks.onStoreDocument,
  });
  return hocuspocusInstance;
}

/**
 * Attach the Doc-collab WebSocket endpoint to an existing HTTP server.
 *
 * Mirrors `attachMeetingStream(server)`:
 *   - Uses `WebSocketServer({ noServer: true })` so we can intercept
 *     upgrades on a specific path.
 *   - Returns early on `upgrade` events for any other path, so multiple
 *     `upgrade` listeners coexist on the same HTTP server (Socket.io,
 *     meeting-stream, doc-collab).
 *
 * The token rides as a `token` query param — the browser cannot set
 * custom headers on a WS upgrade, and in dev the WS goes direct to :5000
 * while the cookie is bound to the Vite origin. The ticket endpoint
 * mints a short-lived JWT precisely for this gap.
 */
function attachDocCollab(httpServer) {
  let WebSocketServer;
  let server;
  try {
    WebSocketServer = require('ws').WebSocketServer || require('ws').Server;
    server = getHocuspocusServer();
  } catch (err) {
    // Hocuspocus or Y.js not installed. Log loudly and bail out — boot
    // continues so the rest of the app stays up. The /ticket endpoint
    // will still respond, but the WS upgrade simply won't be claimed.
    safeLogger.error('[DocCollab] dependencies missing, collab disabled', { err });
    return null;
  }

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch { return; }
    if (pathname !== WS_PATH) return;

    wss.handleUpgrade(req, socket, head, (ws) => {
      // Surface the original query string (which carries `?token=`) to
      // Hocuspocus so its onAuthenticate hook receives the JWT. The
      // hocuspocus connection adapter reads it off `request.url`.
      try {
        server.handleConnection(ws, req);
      } catch (err) {
        safeLogger.error('[DocCollab] handleConnection failed', { err });
        try { ws.close(1011, 'Internal error'); } catch { /* socket gone */ }
      }
    });
  });

  // eslint-disable-next-line no-console
  console.log(`[DocCollab] WebSocket endpoint ready at ${WS_PATH}`);
  return wss;
}

module.exports = {
  attachDocCollab,
  WS_PATH,
  TICKET_PURPOSE,
  // Exported for unit tests
  buildHocuspocusConfig,
  isContentJsonEmptyOrTrivial,
  canSeeWorkspace,
  __resetForTests: () => { hocuspocusInstance = null; },
};
