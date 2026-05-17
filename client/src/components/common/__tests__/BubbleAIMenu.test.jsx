import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import BubbleAIMenu from '../BubbleAIMenu';

/**
 * Phase E — BubbleAIMenu tests.
 *
 * Covers idle → loading → result → error state machine + the
 * needsSelection gating that disables non-Continue modes when there is
 * no selection.
 */

describe('BubbleAIMenu', () => {
  const noop = vi.fn();

  it('renders the action list when idle with a selection', () => {
    render(
      <BubbleAIMenu
        selectedText="some passage to improve"
        onTransform={vi.fn()}
        onReplace={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByText('Improve writing')).toBeInTheDocument();
    expect(screen.getByText('Make shorter')).toBeInTheDocument();
    expect(screen.getByText('Fix grammar')).toBeInTheDocument();
    expect(screen.getByText('Continue writing')).toBeInTheDocument();
    expect(screen.getByText('More casual')).toBeInTheDocument();
    expect(screen.getByText('More professional')).toBeInTheDocument();
    expect(screen.getByText(/chars selected/)).toBeInTheDocument();
  });

  it('disables selection-required modes when there is no selection', () => {
    render(
      <BubbleAIMenu
        selectedText=""
        onTransform={vi.fn()}
        onReplace={noop}
        onClose={noop}
      />,
    );
    const improve = screen.getByRole('button', { name: /Improve writing/i });
    const grammar = screen.getByRole('button', { name: /Fix grammar/i });
    const continueBtn = screen.getByRole('button', { name: /Continue writing/i });
    expect(improve).toBeDisabled();
    expect(grammar).toBeDisabled();
    expect(continueBtn).not.toBeDisabled();
    expect(screen.getByText('No selection')).toBeInTheDocument();
  });

  it('runs the selected mode and shows a result preview', async () => {
    const onTransform = vi.fn().mockResolvedValue({ output: 'much better' });
    render(
      <BubbleAIMenu
        selectedText="hello there"
        onTransform={onTransform}
        onReplace={noop}
        onClose={noop}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Improve writing/i }));
    expect(onTransform).toHaveBeenCalledWith({ mode: 'improve', text: 'hello there' });
    await waitFor(() => expect(screen.getByText(/Preview/)).toBeInTheDocument());
    expect(screen.getByText('much better')).toBeInTheDocument();
    // The Replace button should be active.
    expect(screen.getByRole('button', { name: /^Replace$/i })).not.toBeDisabled();
  });

  it('clicking Insert/Replace fires onReplace with the AI output and closes the menu', async () => {
    const onTransform = vi.fn().mockResolvedValue({ output: 'tidy version' });
    const onReplace = vi.fn();
    const onClose = vi.fn();
    render(
      <BubbleAIMenu
        selectedText="og text"
        onTransform={onTransform}
        onReplace={onReplace}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Make shorter/i }));
    await waitFor(() => expect(screen.getByText('tidy version')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Replace$/i }));
    expect(onReplace).toHaveBeenCalledWith('tidy version');
    expect(onClose).toHaveBeenCalled();
  });

  it('Continue mode shows the Insert label instead of Replace', async () => {
    const onTransform = vi.fn().mockResolvedValue({ output: 'next sentence.' });
    render(
      <BubbleAIMenu
        selectedText="opening line."
        onTransform={onTransform}
        onReplace={noop}
        onClose={noop}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Continue writing/i }));
    await waitFor(() => expect(screen.getByText('next sentence.')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /^Insert$/i })).toBeInTheDocument();
  });

  it('shows an error state with retry when onTransform rejects', async () => {
    const onTransform = vi.fn().mockRejectedValue(new Error('boom'));
    render(
      <BubbleAIMenu
        selectedText="x"
        onTransform={onTransform}
        onReplace={noop}
        onClose={noop}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Fix grammar/i }));
    await waitFor(() => expect(screen.getByText(/AI request failed/i)).toBeInTheDocument());
    expect(screen.getByText('boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument();
  });

  it('Back button returns from result to idle list', async () => {
    const onTransform = vi.fn().mockResolvedValue({ output: 'v2' });
    render(
      <BubbleAIMenu
        selectedText="some text"
        onTransform={onTransform}
        onReplace={noop}
        onClose={noop}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Improve writing/i }));
    await waitFor(() => expect(screen.getByText('v2')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Back$/i }));
    // Back should return us to the idle list.
    expect(screen.getByText('Improve writing')).toBeInTheDocument();
    expect(screen.queryByText('v2')).not.toBeInTheDocument();
  });

  it('Regenerate re-invokes onTransform with the same mode + text', async () => {
    const onTransform = vi.fn()
      .mockResolvedValueOnce({ output: 'first' })
      .mockResolvedValueOnce({ output: 'second' });
    render(
      <BubbleAIMenu
        selectedText="abc"
        onTransform={onTransform}
        onReplace={noop}
        onClose={noop}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /More casual/i }));
    await waitFor(() => expect(screen.getByText('first')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Regenerate/i }));
    await waitFor(() => expect(screen.getByText('second')).toBeInTheDocument());
    expect(onTransform).toHaveBeenCalledTimes(2);
    expect(onTransform.mock.calls[1][0]).toEqual({ mode: 'casual', text: 'abc' });
  });
});
