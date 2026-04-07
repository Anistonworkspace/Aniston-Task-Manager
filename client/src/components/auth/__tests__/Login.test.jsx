import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// --- Module mocks (must come before any import of the module under test) ---
// vi.mock factories are hoisted before imports, so variables must be created
// with vi.hoisted() to be accessible inside the factory.

const { mockNavigate, mockLogin, mockLoginWithToken, mockApiGet, mockApiPost } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockLogin: vi.fn(),
  mockLoginWithToken: vi.fn(),
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({
    login: mockLogin,
    loginWithToken: mockLoginWithToken,
  }),
}));

// api mock: default export is the axios-like instance
vi.mock('../../../services/api', () => ({
  default: {
    get: mockApiGet,
    post: mockApiPost,
  },
}));

// lucide-react icons are ESM — stub them so jsdom doesn't choke on SVG
vi.mock('lucide-react', () => ({
  FolderKanban: () => null,
  Mail: () => null,
  Lock: () => null,
  ArrowRight: () => null,
  Eye: () => null,
  EyeOff: () => null,
}));

import Login from '../Login';

// Helper: wrap in router (Link components need it)
function renderLogin() {
  return render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>
  );
}

describe('Login component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: SSO not enabled
    mockApiGet.mockResolvedValue({ data: { data: { ssoEnabled: false } } });
    // Clear URL search params
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...window.location, search: '', pathname: '/login' },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- Rendering ----

  it('renders an email input field', async () => {
    renderLogin();
    const emailInput = await screen.findByPlaceholderText('name@company.com');
    expect(emailInput).toBeInTheDocument();
    expect(emailInput).toHaveAttribute('type', 'email');
  });

  it('renders a password input field', async () => {
    renderLogin();
    const passwordInput = await screen.findByPlaceholderText('Enter your password');
    expect(passwordInput).toBeInTheDocument();
    expect(passwordInput).toHaveAttribute('type', 'password');
  });

  it('renders the Log in submit button', async () => {
    renderLogin();
    const loginButton = await screen.findByRole('button', { name: /log in/i });
    expect(loginButton).toBeInTheDocument();
    expect(loginButton).toHaveAttribute('type', 'submit');
  });

  it('does NOT render the Microsoft SSO button when SSO is disabled', async () => {
    renderLogin();
    // Wait for the SSO status API call to resolve
    await waitFor(() => {
      expect(mockApiGet).toHaveBeenCalledWith('/auth/sso-status');
    });
    expect(screen.queryByText(/sign in with microsoft/i)).not.toBeInTheDocument();
  });

  it('renders the Microsoft SSO button when SSO is enabled', async () => {
    mockApiGet.mockResolvedValue({ data: { data: { ssoEnabled: true } } });
    renderLogin();
    await screen.findByText(/sign in with microsoft/i);
  });

  it('renders forgot password and sign up links', async () => {
    renderLogin();
    expect(await screen.findByText(/forgot password/i)).toBeInTheDocument();
    expect(screen.getByText(/sign up/i)).toBeInTheDocument();
  });

  // ---- Validation ----

  it('shows validation error when submitting with empty email and password', async () => {
    renderLogin();
    const button = await screen.findByRole('button', { name: /log in/i });
    fireEvent.click(button);
    expect(await screen.findByText('Please fill in all fields')).toBeInTheDocument();
    expect(mockLogin).not.toHaveBeenCalled();
  });

  it('shows validation error when only email is filled', async () => {
    renderLogin();
    const emailInput = await screen.findByPlaceholderText('name@company.com');
    fireEvent.change(emailInput, { target: { value: 'user@test.com' } });
    const button = screen.getByRole('button', { name: /log in/i });
    fireEvent.click(button);
    expect(await screen.findByText('Please fill in all fields')).toBeInTheDocument();
    expect(mockLogin).not.toHaveBeenCalled();
  });

  it('shows validation error when only password is filled', async () => {
    renderLogin();
    const passwordInput = await screen.findByPlaceholderText('Enter your password');
    fireEvent.change(passwordInput, { target: { value: 'secret123' } });
    const button = screen.getByRole('button', { name: /log in/i });
    fireEvent.click(button);
    expect(await screen.findByText('Please fill in all fields')).toBeInTheDocument();
    expect(mockLogin).not.toHaveBeenCalled();
  });

  // ---- API call on valid submit ----

  it('calls login with trimmed, lowercased email and password on valid submit', async () => {
    mockLogin.mockResolvedValue({});
    renderLogin();
    const emailInput = await screen.findByPlaceholderText('name@company.com');
    const passwordInput = screen.getByPlaceholderText('Enter your password');
    fireEvent.change(emailInput, { target: { value: '  User@Test.COM  ' } });
    fireEvent.change(passwordInput, { target: { value: 'mypassword' } });
    fireEvent.click(screen.getByRole('button', { name: /log in/i }));
    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith('user@test.com', 'mypassword');
    });
  });

  // ---- Redirect on success ----

  it('navigates to / after successful login', async () => {
    mockLogin.mockResolvedValue({});
    renderLogin();
    const emailInput = await screen.findByPlaceholderText('name@company.com');
    const passwordInput = screen.getByPlaceholderText('Enter your password');
    fireEvent.change(emailInput, { target: { value: 'admin@aniston.com' } });
    fireEvent.change(passwordInput, { target: { value: 'Admin@1234' } });
    fireEvent.click(screen.getByRole('button', { name: /log in/i }));
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/');
    });
  });

  // ---- Error handling ----

  it('shows server error message when login API returns an error', async () => {
    mockLogin.mockRejectedValue({
      response: { data: { message: 'Invalid email or password' } },
    });
    renderLogin();
    const emailInput = await screen.findByPlaceholderText('name@company.com');
    const passwordInput = screen.getByPlaceholderText('Enter your password');
    fireEvent.change(emailInput, { target: { value: 'wrong@test.com' } });
    fireEvent.change(passwordInput, { target: { value: 'wrongpass' } });
    fireEvent.click(screen.getByRole('button', { name: /log in/i }));
    expect(await screen.findByText('Invalid email or password')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('shows a fallback error message when API error has no message', async () => {
    mockLogin.mockRejectedValue(new Error('Network Error'));
    renderLogin();
    const emailInput = await screen.findByPlaceholderText('name@company.com');
    const passwordInput = screen.getByPlaceholderText('Enter your password');
    fireEvent.change(emailInput, { target: { value: 'user@test.com' } });
    fireEvent.change(passwordInput, { target: { value: 'pass123' } });
    fireEvent.click(screen.getByRole('button', { name: /log in/i }));
    expect(
      await screen.findByText(/login failed/i)
    ).toBeInTheDocument();
  });

  it('clears previous error on a new submit attempt', async () => {
    mockLogin
      .mockRejectedValueOnce({ response: { data: { message: 'Bad credentials' } } })
      .mockResolvedValueOnce({});
    renderLogin();
    const emailInput = await screen.findByPlaceholderText('name@company.com');
    const passwordInput = screen.getByPlaceholderText('Enter your password');
    const button = screen.getByRole('button', { name: /log in/i });

    // First submit — error
    fireEvent.change(emailInput, { target: { value: 'user@test.com' } });
    fireEvent.change(passwordInput, { target: { value: 'wrong' } });
    fireEvent.click(button);
    expect(await screen.findByText('Bad credentials')).toBeInTheDocument();

    // Second submit — should clear the error before calling API
    fireEvent.click(button);
    await waitFor(() => {
      expect(screen.queryByText('Bad credentials')).not.toBeInTheDocument();
    });
  });

  // ---- Toggle password visibility ----

  it('toggles password field visibility when eye icon button is clicked', async () => {
    renderLogin();
    const passwordInput = await screen.findByPlaceholderText('Enter your password');
    expect(passwordInput).toHaveAttribute('type', 'password');

    // The toggle button is the only type="button" inside the password wrapper
    const toggleBtn = screen.getAllByRole('button').find(
      (btn) => btn.getAttribute('type') === 'button'
    );
    fireEvent.click(toggleBtn);
    expect(passwordInput).toHaveAttribute('type', 'text');

    fireEvent.click(toggleBtn);
    expect(passwordInput).toHaveAttribute('type', 'password');
  });

  // ---- SSO callback handling ----

  it('calls loginWithToken and navigates when ?sso=success&token=xxx is present', async () => {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: {
        ...window.location,
        search: '?sso=success&token=abc123&refreshToken=ref456',
        pathname: '/login',
      },
    });
    mockLoginWithToken.mockResolvedValue({});
    renderLogin();
    await waitFor(() => {
      expect(mockLoginWithToken).toHaveBeenCalledWith('abc123', 'ref456');
    });
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/');
    });
  });

  it('shows SSO error message when ?sso=error is present in URL', async () => {
    const msg = encodeURIComponent('Account not found in directory');
    Object.defineProperty(window, 'location', {
      writable: true,
      value: {
        ...window.location,
        search: `?sso=error&msg=${msg}`,
        pathname: '/login',
      },
    });
    renderLogin();
    expect(
      await screen.findByText('Account not found in directory')
    ).toBeInTheDocument();
  });
});
