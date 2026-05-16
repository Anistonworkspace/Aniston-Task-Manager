import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// AuthContext is consumed by AddNewContentMenu for tier gating — mock it
// at the module level so each test can override the auth shape per case.
vi.mock('../../../../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }) => <>{children}</>,
  motion: new Proxy({}, {
    get: (_, tag) => React.forwardRef(({ children, ...rest }, ref) =>
      React.createElement(tag, { ref, ...rest }, children)
    ),
  }),
  useReducedMotion: () => false,
}));

import AddNewContentMenu from '../AddNewContentMenu';
import { useAuth } from '../../../../context/AuthContext';

function renderMenu(props = {}, auth = {}) {
  useAuth.mockReturnValue({
    isSuperAdmin: false,
    canManage: true,
    isStrictAdmin: false,
    granularPermissions: {},
    ...auth,
  });
  return render(
    <MemoryRouter>
      <AddNewContentMenu
        open
        onOpenChange={() => {}}
        trigger={<button>Trigger</button>}
        onCreateBoard={() => {}}
        onCreateDoc={() => {}}
        onCreateDashboard={() => {}}
        onCreateForm={() => {}}
        onCreateWorkflow={() => {}}
        onCreateFolder={() => {}}
        onCreateProject={() => {}}
        onCreatePortfolio={() => {}}
        onCreateWorkspace={() => {}}
        onOpenMagic={() => {}}
        {...props}
      />
    </MemoryRouter>
  );
}

describe('AddNewContentMenu', () => {
  it('shows Board, Doc, Dashboard for managers', async () => {
    renderMenu();
    await waitFor(() => expect(screen.getByText('Board')).toBeInTheDocument());
    expect(screen.getByText('Doc')).toBeInTheDocument();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
  });

  it('shows Magic AI when AI is not denied', async () => {
    renderMenu({}, { granularPermissions: {} });
    await waitFor(() => expect(screen.getByText('Magic AI solution')).toBeInTheDocument());
  });

  it('hides Magic AI when ai.use is explicitly denied', async () => {
    // isExplicitlyDenied resolves to true when the grant value is the literal
    // boolean `false` (matches the backend permission resolver — see
    // utils/permissions.js#isExplicitlyDenied).
    renderMenu({}, { granularPermissions: { 'ai.use': false } });
    await waitFor(() => expect(screen.getByText('Board')).toBeInTheDocument());
    expect(screen.queryByText('Magic AI solution')).not.toBeInTheDocument();
  });

  it('hides Workflow / Folder / Dashboard for members (canManage=false)', async () => {
    renderMenu({}, { canManage: false });
    await waitFor(() => expect(screen.getByText('Board')).toBeInTheDocument());
    expect(screen.queryByText('Workflow')).not.toBeInTheDocument();
    expect(screen.queryByText('Folder')).not.toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  });

  it('calls onCreateBoard when Board is clicked', async () => {
    const onCreateBoard = vi.fn();
    renderMenu({ onCreateBoard });
    await waitFor(() => screen.getByText('Board'));
    fireEvent.click(screen.getByText('Board'));
    expect(onCreateBoard).toHaveBeenCalled();
  });

  it('calls onOpenMagic when Magic AI is clicked', async () => {
    const onOpenMagic = vi.fn();
    renderMenu({ onOpenMagic });
    await waitFor(() => screen.getByText('Magic AI solution'));
    fireEvent.click(screen.getByText('Magic AI solution'));
    expect(onOpenMagic).toHaveBeenCalled();
  });

  it('closes the menu after a selection (onOpenChange called with false)', async () => {
    const onOpenChange = vi.fn();
    renderMenu({ onOpenChange });
    await waitFor(() => screen.getByText('Board'));
    fireEvent.click(screen.getByText('Board'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
