import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }) => <>{children}</>,
  motion: new Proxy({}, {
    get: (_, tag) => React.forwardRef(({ children, onClick, ...rest }, ref) =>
      React.createElement(tag, { ref, onClick, ...rest }, children)
    ),
  }),
  useReducedMotion: () => false,
}));

import SidePanel from '../SidePanel';

describe('SidePanel', () => {
  it('does not render when closed', () => {
    render(
      <SidePanel open={false} onClose={() => {}}>
        <SidePanel.Body>Body content</SidePanel.Body>
      </SidePanel>
    );
    expect(screen.queryByText('Body content')).not.toBeInTheDocument();
  });

  it('renders when open', () => {
    render(
      <SidePanel open onClose={() => {}}>
        <SidePanel.Body>Body content</SidePanel.Body>
      </SidePanel>
    );
    expect(screen.getByText('Body content')).toBeInTheDocument();
  });

  it('calls onClose when X in header is clicked', () => {
    const onClose = vi.fn();
    render(
      <SidePanel open onClose={onClose}>
        <SidePanel.Header title="My Panel" />
        <SidePanel.Body>Body</SidePanel.Body>
      </SidePanel>
    );
    const closeBtn = screen.getByRole('button', { name: 'Close panel' });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose on Escape when closeOnEscape is true (default)', () => {
    const onClose = vi.fn();
    render(
      <SidePanel open onClose={onClose}>
        <SidePanel.Body>Body</SidePanel.Body>
      </SidePanel>
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('does not call onClose on Escape when disabled', () => {
    const onClose = vi.fn();
    render(
      <SidePanel open onClose={onClose} closeOnEscape={false}>
        <SidePanel.Body>Body</SidePanel.Body>
      </SidePanel>
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders header title text', () => {
    render(
      <SidePanel open onClose={() => {}}>
        <SidePanel.Header title="Item details" />
        <SidePanel.Body>X</SidePanel.Body>
      </SidePanel>
    );
    expect(screen.getByText('Item details')).toBeInTheDocument();
  });

  it('renders footer content', () => {
    render(
      <SidePanel open onClose={() => {}}>
        <SidePanel.Body>X</SidePanel.Body>
        <SidePanel.Footer><button>Save</button></SidePanel.Footer>
      </SidePanel>
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('renders dialog role with aria-label', () => {
    render(
      <SidePanel open onClose={() => {}} ariaLabel="Task detail panel">
        <SidePanel.Body>X</SidePanel.Body>
      </SidePanel>
    );
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', 'Task detail panel');
  });
});
