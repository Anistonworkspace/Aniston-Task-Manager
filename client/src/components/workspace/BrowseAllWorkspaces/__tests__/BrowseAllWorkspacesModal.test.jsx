import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }) => <>{children}</>,
  motion: new Proxy({}, {
    get: (_, tag) => React.forwardRef(({ children, onClick, ...rest }, ref) =>
      React.createElement(tag, { ref, onClick, ...rest }, children)
    ),
  }),
  useReducedMotion: () => false,
}));

vi.mock('../../../../utils/animations', () => ({
  modalOverlay: {},
  modalContent: {},
}));

vi.mock('../../../../services/api', () => ({
  default: { get: vi.fn() },
}));

vi.mock('../../../../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

import BrowseAllWorkspacesModal from '../BrowseAllWorkspacesModal';
import api from '../../../../services/api';
import { useAuth } from '../../../../context/AuthContext';

beforeEach(() => {
  vi.clearAllMocks();
  useAuth.mockReturnValue({
    user: { id: 'u1', name: 'Test User' },
    canManage: true,
    isSuperAdmin: false,
  });
});

const WS_FIXTURES = [
  { id: 'w1', name: 'Marketing', description: 'Brand work', createdBy: 'u1', workspaceMembers: [], boards: [] },
  { id: 'w2', name: 'Engineering', description: 'Code reviews', createdBy: 'u2', workspaceMembers: [{ id: 'u1' }], boards: [] },
];

function setApiResponse(workspaces = WS_FIXTURES) {
  api.get.mockResolvedValue({ data: { success: true, data: { workspaces } } });
}

describe('BrowseAllWorkspacesModal', () => {
  it('does not render when isOpen=false', () => {
    setApiResponse();
    render(
      <MemoryRouter>
        <BrowseAllWorkspacesModal isOpen={false} onClose={() => {}} />
      </MemoryRouter>
    );
    expect(screen.queryByText('Browse all workspaces')).not.toBeInTheDocument();
  });

  it('renders title and filter rail when open', async () => {
    setApiResponse();
    render(
      <MemoryRouter>
        <BrowseAllWorkspacesModal isOpen onClose={() => {}} />
      </MemoryRouter>
    );
    expect(screen.getByText('Browse all workspaces')).toBeInTheDocument();
    // "Recent workspaces" appears in both the sidebar filter button AND the
    // section header by default — the filter button is the one we test for.
    expect(screen.getByRole('button', { name: /Recent workspaces/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /All workspaces/ })).toBeInTheDocument();
  });

  it('fetches workspaces and renders cards', async () => {
    setApiResponse();
    render(
      <MemoryRouter>
        <BrowseAllWorkspacesModal isOpen onClose={() => {}} />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/workspaces');
    });
    await waitFor(() => expect(screen.getByText('Marketing')).toBeInTheDocument());
    expect(screen.getByText('Engineering')).toBeInTheDocument();
  });

  it('uses /workspaces/mine for non-managers', async () => {
    useAuth.mockReturnValue({
      user: { id: 'u1' },
      canManage: false,
      isSuperAdmin: false,
    });
    setApiResponse();
    render(
      <MemoryRouter>
        <BrowseAllWorkspacesModal isOpen onClose={() => {}} />
      </MemoryRouter>
    );
    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/workspaces/mine');
    });
  });

  it('filters by search query', async () => {
    setApiResponse();
    render(
      <MemoryRouter>
        <BrowseAllWorkspacesModal isOpen onClose={() => {}} />
      </MemoryRouter>
    );
    await waitFor(() => screen.getByText('Marketing'));
    fireEvent.click(screen.getByText('All workspaces'));
    const search = screen.getByPlaceholderText('Search workspaces');
    fireEvent.change(search, { target: { value: 'eng' } });
    expect(screen.queryByText('Marketing')).not.toBeInTheDocument();
    expect(screen.getByText('Engineering')).toBeInTheDocument();
  });

  it('shows empty state when nothing matches', async () => {
    setApiResponse();
    render(
      <MemoryRouter>
        <BrowseAllWorkspacesModal isOpen onClose={() => {}} />
      </MemoryRouter>
    );
    await waitFor(() => screen.getByText('Marketing'));
    fireEvent.click(screen.getByText('All workspaces'));
    fireEvent.change(screen.getByPlaceholderText('Search workspaces'), { target: { value: 'xyz' } });
    expect(screen.getByText('No workspaces match your filter')).toBeInTheDocument();
  });

  it('owner filter shows only owned workspaces', async () => {
    setApiResponse();
    render(
      <MemoryRouter>
        <BrowseAllWorkspacesModal isOpen onClose={() => {}} />
      </MemoryRouter>
    );
    await waitFor(() => screen.getByText('Marketing'));
    // "Owner" appears as both a sidebar filter button AND a StatusPill on
    // owned cards — click the sidebar button specifically.
    const ownerButtons = screen.getAllByRole('button', { name: /Owner/ });
    // The sidebar filter button is the one inside the aside (smaller; second
    // is the role pill which is a span). The filter button is the one with
    // the icon + text and lives in the rail.
    const sidebarOwner = ownerButtons.find((b) => b.className.includes('rounded-md'));
    fireEvent.click(sidebarOwner);
    expect(screen.getByText('Marketing')).toBeInTheDocument(); // createdBy: u1
    expect(screen.queryByText('Engineering')).not.toBeInTheDocument(); // createdBy: u2
  });
});
