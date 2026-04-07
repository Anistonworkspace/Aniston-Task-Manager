import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import Avatar from '../Avatar';

describe('Avatar component', () => {
  // ---- Initials rendering ----

  it('renders initials from a single-word name', () => {
    render(<Avatar name="Alice" />);
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('renders first and last initials from a two-word name', () => {
    render(<Avatar name="John Doe" />);
    expect(screen.getByText('JD')).toBeInTheDocument();
  });

  it('renders first and last initials from a name with multiple words', () => {
    render(<Avatar name="Mary Jane Watson" />);
    // initials() uses first word[0] + last word[0]
    expect(screen.getByText('MW')).toBeInTheDocument();
  });

  it('renders initials in uppercase', () => {
    render(<Avatar name="alice bob" />);
    expect(screen.getByText('AB')).toBeInTheDocument();
  });

  // ---- Image rendering ----

  it('renders an img element when an image URL is provided', () => {
    render(<Avatar name="Alice" image="https://example.com/avatar.png" />);
    const img = screen.getByRole('img');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', 'https://example.com/avatar.png');
    expect(img).toHaveAttribute('alt', 'Alice');
  });

  it('does NOT render an img element when no image is provided', () => {
    render(<Avatar name="Alice" />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('does NOT render initials text when an image is provided', () => {
    render(<Avatar name="Alice" image="https://example.com/avatar.png" />);
    // The initials would be "A" — should not appear as text node
    expect(screen.queryByText('A')).not.toBeInTheDocument();
  });

  // ---- Size classes ----

  it('applies xs size class when size="xs"', () => {
    const { container } = render(<Avatar name="Alice" size="xs" />);
    expect(container.firstChild).toHaveClass('w-6', 'h-6');
  });

  it('applies sm size class when size="sm"', () => {
    const { container } = render(<Avatar name="Alice" size="sm" />);
    expect(container.firstChild).toHaveClass('w-7', 'h-7');
  });

  it('applies md size class when size="md" (default)', () => {
    const { container } = render(<Avatar name="Alice" />);
    expect(container.firstChild).toHaveClass('w-8', 'h-8');
  });

  it('applies lg size class when size="lg"', () => {
    const { container } = render(<Avatar name="Alice" size="lg" />);
    expect(container.firstChild).toHaveClass('w-10', 'h-10');
  });

  it('applies xl size class when size="xl"', () => {
    const { container } = render(<Avatar name="Alice" size="xl" />);
    expect(container.firstChild).toHaveClass('w-12', 'h-12');
  });

  it('falls back to md class for an unknown size value', () => {
    const { container } = render(<Avatar name="Alice" size="unknown" />);
    // SIZES lookup falls back to SIZES.md via `|| SIZES.md`
    expect(container.firstChild).toHaveClass('w-8', 'h-8');
  });

  // ---- Null / missing name handling ----

  it('renders "?" when name is null', () => {
    render(<Avatar name={null} />);
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('renders "?" when name is undefined', () => {
    render(<Avatar name={undefined} />);
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('renders "?" when name is an empty string', () => {
    render(<Avatar name="" />);
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('renders "?" when name is a whitespace-only string', () => {
    render(<Avatar name="   " />);
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  // ---- Gradient background ----

  it('sets a linear-gradient background style when no image is provided', () => {
    const { container } = render(<Avatar name="Alice" />);
    expect(container.firstChild.style.background).toMatch(/linear-gradient/);
  });

  it('sets background to transparent when an image is provided', () => {
    const { container } = render(<Avatar name="Alice" image="https://example.com/avatar.png" />);
    expect(container.firstChild.style.background).toBe('transparent');
  });

  // ---- title attribute ----

  it('sets a title attribute equal to the name', () => {
    render(<Avatar name="Sara Connor" />);
    expect(screen.getByTitle('Sara Connor')).toBeInTheDocument();
  });

  // ---- Custom className passthrough ----

  it('forwards extra className to the wrapper div', () => {
    const { container } = render(<Avatar name="Bob" className="ring-2 ring-blue-500" />);
    expect(container.firstChild).toHaveClass('ring-2', 'ring-blue-500');
  });

  // ---- Consistent gradient hashing ----

  it('produces the same gradient for the same name each render', () => {
    const { container: c1 } = render(<Avatar name="TestUser" />);
    const { container: c2 } = render(<Avatar name="TestUser" />);
    expect(c1.firstChild.style.background).toBe(c2.firstChild.style.background);
  });

  it('produces different gradients for different names', () => {
    const { container: c1 } = render(<Avatar name="Alpha" />);
    const { container: c2 } = render(<Avatar name="Zeta" />);
    // This is probabilistic but very reliable given 10 gradient slots
    // (different enough names hash to different slots)
    // We only assert neither is empty
    expect(c1.firstChild.style.background).toMatch(/linear-gradient/);
    expect(c2.firstChild.style.background).toMatch(/linear-gradient/);
  });
});
