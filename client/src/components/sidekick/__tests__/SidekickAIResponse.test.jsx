import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

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

import SidekickAIResponse from '../SidekickAIResponse';

beforeEach(() => {
  Object.defineProperty(global.navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue() },
    configurable: true,
  });
});

describe('SidekickAIResponse', () => {
  it('renders the message body as markdown', () => {
    render(<SidekickAIResponse message={{ content: 'Hello **world**' }} />);
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.getByText('world')).toBeInTheDocument();
  });

  it('hides the action row while a cursor is showing (streaming)', () => {
    render(<SidekickAIResponse message={{ content: 'Streaming…' }} showCursor />);
    expect(screen.queryByLabelText('Copy message')).not.toBeInTheDocument();
  });

  it('renders the Thinking expander when message.thinking is set', () => {
    render(<SidekickAIResponse message={{ content: 'Body', thinking: 'my chain of thought' }} />);
    expect(screen.getByText('Thinking process')).toBeInTheDocument();
  });

  it('fires onFeedback when 👍 is clicked', () => {
    const onFeedback = vi.fn();
    render(<SidekickAIResponse message={{ content: 'X' }} onFeedback={onFeedback} />);
    fireEvent.click(screen.getByLabelText('Helpful'));
    expect(onFeedback).toHaveBeenCalledWith('up', expect.objectContaining({ content: 'X' }));
  });

  it('shows Sources count when sources prop is non-empty', () => {
    render(
      <SidekickAIResponse message={{
        content: 'X',
        sources: [
          { title: 'Doc one', url: 'https://example.com/a' },
          { title: 'Doc two', url: 'https://example.com/b' },
        ],
      }} />
    );
    expect(screen.getByText(/2 Sources/)).toBeInTheDocument();
  });
});
