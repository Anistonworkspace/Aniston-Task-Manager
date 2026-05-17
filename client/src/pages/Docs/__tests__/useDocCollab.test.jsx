import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';

/* ──────────────────────────────────────────────────────────────
 * Phase G — useDocCollab smoke tests.
 *
 * We mock both @hocuspocus/provider AND yjs so the tests run in jsdom
 * without spinning up a real WebSocket. The mocked HocuspocusProvider
 * exposes the same on/awareness/destroy surface useDocCollab depends on
 * plus a `__emit(event, payload)` test helper so we can simulate status
 * transitions deterministically.
 * ────────────────────────────────────────────────────────────── */

// Hoisted so the vi.mock factories can reach into them.
const { providerInstances, ydocInstances } = vi.hoisted(() => ({
  providerInstances: [],
  ydocInstances: [],
}));

vi.mock('@hocuspocus/provider', () => {
  class HocuspocusProvider {
    constructor(opts) {
      this.opts = opts;
      this._listeners = {};
      this.destroyed = false;
      // Minimal awareness shim — getStates().size feeds the peer count;
      // setLocalStateField is called by the hook to publish user identity.
      this._awarenessListeners = {};
      this.awareness = {
        getStates: () => new Map([[1, { user: { name: 'me' } }]]),
        on: (event, handler) => {
          this._awarenessListeners[event] = this._awarenessListeners[event] || [];
          this._awarenessListeners[event].push(handler);
        },
        setLocalStateField: vi.fn(),
      };
      this.setAwarenessField = vi.fn();
      providerInstances.push(this);
    }
    on(event, handler) {
      this._listeners[event] = this._listeners[event] || [];
      this._listeners[event].push(handler);
    }
    destroy() {
      this.destroyed = true;
      this._listeners = {};
    }
    __emit(event, payload) {
      (this._listeners[event] || []).forEach((h) => h(payload));
    }
    __emitAwarenessChange() {
      (this._awarenessListeners.change || []).forEach((h) => h());
    }
  }
  return { HocuspocusProvider };
});

vi.mock('yjs', () => {
  class Doc {
    constructor() {
      this.destroyed = false;
      ydocInstances.push(this);
    }
    destroy() { this.destroyed = true; }
  }
  return { Doc };
});

vi.mock('../../../services/api', () => ({
  default: {
    post: vi.fn(),
  },
}));

vi.mock('../../../utils/safeLog', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import api from '../../../services/api';
import { HocuspocusProvider } from '@hocuspocus/provider';
import useDocCollab from '../useDocCollab';

function Harness({ hookProps, captureRef }) {
  const hook = useDocCollab(hookProps);
  React.useEffect(() => {
    captureRef.current = hook;
  });
  return (
    <div>
      <div data-testid="status">{hook.status}</div>
      <div data-testid="peers">{String(hook.peerCount)}</div>
      <div data-testid="error">{hook.error ? hook.error.message : ''}</div>
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  providerInstances.length = 0;
  ydocInstances.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDocCollab', () => {
  it("returns 'disabled' state and never fetches a ticket when enabled=false", async () => {
    const captureRef = React.createRef();
    const { getByTestId } = render(
      <Harness hookProps={{ docId: 'd1', enabled: false }} captureRef={captureRef} />,
    );
    // Give any unintended async work a tick to land.
    await act(async () => { await Promise.resolve(); });
    expect(getByTestId('status').textContent).toBe('disabled');
    expect(api.post).not.toHaveBeenCalled();
    expect(providerInstances.length).toBe(0);
  });

  it("POSTs /docs-collab/ticket with the docId when enabled=true", async () => {
    // Never-resolving promise keeps us in 'connecting' so we can inspect
    // what was sent without dealing with the rest of the lifecycle.
    api.post.mockReturnValue(new Promise(() => {}));
    const captureRef = React.createRef();
    render(
      <Harness
        hookProps={{ docId: 'doc-42', enabled: true, currentUser: { id: 'u1', name: 'Sara' } }}
        captureRef={captureRef}
      />,
    );
    await act(async () => { await Promise.resolve(); });
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith(
      '/docs-collab/ticket',
      { docId: 'doc-42' },
      expect.objectContaining({ _silent: true }),
    );
  });

  it("surfaces a flagged migration error when the server replies 409 'not migrated'", async () => {
    api.post.mockRejectedValue({
      response: { status: 409, data: { message: 'Doc not migrated for collab' } },
    });
    const captureRef = React.createRef();
    const { getByTestId } = render(
      <Harness hookProps={{ docId: 'd1', enabled: true }} captureRef={captureRef} />,
    );
    await waitFor(() => expect(getByTestId('status').textContent).toBe('error'));
    expect(getByTestId('error').textContent).toMatch(/not migrated/i);
    expect(captureRef.current.error._collabMigrationMissing).toBe(true);
    // No provider should have been constructed for a failed ticket fetch.
    expect(providerInstances.length).toBe(0);
  });

  it("surfaces an auth failure error when the ticket endpoint returns 403", async () => {
    api.post.mockRejectedValue({
      response: { status: 403, data: { message: 'forbidden' } },
    });
    const captureRef = React.createRef();
    const { getByTestId } = render(
      <Harness hookProps={{ docId: 'd1', enabled: true }} captureRef={captureRef} />,
    );
    await waitFor(() => expect(getByTestId('status').textContent).toBe('error'));
    expect(captureRef.current.error._authFailure).toBe(true);
    expect(providerInstances.length).toBe(0);
  });

  it("instantiates HocuspocusProvider with the ticket + docId once the ticket resolves", async () => {
    api.post.mockResolvedValue({ data: { data: { ticket: 'jwt-abc' } } });
    const captureRef = React.createRef();
    render(
      <Harness
        hookProps={{ docId: 'd1', enabled: true, currentUser: { id: 'u1', name: 'Sara' } }}
        captureRef={captureRef}
      />,
    );
    await waitFor(() => expect(providerInstances.length).toBe(1));
    const inst = providerInstances[0];
    expect(inst.opts.name).toBe('d1');
    expect(inst.opts.token).toBe('jwt-abc');
    expect(inst.opts.url).toMatch(/\/api\/docs-collab\/ws$/);
    expect(inst.opts.document).toBeDefined();
    expect(ydocInstances.length).toBe(1);
  });

  it("transitions to 'connected' once the provider emits status=connected and tracks peers", async () => {
    api.post.mockResolvedValue({ data: { data: { ticket: 'jwt-abc' } } });
    const captureRef = React.createRef();
    const { getByTestId } = render(
      <Harness
        hookProps={{ docId: 'd1', enabled: true, currentUser: { id: 'u1', name: 'Sara' } }}
        captureRef={captureRef}
      />,
    );
    await waitFor(() => expect(providerInstances.length).toBe(1));
    const inst = providerInstances[0];
    expect(getByTestId('status').textContent).toBe('connecting');

    act(() => { inst.__emit('status', { status: 'connected' }); });
    await waitFor(() => expect(getByTestId('status').textContent).toBe('connected'));

    // Peer count starts at 0 (only self in awareness map). Simulate two
    // other peers joining by replacing the awareness map size.
    inst.awareness.getStates = () => new Map([[1, {}], [2, {}], [3, {}]]);
    act(() => { inst.__emitAwarenessChange(); });
    await waitFor(() => expect(getByTestId('peers').textContent).toBe('2'));
  });

  it("destroys the provider AND the Y.Doc on unmount", async () => {
    api.post.mockResolvedValue({ data: { data: { ticket: 'jwt-abc' } } });
    const captureRef = React.createRef();
    const { unmount } = render(
      <Harness
        hookProps={{ docId: 'd1', enabled: true, currentUser: { id: 'u1', name: 'Sara' } }}
        captureRef={captureRef}
      />,
    );
    await waitFor(() => expect(providerInstances.length).toBe(1));
    const inst = providerInstances[0];
    const ydoc = ydocInstances[0];
    expect(inst.destroyed).toBe(false);
    expect(ydoc.destroyed).toBe(false);

    unmount();

    expect(inst.destroyed).toBe(true);
    expect(ydoc.destroyed).toBe(true);
  });
});
