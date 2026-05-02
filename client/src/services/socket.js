import { io } from 'socket.io-client';

let socket = null;

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

  socket = io(window.location.origin, {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
  });

  // Fires on initial connect AND after every successful reconnect.
  socket.on('connect', () => {
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
      try { cb(); } catch (err) { console.error('[Socket] connect listener threw:', err); }
    });
  });

  socket.on('disconnect', (reason) => {
    console.log('[Socket] disconnected:', reason);
  });

  socket.on('connect_error', (err) => {
    console.error('[Socket] connection error:', err.message);
  });

  return socket;
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
