import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// --- Module mocks ---
// All variables referenced inside vi.mock factories MUST be created with vi.hoisted()
// because vi.mock calls are hoisted to the top of the file before any variable declarations.

const { mockNavigate, mockApiGet, mockApiPut, mockApiPost, authState } = vi.hoisted(() => {
  // authState is a plain object whose properties are mutated per-test.
  // The mock factory captures a reference to this object, so mutations are reflected.
  const authState = {
    user: { name: 'Alice Admin', role: 'admin' },
    canManage: true,
    isAdmin: true,
    isStrictAdmin: true,
    isManager: false,
    isAssistantManager: false,
    isDirector: false,
    isSuperAdmin: false,
    permissionGrants: [],
    effectivePermissions: {},
    granularPermissions: {},
  };
  return {
    mockNavigate: vi.fn(),
    mockApiGet: vi.fn(),
    mockApiPut: vi.fn(),
    mockApiPost: vi.fn(),
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
    post: mockApiPost,
  },
}));

vi.mock('../../../hooks/useSocket', () => ({ default: () => {} }));

// useRealtimeQuery wires Sidebar into the realtime refresh fabric. The
// production hook subscribes to socket events; for tests we just no-op.
vi.mock('../../../realtime/useRealtimeQuery', () => ({
  default: () => {},
}));

// Approvals badge — Sidebar reads a count + formatter. Return a stable
// "0 / no badge" pair so the row renders without an aria-pending label.
vi.mock('../../../hooks/useNavBadgeCounts', () => ({
  useApprovalsBadgeCount: () => 0,
  formatBadgeCount: () => null,
}));

// Child modals are heavy and not under test here — stub each with a minimal
// stand-in that surfaces an open/close hook for the relevant test. Paths
// mirror what Sidebar.jsx imports (relative to its own location); vitest
// resolves to the same module regardless of how the test file spells it.
vi.mock('../../board/CreateWorkspaceModal', () => ({
  default: ({ onClose }) => (
    <div data-testid="create-workspace-modal">
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));
vi.mock('../../board/CreateBoardModal', () => ({
  default: () => <div data-testid="create-board-modal" />,
}));
vi.mock('../../board/RearrangeBoardsModal', () => ({
  default: () => <div data-testid="rearrange-boards-modal" />,
}));
vi.mock('../../board/RearrangeWorkspacesModal', () => ({
  default: () => <div data-testid="rearrange-workspaces-modal" />,
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
  authState.isStrictAdmin = true;
  authState.isManager = false;
  authState.isAssistantManager = false;
  authState.isDirector = false;
  authState.isSuperAdmin = false;
  authState.permissionGrants = [];
  authState.effectivePermissions = {};
  authState.granularPermissions = {};
}

function setMemberAuth() {
  authState.user = { name: 'John Member', role: 'member' };
  authState.canManage = false;
  authState.isAdmin = false;
  authState.isStrictAdmin = false;
  authState.isManager = false;
  authState.isAssistantManager = false;
  authState.isDirector = false;
  authState.isSuperAdmin = false;
  authState.permissionGrants = [];
  authState.effectivePermissions = {};
  authState.granularPermissions = {};
}

function setManagerAuth() {
  authState.user = { name: 'Mgr User', role: 'manager' };
  authState.canManage = true;
  authState.isAdmin = false;
  authState.isStrictAdmin = false;
  authState.isManager = true;
  authState.isAssistantManager = false;
  authState.isDirector = false;
  authState.isSuperAdmin = false;
  authState.permissionGrants = [];
  authState.effectivePermissions = {};
  authState.granularPermissions = {};
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
      // The other two preference fetches (/board-orders/mine, /workspaces/order)
      // are marked `_silent` in the controller and the Sidebar swallows their
      // rejection; resolving with empty payloads keeps the happy-path quiet.
      if (url === '/board-orders/mine') return Promise.resolve({ data: { orders: {} } });
      if (url === '/workspaces/order') return Promise.resolve({ data: { workspaceIds: [] } });
      return Promise.resolve({ data: {} });
    });
  });

  // ---- Core navigation items (present for every role) ----

  it('renders the Home navigation item', () => {
    renderSidebar();
    expect(screen.getByText('Home')).toBeInTheDocument();
  });

  it('renders the My Work navigation item', () => {
    renderSidebar();
    expect(screen.getByText('My Work')).toBeInTheDocument();
  });

  it('renders Meetings navigation item', () => {
    renderSidebar();
    expect(screen.getByText('Meetings')).toBeInTheDocument();
  });

  it('renders Reviews navigation item', () => {
    renderSidebar();
    expect(screen.getByText('Reviews')).toBeInTheDocument();
  });

  // Time Plan and Org Chart moved to header icons in the latest layout — the
  // sidebar no longer renders them. Verify their absence to lock in the layout.
  it('does NOT render Time Plan in the sidebar (moved to header icons)', () => {
    renderSidebar();
    expect(screen.queryByText('Time Plan')).not.toBeInTheDocument();
  });

  it('does NOT render Org Chart in the sidebar (moved to header icons)', () => {
    renderSidebar();
    expect(screen.queryByText('Org Chart')).not.toBeInTheDocument();
  });

  // ---- Manager+ items ----

  it('renders Team Dashboard for admin', () => {
    renderSidebar();
    expect(screen.getByText('Team Dashboard')).toBeInTheDocument();
  });

  // Admin Settings / Integrations / Archive / Feedback all moved to the
  // top-right header profile dropdown. They must NOT appear in the sidebar.
  it('does NOT render Admin Settings, Integrations, or Archive in the sidebar (moved to header dropdown)', () => {
    renderSidebar();
    expect(screen.queryByText('Admin Settings')).not.toBeInTheDocument();
    expect(screen.queryByText('Integrations')).not.toBeInTheDocument();
    expect(screen.queryByText('Archive')).not.toBeInTheDocument();
  });

  it('does NOT render Team Dashboard for a plain member', () => {
    setMemberAuth();
    renderSidebar();
    expect(screen.queryByText('Team Dashboard')).not.toBeInTheDocument();
  });

  it('renders Team Dashboard for a manager', () => {
    setManagerAuth();
    renderSidebar();
    expect(screen.getByText('Team Dashboard')).toBeInTheDocument();
  });

  // ---- Collapse / expand ----

  it('calls onToggle when the collapse button is clicked', () => {
    const onToggle = vi.fn();
    render(
      <MemoryRouter>
        <Sidebar collapsed={false} onToggle={onToggle} />
      </MemoryRouter>
    );
    // The collapse button is the only PanelLeftClose sibling inside the
    // logo header (border-b). Click whichever button is in that row.
    const header = screen.getByText('Monday Aniston').closest('div.border-b');
    const collapseBtn = header.querySelector('button');
    fireEvent.click(collapseBtn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('does NOT render the full nav labels when collapsed=true', () => {
    render(
      <MemoryRouter>
        <Sidebar collapsed={true} onToggle={vi.fn()} />
      </MemoryRouter>
    );
    // Collapsed mode renders only icon-buttons; the text labels are hidden.
    expect(screen.queryByText('My Work')).not.toBeInTheDocument();
    expect(screen.queryByText('Reviews')).not.toBeInTheDocument();
  });

  // ---- User footer ----

  it('shows the logged-in user name in the footer', () => {
    renderSidebar();
    expect(screen.getByText('Alice Admin')).toBeInTheDocument();
  });

  // The footer now shows the tier label (Tier 1..Tier 4) — see tiers.js.
  // admin → Tier 2, member → Tier 4, assistant_manager → Tier 3.
  it('shows the tier label in the footer for admin role', () => {
    renderSidebar();
    expect(screen.getByText('Tier 2')).toBeInTheDocument();
  });

  // ---- Profile modal ----

  // Sidebar Profile and Header "My Profile" must open the same overlay.
  // Both navigate to /profile with the current location as state.background
  // so App.jsx mounts ProfileModalRoute on top of the page behind it. The
  // separate right-side Account Settings drawer was removed for parity.
  it('navigates to /profile with background state when the user footer button is clicked', () => {
    renderSidebar();
    const accountBtn = screen.getByTitle('Account Settings');
    fireEvent.click(accountBtn);
    expect(mockNavigate).toHaveBeenCalledWith(
      '/profile',
      expect.objectContaining({ state: expect.objectContaining({ background: expect.any(Object) }) })
    );
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

  it('navigates to /dashboard when Team Dashboard is clicked (admin)', () => {
    renderSidebar();
    fireEvent.click(screen.getByText('Team Dashboard'));
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard');
  });

  it('navigates to /meetings when Meetings is clicked', () => {
    renderSidebar();
    fireEvent.click(screen.getByText('Meetings'));
    expect(mockNavigate).toHaveBeenCalledWith('/meetings');
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
      // /workspaces/mine is also fetched (second arg may be the silent-options
      // object, so we only check by URL substring).
      const urls = mockApiGet.mock.calls.map((c) => c[0]);
      expect(urls).toContain('/workspaces/mine');
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
      if (url === '/board-orders/mine') return Promise.resolve({ data: { orders: {} } });
      if (url === '/workspaces/order') return Promise.resolve({ data: { workspaceIds: [] } });
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
      if (url === '/board-orders/mine') return Promise.resolve({ data: { orders: {} } });
      if (url === '/workspaces/order') return Promise.resolve({ data: { workspaceIds: [] } });
      return Promise.resolve({ data: {} });
    });
    renderSidebar();
    await waitFor(() => {
      expect(screen.getByText('Sprint 1')).toBeInTheDocument();
    });
  });
});
