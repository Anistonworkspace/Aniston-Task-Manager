import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }) => <>{children}</>,
  motion: new Proxy({}, {
    get: (_, tag) => React.forwardRef(({ children, onKeyDown, onMouseEnter, onMouseLeave, ...rest }, ref) =>
      React.createElement(tag, { ref, onKeyDown, onMouseEnter, onMouseLeave, ...rest }, children)
    ),
  }),
  useReducedMotion: () => false,
}));

import ContextMenu from '../ContextMenu';

describe('ContextMenu', () => {
  it('does not show menu by default', () => {
    render(
      <ContextMenu>
        <ContextMenu.Trigger><div>Right-click me</div></ContextMenu.Trigger>
        <ContextMenu.Content>
          <ContextMenu.Item onSelect={() => {}}>Rename</ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu>
    );
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens menu on right-click and shows items', () => {
    render(
      <ContextMenu>
        <ContextMenu.Trigger><div>Right-click me</div></ContextMenu.Trigger>
        <ContextMenu.Content>
          <ContextMenu.Item onSelect={() => {}}>Rename</ContextMenu.Item>
          <ContextMenu.Item onSelect={() => {}}>Delete</ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu>
    );
    fireEvent.contextMenu(screen.getByText('Right-click me'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByText('Rename')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('fires onSelect and closes on item click', () => {
    const onRename = vi.fn();
    render(
      <ContextMenu>
        <ContextMenu.Trigger><div>Target</div></ContextMenu.Trigger>
        <ContextMenu.Content>
          <ContextMenu.Item onSelect={onRename}>Rename</ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu>
    );
    fireEvent.contextMenu(screen.getByText('Target'));
    fireEvent.click(screen.getByText('Rename'));
    expect(onRename).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes on Escape', () => {
    render(
      <ContextMenu>
        <ContextMenu.Trigger><div>Target</div></ContextMenu.Trigger>
        <ContextMenu.Content>
          <ContextMenu.Item onSelect={() => {}}>X</ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu>
    );
    fireEvent.contextMenu(screen.getByText('Target'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('does not invoke disabled items', () => {
    const onSelect = vi.fn();
    render(
      <ContextMenu>
        <ContextMenu.Trigger><div>T</div></ContextMenu.Trigger>
        <ContextMenu.Content>
          <ContextMenu.Item disabled onSelect={onSelect}>Disabled</ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu>
    );
    fireEvent.contextMenu(screen.getByText('T'));
    fireEvent.click(screen.getByText('Disabled'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('applies destructive styling', () => {
    render(
      <ContextMenu>
        <ContextMenu.Trigger><div>T</div></ContextMenu.Trigger>
        <ContextMenu.Content>
          <ContextMenu.Item destructive onSelect={() => {}}>Delete</ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu>
    );
    fireEvent.contextMenu(screen.getByText('T'));
    expect(screen.getByText('Delete').closest('button')).toHaveClass('text-danger');
  });
});
