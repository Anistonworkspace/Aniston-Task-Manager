import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import LetterAvatar from '../LetterAvatar';
import { LABEL_PALETTE, hashToPaletteToken } from '../../../utils/labelPalette';

describe('LetterAvatar', () => {
  it('renders single initial by default', () => {
    render(<LetterAvatar name="Inbound Sales" />);
    expect(screen.getByText('I')).toBeInTheDocument();
  });

  it('renders double initials when initials="double"', () => {
    render(<LetterAvatar name="John Smith" initials="double" />);
    expect(screen.getByText('JS')).toBeInTheDocument();
  });

  it('renders ? for empty name', () => {
    render(<LetterAvatar name="" />);
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('uses 50% radius for circle shape, 6px for square', () => {
    const { container, rerender } = render(<LetterAvatar name="John" shape="square" />);
    expect(container.firstChild).toHaveStyle({ borderRadius: '6px' });
    rerender(<LetterAvatar name="John" shape="circle" />);
    expect(container.firstChild).toHaveStyle({ borderRadius: '50%' });
  });

  it('applies the hashed palette color when no color is given', () => {
    const { container } = render(<LetterAvatar name="Inbound Sales" />);
    const token = hashToPaletteToken('Inbound Sales');
    expect(container.firstChild).toHaveStyle({ backgroundColor: LABEL_PALETTE[token].bg });
  });

  it('applies an explicit palette color override', () => {
    const { container } = render(<LetterAvatar name="John" color="purple" />);
    expect(container.firstChild).toHaveStyle({ backgroundColor: LABEL_PALETTE.purple.bg });
  });

  it('renders an image when provided and falls back on error', () => {
    const { container, rerender } = render(<LetterAvatar name="John" image="/u/1.png" />);
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toBe('/u/1.png');
  });

  it('aria-label uses the name', () => {
    const { container } = render(<LetterAvatar name="Acme Workspace" />);
    expect(container.firstChild).toHaveAttribute('aria-label', 'Acme Workspace');
  });
});
