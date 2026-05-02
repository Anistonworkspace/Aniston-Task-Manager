const jwt = require('jsonwebtoken');
const { User, Board } = require('../models');

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
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;

      if (!token) {
        return next(new Error('Authentication required'));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findByPk(decoded.id);

      if (!user || !user.isActive) {
        return next(new Error('Invalid or inactive user'));
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

    // ── Board room management (with membership check) ─────
    socket.on('board:join', async ({ boardId }) => {
      if (!boardId) return;
      try {
        // Admins and managers can join any board room
        if (socket.user.role === 'admin' || socket.user.role === 'manager') {
          socket.join(`board:${boardId}`);
          return;
        }
        // Members: verify board membership
        const board = await Board.findByPk(boardId, {
          include: [{ model: User, as: 'members', attributes: ['id'], through: { attributes: [] } }],
        });
        if (!board) return;
        const isMember = board.members?.some(m => m.id === socket.user.id);
        if (isMember || board.createdBy === socket.user.id) {
          socket.join(`board:${boardId}`);
        }
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

/** Emit an event to a specific user's personal room. Also sends push notification for notification:new events. */
const emitToUser = (userId, event, data) => {
  if (ioInstance) {
    ioInstance.to(`user:${userId}`).emit(event, data);
  }
  // Send push notification for new notifications (fire-and-forget)
  if (event === 'notification:new' && data?.notification?.message) {
    try {
      const { sendPushToUser } = require('./pushService');
      sendPushToUser(userId, {
        title: 'Monday Aniston',
        body: data.notification.message,
        tag: `notif-${data.notification.id || Date.now()}`,
        url: data.notification.entityType === 'task' ? '/my-work' : '/',
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

module.exports = {
  initializeSocket,
  getIO,
  emitToBoard,
  emitToUser,
  emitToUsers,
  emitToBoardAndUsers,
  forceUserLeaveBoard,
};
