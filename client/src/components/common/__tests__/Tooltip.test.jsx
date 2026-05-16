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

import Tooltip from '../Tooltip';
import { LABEL_PALETTE } from '../../../utils/labelPalette';

describe('Tooltip', () => {
  it('does not render content by default', () => {
    render(
      <Tooltip content="Help text">
        <button>Hover me</button>
      </Tooltip>
    );
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('opens after hover with delay', async () => {
    render(
      <Tooltip content="Hovered" delay={20}>
        <button>Hover me</button>
      </Tooltip>
    );
    fireEvent.mouseEnter(screen.getByText('Hover me'));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('tooltip')).toBeInTheDocument();
    });
  });

  it('uses colorMatch palette token for background', async () => {
    render(
      <Tooltip content="Stuck" colorMatch="red" delay={20}>
        <button>Trigger</button>
      </Tooltip>
    );
    fireEvent.mouseEnter(screen.getByText('Trigger'));
    await waitFor(() => {
      const tip = screen.getByRole('tooltip');
      expect(tip).toHaveStyle({ backgroundColor: LABEL_PALETTE.red.bg });
    });
  });

  it('hides on mouse leave', async () => {
    render(
      <Tooltip content="X" delay={20}>
        <button>T</button>
      </Tooltip>
    );
    fireEvent.mouseEnter(screen.getByText('T'));
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeInTheDocument());
    fireEvent.mouseLeave(screen.getByText('T'));
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
  });

  it('does not open when disabled', async () => {
    render(
      <Tooltip content="X" disabled delay={10}>
        <button>T</button>
      </Tooltip>
    );
    fireEvent.mouseEnter(screen.getByText('T'));
    // Wait past the delay window — should still not appear.
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});
