import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// --- Module mocks ---
// All variables referenced inside vi.mock factories MUST be created with vi.hoisted()
// because vi.mock calls are hoisted to the top of the file before any variable declarations.

const { mockNavigate, mockApiGet, mockApiPut, authState } = vi.hoisted(() => {
  // authState is a plain object whose properties are mutated per-test.
  // The mock factory captures a reference to this object, so mutations are reflected.
  const authState = {
    user: { name: 'Alice Admin', role: 'admin' },
    canManage: true,
    isAdmin: true,
    isManager: false,
    isAssistantManager: false,
    isDirector: false,
    isSuperAdmin: false,
  };
  return {
    mockNavigate: vi.fn(),
    mockApiGet: vi.fn(),
    mockApiPut: vi.fn(),
    authState,
  };
});

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('../../../context/AuthContext', () => ({
  // Return the shared authState object — mutations in beforeEach are visible here
  useAuth: () => authState,
}));

vi.mock('../../../services/api', () => ({
  default: {
    get: mockApiGet,
    put: mockApiPut,
  },
}));

vi.mock('../../../hooks/useSocket', () => ({ default: () => {} }));

// Child modals are heavy — stub them with minimal stand-ins
vi.mock('../../board/CreateWorkspaceModal', () => ({
  default: ({ onClose }) => (
    <div data-testid="create-workspace-modal">
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));

vi.mock('../../common/ProfileModal', () => ({
  default: ({ onClose }) => (
    <div data-testid="profile-modal">
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));

// createPortal renders portals inline in jsdom (no document.body append needed)
vi.mock('react-dom', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createPortal: (children) => children,
  };
});

import Sidebar from '../Sidebar';

const EMPTY_BOARDS_RESPONSE = { data: { boards: [] } };
const EMPTY_WORKSPACES_RESPONSE = { data: { workspaces: [] } };

// Helper to reset authState to admin defaults between tests
function setAdminAuth() {
  authState.user = { name: 'Alice Admin', role: 'admin' };
  authState.canManage = true;
  authState.isAdmin = true;
  authState.isManager = false;
  authState.isAssistantManager = false;
  authState.isDirector = false;
  authState.isSuperAdmin = false;
}

function setMemberAuth() {
  authState.user = { name: 'John Member', role: 'member' };
  authState.canManage = false;
  authState.isAdmin = false;
  authState.isManager = false;
  authState.isAssistantManager = false;
  authState.isDirector = false;
  authState.isSuperAdmin = false;
}

function setManagerAuth() {
  authState.user = { name: 'Mgr User', role: 'manager' };
  authState.canManage = true;
  authState.isAdmin = false;
  authState.isManager = true;
  authState.isAssistantManager = false;
  authState.isDirector = false;
  authState.isSuperAdmin = false;
}

function renderSidebar(props = {}) {
  return render(
    <MemoryRouter initialEntries={[props.initialPath || '/']}>
      <Sidebar collapsed={false} onToggle={vi.fn()} {...props} />
    </MemoryRouter>
  );
}

describe('Sidebar component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAdminAuth();
    mockApiGet.mockImplementation((url) => {
      if (url === '/boards') return Promise.resolve(EMPTY_BOARDS_RESPONSE);
      if (url === '/workspaces/mine') return Promise.resolve(EMPTY_WORKSPACES_RESPONSE);
      return Promise.resolve({ data: {} });
    });
  });

  // ---- Core navigation items ----

  it('renders the Home navigation item', () => {
    renderSidebar();
    expect(screen.getByText('Home')).toBeInTheDocument();
  });

  it('renders the My Work navigation item', () => {
    renderSidebar();
    expect(screen.getByText('My Work')).toBeInTheDocument();
  });

  it('renders Time Plan navigation item', () => {
    renderSidebar();
    expect(screen.getByText('Time Plan')).toBeInTheDocument();
  });

  it('renders Meetings navigation item', () => {
    renderSidebar();
    expect(screen.getByText('Meetings')).toBeInTheDocument();
  });

  it('renders Reviews navigation item', () => {
    renderSidebar();
    expect(screen.getByText('Reviews')).toBeInTheDocument();
  });

  it('renders the Org Chart navigation item', () => {
    renderSidebar();
    expect(screen.getByText('Org Chart')).toBeInTheDocument();
  });

  // ---- Admin-only items ----

  it('renders Dashboard, Team, Admin Settings, Integrations, and Archive for admin', () => {
    renderSidebar();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Team')).toBeInTheDocument();
    expect(screen.getByText('Admin Settings')).toBeInTheDocument();
    expect(screen.getByText('Integrations')).toBeInTheDocument();
    expect(screen.getByText('Archive')).toBeInTheDocument();
  });

  it('does NOT render Admin Settings, Integrations, and Archive for a plain member', () => {
    setMemberAuth();
    renderSidebar();
    expect(screen.queryByText('Admin Settings')).not.toBeInTheDocument();
    expect(screen.queryByText('Integrations')).not.toBeInTheDocument();
    expect(screen.queryByText('Archive')).not.toBeInTheDocument();
  });

  it('does NOT render Dashboard and Team for a plain member', () => {
    setMemberAuth();
    renderSidebar();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
    expect(screen.queryByText('Team')).not.toBeInTheDocument();
  });

  it('renders Dashboard and Team for a manager but NOT Admin Settings', () => {
    setManagerAuth();
    renderSidebar();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Team')).toBeInTheDocument();
    expect(screen.queryByText('Admin Settings')).not.toBeInTheDocument();
  });

  // ---- Collapse / expand ----

  it('calls onToggle when the collapse button (PanelLeftClose) is clicked', () => {
    const onToggle = vi.fn();
    render(
      <MemoryRouter>
        <Sidebar collapsed={false} onToggle={onToggle} />
      </MemoryRouter>
    );
    // The collapse button is inside the logo header border-b div
    const header = screen.getByText('Monday Aniston').closest('div.border-b');
    const collapseBtn = header.querySelector('button');
    fireEvent.click(collapseBtn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('renders the collapsed variant (w-[52px] width) when collapsed=true', () => {
    const { container } = render(
      <MemoryRouter>
        <Sidebar collapsed={true} onToggle={vi.fn()} />
      </MemoryRouter>
    );
    // The collapsed sidebar has a fixed 52px width class
    expect(container.querySelector('.w-\\[52px\\]')).toBeInTheDocument();
  });

  it('does NOT render the full nav labels when collapsed=true', () => {
    render(
      <MemoryRouter>
        <Sidebar collapsed={true} onToggle={vi.fn()} />
      </MemoryRouter>
    );
    expect(screen.queryByText('My Work')).not.toBeInTheDocument();
    expect(screen.queryByText('Reviews')).not.toBeInTheDocument();
  });

  // ---- User footer ----

  it('shows the logged-in user name in the footer', () => {
    renderSidebar();
    expect(screen.getByText('Alice Admin')).toBeInTheDocument();
  });

  it('shows the user role in the footer', () => {
    renderSidebar();
    // The footer shows user.role — "admin"
    expect(screen.getByText('admin')).toBeInTheDocument();
  });

  // ---- Profile modal ----

  it('opens the profile modal when the user footer button is clicked', () => {
    renderSidebar();
    const accountBtn = screen.getByTitle('Account Settings');
    fireEvent.click(accountBtn);
    expect(screen.getByTestId('profile-modal')).toBeInTheDocument();
  });

  // ---- Workspace search ----

  it('renders the board search input', () => {
    renderSidebar();
    expect(screen.getByPlaceholderText('Search boards...')).toBeInTheDocument();
  });

  it('updates search value when typing in the search input', () => {
    renderSidebar();
    const searchInput = screen.getByPlaceholderText('Search boards...');
    fireEvent.change(searchInput, { target: { value: 'marketing' } });
    expect(searchInput).toHaveValue('marketing');
  });

  // ---- Navigation ----

  it('navigates to / when Home is clicked', () => {
    renderSidebar();
    fireEvent.click(screen.getByText('Home'));
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('navigates to /my-work when My Work is clicked', () => {
    renderSidebar();
    fireEvent.click(screen.getByText('My Work'));
    expect(mockNavigate).toHaveBeenCalledWith('/my-work');
  });

  it('navigates to /dashboard when Dashboard is clicked (admin)', () => {
    renderSidebar();
    fireEvent.click(screen.getByText('Dashboard'));
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard');
  });

  it('navigates to /meetings when Meetings is clicked', () => {
    renderSidebar();
    fireEvent.click(screen.getByText('Meetings'));
    expect(mockNavigate).toHaveBeenCalledWith('/meetings');
  });

  // ---- Add workspace button ----

  it('renders the Add new workspace button', () => {
    renderSidebar();
    expect(screen.getByText('Add new workspace')).toBeInTheDocument();
  });

  it('opens the CreateWorkspaceModal when Add new workspace is clicked', () => {
    renderSidebar();
    fireEvent.click(screen.getByText('Add new workspace'));
    expect(screen.getByTestId('create-workspace-modal')).toBeInTheDocument();
  });

  // ---- Empty state ----

  it('shows "No boards yet" when there are no boards or workspaces', async () => {
    renderSidebar();
    await waitFor(() => {
      expect(screen.getByText('No boards yet')).toBeInTheDocument();
    });
  });

  // ---- API calls ----

  it('calls /boards and /workspaces/mine on mount', async () => {
    renderSidebar();
    await waitFor(() => {
      expect(mockApiGet).toHaveBeenCalledWith('/boards');
      expect(mockApiGet).toHaveBeenCalledWith('/workspaces/mine');
    });
  });

  // ---- Workspaces in sidebar ----

  it('renders workspace names when workspaces are returned from the API', async () => {
    mockApiGet.mockImplementation((url) => {
      if (url === '/boards') return Promise.resolve({ data: { boards: [] } });
      if (url === '/workspaces/mine')
        return Promise.resolve({
          data: {
            workspaces: [{ id: 'ws1', name: 'Engineering', color: '#0073ea', boards: [] }],
          },
        });
      return Promise.resolve({ data: {} });
    });
    renderSidebar();
    await waitFor(() => {
      expect(screen.getByText('Engineering')).toBeInTheDocument();
    });
  });

  it('renders board names inside a workspace when boards are returned', async () => {
    mockApiGet.mockImplementation((url) => {
      if (url === '/boards')
        return Promise.resolve({
          data: { boards: [{ id: 'b1', name: 'Sprint 1', color: '#579bfc', workspaceId: 'ws1' }] },
        });
      if (url === '/workspaces/mine')
        return Promise.resolve({
          data: {
            workspaces: [
              {
                id: 'ws1',
                name: 'Engineering',
                color: '#0073ea',
                boards: [{ id: 'b1', name: 'Sprint 1', color: '#579bfc' }],
              },
            ],
          },
        });
      return Promise.resolve({ data: {} });
    });
    renderSidebar();
    await waitFor(() => {
      expect(screen.getByText('Sprint 1')).toBeInTheDocument();
    });
  });
});
