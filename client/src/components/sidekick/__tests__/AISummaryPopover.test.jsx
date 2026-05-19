import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }) => <>{children}</>,
  motion: new Proxy({}, {
    get: (_, tag) => React.forwardRef(({ children, ...rest }, ref) =>
      React.createElement(tag, { ref, ...rest }, children)
    ),
  }),
  useReducedMotion: () => false,
}));

vi.mock('../../common/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

import AISummaryPopover from '../AISummaryPopover';

describe('AISummaryPopover', () => {
  it('does not run on mount when closed', () => {
    const run = vi.fn();
    render(<AISummaryPopover trigger={<button>Open</button>} run={run} />);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs once when opened and shows the result', async () => {
    const run = vi.fn().mockResolvedValue({ summary: 'This task is on track.' });
    render(<AISummaryPopover trigger={<button>Open</button>} run={run} title="Task summary" />);
    fireEvent.click(screen.getByText('Open'));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('This task is on track.')).toBeInTheDocument());
  });

  it('renders loading state before the run resolves', async () => {
    let resolveRun;
    const run = vi.fn().mockReturnValue(new Promise((r) => { resolveRun = r; }));
    render(<AISummaryPopover trigger={<button>Open</button>} run={run} />);
    fireEvent.click(screen.getByText('Open'));
    // May 2026 — copy changed from "Reading the data and writing the summary…"
    // to a phase-based message that progresses with elapsed time. Match the
    // first phase here.
    await waitFor(() => expect(screen.getByText(/Reading the doc/)).toBeInTheDocument());
    resolveRun({ summary: 'done' });
  });

  it('shows an error when run() throws', async () => {
    const run = vi.fn().mockRejectedValue({ response: { data: { message: 'AI is unavailable' } } });
    render(<AISummaryPopover trigger={<button>Open</button>} run={run} />);
    fireEvent.click(screen.getByText('Open'));
    await waitFor(() => expect(screen.getByText('AI is unavailable')).toBeInTheDocument());
  });

  it('regenerate button re-runs the request', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ summary: 'first' })
      .mockResolvedValueOnce({ summary: 'second' });
    render(<AISummaryPopover trigger={<button>Open</button>} run={run} />);
    fireEvent.click(screen.getByText('Open'));
    await waitFor(() => screen.getByText('first'));
    fireEvent.click(screen.getByLabelText('Regenerate'));
    await waitFor(() => screen.getByText('second'));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('uses renderResult when supplied', async () => {
    const run = vi.fn().mockResolvedValue({ priority: 'high', reason: 'because deadline' });
    render(
      <AISummaryPopover
        trigger={<button>Open</button>}
        run={run}
        renderResult={(d) => <div data-testid="custom">prio: {d.priority}</div>}
      />
    );
    fireEvent.click(screen.getByText('Open'));
    await waitFor(() => expect(screen.getByTestId('custom')).toHaveTextContent('prio: high'));
  });

  it('shows the Insert action when onInsert is provided and result has summary', async () => {
    const run = vi.fn().mockResolvedValue({ summary: 'Final answer' });
    const onInsert = vi.fn();
    render(
      <AISummaryPopover
        trigger={<button>Open</button>}
        run={run}
        onInsert={onInsert}
        insertLabel="Insert into description"
      />
    );
    fireEvent.click(screen.getByText('Open'));
    await waitFor(() => screen.getByText('Final answer'));
    fireEvent.click(screen.getByText('Insert into description'));
    expect(onInsert).toHaveBeenCalledWith('Final answer');
  });
});
