import { io } from 'socket.io-client';

let socket = null;

export function connect(token) {
  if (socket && socket.connected) {
    return socket;
  }

  socket = io(window.location.origin, {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
  });

  socket.on('connect', () => {
    console.log('Socket connected:', socket.id);
  });

  socket.on('disconnect', (reason) => {
    console.log('Socket disconnected:', reason);
  });

  socket.on('connect_error', (err) => {
    console.error('Socket connection error:', err.message);
  });

  return socket;
}

export function disconnect() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
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
  emit('board:join', { boardId });
}

export function leaveBoard(boardId) {
  emit('board:leave', { boardId });
}
