import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';

// --- Module mocks ---
// All variables referenced inside vi.mock factories must be created with vi.hoisted()
// because vi.mock is hoisted before any module-level variable declarations.

const {
  mockApiGet, mockApiPost, mockApiPut,
  mockConnect, mockDisconnect, mockDisconnectForLogout,
  mockSubscribe, mockGetSocketId, mockOnConnect,
  mockUnsubscribeFromPush,
} = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
  mockApiPut: vi.fn(),
  mockConnect: vi.fn(),
  mockDisconnect: vi.fn(),
  mockDisconnectForLogout: vi.fn(),
  mockSubscribe: vi.fn(() => () => {}), // returns unsubscribe fn
  mockGetSocketId: vi.fn(() => 'fake-socket-id'),
  mockOnConnect: vi.fn(() => () => {}),
  mockUnsubscribeFromPush: vi.fn(() => Promise.resolve(null)),
}));

// Mock the api service — actual HTTP calls must never fire in unit tests
vi.mock('../../services/api', () => ({
  default: {
    get: mockApiGet,
    post: mockApiPost,
    put: mockApiPut,
  },
}));

// Mock the socket service — we don't want real socket connections.
// AuthContext.jsx imports connect, disconnect, disconnectForLogout, subscribe,
// and getSocketId, so all of those must be exported here or the module fails
// to evaluate.
vi.mock('../../services/socket', () => ({
  connect: mockConnect,
  disconnect: mockDisconnect,
  disconnectForLogout: mockDisconnectForLogout,
  subscribe: mockSubscribe,
  getSocketId: mockGetSocketId,
  onConnect: mockOnConnect,
}));

// pushNotifications is imported by AuthContext for logout teardown.
vi.mock('../../services/pushNotifications', () => ({
  unsubscribeFromPush: mockUnsubscribeFromPush,
}));

import { AuthProvider, useAuth } from '../AuthContext';

// --- Test consumer component ---
// Renders auth context values as data-testid attributes so we can assert on them.
function AuthConsumer() {
  const {
    user,
    token,
    loading,
    isAdmin,
    isManager,
    isMember,
    isAssistantManager,
    canManage,
    isDirector,
    login,
    logout,
  } = useAuth();

  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="user">{user ? user.name : 'none'}</span>
      <span data-testid="role">{user ? user.role : 'none'}</span>
      <span data-testid="token">{token || 'none'}</span>
      <span data-testid="isAdmin">{String(isAdmin)}</span>
      <span data-testid="isManager">{String(isManager)}</span>
      <span data-testid="isMember">{String(isMember)}</span>
      <span data-testid="isAssistantManager">{String(isAssistantManager)}</span>
      <span data-testid="canManage">{String(canManage)}</span>
      <span data-testid="isDirector">{String(isDirector)}</span>
      <button onClick={() => login('user@test.com', 'pass123')} data-testid="login-btn">Login</button>
      <button onClick={() => logout()} data-testid="logout-btn">Logout</button>
    </div>
  );
}

function renderWithProvider() {
  return render(
    <AuthProvider>
      <AuthConsumer />
    </AuthProvider>
  );
}

// Build a fake API response structure that mirrors the real backend
function makeLoginResponse(user) {
  return {
    data: {
      data: {
        token: 'fake-jwt-token',
        refreshToken: 'fake-refresh-token',
        user,
      },
    },
  };
}

function makeMeResponse(user) {
  return {
    data: {
      data: { user },
    },
  };
}

describe('AuthContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    // Default: no existing session — D-1 Phase 2 always hits /auth/me and
    // treats a 401 as "not logged in". A blanket reject keeps every test's
    // loadUser path silent and user=null unless the test overrides the mock.
    mockApiGet.mockRejectedValue({ response: { status: 401 }, message: 'Unauthorized' });
    // Many logout / login paths post to /auth/logout or /auth/login — keep a
    // resolved default so background calls never blow up the test.
    mockApiPost.mockResolvedValue({ data: { success: true, data: {} } });
  });

  afterEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  // ---- Initial state ----

  it('provides loading=true initially before the profile API resolves', async () => {
    // Hold the API call so loading stays true
    let resolveMe;
    mockApiGet.mockReturnValue(new Promise((res) => { resolveMe = res; }));
    sessionStorage.setItem('token', 'existing-token');

    render(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>
    );

    expect(screen.getByTestId('loading').textContent).toBe('true');
    // Resolve so the component finishes
    await act(async () => { resolveMe({ data: {} }); });
  });

  it('provides user=none and loading=false when no token is stored', async () => {
    renderWithProvider();
    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    expect(screen.getByTestId('user').textContent).toBe('none');
  });

  it('loads user from API when a token already exists in sessionStorage', async () => {
    sessionStorage.setItem('token', 'stored-token');
    mockApiGet.mockResolvedValue(makeMeResponse({ name: 'Alice', role: 'admin' }));

    renderWithProvider();
    await waitFor(() => {
      expect(screen.getByTestId('user').textContent).toBe('Alice');
    });
    expect(mockApiGet).toHaveBeenCalledWith('/auth/me');
  });

  // D-1 Phase 2 removed legacy localStorage→sessionStorage migration; auth now
  // rides an httpOnly cookie. We still verify that a cookie session resolves
  // the user via /auth/me regardless of any stale storage value.
  it('loads user via /auth/me even when only localStorage has a (legacy) token', async () => {
    localStorage.setItem('token', 'local-token');
    mockApiGet.mockResolvedValue(makeMeResponse({ name: 'Bob', role: 'member' }));

    renderWithProvider();
    await waitFor(() => {
      expect(screen.getByTestId('user').textContent).toBe('Bob');
    });
    expect(mockApiGet).toHaveBeenCalledWith('/auth/me');
  });

  // ---- login() function ----

  it('sets the user after a successful login (D-1 Phase 2: session lives in cookie)', async () => {
    // No existing token — loadUser rejects with 401 (default)
    mockApiPost.mockResolvedValue(
      makeLoginResponse({ name: 'Admin User', role: 'admin', hierarchyLevel: null })
    );

    renderWithProvider();
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));

    await act(async () => {
      screen.getByTestId('login-btn').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('user').textContent).toBe('Admin User');
    });
    // Phase 2: tokens are NOT written to storage — auth rides an httpOnly cookie.
    expect(sessionStorage.getItem('token')).toBeNull();
    expect(sessionStorage.getItem('refreshToken')).toBeNull();
  });

  it('calls socket connect after successful login', async () => {
    mockApiPost.mockResolvedValue(
      makeLoginResponse({ name: 'Manager', role: 'manager', hierarchyLevel: null })
    );

    renderWithProvider();
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));

    await act(async () => {
      screen.getByTestId('login-btn').click();
    });

    // Phase 2: connect() is called with no argument — the socket reads the
    // auth cookie via withCredentials on the handshake.
    await waitFor(() => {
      expect(mockConnect).toHaveBeenCalled();
    });
  });

  // ---- logout() function ----

  it('clears user and token after logout', async () => {
    sessionStorage.setItem('token', 'stored-token');
    mockApiGet.mockResolvedValue(makeMeResponse({ name: 'Alice', role: 'admin' }));

    renderWithProvider();
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('Alice'));

    await act(async () => {
      screen.getByTestId('logout-btn').click();
    });

    expect(screen.getByTestId('user').textContent).toBe('none');
    expect(screen.getByTestId('token').textContent).toBe('none');
    expect(sessionStorage.getItem('token')).toBeNull();
  });

  it('calls socket disconnectForLogout on logout', async () => {
    sessionStorage.setItem('token', 'stored-token');
    mockApiGet.mockResolvedValue(makeMeResponse({ name: 'Alice', role: 'admin' }));

    renderWithProvider();
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('Alice'));

    await act(async () => {
      screen.getByTestId('logout-btn').click();
    });

    // logout uses the hard disconnectForLogout() which engages the logoutLatch
    // so a stale reconnect cannot revive the socket after teardown.
    expect(mockDisconnectForLogout).toHaveBeenCalled();
  });

  it('clears localStorage tokens on logout', async () => {
    sessionStorage.setItem('token', 'tok');
    localStorage.setItem('token', 'old-local-tok');
    mockApiGet.mockResolvedValue(makeMeResponse({ name: 'Alice', role: 'admin' }));

    renderWithProvider();
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('Alice'));

    await act(async () => {
      screen.getByTestId('logout-btn').click();
    });

    expect(localStorage.getItem('token')).toBeNull();
  });

  // ---- RBAC role helpers ----

  // Phase 6 tier rollout: admin and manager both resolve to Tier 2, so the
  // legacy `isAdmin` / `isManager` aliases both return true for either role.
  // The tests verify the tier-derived semantics rather than the pre-tier
  // mutual exclusivity. See AuthContext.jsx legacy-alias block.
  it('sets isAdmin=true and canManage=true for admin role', async () => {
    sessionStorage.setItem('token', 'tok');
    mockApiGet.mockResolvedValue(makeMeResponse({ name: 'Admin', role: 'admin', hierarchyLevel: null }));
    renderWithProvider();
    await waitFor(() => expect(screen.getByTestId('isAdmin').textContent).toBe('true'));
    expect(screen.getByTestId('isMember').textContent).toBe('false');
    expect(screen.getByTestId('canManage').textContent).toBe('true');
  });

  it('sets isManager=true and canManage=true for manager role', async () => {
    sessionStorage.setItem('token', 'tok');
    mockApiGet.mockResolvedValue(makeMeResponse({ name: 'Mgr', role: 'manager', hierarchyLevel: null }));
    renderWithProvider();
    await waitFor(() => expect(screen.getByTestId('isManager').textContent).toBe('true'));
    expect(screen.getByTestId('isMember').textContent).toBe('false');
    expect(screen.getByTestId('canManage').textContent).toBe('true');
  });

  it('sets isMember=true for member role', async () => {
    sessionStorage.setItem('token', 'tok');
    mockApiGet.mockResolvedValue(makeMeResponse({ name: 'John', role: 'member', hierarchyLevel: null }));
    renderWithProvider();
    await waitFor(() => expect(screen.getByTestId('isMember').textContent).toBe('true'));
    expect(screen.getByTestId('isAdmin').textContent).toBe('false');
    expect(screen.getByTestId('isManager').textContent).toBe('false');
    expect(screen.getByTestId('canManage').textContent).toBe('false');
  });

  // assistant_manager resolves to Tier 3. canManage is currently scoped to
  // T1/T2, so it is false here even though the assistant_manager role has
  // partial-management capabilities elsewhere in the app.
  it('sets isAssistantManager=true for assistant_manager role', async () => {
    sessionStorage.setItem('token', 'tok');
    mockApiGet.mockResolvedValue(
      makeMeResponse({ name: 'Asst', role: 'assistant_manager', hierarchyLevel: null })
    );
    renderWithProvider();
    await waitFor(() => expect(screen.getByTestId('isAssistantManager').textContent).toBe('true'));
    expect(screen.getByTestId('isAdmin').textContent).toBe('false');
    expect(screen.getByTestId('isMember').textContent).toBe('false');
  });

  it('sets isDirector=true when hierarchyLevel is "director"', async () => {
    sessionStorage.setItem('token', 'tok');
    mockApiGet.mockResolvedValue(
      makeMeResponse({ name: 'Dir', role: 'manager', hierarchyLevel: 'director' })
    );
    renderWithProvider();
    await waitFor(() => expect(screen.getByTestId('isDirector').textContent).toBe('true'));
  });

  it('sets isDirector=true when hierarchyLevel is "vp"', async () => {
    sessionStorage.setItem('token', 'tok');
    mockApiGet.mockResolvedValue(
      makeMeResponse({ name: 'VP', role: 'manager', hierarchyLevel: 'vp' })
    );
    renderWithProvider();
    await waitFor(() => expect(screen.getByTestId('isDirector').textContent).toBe('true'));
  });

  it('sets isDirector=false for a regular member', async () => {
    sessionStorage.setItem('token', 'tok');
    mockApiGet.mockResolvedValue(
      makeMeResponse({ name: 'John', role: 'member', hierarchyLevel: 'member' })
    );
    renderWithProvider();
    await waitFor(() => expect(screen.getByTestId('isDirector').textContent).toBe('false'));
  });

  // ---- Error recovery on loadUser ----

  it('clears token from storage when the /auth/me call fails', async () => {
    sessionStorage.setItem('token', 'bad-token');
    mockApiGet.mockRejectedValue(new Error('401 Unauthorized'));

    renderWithProvider();
    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    expect(sessionStorage.getItem('token')).toBeNull();
    expect(screen.getByTestId('user').textContent).toBe('none');
  });

  // ---- useAuth guard ----

  it('throws when useAuth is used outside AuthProvider', () => {
    // Suppress the React error boundary output
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<AuthConsumer />)).toThrow(
      'useAuth must be used within AuthProvider'
    );
    spy.mockRestore();
  });
});
