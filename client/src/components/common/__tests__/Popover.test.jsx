import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }) => <>{children}</>,
  motion: new Proxy({}, {
    get: (_, tag) => React.forwardRef(({ children, onKeyDown, ...rest }, ref) =>
      React.createElement(tag, { ref, onKeyDown, ...rest }, children)
    ),
  }),
  useReducedMotion: () => false,
}));

import Popover from '../Popover';

describe('Popover', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not render content when closed', () => {
    render(
      <Popover>
        <Popover.Trigger><button>Open</button></Popover.Trigger>
        <Popover.Content><div>Hello</div></Popover.Content>
      </Popover>
    );
    expect(screen.queryByText('Hello')).not.toBeInTheDocument();
  });

  it('opens on trigger click (uncontrolled)', async () => {
    render(
      <Popover>
        <Popover.Trigger><button>Open</button></Popover.Trigger>
        <Popover.Content><div>Hello</div></Popover.Content>
      </Popover>
    );
    fireEvent.click(screen.getByText('Open'));
    await waitFor(() => {
      expect(screen.getByText('Hello')).toBeInTheDocument();
    });
  });

  it('respects controlled open prop', () => {
    const { rerender } = render(
      <Popover open={false} onOpenChange={() => {}}>
        <Popover.Trigger><button>Open</button></Popover.Trigger>
        <Popover.Content><div>Body</div></Popover.Content>
      </Popover>
    );
    expect(screen.queryByText('Body')).not.toBeInTheDocument();
    rerender(
      <Popover open onOpenChange={() => {}}>
        <Popover.Trigger><button>Open</button></Popover.Trigger>
        <Popover.Content><div>Body</div></Popover.Content>
      </Popover>
    );
    expect(screen.getByText('Body')).toBeInTheDocument();
  });

  it('fires onOpenChange when trigger toggled', () => {
    const onOpenChange = vi.fn();
    render(
      <Popover onOpenChange={onOpenChange}>
        <Popover.Trigger><button>Toggle</button></Popover.Trigger>
        <Popover.Content><div>Body</div></Popover.Content>
      </Popover>
    );
    fireEvent.click(screen.getByText('Toggle'));
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('sets aria-expanded on the trigger', () => {
    render(
      <Popover defaultOpen>
        <Popover.Trigger><button>Trigger</button></Popover.Trigger>
        <Popover.Content><div>Body</div></Popover.Content>
      </Popover>
    );
    expect(screen.getByRole('button', { name: 'Trigger' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('closes on Escape when closeOnEscape is true (default)', async () => {
    const onOpenChange = vi.fn();
    render(
      <Popover defaultOpen onOpenChange={onOpenChange}>
        <Popover.Trigger><button>Open</button></Popover.Trigger>
        <Popover.Content><div>Body</div></Popover.Content>
      </Popover>
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
