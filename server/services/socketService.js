const jwt = require('jsonwebtoken');
const { User, Board } = require('../models');

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

module.exports = {
  initializeSocket,
  getIO,
  emitToBoard,
  emitToUser,
};
