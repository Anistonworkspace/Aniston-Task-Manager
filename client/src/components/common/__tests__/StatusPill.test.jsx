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

import StatusPill from '../StatusPill';
import { LABEL_PALETTE } from '../../../utils/labelPalette';

describe('StatusPill', () => {
  it('renders the label text', () => {
    render(<StatusPill color="red" label="Stuck" />);
    expect(screen.getByText('Stuck')).toBeInTheDocument();
  });

  it('applies the palette bg for the given color', () => {
    const { container } = render(<StatusPill color="green" label="Done" />);
    const pill = container.querySelector('span[class*="inline-flex"]');
    expect(pill).toHaveStyle({ backgroundColor: LABEL_PALETTE.green.bg });
  });

  it('uses palette soft bg for outlined variant', () => {
    const { container } = render(<StatusPill color="blue" label="Pending" variant="outlined" />);
    const pill = container.querySelector('span[class*="inline-flex"]');
    expect(pill).toHaveStyle({ backgroundColor: LABEL_PALETTE.blue.soft });
  });

  it('falls back to gray for unknown color tokens', () => {
    const { container } = render(<StatusPill color="not-a-color" label="X" />);
    const pill = container.querySelector('span[class*="inline-flex"]');
    expect(pill).toHaveStyle({ backgroundColor: LABEL_PALETTE.gray.bg });
  });

  it('fires onClick when clicked and is keyboard-activatable', () => {
    const onClick = vi.fn();
    render(<StatusPill color="purple" label="Click me" onClick={onClick} />);
    const pill = screen.getByRole('button');
    fireEvent.click(pill);
    expect(onClick).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(pill, { key: 'Enter' });
    expect(onClick).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(pill, { key: ' ' });
    expect(onClick).toHaveBeenCalledTimes(3);
  });

  it('renders as static span (no button role) without onClick', () => {
    render(<StatusPill color="red" label="Static" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('accepts a hex color and applies it as bg', () => {
    const { container } = render(<StatusPill color="#abcdef" label="Custom" />);
    const pill = container.querySelector('span[class*="inline-flex"]');
    expect(pill).toHaveStyle({ backgroundColor: '#abcdef' });
  });
});
