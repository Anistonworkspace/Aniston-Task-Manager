import { useEffect, useRef } from 'react';
import { getSocket } from '../services/socket';

export default function useSocket(event, callback) {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handler = (...args) => {
      if (callbackRef.current) callbackRef.current(...args);
    };

    socket.on(event, handler);

    return () => {
      socket.off(event, handler);
    };
  }, [event]);
}
