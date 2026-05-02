import { useEffect, useRef, useState } from 'react';
import { getSocket, onConnect } from '../services/socket';

/**
 * Subscribe to a server-emitted socket event for the lifetime of the
 * calling component.
 *
 * Behaviour:
 *   - Stable callback identity isn't required: the latest `callback` is
 *     held in a ref and invoked by a stable `handler`, so passing an
 *     inline arrow function does NOT cause re-attach churn.
 *   - The listener is (re-)attached on every transition into the connected
 *     state. This fixes a long-standing bug where a component mounted
 *     before the socket finished its handshake — getSocket() returned null,
 *     the previous implementation bailed for the lifetime of the component,
 *     and the user had to refresh the page to ever receive events.
 *   - On reconnect (network drop / laptop sleep), the listener is detached
 *     and re-attached cleanly so we never accumulate ghost listeners on a
 *     stale socket reference.
 */
export default function useSocket(event, callback) {
  const callbackRef = useRef(callback);
  // Bumped on every (re)connect to force the attach effect to re-run.
  const [connectTick, setConnectTick] = useState(0);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  // Subscribe once to "socket connected" so we can wake up the attach
  // effect when the handshake finally completes (or when the socket
  // reconnects after a drop).
  useEffect(() => {
    const off = onConnect(() => setConnectTick((t) => t + 1));
    return off;
  }, []);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return undefined;

    const handler = (...args) => {
      if (callbackRef.current) callbackRef.current(...args);
    };

    socket.on(event, handler);
    return () => {
      socket.off(event, handler);
    };
  }, [event, connectTick]);
}
