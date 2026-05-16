import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

vi.mock('../../../services/aiSummaryService', () => ({
  default: { suggestPriority: vi.fn() },
}));

import SuggestPriorityChip from '../SuggestPriorityChip';
import aiSummary from '../../../services/aiSummaryService';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SuggestPriorityChip', () => {
  it('renders the Suggest trigger', () => {
    render(<SuggestPriorityChip taskTitle="X" />);
    expect(screen.getByRole('button', { name: /Suggest/ })).toBeInTheDocument();
  });

  it('calls /ai/suggest-priority on open', async () => {
    aiSummary.suggestPriority.mockResolvedValue({
      kind: 'structured', priority: 'high', reason: 'due tomorrow',
    });
    render(<SuggestPriorityChip taskTitle="Ship the email" />);
    fireEvent.click(screen.getByRole('button', { name: /Suggest/ }));
    await waitFor(() => {
      expect(aiSummary.suggestPriority).toHaveBeenCalledWith(
        expect.objectContaining({ taskTitle: 'Ship the email' })
      );
    });
  });

  it('renders the suggestion + reason after success', async () => {
    aiSummary.suggestPriority.mockResolvedValue({
      kind: 'structured', priority: 'high', reason: 'Has a launch deadline tomorrow.',
    });
    render(<SuggestPriorityChip taskTitle="X" />);
    fireEvent.click(screen.getByRole('button', { name: /Suggest/ }));
    await waitFor(() => expect(screen.getByText('Has a launch deadline tomorrow.')).toBeInTheDocument());
    expect(screen.getByText('High')).toBeInTheDocument();
  });

  it('Apply calls onApply with the suggested priority', async () => {
    aiSummary.suggestPriority.mockResolvedValue({
      kind: 'structured', priority: 'critical', reason: 'x',
    });
    const onApply = vi.fn();
    render(<SuggestPriorityChip taskTitle="X" onApply={onApply} />);
    fireEvent.click(screen.getByRole('button', { name: /Suggest/ }));
    await waitFor(() => screen.getByText(/Critical/));
    fireEvent.click(screen.getByText(/Apply/));
    expect(onApply).toHaveBeenCalledWith('critical', null);
  });

  it('passes suggestedDueDate through to onApply', async () => {
    aiSummary.suggestPriority.mockResolvedValue({
      kind: 'structured', priority: 'high', reason: 'r', suggestedDueDate: '2026-05-20',
    });
    const onApply = vi.fn();
    render(<SuggestPriorityChip taskTitle="X" onApply={onApply} />);
    fireEvent.click(screen.getByRole('button', { name: /Suggest/ }));
    await waitFor(() => screen.getByText(/High/));
    fireEvent.click(screen.getByText(/Apply/));
    expect(onApply).toHaveBeenCalledWith('high', '2026-05-20');
  });

  it('disables Apply when suggestion matches current priority (no change)', async () => {
    aiSummary.suggestPriority.mockResolvedValue({
      kind: 'structured', priority: 'medium', reason: 'r',
    });
    render(<SuggestPriorityChip taskTitle="X" currentPriority="medium" onApply={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Suggest/ }));
    await waitFor(() => screen.getByText('(no change)'));
    expect(screen.getByText(/Apply/).closest('button')).toBeDisabled();
  });

  it('renders error state on failure', async () => {
    aiSummary.suggestPriority.mockRejectedValue({
      response: { data: { message: 'AI not configured' } },
    });
    render(<SuggestPriorityChip taskTitle="X" />);
    fireEvent.click(screen.getByRole('button', { name: /Suggest/ }));
    await waitFor(() => expect(screen.getByText(/AI not configured/)).toBeInTheDocument());
  });
});
