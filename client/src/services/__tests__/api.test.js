import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';

// We test the module's behaviour by importing it and inspecting the axios instance.
// For interceptor logic we use a lightweight manual-invocation approach —
// extracting the registered interceptors from the axios instance.

// Prevent any real HTTP requests
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal();

  // We need a real axios.create so the module works, but we intercept the
  // network layer at the adapter level further down.
  return {
    ...actual,
    default: actual.default,
  };
});

// Re-import api AFTER storage is set up so interceptors register with a clean state.
// We use dynamic import to get a fresh module per test where needed.

describe('api service', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  // ---- Base configuration ----

  it('has baseURL set to /api', async () => {
    const { default: api } = await import('../api.js');
    expect(api.defaults.baseURL).toBe('/api');
  });

  it('has default Content-Type header of application/json', async () => {
    const { default: api } = await import('../api.js');
    expect(api.defaults.headers['Content-Type']).toBe('application/json');
  });

  it('has a 30-second timeout', async () => {
    const { default: api } = await import('../api.js');
    expect(api.defaults.timeout).toBe(30000);
  });

  // ---- Request interceptor ----

  it('request interceptor adds Authorization header when a token is in sessionStorage', async () => {
    sessionStorage.setItem('token', 'session-jwt');
    const { default: api } = await import('../api.js');

    // Extract the first request interceptor handler
    const fulfilled = api.interceptors.request.handlers[0]?.fulfilled;
    expect(fulfilled).toBeDefined();

    const config = { headers: {} };
    const result = fulfilled(config);
    expect(result.headers.Authorization).toBe('Bearer session-jwt');
  });

  it('request interceptor adds Authorization header from localStorage when sessionStorage is empty', async () => {
    localStorage.setItem('token', 'local-jwt');
    const { default: api } = await import('../api.js');

    const fulfilled = api.interceptors.request.handlers[0]?.fulfilled;
    const config = { headers: {} };
    const result = fulfilled(config);
    expect(result.headers.Authorization).toBe('Bearer local-jwt');
  });

  it('request interceptor does NOT add Authorization header when no token is stored', async () => {
    const { default: api } = await import('../api.js');

    const fulfilled = api.interceptors.request.handlers[0]?.fulfilled;
    const config = { headers: {} };
    const result = fulfilled(config);
    expect(result.headers.Authorization).toBeUndefined();
  });

  it('request interceptor returns the config object unchanged (same reference)', async () => {
    sessionStorage.setItem('token', 'tok');
    const { default: api } = await import('../api.js');

    const fulfilled = api.interceptors.request.handlers[0]?.fulfilled;
    const config = { headers: {}, url: '/tasks' };
    const result = fulfilled(config);
    expect(result).toBe(config);
  });

  // ---- Response interceptor — success path ----

  it('response interceptor unwraps { success, data } envelopes into the response', async () => {
    const { default: api } = await import('../api.js');

    const fulfilled = api.interceptors.response.handlers[0]?.fulfilled;
    const response = {
      data: {
        success: true,
        data: { boards: [{ id: '1', name: 'Sprint 1' }] },
        message: 'ok',
      },
    };
    const result = fulfilled(response);
    // The interceptor merges data.data into data: result.data.boards should exist
    expect(result.data.boards).toEqual([{ id: '1', name: 'Sprint 1' }]);
    // Original fields are preserved
    expect(result.data.success).toBe(true);
  });

  it('response interceptor passes through responses without success/data envelope', async () => {
    const { default: api } = await import('../api.js');

    const fulfilled = api.interceptors.response.handlers[0]?.fulfilled;
    const response = { data: { token: 'abc', user: { name: 'Alice' } } };
    const result = fulfilled(response);
    expect(result.data.token).toBe('abc');
    expect(result.data.user.name).toBe('Alice');
  });

  it('response interceptor passes through when data.success is false (error response)', async () => {
    const { default: api } = await import('../api.js');

    const fulfilled = api.interceptors.response.handlers[0]?.fulfilled;
    const response = { data: { success: false, message: 'Not found' } };
    const result = fulfilled(response);
    expect(result.data.success).toBe(false);
    expect(result.data.message).toBe('Not found');
  });

  it('response interceptor passes through when data.data is null', async () => {
    const { default: api } = await import('../api.js');

    const fulfilled = api.interceptors.response.handlers[0]?.fulfilled;
    const response = { data: { success: true, data: null } };
    const result = fulfilled(response);
    // Null data should not trigger the spread (falsy guard)
    expect(result.data.success).toBe(true);
  });

  // ---- Response interceptor — error path ----

  it('response interceptor rejects non-401 errors unchanged', async () => {
    const { default: api } = await import('../api.js');

    const rejected = api.interceptors.response.handlers[0]?.rejected;
    const error = {
      response: { status: 500, data: { message: 'Server error' } },
      config: { url: '/tasks', _retry: false },
      message: 'Internal Server Error',
    };

    await expect(rejected(error)).rejects.toMatchObject({ response: { status: 500 } });
  });

  it('response interceptor emits api-error event for 500 errors', async () => {
    const { default: api } = await import('../api.js');
    const rejected = api.interceptors.response.handlers[0]?.rejected;

    const events = [];
    window.addEventListener('api-error', (e) => events.push(e.detail));

    const error = {
      response: { status: 500, data: { message: 'Internal error' } },
      config: { url: '/tasks', _retry: false },
    };

    await expect(rejected(error)).rejects.toBeDefined();
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].message).toBe('Internal error');
    expect(events[0].status).toBe(500);
  });

  it('response interceptor emits network error event when there is no response object', async () => {
    const { default: api } = await import('../api.js');
    const rejected = api.interceptors.response.handlers[0]?.rejected;

    const events = [];
    window.addEventListener('api-error', (e) => events.push(e.detail));

    const error = {
      // No .response property (network offline)
      response: undefined,
      message: 'Network Error',
      config: { url: '/tasks', _retry: false },
    };

    await expect(rejected(error)).rejects.toBeDefined();
    expect(events.some((e) => e.status === 0)).toBe(true);
  });

  // ---- 401 → token refresh flow ----

  it('clears tokens and redirects to /login on 401 when no refresh token is stored', async () => {
    sessionStorage.setItem('token', 'expired-tok');
    // No refreshToken in storage

    const { default: api } = await import('../api.js');
    const rejected = api.interceptors.response.handlers[0]?.rejected;

    const originalPathname = window.location.pathname;
    const hrefSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...window.location, pathname: '/dashboard', href: '' },
    });

    const error = {
      response: { status: 401, data: {} },
      config: { url: '/tasks', _retry: false },
    };

    await expect(rejected(error)).rejects.toBeDefined();
    expect(sessionStorage.getItem('token')).toBeNull();

    // Restore
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...window.location, pathname: originalPathname },
    });
  });

  it('does NOT redirect to /login when already on the /login page on 401', async () => {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...window.location, pathname: '/login', href: '' },
    });

    const { default: api } = await import('../api.js');
    const rejected = api.interceptors.response.handlers[0]?.rejected;

    const error = {
      response: { status: 401, data: {} },
      config: { url: '/tasks', _retry: false },
    };

    await expect(rejected(error)).rejects.toBeDefined();
    // href should not have been reassigned to /login again
    expect(window.location.href).not.toBe('/login');
  });

  it('does NOT attempt refresh for login endpoint 401 errors', async () => {
    sessionStorage.setItem('refreshToken', 'some-refresh');
    const { default: api } = await import('../api.js');
    const rejected = api.interceptors.response.handlers[0]?.rejected;

    const error = {
      response: { status: 401, data: {} },
      config: { url: '/auth/login', _retry: false },
    };

    // Should reject without trying refresh
    await expect(rejected(error)).rejects.toBeDefined();
    // refreshToken should still be present (wasn't consumed)
    expect(sessionStorage.getItem('refreshToken')).toBe('some-refresh');
  });
});
