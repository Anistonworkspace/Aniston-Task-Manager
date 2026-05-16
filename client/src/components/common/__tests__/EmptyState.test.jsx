import React from 'react';
import { describe, it, expect, vi } from 'vitest';
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

import EmptyState from '../EmptyState';

describe('EmptyState', () => {
  it('renders title and description', () => {
    render(<EmptyState title="Nothing here" description="Add an item to get started" />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.getByText('Add an item to get started')).toBeInTheDocument();
  });

  it('renders a primary action button and fires onClick', () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        title="Empty"
        primaryAction={{ label: 'Create item', onClick }}
      />
    );
    const btn = screen.getByRole('button', { name: /Create item/ });
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalled();
  });

  it('renders a secondary action below the primary', () => {
    render(
      <EmptyState
        title="Empty"
        primaryAction={{ label: 'Primary', onClick: () => {} }}
        secondaryAction={{ label: 'Learn more', onClick: () => {} }}
      />
    );
    expect(screen.getByRole('button', { name: /Learn more/ })).toBeInTheDocument();
  });

  it('renders an illustration slot', () => {
    render(<EmptyState illustration={<svg data-testid="illu" />} title="X" />);
    expect(screen.getByTestId('illu')).toBeInTheDocument();
  });

  it('uses role=status for accessibility', () => {
    const { container } = render(<EmptyState title="X" />);
    expect(container.querySelector('[role="status"]')).toBeInTheDocument();
  });
});
