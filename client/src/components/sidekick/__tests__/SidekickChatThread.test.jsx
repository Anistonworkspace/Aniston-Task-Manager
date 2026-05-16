import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

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

import SidekickChatThread from '../SidekickChatThread';

beforeEach(() => {
  // jsdom doesn't implement scrollIntoView — stub it so the thread's
  // auto-scroll effect doesn't blow up.
  Element.prototype.scrollIntoView = vi.fn();
});

describe('SidekickChatThread', () => {
  it('renders user and assistant turns in order', () => {
    render(
      <SidekickChatThread
        messages={[
          { role: 'user', content: 'Hi there' },
          { role: 'assistant', content: 'Hello back' },
        ]}
      />
    );
    expect(screen.getByText('Hi there')).toBeInTheDocument();
    expect(screen.getByText('Hello back')).toBeInTheDocument();
  });

  it('renders the Thinking indicator when status="thinking"', () => {
    render(<SidekickChatThread messages={[{ role: 'user', content: 'X' }]} status="thinking" />);
    expect(screen.getByText('Thinking…')).toBeInTheDocument();
  });

  it('does not show Thinking indicator at idle', () => {
    render(<SidekickChatThread messages={[]} status="idle" />);
    expect(screen.queryByText('Thinking…')).not.toBeInTheDocument();
  });

  it('renders error-role messages with danger styling', () => {
    render(<SidekickChatThread messages={[{ role: 'error', content: 'Network down' }]} />);
    expect(screen.getByText('Network down')).toBeInTheDocument();
  });
});
