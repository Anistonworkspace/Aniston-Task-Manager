import { io } from 'socket.io-client';
import safeLog from '../utils/safeLog';
import { getSocketUrl } from '../utils/runtime';

let socket = null;

// Set when the user logs out so the auto-reconnect logic refuses to bring the
// socket back up before a fresh login. Cleared on next successful connect()
// call (which only happens with a valid token).
let logoutLatch = false;

// Board rooms the app wants to be in. We keep this on the module so we can
// re-join after a reconnect, AND so a joinBoard() call that happens before
// the socket finishes its initial handshake doesn't get silently dropped
// (the previous version of emit() bailed if !socket.connected, which was
// the primary cause of "I don't see updates until I refresh").
const desiredBoardRooms = new Set();

// Listeners that fire every time the socket transitions to connected
// (initial connect AND after a reconnect). useSocket() uses this to (re-)attach
// event listeners that may have been registered before the socket was ready.
const connectListeners = new Set();

export function connect(token) {
  if (socket) {
    // Already created — just make sure auth is current. We don't tear down
    // and rebuild on every call because AuthContext can call connect() more
    // than once (login + loadUser). Tearing down would drop active rooms
    // and listeners.
    return socket;
  }

  // Logout latch is cleared the moment connect() is called with a token —
  // the only legitimate caller is AuthContext.login / loadUser after the
  // user is authenticated. Without this, a stale token in storage could
  // technically reconnect after logout.
  logoutLatch = false;

  // D-1 Phase 2: cookies carry the auth on the handshake (withCredentials:
  // true makes the browser attach them on the upgrade request). The auth
  // payload is still passed when a `token` is supplied — useful for legacy
  // callers and for manual connect attempts in tests — but the production
  // browser flow no longer relies on a JS-readable token.
  // Web → window.location.origin (same-origin handshake), desktop →
  // 'https://monday.anistonav.com' (read from the preload's runtime
  // config). Under file:// origin, window.location.origin is 'file://'
  // and socket.io-client cannot connect — so resolving via the runtime
  // helper is mandatory for the packaged desktop app.
  socket = io(getSocketUrl(), {
    auth: token ? { token } : {},
    withCredentials: true,
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
  });

  // Fires on initial connect AND after every successful reconnect.
  socket.on('connect', () => {
    // If a logout happened between the network reconnect attempt and the
    // upgrade completing, refuse to stay connected — even though the server
    // accepted the handshake. Belt-and-suspenders for the "stale token in
    // storage" case.
    if (logoutLatch) {
      try { socket.disconnect(); } catch { /* ignore */ }
      return;
    }
    console.log('[Socket] connected:', socket.id);
    // Re-join every board room the app wants to be in. This covers two
    // critical cases:
    //   1. joinBoard(boardId) was called before the handshake completed
    //      — the emit was queued here, not sent to a not-yet-connected
    //      socket where it would have been dropped.
    //   2. The socket dropped (network blip, laptop sleep) and reconnected
    //      — without this, the user silently leaves every board room and
    //      stops receiving any task events.
    desiredBoardRooms.forEach((boardId) => {
      socket.emit('board:join', { boardId });
    });
    connectListeners.forEach((cb) => {
      try { cb(); } catch (err) { safeLog.error('[Socket] connect listener threw', err); }
    });
  });

  socket.on('disconnect', (reason) => {
    console.log('[Socket] disconnected:', reason);
  });

  socket.on('connect_error', (err) => {
    safeLog.error('[Socket] connection error', err);
  });

  // Server-side logout signal — when the backend force-disconnects this
  // user's sockets (logout endpoint, password change, deactivation), the
  // server emits 'auth:logout' just before closing. We latch the local
  // flag so the auto-reconnect machinery doesn't bring the socket back up
  // with the now-revoked-context token.
  socket.on('auth:logout', () => {
    logoutLatch = true;
    try { socket.disconnect(); } catch { /* ignore */ }
  });

  // Single-active-session: server emits this on the OLD socket(s) when a
  // new device confirms the takeover via /auth/login/force or
  // /auth/login/force-sso. AuthContext's listener handles the user-
  // visible cleanup (state reset + redirect to /login with a banner);
  // we just latch out so reconnect doesn't fire against a now-revoked
  // session.
  socket.on('auth:force_logout', () => {
    logoutLatch = true;
    try { socket.disconnect(); } catch { /* ignore */ }
  });

  return socket;
}

/**
 * Hard-disconnect the current socket and forbid auto-reconnect until the next
 * connect() call (which only happens after a fresh login). Used by the
 * AuthContext logout flow.
 *
 * Differs from disconnect() in that:
 *   - It sets the logoutLatch — even if some background timer or stale
 *     event tries to reconnect, the on-connect handler will refuse.
 *   - It clears desiredBoardRooms and the socket reference.
 */
export function disconnectForLogout() {
  logoutLatch = true;
  if (socket) {
    try {
      socket.removeAllListeners();
      socket.disconnect();
    } catch (err) {
      safeLog.warn('[Socket] disconnectForLogout failed', err);
    }
    socket = null;
  }
  desiredBoardRooms.clear();
}

export function disconnect() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  // Clear desired rooms on logout so the next user doesn't inherit them.
  desiredBoardRooms.clear();
}

export function getSocket() {
  return socket;
}

export function getSocketId() {
  return socket?.id || null;
}

export function emit(event, data) {
  if (socket && socket.connected) {
    socket.emit(event, data);
  }
}

export function subscribe(event, callback) {
  if (socket) {
    socket.on(event, callback);
  }
  return () => {
    if (socket) {
      socket.off(event, callback);
    }
  };
}

export function joinBoard(boardId) {
  if (!boardId) return;
  desiredBoardRooms.add(boardId);
  if (socket && socket.connected) {
    socket.emit('board:join', { boardId });
  }
  // If the socket isn't connected yet, the 'connect' handler above will
  // replay every desired room. No silent drop.
}

export function leaveBoard(boardId) {
  if (!boardId) return;
  desiredBoardRooms.delete(boardId);
  if (socket && socket.connected) {
    socket.emit('board:leave', { boardId });
  }
}

/**
 * Register a callback for every successful (re)connect. Returns an
 * unsubscribe function. Used by useSocket() to wake up listeners that
 * registered before the socket was ready.
 */
export function onConnect(callback) {
  connectListeners.add(callback);
  return () => { connectListeners.delete(callback); };
}
