const jwt = require('jsonwebtoken');
const { User, RefreshToken } = require('../models');
const boardVisibility = require('./boardVisibilityService');

// TODO(scaling): horizontal scaling requires a Socket.io adapter so that
// emits made on one app instance reach sockets connected to another. With
// Redis available, install `@socket.io/redis-adapter` + `redis` and wire
// up here:
//
//   const { createAdapter } = require('@socket.io/redis-adapter');
//   const { createClient } = require('redis');
//   const pub = createClient({ url: process.env.REDIS_URL });
//   const sub = pub.duplicate();
//   await Promise.all([pub.connect(), sub.connect()]);
//   io.adapter(createAdapter(pub, sub));
//
// Until then, single-instance only. emitToBoardAndUsers dedup uses both
// socket.user and socket.data.userId so it stays correct after the switch.
let ioInstance = null;

/**
 * Initialise Socket.io on the provided HTTP server.
 *
 * Authentication:
 *   Clients must send a valid JWT in the `auth.token` handshake field.
 *
 * Room strategy:
 *   - Every authenticated socket auto-joins a personal room `user:<userId>`
 *     so the server can push notifications to individual users.
 *   - Clients explicitly join / leave board rooms via events:
 *       'board:join'  -> payload { boardId }
 *       'board:leave' -> payload { boardId }
 */
const initializeSocket = (server) => {
  const { Server } = require('socket.io');

  const io = new Server(server, {
    cors: {
      origin: process.env.CLIENT_URL || 'http://localhost:3000',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // ── Auth middleware ────────────────────────────────────────
  // D-1 Phase 2: prefer the httpOnly cookie sent on the handshake. Falls
  // back to socket.handshake.auth.token for legacy clients (e.g. native
  // mobile apps or test scripts that drive socket.io-client directly).
  // The cookie is parsed inline rather than via cookie-parser to avoid a
  // dependency just for this one read.
  const { ACCESS_COOKIE } = require('../utils/authCookies');
  function tokenFromHandshake(socket) {
    if (socket.handshake.auth && socket.handshake.auth.token) {
      return socket.handshake.auth.token;
    }
    const cookieHeader = socket.handshake.headers && socket.handshake.headers.cookie;
    if (!cookieHeader || typeof cookieHeader !== 'string') return null;
    for (const part of cookieHeader.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const name = part.slice(0, eq).trim();
      if (name !== ACCESS_COOKIE) continue;
      const raw = part.slice(eq + 1).trim();
      try { return decodeURIComponent(raw); } catch { return raw; }
    }
    return null;
  }

  io.use(async (socket, next) => {
    try {
      const token = tokenFromHandshake(socket);

      if (!token) {
        return next(new Error('Authentication required'));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findByPk(decoded.id);

      if (!user || !user.isActive) {
        return next(new Error('Invalid or inactive user'));
      }

      // Single-active-session check on the realtime channel. Mirrors
      // the HTTP authenticate middleware: if the access token's `sid`
      // points to a hard-revoked session, refuse the handshake. The
      // browser receives the connect_error and falls through to the
      // existing reconnect / login flow.
      //
      // Tokens without `sid` are legacy (pre-feature) and continue to
      // be accepted until natural expiry — same compatibility window
      // as the HTTP path.
      if (decoded.sid) {
        const session = await RefreshToken.findByPk(decoded.sid);
        if (!session || (session.revokedAt && !session.replacedByJti)) {
          return next(new Error('Session revoked'));
        }
        socket.data.sid = decoded.sid;
      }

      // passwordChangedAt check — closes audit F-07. A stolen access
      // token can no longer ride the socket channel past a forced
      // password reset.
      if (user.passwordChangedAt && decoded.iat) {
        const pwSec = Math.floor(new Date(user.passwordChangedAt).getTime() / 1000);
        if (decoded.iat + 1 < pwSec) {
          return next(new Error('Session expired'));
        }
      }

      socket.user = user.toJSON();
      // Also stash userId on socket.data — RemoteSocket (returned by
      // fetchSockets on multi-instance / Redis-adapter setups) only exposes
      // .data, not arbitrary custom props like .user. Keeps emitToBoardAndUsers
      // dedup correct when we eventually scale horizontally.
      socket.data.userId = user.id;
      next();
    } catch (err) {
      next(new Error('Authentication failed'));
    }
  });

  // ── Connection handler ─────────────────────────────────────
  io.on('connection', (socket) => {
    const userId = socket.user.id;
    console.log(`[Socket] User connected: ${socket.user.name} (${userId})`);

    // Auto-join personal room for directed notifications
    socket.join(`user:${userId}`);

    // ── Board room management ─────────────────────────────
    //
    // Delegates to boardVisibilityService.canUserSeeBoard so the realtime
    // join check uses the SAME predicate as the page-load APIs:
    //
    //   1. Tier 1 + Tier 2 (admin / manager / super admin) → unrestricted,
    //      short-circuited inside the service.
    //   2. Tier 3 + Tier 4 → may join iff ANY of these holds against the
    //      viewer's { self ∪ descendants } set:
    //        a) board.createdBy in subtree
    //        b) explicit BoardMembers row (autoAdded=false) for self
    //        c) any task on the board with assignedTo / createdBy in subtree
    //        d) task_assignees junction in subtree
    //        e) task_owners    junction in subtree
    //
    // Previous implementation strictly required a BoardMembers row OR
    // board.createdBy === self for non-admin/manager users. That rejected
    // assignees whose auto-added BoardMembers row was missing (audit
    // confirmed 4 rows in production). Page-load visibility worked, so
    // the task SHOWED up but live updates never arrived — the symptom
    // users perceived as "task is missing / stale".
    //
    // Unauthorised users (canUserSeeBoard → false) do not join the room
    // and so do not receive any subsequent emitToBoard broadcasts.
    socket.on('board:join', async ({ boardId }) => {
      if (!boardId) return;
      try {
        const allowed = await boardVisibility.canUserSeeBoard(socket.user, boardId);
        if (allowed) socket.join(`board:${boardId}`);
      } catch (err) {
        console.error(`[Socket] board:join error for ${socket.user.name}:`, err.message);
      }
    });

    socket.on('board:leave', ({ boardId }) => {
      if (boardId) {
        socket.leave(`board:${boardId}`);
        console.log(`[Socket] ${socket.user.name} left board:${boardId}`);
      }
    });

    // ── Rate limiting for socket events ──
    const eventCounts = {};
    const RATE_LIMIT = 30; // max events per 10 seconds
    const RATE_WINDOW = 10000;
    function isRateLimited(eventName) {
      const now = Date.now();
      if (!eventCounts[eventName]) eventCounts[eventName] = [];
      eventCounts[eventName] = eventCounts[eventName].filter(t => now - t < RATE_WINDOW);
      if (eventCounts[eventName].length >= RATE_LIMIT) return true;
      eventCounts[eventName].push(now);
      return false;
    }

    // ── Typing indicators (optional, forwarded to board) ──
    socket.on('task:typing', ({ boardId, taskId }) => {
      if (isRateLimited('task:typing')) return;
      socket.to(`board:${boardId}`).emit('task:typing', {
        taskId,
        user: socket.user,
      });
    });

    socket.on('task:stopTyping', ({ boardId, taskId }) => {
      socket.to(`board:${boardId}`).emit('task:stopTyping', {
        taskId,
        user: socket.user,
      });
    });

    // ── Disconnect ────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      console.log(`[Socket] User disconnected: ${socket.user.name} (${reason})`);
    });
  });

  ioInstance = io;
  return io;
};

/**
 * Retrieve the live Socket.io instance.
 */
const getIO = () => {
  if (!ioInstance) {
    throw new Error('Socket.io has not been initialised. Call initializeSocket first.');
  }
  return ioInstance;
};

// ─── Convenience emitters ─────────────────────────────────────

/** Emit an event to everyone in a board room. */
const emitToBoard = (boardId, event, data) => {
  if (ioInstance) {
    ioInstance.to(`board:${boardId}`).emit(event, data);
  }
};

/**
 * Emit an event ONLY to the specified user rooms — never the board room.
 *
 * Used by realtime task events that carry task-row data: the recipient list
 * is computed via taskVisibilityService.getAuthorizedRealtimeRecipients() so
 * we cannot leak Muskan's manager-only task to a board-room subscriber like
 * Shubhanshu just because he had the board open.
 *
 * Dedup is implicit (Set semantics on userIds). Empty list is a no-op.
 */
const emitToUsers = (event, data, userIds = []) => {
  if (!ioInstance || !Array.isArray(userIds) || userIds.length === 0) return;
  const seen = new Set();
  for (const uid of userIds) {
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    ioInstance.to(`user:${uid}`).emit(event, data);
  }
};

/**
 * Emit an event to a specific user's personal room. Also sends a Web Push
 * for `notification:new` events so the OS-tray notification fires even when
 * the tab is unfocused or closed.
 *
 * The push payload carries the notification id, entity type, entity id, and
 * board id so the service worker can:
 *   1. Use a stable `notif-<id>` tag (prevents silent collapse + dedupes
 *      with any foreground-rendered notification using the same tag).
 *   2. Build a deep-link path even if the backend `url` is generic.
 */
const emitToUser = (userId, event, data) => {
  if (ioInstance) {
    ioInstance.to(`user:${userId}`).emit(event, data);
  }
  if (event === 'notification:new' && data?.notification?.message) {
    try {
      const { sendPushToUser } = require('./pushService');
      const n = data.notification;
      const entityType = n.entityType || null;
      const entityId = n.entityId || null;
      const boardId = n.boardId || data?.boardId || null;
      let url = '/';
      if (entityType === 'task' && entityId) {
        url = boardId ? `/boards/${boardId}?taskId=${entityId}` : `/my-work?taskId=${entityId}`;
      } else if (entityType === 'board' && entityId) {
        url = `/boards/${entityId}`;
      } else if (entityType === 'meeting') {
        url = '/meetings';
      } else if (entityType === 'access_request') {
        url = '/access-requests';
      } else if (entityType === 'help_request' || entityType === 'dependency_request') {
        url = '/cross-team';
      }
      sendPushToUser(userId, {
        title: 'Monday Aniston',
        body: n.message,
        tag: `notif-${n.id || Date.now()}`,
        notificationId: n.id || null,
        entityType,
        entityId,
        boardId,
        url,
      }).catch(() => {}); // Silently ignore push failures
    } catch (e) { /* pushService not available */ }
  }
};

/**
 * Emit a task/board event to everyone in the board room AND fan out to any
 * affected users (assignees, supervisors, watchers, creator) whose socket
 * is NOT currently in that board room — i.e. they're on HomePage, MyWork,
 * Dashboard, or a different board, but still need to know.
 *
 * Dedupes by skipping users already covered by the board-room broadcast,
 * so handlers don't fire twice in those tabs.
 *
 * RBAC note: payload is the same as emitToBoard. Affected user IDs MUST be
 * users who are authorised to see the task (assignees etc. are by definition
 * authorised). The frontend always re-fetches via the authorised API after
 * receiving the event, so a permission revoke between emit and refetch is
 * handled cleanly (refetch 403s, frontend drops the row).
 *
 * Single-instance only; for multi-replica deployments wire up the Redis
 * adapter (see TODO at top of socketService.js).
 */
const emitToBoardAndUsers = async (boardId, event, data, affectedUserIds = []) => {
  if (!ioInstance) return;
  if (boardId) ioInstance.to(`board:${boardId}`).emit(event, data);
  if (!Array.isArray(affectedUserIds) || affectedUserIds.length === 0) return;

  // Find which affected users already received the event via the board room
  // so we don't fire it twice on those tabs.
  let usersInBoardRoom = new Set();
  if (boardId) {
    try {
      const sockets = await ioInstance.in(`board:${boardId}`).fetchSockets();
      // Single-instance fetchSockets returns local Socket objects (so
      // s.user is available); RemoteSocket from a Redis adapter only
      // exposes .data — read both so this works in either deployment.
      usersInBoardRoom = new Set(
        sockets.map(s => s.user?.id || s.data?.userId).filter(Boolean)
      );
    } catch (err) {
      // fetchSockets is async-only; if it fails, fall back to broadcasting
      // to user rooms unconditionally (worst case: handlers fire twice on
      // tabs that have the board open — refetch is idempotent).
      console.warn('[Socket] fetchSockets failed, falling back:', err.message);
    }
  }

  const seen = new Set();
  for (const uid of affectedUserIds) {
    if (!uid || seen.has(uid) || usersInBoardRoom.has(uid)) continue;
    seen.add(uid);
    ioInstance.to(`user:${uid}`).emit(event, data);
  }
};

/**
 * Force every active socket of a given user to leave a specific board room.
 * Used when board access is revoked while the user is connected — without
 * this, their socket would keep receiving emitToBoard broadcasts for a
 * board they're no longer authorised to see.
 *
 * Single-instance: walks local sockets directly. With a Redis adapter
 * fetchSockets returns RemoteSocket instances which expose .leave() too,
 * so this remains correct under horizontal scaling.
 *
 * Returns the count of sockets that left, for caller-side logging.
 */
const forceUserLeaveBoard = async (userId, boardId) => {
  if (!ioInstance || !userId || !boardId) return 0;
  const room = `board:${boardId}`;
  let count = 0;
  try {
    const sockets = await ioInstance.in(`user:${userId}`).fetchSockets();
    for (const s of sockets) {
      const sUserId = s.user?.id || s.data?.userId;
      if (sUserId !== userId) continue; // defensive — should never happen
      if (s.rooms?.has?.(room) || s.rooms?.includes?.(room)) {
        await s.leave(room);
        count += 1;
      }
    }
  } catch (err) {
    console.warn('[Socket] forceUserLeaveBoard failed:', err.message);
  }
  return count;
};

/**
 * Force-disconnect every active socket for a given user. Called by:
 *   - the /api/auth/logout endpoint (event: 'auth:logout', reason:
 *     'user_logged_out') — the just-logged-out browser stops receiving
 *     live events even if its JWT is technically still valid.
 *   - the single-active-session force-login flow (event:
 *     'auth:force_logout', reason: 'forced_other_device') — the OTHER
 *     device's tab receives the event and renders a clean "you were
 *     signed out because…" banner before its socket closes.
 *
 * If `socketId` is provided, only the specific socket disconnects — used for
 * single-tab logout when the client reports its own socket id.
 *
 * `options.event` and `options.payload` let callers pick the wire event
 * and payload shape. Defaults preserve the pre-feature contract so
 * existing callers (logout endpoint) keep working unchanged.
 *
 * Returns the count of sockets disconnected.
 */
const disconnectUser = async (userId, socketId = null, options = {}) => {
  if (!ioInstance || !userId) return 0;
  const event = options.event || 'auth:logout';
  const payload = options.payload || { reason: 'user_logged_out' };
  let count = 0;
  try {
    const sockets = await ioInstance.in(`user:${userId}`).fetchSockets();
    for (const s of sockets) {
      const sUserId = s.user?.id || s.data?.userId;
      if (sUserId !== userId) continue; // defensive
      if (socketId && s.id !== socketId) continue;
      try {
        // Tell the client first so it can disable auto-reconnect, then close.
        s.emit(event, payload);
        s.disconnect(true);
        count += 1;
      } catch (err) {
        console.warn('[Socket] disconnectUser per-socket failed:', err.message);
      }
    }
  } catch (err) {
    console.warn('[Socket] disconnectUser fetchSockets failed:', err.message);
  }
  return count;
};

/**
 * Broadcast an event to EVERY authenticated socket. Use sparingly — most
 * events should target a board room or specific user rooms. Reserved for
 * data that is org-wide and permission-gated at fetch time, e.g.
 * `org:hierarchy:changed` (every viewer's GET is gated by
 * requirePermission('org_chart','view'), so a stale event reaching a
 * forbidden tab is harmless — the tab just refetches and gets a 403,
 * which the existing AccessDenied flow already handles).
 *
 * No-op if Socket.io has not been initialised (e.g. during tests).
 */
const broadcastAll = (event, data) => {
  if (!ioInstance) return;
  ioInstance.emit(event, data);
};

module.exports = {
  initializeSocket,
  getIO,
  emitToBoard,
  emitToUser,
  emitToUsers,
  emitToBoardAndUsers,
  broadcastAll,
  forceUserLeaveBoard,
  disconnectUser,
};
