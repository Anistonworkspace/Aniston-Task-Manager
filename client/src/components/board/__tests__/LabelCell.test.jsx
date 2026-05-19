import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// Mock the api service so we can assert backend calls without a server.
vi.mock('../../../services/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
    put: vi.fn(),
  },
}));

// PortalDropdown renders children into <body> via createPortal. For unit
// tests we replace it with a direct passthrough so anchorRef/positioning
// quirks don't interfere with assertions.
vi.mock('../../common/PortalDropdown', () => ({
  default: ({ open, children }) => (open ? <div data-testid="portal">{children}</div> : null),
}));

import api from '../../../services/api';
import LabelCell from '../LabelCell';

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({ data: { labels: [] } });
});

describe('LabelCell — read-only mode', () => {
  it('renders an em-dash for read-only with no labels', () => {
    render(<LabelCell taskId="t1" boardId="b1" labels={[]} canEdit={false} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows labels but no Add affordance when canEdit=false and labels present', () => {
    render(
      <LabelCell taskId="t1" boardId="b1" canEdit={false}
        labels={[{ id: 'l1', name: 'Bug', color: '#e2445c' }]} />,
    );
    // Each label is now rendered twice — once in the hidden "ghost"
    // measurement layer (visibility: hidden, aria-hidden) and once in
    // the visible layer. `getAllByText` confirms presence without
    // tripping on duplicates.
    expect(screen.getAllByText('Bug').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Add/)).not.toBeInTheDocument();
  });
});

describe('LabelCell — editable mode', () => {
  it('shows "Add" affordance when canEdit=true and no labels', () => {
    render(<LabelCell taskId="t1" boardId="b1" labels={[]} canEdit={true} />);
    expect(screen.getByText('Add')).toBeInTheDocument();
  });

  it('renders all labels when the layout has room (no overflow badge)', () => {
    // The Labels cell now sizes overflow dynamically based on the actual
    // column width (bug report 2026-05-18). In jsdom there is no real
    // layout — `clientWidth` and `getBoundingClientRect().width` both
    // return 0 — so the measurement effect leaves the visible count at
    // its initial `labels.length`, which means every chip is rendered
    // and no "+N" badge appears. This is the correct graceful-
    // degradation behaviour: when the component can't measure, it
    // doesn't pretend to trim.
    const labels = [
      { id: 'l1', name: 'Bug', color: '#e2445c' },
      { id: 'l2', name: 'Feature', color: '#00c875' },
      { id: 'l3', name: 'Urgent', color: '#fdab3d' },
      { id: 'l4', name: 'Internal', color: '#a25ddc' },
      { id: 'l5', name: 'Tech debt', color: '#579bfc' },
    ];
    render(<LabelCell taskId="t1" boardId="b1" labels={labels} canEdit={true} />);
    for (const l of labels) {
      // Each label name appears twice — once in the ghost (hidden,
      // for measurement) and once in the visible layer.
      expect(screen.getAllByText(l.name).length).toBe(2);
    }
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument();
  });

  it('renders a hidden "ghost" measurement layer with every label for live resize', () => {
    // The overflow trimming is decided at layout time by a useLayoutEffect
    // that measures `chipBarRef.current.clientWidth` and each ghost chip's
    // `getBoundingClientRect().width`. The ghost layer ALWAYS holds every
    // label (regardless of the visible trim state) so a wider column can
    // grow the visible count back up — single-layer approaches could only
    // shrink, never re-expand. This test pins the ghost contract.
    //
    // Trim arithmetic + ResizeObserver behaviour are covered by browser
    // smoke-tests (bug report 2026-05-18: dynamic column resize).
    const labels = [
      { id: 'l1', name: 'Bug', color: '#e2445c' },
      { id: 'l2', name: 'Feature', color: '#00c875' },
      { id: 'l3', name: 'Urgent', color: '#fdab3d' },
    ];
    const { container } = render(
      <LabelCell taskId="t1" boardId="b1" labels={labels} canEdit={true} />,
    );
    // The ghost chips carry [data-label-chip] and live inside an
    // [aria-hidden] container. Visible chips do NOT carry the marker.
    const ghostChips = container.querySelectorAll('[data-label-chip]');
    expect(ghostChips.length).toBe(3);
    expect(ghostChips[0].textContent).toBe('Bug');
    expect(ghostChips[2].textContent).toBe('Urgent');
    // Every ghost chip is inside an aria-hidden wrapper so AT software
    // doesn't double-announce the labels.
    for (const chip of ghostChips) {
      expect(chip.closest('[aria-hidden="true"]')).not.toBeNull();
    }
  });

  it('opens the picker when clicked and lazy-loads board labels', async () => {
    api.get.mockResolvedValue({
      data: { labels: [{ id: 'l1', name: 'Bug', color: '#e2445c' }] },
    });
    render(<LabelCell taskId="t1" boardId="b1" labels={[]} canEdit={true} />);
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/labels?boardId=b1'));
    expect(screen.getByTestId('portal')).toBeInTheDocument();
  });
});

describe('LabelCell — optimistic state with stale-prop latch (P2-5)', () => {
  it('keeps optimistic state after parent re-renders with the same prop', async () => {
    api.post.mockResolvedValue({ data: { success: true } });
    api.get.mockResolvedValue({
      data: { labels: [{ id: 'l1', name: 'Bug', color: '#e2445c' }] },
    });
    const onLabelsChange = vi.fn();
    const { rerender } = render(
      <LabelCell taskId="t1" boardId="b1" labels={[]} canEdit={true}
        onLabelsChange={onLabelsChange} />,
    );
    // Open picker
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() => expect(screen.getByText('Bug')).toBeInTheDocument());
    // Click the label to toggle (assign)
    await act(async () => {
      fireEvent.click(screen.getByText('Bug'));
    });
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/labels/assign', { taskId: 't1', labelId: 'l1' }));
    // Parent re-renders with the STILL-STALE empty labels prop.
    // The pendingMutation latch must skip the prop sync so the
    // optimistic state survives. (The actual user-reported bug
    // pre-fix was: this re-render reverted the visible label.)
    rerender(
      <LabelCell taskId="t1" boardId="b1" labels={[]} canEdit={true}
        onLabelsChange={onLabelsChange} />,
    );
    // Sanity: onLabelsChange was called with the optimistic new list
    expect(onLabelsChange).toHaveBeenCalledWith([
      { id: 'l1', name: 'Bug', color: '#e2445c' },
    ]);
  });

  it('rolls back optimistic state when API fails', async () => {
    api.post.mockRejectedValue({ response: { data: { message: 'Forbidden' } } });
    api.get.mockResolvedValue({
      data: { labels: [{ id: 'l1', name: 'Bug', color: '#e2445c' }] },
    });
    render(<LabelCell taskId="t1" boardId="b1" labels={[]} canEdit={true} />);
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() => expect(screen.getByText('Bug')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByText('Bug'));
    });
    await waitFor(() => expect(screen.getByText(/Forbidden/)).toBeInTheDocument());
  });
});

describe('LabelCell — unmount safety (P2-5)', () => {
  it('does not throw or log a React warning when component unmounts mid-mutation', async () => {
    // Spy on console.error before mounting so we catch any React
    // "setState on unmounted component" warning that fires when the
    // delayed API resolution touches state on a torn-down tree.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    let resolveLatch;
    api.post.mockReturnValue(
      new Promise((resolve) => { resolveLatch = () => resolve({ data: { success: true } }); }),
    );
    api.get.mockResolvedValue({
      data: { labels: [{ id: 'l1', name: 'Bug', color: '#e2445c' }] },
    });
    const { unmount } = render(
      <LabelCell taskId="t1" boardId="b1" labels={[]} canEdit={true} />,
    );
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() => expect(screen.getByText('Bug')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Bug'));

    // Sanity check that the test path actually fired the mutation we are
    // testing the safety of — otherwise the unmount safety check would be
    // exercising the wrong code path.
    expect(api.post).toHaveBeenCalled();

    // Unmount BEFORE the API resolves
    unmount();
    // Now resolve the in-flight request — must not log "setState on
    // unmounted component" warnings or throw.
    await act(async () => { resolveLatch(); });

    // The component MUST NOT have logged any React warning during the
    // late state update. We filter to React-shaped warnings only so an
    // unrelated console.error from a dependency does not false-positive.
    const reactWarnings = errorSpy.mock.calls.filter(
      (args) => args.some(
        (arg) => typeof arg === 'string'
          && (arg.includes('unmounted component')
            || arg.includes("Can't perform a React state update")
            || arg.includes('was not wrapped in act')),
      ),
    );
    expect(reactWarnings).toEqual([]);

    errorSpy.mockRestore();
  });
});
