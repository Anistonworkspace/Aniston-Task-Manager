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

  it('renders the Dashboard (formerly Home) navigation item', () => {
    renderSidebar();
    // Home was renamed to "Dashboard" — the icon and path (`/`) are
    // unchanged; only the visible label moved. Two Dashboard rows exist
    // (the personal one at `/` and Team Dashboard at `/dashboard`),
    // so we look for at least one occurrence.
    expect(screen.getAllByText('Dashboard').length).toBeGreaterThan(0);
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
    // The logo header (border-b) now holds TWO buttons: the brand button
    // (logo + title) which reloads the app, and the collapse toggle. The
    // collapse button is the last one in the row.
    const header = screen.getByText('Monday Aniston').closest('div.border-b');
    const buttons = header.querySelectorAll('button');
    const collapseBtn = buttons[buttons.length - 1];
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

  it('navigates to / when Dashboard (formerly Home) is clicked', () => {
    renderSidebar();
    // The personal Dashboard row is always first in the sidebar nav;
    // the Team Dashboard entry (when present) lives below the divider.
    fireEvent.click(screen.getAllByText('Dashboard')[0]);
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

  // ---- Sidebar search behavior ----
  // Locks in the fix for the regression where searching a workspace name
  // showed "No boards match" under it (the inner filter ran even when the
  // workspace itself matched) and where board-name hits were buried inside
  // their parent workspace position instead of promoted to the top.

  function mockMultiWorkspace() {
    mockApiGet.mockImplementation((url) => {
      if (url === '/boards') {
        return Promise.resolve({
          data: {
            boards: [
              { id: 'b1', name: 'Roadmap', color: '#579bfc', workspaceId: 'ws1' },
              { id: 'b2', name: 'Bugs', color: '#ff5ac4', workspaceId: 'ws1' },
              { id: 'b3', name: 'ALL DAY', color: '#00c875', workspaceId: 'ws3' },
              { id: 'b4', name: 'Standalone', color: '#fdab3d', workspaceId: null },
            ],
          },
        });
      }
      if (url === '/workspaces/mine') {
        return Promise.resolve({
          data: {
            workspaces: [
              {
                id: 'ws1',
                name: 'workspace 1',
                color: '#0073ea',
                boards: [
                  { id: 'b1', name: 'Roadmap', color: '#579bfc' },
                  { id: 'b2', name: 'Bugs', color: '#ff5ac4' },
                ],
              },
              {
                id: 'ws2',
                name: 'workspace 2',
                color: '#0073ea',
                boards: [],
              },
              {
                id: 'ws3',
                name: 'workspace 3',
                color: '#0073ea',
                boards: [{ id: 'b3', name: 'ALL DAY', color: '#00c875' }],
              },
              {
                id: 'ws4',
                name: 'Marketing',
                color: '#0073ea',
                boards: [],
              },
            ],
          },
        });
      }
      if (url === '/board-orders/mine') return Promise.resolve({ data: { orders: {} } });
      if (url === '/workspaces/order') return Promise.resolve({ data: { workspaceIds: [] } });
      return Promise.resolve({ data: {} });
    });
  }

  it('search "work" shows matching workspaces and their boards (no "No boards match")', async () => {
    mockMultiWorkspace();
    renderSidebar();
    await waitFor(() => expect(screen.getByText('workspace 1')).toBeInTheDocument());

    const searchInput = screen.getByPlaceholderText('Search boards...');
    fireEvent.change(searchInput, { target: { value: 'work' } });

    expect(screen.getByText('workspace 1')).toBeInTheDocument();
    expect(screen.getByText('workspace 2')).toBeInTheDocument();
    expect(screen.getByText('workspace 3')).toBeInTheDocument();
    expect(screen.queryByText('Marketing')).not.toBeInTheDocument();
    // Boards inside matching workspaces appear even though no board contains "work"
    expect(screen.getByText('Roadmap')).toBeInTheDocument();
    expect(screen.getByText('Bugs')).toBeInTheDocument();
    expect(screen.getByText('ALL DAY')).toBeInTheDocument();
    // The misleading "No boards match" message must NOT render
    expect(screen.queryByText('No boards match')).not.toBeInTheDocument();
  });

  it('search "all" promotes the "ALL DAY" board to the top with parent workspace context', async () => {
    mockMultiWorkspace();
    renderSidebar();
    await waitFor(() => expect(screen.getByText('workspace 1')).toBeInTheDocument());

    const searchInput = screen.getByPlaceholderText('Search boards...');
    fireEvent.change(searchInput, { target: { value: 'all' } });

    expect(screen.getByText('Matching boards')).toBeInTheDocument();
    expect(screen.getAllByText('ALL DAY').length).toBeGreaterThan(0);
    // Parent workspace context renders as the subtitle on the promoted row
    expect(screen.getByText('workspace 3')).toBeInTheDocument();
    // No workspace name contains "all"
    expect(screen.queryByText('workspace 1')).not.toBeInTheDocument();
    expect(screen.queryByText('workspace 2')).not.toBeInTheDocument();
  });

  it('clicking a promoted matching board navigates to /boards/:id', async () => {
    mockMultiWorkspace();
    renderSidebar();
    await waitFor(() => expect(screen.getByText('workspace 1')).toBeInTheDocument());

    const searchInput = screen.getByPlaceholderText('Search boards...');
    fireEvent.change(searchInput, { target: { value: 'all' } });

    const matches = screen.getAllByText('ALL DAY');
    fireEvent.click(matches[0]);
    expect(mockNavigate).toHaveBeenCalledWith('/boards/b3');
  });

  it('search is case-insensitive — "ALL", "all", "All" behave the same', async () => {
    mockMultiWorkspace();
    renderSidebar();
    await waitFor(() => expect(screen.getByText('workspace 1')).toBeInTheDocument());
    const searchInput = screen.getByPlaceholderText('Search boards...');

    for (const q of ['ALL', 'all', 'All']) {
      fireEvent.change(searchInput, { target: { value: q } });
      expect(screen.getByText('Matching boards')).toBeInTheDocument();
      expect(screen.getAllByText('ALL DAY').length).toBeGreaterThan(0);
    }
  });

  it('partial board-name search promotes matching boards to the top', async () => {
    mockMultiWorkspace();
    renderSidebar();
    await waitFor(() => expect(screen.getByText('workspace 1')).toBeInTheDocument());

    const searchInput = screen.getByPlaceholderText('Search boards...');
    fireEvent.change(searchInput, { target: { value: 'road' } });
    expect(screen.getByText('Matching boards')).toBeInTheDocument();
    expect(screen.getAllByText('Roadmap').length).toBeGreaterThan(0);
    // Other boards (which only appear via their workspace) must NOT render —
    // their workspace doesn't match, so the workspace itself is hidden too.
    expect(screen.queryByText('Bugs')).not.toBeInTheDocument();
    expect(screen.queryByText('ALL DAY')).not.toBeInTheDocument();
    expect(screen.queryByText('Marketing')).not.toBeInTheDocument();
    // "workspace 1" still appears, but only as the subtitle under the
    // promoted Roadmap row — that's the intentional parent-context.
  });

  it('clearing the search restores the normal sidebar', async () => {
    mockMultiWorkspace();
    renderSidebar();
    await waitFor(() => expect(screen.getByText('workspace 1')).toBeInTheDocument());

    const searchInput = screen.getByPlaceholderText('Search boards...');
    fireEvent.change(searchInput, { target: { value: 'all' } });
    // In search mode, only matching workspace 3 is in the workspace section
    expect(screen.getByText('Matching boards')).toBeInTheDocument();
    expect(screen.queryByText('workspace 1')).not.toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: '' } });
    // After clearing: matching-boards section gone, original workspaces back.
    // The default cap is 3 workspaces — pre-existing tests confirm Marketing
    // (the 4th) sits behind a "Show more workspaces" toggle, so we don't
    // assert on it. workspace 1's return is enough proof that search exited.
    expect(screen.queryByText('Matching boards')).not.toBeInTheDocument();
    expect(screen.getByText('workspace 1')).toBeInTheDocument();
  });

  it('search with no matches shows the "No boards or workspaces match" empty state', async () => {
    mockMultiWorkspace();
    renderSidebar();
    await waitFor(() => expect(screen.getByText('workspace 1')).toBeInTheDocument());

    const searchInput = screen.getByPlaceholderText('Search boards...');
    fireEvent.change(searchInput, { target: { value: 'xyznonexistent' } });
    expect(screen.getByText('No boards or workspaces match')).toBeInTheDocument();
    expect(screen.queryByText('Matching boards')).not.toBeInTheDocument();
  });

  it('dedupes a board match when its parent workspace also matches', async () => {
    mockApiGet.mockImplementation((url) => {
      if (url === '/boards') {
        return Promise.resolve({
          data: {
            boards: [{ id: 'b1', name: 'alpha-board', color: '#579bfc', workspaceId: 'ws1' }],
          },
        });
      }
      if (url === '/workspaces/mine') {
        return Promise.resolve({
          data: {
            workspaces: [
              {
                id: 'ws1',
                name: 'alpha-workspace',
                color: '#0073ea',
                boards: [{ id: 'b1', name: 'alpha-board', color: '#579bfc' }],
              },
            ],
          },
        });
      }
      if (url === '/board-orders/mine') return Promise.resolve({ data: { orders: {} } });
      if (url === '/workspaces/order') return Promise.resolve({ data: { workspaceIds: [] } });
      return Promise.resolve({ data: {} });
    });
    renderSidebar();
    await waitFor(() => expect(screen.getByText('alpha-workspace')).toBeInTheDocument());

    const searchInput = screen.getByPlaceholderText('Search boards...');
    fireEvent.change(searchInput, { target: { value: 'alpha' } });

    // Workspace also matched → board only renders under workspace, not at top
    expect(screen.queryByText('Matching boards')).not.toBeInTheDocument();
    expect(screen.getAllByText('alpha-board').length).toBe(1);
  });
});
