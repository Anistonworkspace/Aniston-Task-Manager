import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

import api from '../../../services/api';
import useSidekickChat from '../useSidekickChat';

beforeEach(() => {
  vi.clearAllMocks();
  try { localStorage.clear(); } catch {}
  api.get.mockResolvedValue({ data: { success: true, data: { hasKey: true } } });
});

// Lightweight test harness — surface the hook's state on the DOM so we can
// assert on it without a full component shell.
function Harness({ hookProps, captureRef }) {
  const hook = useSidekickChat(hookProps || {});
  React.useEffect(() => { captureRef.current = hook; });
  return (
    <div>
      <div data-testid="status">{hook.status}</div>
      <div data-testid="count">{hook.messages.length}</div>
      <div data-testid="error">{hook.error || ''}</div>
    </div>
  );
}

describe('useSidekickChat', () => {
  it('starts idle with no messages', () => {
    const captureRef = React.createRef();
    const { getByTestId } = render(<Harness captureRef={captureRef} />);
    expect(getByTestId('status').textContent).toBe('idle');
    expect(getByTestId('count').textContent).toBe('0');
  });

  it('hydrates from `history` prop', () => {
    const captureRef = React.createRef();
    const history = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const { getByTestId } = render(
      <Harness hookProps={{ history }} captureRef={captureRef} />
    );
    expect(getByTestId('count').textContent).toBe('2');
  });

  it('appends user + assistant message on successful send', async () => {
    api.post.mockResolvedValue({ data: { success: true, data: { message: 'AI reply' } } });
    const captureRef = React.createRef();
    const { getByTestId } = render(<Harness captureRef={captureRef} />);

    await act(async () => {
      await captureRef.current.send('hi');
    });

    await waitFor(() => expect(getByTestId('count').textContent).toBe('2'));
    expect(getByTestId('status').textContent).toBe('idle');
    expect(captureRef.current.messages[0].role).toBe('user');
    expect(captureRef.current.messages[1].role).toBe('assistant');
    expect(captureRef.current.messages[1].content).toBe('AI reply');
  });

  it('records an error message when /ai/chat fails', async () => {
    api.post.mockRejectedValue({ response: { data: { message: 'Quota exhausted' } } });
    const captureRef = React.createRef();
    const { getByTestId } = render(<Harness captureRef={captureRef} />);

    await act(async () => {
      await captureRef.current.send('hi');
    });

    await waitFor(() => expect(getByTestId('status').textContent).toBe('error'));
    // user msg + error msg
    expect(getByTestId('count').textContent).toBe('2');
    expect(captureRef.current.messages[1].role).toBe('error');
  });

  it('reset() clears messages and persistence', async () => {
    api.post.mockResolvedValue({ data: { success: true, data: { message: 'ok' } } });
    const captureRef = React.createRef();
    const historyKey = 'sidekick:chat:test';
    render(<Harness hookProps={{ historyKey }} captureRef={captureRef} />);

    await act(async () => {
      await captureRef.current.send('hi');
    });
    expect(captureRef.current.messages.length).toBe(2);
    expect(localStorage.getItem(historyKey)).toBeTruthy();

    act(() => captureRef.current.reset());
    expect(captureRef.current.messages.length).toBe(0);
    // reset() does removeItem(), then the persistence effect re-syncs the
    // empty state back to storage as "[]". Either is "cleared" — assert on
    // the effective contents rather than the storage key's presence.
    const after = localStorage.getItem(historyKey);
    expect(after === null || after === '[]').toBe(true);
  });

  it('persists messages to localStorage when historyKey is set', async () => {
    api.post.mockResolvedValue({ data: { success: true, data: { message: 'ok' } } });
    const captureRef = React.createRef();
    const historyKey = 'sidekick:chat:abc';
    render(<Harness hookProps={{ historyKey }} captureRef={captureRef} />);

    await act(async () => {
      await captureRef.current.send('hi');
    });

    const stored = JSON.parse(localStorage.getItem(historyKey));
    expect(stored).toHaveLength(2);
  });

  it('ignores duplicate sends while in-flight', async () => {
    let resolveFn;
    api.post.mockReturnValue(new Promise((r) => { resolveFn = r; }));
    const captureRef = React.createRef();
    render(<Harness captureRef={captureRef} />);

    await act(async () => { captureRef.current.send('first'); });
    expect(captureRef.current.status).toBe('thinking');
    // Second send while thinking — should be a no-op.
    await act(async () => { captureRef.current.send('second'); });
    expect(captureRef.current.messages.filter((m) => m.role === 'user').length).toBe(1);

    await act(async () => {
      resolveFn({ data: { success: true, data: { message: 'ok' } } });
    });
  });
});
