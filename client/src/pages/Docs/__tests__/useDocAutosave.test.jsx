import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';

vi.mock('../../../services/docsService', () => ({
  updateDoc: vi.fn(),
}));

// Keep errorMap predictable — return the backend message verbatim.
vi.mock('../../../utils/errorMap', () => ({
  getErrorMessage: (err) =>
    (err && err.response && err.response.data && err.response.data.message) ||
    (err && err.message) ||
    'Something went wrong',
}));

// safeLog is a default export with debug/info/warn/error methods.
vi.mock('../../../utils/safeLog', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { updateDoc } from '../../../services/docsService';
import useDocAutosave from '../useDocAutosave';

// Lightweight harness — mirrors the pattern used in useSidekickChat tests.
function Harness({ hookProps, captureRef }) {
  const hook = useDocAutosave(hookProps || {});
  React.useEffect(() => {
    captureRef.current = hook;
  });
  return (
    <div>
      <div data-testid="status">{hook.status}</div>
      <div data-testid="error">{hook.error || ''}</div>
      <div data-testid="saved-at">{hook.lastSavedAt ? hook.lastSavedAt.toISOString() : ''}</div>
    </div>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // If a test used fake timers, restore real timers so subsequent tests aren't
  // affected. vi.useRealTimers() is a no-op when timers are already real.
  vi.useRealTimers();
});

describe('useDocAutosave', () => {
  it("starts with status='idle' and no lastSavedAt", () => {
    const captureRef = React.createRef();
    const { getByTestId } = render(
      <Harness hookProps={{ docId: 'd1', debounceMs: 100 }} captureRef={captureRef} />
    );
    expect(getByTestId('status').textContent).toBe('idle');
    expect(getByTestId('saved-at').textContent).toBe('');
    expect(captureRef.current.lastSavedAt).toBeNull();
  });

  it("scheduleSave sets status='dirty' and fires updateDoc after the debounce window", async () => {
    vi.useFakeTimers();
    let resolveSave;
    updateDoc.mockReturnValue(
      new Promise((r) => {
        resolveSave = r;
      })
    );
    const captureRef = React.createRef();
    const { getByTestId } = render(
      <Harness hookProps={{ docId: 'd1', debounceMs: 100 }} captureRef={captureRef} />
    );

    act(() => {
      captureRef.current.scheduleSave({ contentJson: { v: 1 } });
    });
    expect(getByTestId('status').textContent).toBe('dirty');
    expect(updateDoc).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(updateDoc).toHaveBeenCalledTimes(1);
    expect(updateDoc).toHaveBeenCalledWith('d1', { contentJson: { v: 1 } });

    // Drain the in-flight promise so the hook leaves the saving state cleanly.
    await act(async () => {
      resolveSave({ doc: { id: 'd1' } });
      await Promise.resolve();
    });
  });

  it('coalesces multiple scheduleSave calls — only the latest patch is sent once', async () => {
    vi.useFakeTimers();
    let resolveSave;
    updateDoc.mockReturnValue(
      new Promise((r) => {
        resolveSave = r;
      })
    );
    const captureRef = React.createRef();
    render(<Harness hookProps={{ docId: 'd1', debounceMs: 100 }} captureRef={captureRef} />);

    act(() => {
      captureRef.current.scheduleSave({ contentJson: { v: 1 } });
      captureRef.current.scheduleSave({ contentJson: { v: 2 } });
      captureRef.current.scheduleSave({ contentJson: { v: 3 } });
    });
    act(() => {
      vi.advanceTimersByTime(120);
    });

    expect(updateDoc).toHaveBeenCalledTimes(1);
    expect(updateDoc).toHaveBeenCalledWith('d1', { contentJson: { v: 3 } });

    await act(async () => {
      resolveSave({ doc: { id: 'd1' } });
      await Promise.resolve();
    });
  });

  it("on successful save → status='saved' and lastSavedAt is set", async () => {
    updateDoc.mockResolvedValue({ doc: { id: 'd1' } });
    const captureRef = React.createRef();
    const { getByTestId } = render(
      <Harness hookProps={{ docId: 'd1', debounceMs: 50 }} captureRef={captureRef} />
    );

    // Use `flush(patch)` instead of `scheduleSave(patch)` here. Both
    // exercise the same success state machine, but `flush` calls send()
    // synchronously without a setTimeout. The earlier scheduleSave path
    // raced with @testing-library's 50ms waitFor poll under heavy load
    // (debounceMs=50 + poll=50 → flaky on slow CI). See May-17 test
    // hardening notes.
    await act(async () => {
      await captureRef.current.flush({ contentJson: { v: 1 } });
    });

    await waitFor(() => expect(getByTestId('status').textContent).toBe('saved'));
    expect(captureRef.current.lastSavedAt).toBeInstanceOf(Date);
  });

  it("on failed save → status='error' and error is populated", async () => {
    updateDoc.mockRejectedValue({ response: { data: { message: 'Save blew up' } } });
    const captureRef = React.createRef();
    const { getByTestId } = render(
      <Harness hookProps={{ docId: 'd1', debounceMs: 50 }} captureRef={captureRef} />
    );

    // Same flake-mitigation as the success case above — flush() instead
    // of scheduleSave() avoids the timer/poll race. flush() re-throws on
    // failure (May 2026: lets Ctrl+S surface a precise error toast); we
    // catch here because the assertions below own the verification.
    await act(async () => {
      await captureRef.current.flush({ contentJson: { v: 1 } }).catch(() => { /* expected */ });
    });

    await waitFor(() => expect(getByTestId('status').textContent).toBe('error'));
    expect(getByTestId('error').textContent).toBe('Save blew up');
  });

  it('flush() re-throws on failure so Ctrl+S can show an error toast', async () => {
    updateDoc.mockRejectedValue({ response: { data: { message: 'Network down' } } });
    const captureRef = React.createRef();
    render(<Harness hookProps={{ docId: 'd1', debounceMs: 10000 }} captureRef={captureRef} />);

    let captured = null;
    await act(async () => {
      try {
        await captureRef.current.flush({ contentJson: { v: 1 } });
      } catch (err) {
        captured = err;
      }
    });
    expect(captured).toBeTruthy();
  });

  it('onError callback fires with the user-facing message on failed save', async () => {
    updateDoc.mockRejectedValue({ response: { data: { message: 'Boom' } } });
    const onError = vi.fn();
    const captureRef = React.createRef();
    render(
      <Harness
        hookProps={{ docId: 'd1', debounceMs: 10000, onError }}
        captureRef={captureRef}
      />
    );

    await act(async () => {
      await captureRef.current.flush({ contentJson: { v: 1 } }).catch(() => { /* expected */ });
    });

    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0][0]).toBe('Boom');
  });

  it('flush({title}) bypasses the debounce timer and saves immediately', async () => {
    updateDoc.mockResolvedValue({ doc: { id: 'd1', title: 'New' } });
    const captureRef = React.createRef();
    render(<Harness hookProps={{ docId: 'd1', debounceMs: 10000 }} captureRef={captureRef} />);

    await act(async () => {
      await captureRef.current.flush({ title: 'New' });
    });

    // Even though debounceMs is 10s we never advanced any timers — flush
    // should have called updateDoc synchronously past its internal awaits.
    expect(updateDoc).toHaveBeenCalledTimes(1);
    expect(updateDoc).toHaveBeenCalledWith('d1', { title: 'New' });
  });

  it('onSaved callback fires with the returned doc on success', async () => {
    const doc = { id: 'd1', title: 'After save' };
    updateDoc.mockResolvedValue({ doc });
    const onSaved = vi.fn();
    const captureRef = React.createRef();
    render(
      <Harness
        hookProps={{ docId: 'd1', debounceMs: 10000, onSaved }}
        captureRef={captureRef}
      />
    );

    await act(async () => {
      await captureRef.current.flush({ title: 'After save' });
    });

    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith(doc);
  });

  it('noop when docId is null/undefined — never calls updateDoc', async () => {
    vi.useFakeTimers();
    const captureRef = React.createRef();
    const { getByTestId } = render(
      <Harness hookProps={{ docId: null, debounceMs: 100 }} captureRef={captureRef} />
    );

    act(() => {
      captureRef.current.scheduleSave({ contentJson: { v: 1 } });
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(updateDoc).not.toHaveBeenCalled();
    expect(getByTestId('status').textContent).toBe('idle');

    // flush should also be a noop — send() short-circuits on !docId.
    await act(async () => {
      await captureRef.current.flush({ title: 'X' });
    });
    expect(updateDoc).not.toHaveBeenCalled();
  });
});
