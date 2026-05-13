import React, { useImperativeHandle, forwardRef } from 'react';
import { render, act } from '@testing-library/react';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import useNotificationBurstDispatcher from '../useNotificationBurstDispatcher';

// Pin the May 2026 storm-fix regression: a single task-assignment notification
// MUST fire its individual side effect (toast + showLocalNotification) without
// a 1500ms delay. The leading-edge dispatch + trailing-summary pattern is the
// contract being tested here.

// Tiny harness that exposes the hook's `dispatch` function via a ref so tests
// can call it directly (the alternative — mounting Header.jsx — drags in
// useAuth + useTheme + socket + ToastProvider, none of which exercise the
// dispatcher itself).
const Harness = forwardRef(function Harness({ onIndividual, onGrouped, threshold, windowMs }, ref) {
  const dispatch = useNotificationBurstDispatcher({ onIndividual, onGrouped, threshold, windowMs });
  useImperativeHandle(ref, () => ({ dispatch }), [dispatch]);
  return null;
});

function setup({ threshold = 3, windowMs = 1500 } = {}) {
  const onIndividual = vi.fn();
  const onGrouped = vi.fn();
  const ref = React.createRef();
  const utils = render(
    <Harness ref={ref} onIndividual={onIndividual} onGrouped={onGrouped} threshold={threshold} windowMs={windowMs} />
  );
  return { onIndividual, onGrouped, ref, ...utils };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useNotificationBurstDispatcher — single notification (regression fix)', () => {
  test('fires onIndividual IMMEDIATELY for a single event (no 1500ms wait)', () => {
    const { onIndividual, onGrouped, ref } = setup();

    act(() => {
      ref.current.dispatch({ n: { id: 'n1', type: 'task_assigned', message: 'assigned' } });
    });

    // CRITICAL: this is the regression fix. The leading event must fire
    // immediately, without advancing any timer. The pre-fix code only
    // dispatched on the trailing flush after 1500ms.
    expect(onIndividual).toHaveBeenCalledTimes(1);
    expect(onIndividual.mock.calls[0][0].n.type).toBe('task_assigned');
    expect(onGrouped).not.toHaveBeenCalled();
  });

  test('does NOT fire a grouped summary when only one event arrives', () => {
    const { onIndividual, onGrouped, ref } = setup();

    act(() => {
      ref.current.dispatch({ n: { id: 'n1', type: 'task_assigned', message: 'assigned' } });
    });
    act(() => { vi.advanceTimersByTime(1500); });

    // After the burst window closes with no late events, no summary fires.
    expect(onGrouped).not.toHaveBeenCalled();
    // The leading event still counts as exactly one individual dispatch.
    expect(onIndividual).toHaveBeenCalledTimes(1);
  });
});

describe('useNotificationBurstDispatcher — small burst (2 events, sub-threshold)', () => {
  test('fires the first immediately, then the second after the window closes', () => {
    const { onIndividual, onGrouped, ref } = setup();

    act(() => {
      ref.current.dispatch({ n: { id: 'a', type: 'task_assigned', message: 'one' } });
      ref.current.dispatch({ n: { id: 'b', type: 'comment_added', message: 'two' } });
    });

    // Only the leading event has fired so far — the second is in the buffer.
    expect(onIndividual).toHaveBeenCalledTimes(1);
    expect(onIndividual.mock.calls[0][0].n.id).toBe('a');

    act(() => { vi.advanceTimersByTime(1500); });

    // Now the trailing flush fires the second event as an individual
    // (below threshold-1 = 2 late events).
    expect(onIndividual).toHaveBeenCalledTimes(2);
    expect(onIndividual.mock.calls[1][0].n.id).toBe('b');
    expect(onGrouped).not.toHaveBeenCalled();
  });
});

describe('useNotificationBurstDispatcher — burst at threshold (3 events)', () => {
  test('fires 1 individual + 1 grouped summary for a 3-event burst (storm protection)', () => {
    const { onIndividual, onGrouped, ref } = setup();

    act(() => {
      ref.current.dispatch({ n: { id: 'a', type: 'task_assigned', message: 'one' } });
      ref.current.dispatch({ n: { id: 'b', type: 'recurring_missed', message: 'two' } });
      ref.current.dispatch({ n: { id: 'c', type: 'recurring_missed', message: 'three' } });
    });

    // Leading event fires immediately, the next two accumulate silently.
    expect(onIndividual).toHaveBeenCalledTimes(1);
    expect(onGrouped).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(1500); });

    // Trailing flush: 2 late events ≥ threshold-1 (2) → grouped summary.
    expect(onIndividual).toHaveBeenCalledTimes(1);
    expect(onGrouped).toHaveBeenCalledTimes(1);
    expect(onGrouped).toHaveBeenCalledWith(2); // late count, not total
  });

  test('30-event storm produces exactly 1 individual + 1 grouped summary', () => {
    // The original 6:30 PM storm scenario: an admin who is the escalation
    // target for many missed recurring tasks gets 30 notification:new
    // events in <1500ms. Pre-storm fix this rendered 30 toasts + 30 OS
    // notifications. The dispatcher must collapse to 2 side effects.
    const { onIndividual, onGrouped, ref } = setup();

    act(() => {
      for (let i = 0; i < 30; i += 1) {
        ref.current.dispatch({ n: { id: `n${i}`, type: 'recurring_missed', message: `msg ${i}` } });
      }
    });
    act(() => { vi.advanceTimersByTime(1500); });

    expect(onIndividual).toHaveBeenCalledTimes(1);
    expect(onGrouped).toHaveBeenCalledTimes(1);
    expect(onGrouped).toHaveBeenCalledWith(29); // 30 total − 1 leading
  });
});

describe('useNotificationBurstDispatcher — back-to-back bursts', () => {
  test('opens a fresh window after the previous one flushes', () => {
    const { onIndividual, onGrouped, ref } = setup();

    // Burst 1: single event.
    act(() => { ref.current.dispatch({ n: { id: 'a', type: 't1', message: 'a' } }); });
    act(() => { vi.advanceTimersByTime(1500); });
    expect(onIndividual).toHaveBeenCalledTimes(1);

    // Burst 2: another single event — must fire immediately, not stay
    // buried in some stale buffer.
    act(() => { ref.current.dispatch({ n: { id: 'b', type: 't2', message: 'b' } }); });
    expect(onIndividual).toHaveBeenCalledTimes(2);
    expect(onIndividual.mock.calls[1][0].n.id).toBe('b');
  });
});

describe('useNotificationBurstDispatcher — defensive guards', () => {
  test('null / undefined payloads are ignored without throwing', () => {
    const { onIndividual, onGrouped, ref } = setup();

    act(() => {
      ref.current.dispatch(null);
      ref.current.dispatch(undefined);
    });

    expect(onIndividual).not.toHaveBeenCalled();
    expect(onGrouped).not.toHaveBeenCalled();
  });

  test('throwing onIndividual does not break subsequent dispatches', () => {
    const onIndividual = vi.fn().mockImplementationOnce(() => {
      throw new Error('first one bad');
    });
    const onGrouped = vi.fn();
    const ref = React.createRef();
    render(<Harness ref={ref} onIndividual={onIndividual} onGrouped={onGrouped} threshold={3} windowMs={1500} />);

    // Suppress the console.error noise from the deliberately-thrown handler.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    act(() => {
      // First dispatch — handler throws but the hook must swallow it.
      ref.current.dispatch({ n: { id: 'a', type: 't', message: 'a' } });
    });
    act(() => { vi.advanceTimersByTime(1500); });

    // After the window closes, a SECOND burst must still work.
    act(() => {
      ref.current.dispatch({ n: { id: 'b', type: 't', message: 'b' } });
    });
    expect(onIndividual).toHaveBeenCalledTimes(2);

    errorSpy.mockRestore();
  });
});

describe('useNotificationBurstDispatcher — cleanup on unmount', () => {
  test('clears the pending trailing-summary timer when the component unmounts', () => {
    const { onIndividual, onGrouped, ref, unmount } = setup();

    act(() => { ref.current.dispatch({ n: { id: 'a', type: 't', message: 'a' } }); });
    act(() => { ref.current.dispatch({ n: { id: 'b', type: 't', message: 'b' } }); });
    act(() => { ref.current.dispatch({ n: { id: 'c', type: 't', message: 'c' } }); });

    // Three events accumulated; trailing summary would fire at +1500ms.
    expect(onIndividual).toHaveBeenCalledTimes(1);
    expect(onGrouped).not.toHaveBeenCalled();

    // Unmount before the window closes — the cleanup must clear the timer.
    unmount();
    act(() => { vi.advanceTimersByTime(2000); });

    // No grouped summary fires post-unmount.
    expect(onGrouped).not.toHaveBeenCalled();
  });
});
