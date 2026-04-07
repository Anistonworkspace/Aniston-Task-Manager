import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';

// --- Module mocks ---
// All variables referenced inside vi.mock factories must be created with vi.hoisted()
// because vi.mock is hoisted before any module-level variable declarations.

const { mockApiGet, mockApiPost, mockConnect, mockDisconnect } = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
  mockConnect: vi.fn(),
  mockDisconnect: vi.fn(),
}));

// Mock the api service — actual HTTP calls must never fire in unit tests
vi.mock('../../services/api', () => ({
  default: {
    get: mockApiGet,
    post: mockApiPost,
  },
}));

// Mock the socket service — we don't want real socket connections
vi.mock('../../services/socket', () => ({
  connect: mockConnect,
  disconnect: mockDisconnect,
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
    // Default: no existing session
    mockApiGet.mockResolvedValue({ data: {} });
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

  it('migrates token from localStorage to sessionStorage', async () => {
    localStorage.setItem('token', 'local-token');
    mockApiGet.mockResolvedValue(makeMeResponse({ name: 'Bob', role: 'member' }));

    renderWithProvider();
    await waitFor(() => {
      expect(screen.getByTestId('user').textContent).toBe('Bob');
    });
    expect(sessionStorage.getItem('token')).toBe('local-token');
    expect(localStorage.getItem('token')).toBeNull();
  });

  // ---- login() function ----

  it('sets user and token after successful login', async () => {
    // No existing token — loadUser resolves immediately
    mockApiGet.mockResolvedValue({ data: {} });
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
    expect(screen.getByTestId('token').textContent).toBe('fake-jwt-token');
    expect(sessionStorage.getItem('token')).toBe('fake-jwt-token');
    expect(sessionStorage.getItem('refreshToken')).toBe('fake-refresh-token');
  });

  it('calls socket connect after successful login', async () => {
    mockApiGet.mockResolvedValue({ data: {} });
    mockApiPost.mockResolvedValue(
      makeLoginResponse({ name: 'Manager', role: 'manager', hierarchyLevel: null })
    );

    renderWithProvider();
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));

    await act(async () => {
      screen.getByTestId('login-btn').click();
    });

    await waitFor(() => {
      expect(mockConnect).toHaveBeenCalledWith('fake-jwt-token');
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

  it('calls socket disconnect on logout', async () => {
    sessionStorage.setItem('token', 'stored-token');
    mockApiGet.mockResolvedValue(makeMeResponse({ name: 'Alice', role: 'admin' }));

    renderWithProvider();
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('Alice'));

    await act(async () => {
      screen.getByTestId('logout-btn').click();
    });

    expect(mockDisconnect).toHaveBeenCalledTimes(1);
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

  it('sets isAdmin=true for admin role', async () => {
    sessionStorage.setItem('token', 'tok');
    mockApiGet.mockResolvedValue(makeMeResponse({ name: 'Admin', role: 'admin', hierarchyLevel: null }));
    renderWithProvider();
    await waitFor(() => expect(screen.getByTestId('isAdmin').textContent).toBe('true'));
    expect(screen.getByTestId('isManager').textContent).toBe('false');
    expect(screen.getByTestId('isMember').textContent).toBe('false');
    expect(screen.getByTestId('canManage').textContent).toBe('true');
  });

  it('sets isManager=true for manager role', async () => {
    sessionStorage.setItem('token', 'tok');
    mockApiGet.mockResolvedValue(makeMeResponse({ name: 'Mgr', role: 'manager', hierarchyLevel: null }));
    renderWithProvider();
    await waitFor(() => expect(screen.getByTestId('isManager').textContent).toBe('true'));
    expect(screen.getByTestId('isAdmin').textContent).toBe('false');
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

  it('sets canManage=true for assistant_manager role', async () => {
    sessionStorage.setItem('token', 'tok');
    mockApiGet.mockResolvedValue(
      makeMeResponse({ name: 'Asst', role: 'assistant_manager', hierarchyLevel: null })
    );
    renderWithProvider();
    await waitFor(() => expect(screen.getByTestId('isAssistantManager').textContent).toBe('true'));
    expect(screen.getByTestId('canManage').textContent).toBe('true');
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
