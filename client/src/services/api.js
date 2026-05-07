import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
  // D-1: send the httpOnly auth cookies on every request. The backend now
  // sets aniston_at + aniston_rt on login/refresh/SSO so the user no longer
  // needs the JS-readable token snapshot in sessionStorage to be authenticated.
  // The Authorization header is still attached below as a backward-compat
  // fallback during the dual-track migration; once Phase 2 ships and the
  // frontend stops storing tokens, the cookie will be the sole carrier.
  withCredentials: true,
});

// Set Content-Type to application/json by default, but let axios auto-set it
// for FormData (multipart/form-data) — this is critical for file uploads.
api.interceptors.request.use((config) => {
  if (config.data instanceof FormData) {
    // Remove Content-Type so browser sets multipart/form-data with correct boundary
    delete config.headers['Content-Type'];
  } else if (!config.headers['Content-Type']) {
    config.headers['Content-Type'] = 'application/json';
  }
  return config;
});

let isRefreshing = false;
let failedQueue = [];

// Single-flight guard for 429 toast events. While a Retry-After window is
// active we suppress further global 429 toasts so a tight retry loop in any
// page cannot fire the same "Too many requests" toast hundreds of times.
// Reset to 0 by setTimeout below once the window passes.
let rateLimited429SuppressedUntil = 0;

function processQueue(error, token = null) {
  failedQueue.forEach(({ resolve, reject }) => {
    if (error) reject(error);
    else resolve(token);
  });
  failedQueue = [];
}

api.interceptors.request.use(
  (config) => {
    const token = sessionStorage.getItem('token') || localStorage.getItem('token');
    if (token) config.headers.Authorization = `Bearer ${token}`;
    return config;
  },
  (error) => Promise.reject(error)
);

api.interceptors.response.use(
  (response) => {
    if (response.data && response.data.success && response.data.data) {
      response.data = { ...response.data, ...response.data.data };
    }
    return response;
  },
  async (error) => {
    const originalRequest = error.config;

    // Try silent refresh on 401 (except for login/refresh endpoints)
    if (error.response?.status === 401 && !originalRequest._retry &&
        !originalRequest.url?.includes('/auth/login') &&
        !originalRequest.url?.includes('/auth/refresh')) {

      const refreshToken = sessionStorage.getItem('refreshToken');

      if (refreshToken) {
        if (isRefreshing) {
          // Queue this request while refresh is in progress
          return new Promise((resolve, reject) => {
            failedQueue.push({ resolve, reject });
          }).then((token) => {
            originalRequest.headers.Authorization = `Bearer ${token}`;
            return api(originalRequest);
          });
        }

        originalRequest._retry = true;
        isRefreshing = true;

        try {
          // withCredentials so the refresh httpOnly cookie rides too — once
          // Phase 2 ships we can drop the body payload entirely.
          const res = await axios.post('/api/auth/refresh', { refreshToken }, { withCredentials: true });
          const { token: newToken, refreshToken: newRefresh } = res.data?.data || res.data;

          sessionStorage.setItem('token', newToken);
          if (newRefresh) sessionStorage.setItem('refreshToken', newRefresh);

          api.defaults.headers.common.Authorization = `Bearer ${newToken}`;
          processQueue(null, newToken);

          originalRequest.headers.Authorization = `Bearer ${newToken}`;
          return api(originalRequest);
        } catch (refreshError) {
          processQueue(refreshError, null);
          // Refresh failed — clear everything and redirect to login
          sessionStorage.removeItem('token');
          sessionStorage.removeItem('user');
          sessionStorage.removeItem('refreshToken');
          localStorage.removeItem('token');
          localStorage.removeItem('user');
          if (window.location.pathname !== '/login') {
            window.location.href = '/login';
          }
          return Promise.reject(refreshError);
        } finally {
          isRefreshing = false;
        }
      }

      // No refresh token available — redirect to login
      sessionStorage.removeItem('token');
      sessionStorage.removeItem('user');
      sessionStorage.removeItem('refreshToken');
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }

    // Handle 403 Forbidden — permission denied (skip silent requests)
    if (error.response?.status === 403) {
      if (!originalRequest?._silent) {
        const message = error.response?.data?.message || "You don't have permission to perform this action.";
        window.dispatchEvent(new CustomEvent('api-error', { detail: { message, status: 403 } }));
      }
      return Promise.reject(error);
    }

    // Handle 429 Too Many Requests — surface ONE muted toast per Retry-After
    // window so a stuck loop somewhere in the app cannot spam the UI. The
    // Toast.jsx dedup window already swallows identical messages within
    // 1500ms; we additionally skip emitting if the same window is still in
    // flight (tracked on a module-level guard). The `Retry-After` header is
    // attached to the rejection so callers that DO want to retry can wait.
    if (error.response?.status === 429) {
      const retryAfterHeader = error.response.headers?.['retry-after'];
      const retryAfterBody = error.response.data?.retryAfter;
      const retryAfterSec = Number(retryAfterHeader || retryAfterBody) || 60;
      error.retryAfter = retryAfterSec;

      const isSilent = originalRequest?._silent;
      if (!isSilent && !rateLimited429SuppressedUntil) {
        rateLimited429SuppressedUntil = Date.now() + Math.min(retryAfterSec, 30) * 1000;
        const message = error.response.data?.message
          || `Too many requests. Please wait ${retryAfterSec}s and try again.`;
        window.dispatchEvent(new CustomEvent('api-error', { detail: { message, status: 429, retryAfter: retryAfterSec } }));
        // Clear the guard once the suppression window passes so a NEW 429
        // event after recovery can still inform the user.
        setTimeout(() => { rateLimited429SuppressedUntil = 0; }, Math.min(retryAfterSec, 30) * 1000);
      }
      return Promise.reject(error);
    }

    // Emit global error event for toast notifications (skip 401 auth errors, 404 not-found, and silent requests)
    const isSilent = originalRequest?._silent;
    if (!isSilent && error.response && error.response.status !== 401 && error.response.status !== 404 && !axios.isCancel(error)) {
      const message = error.response?.data?.message || error.message || 'Something went wrong';
      window.dispatchEvent(new CustomEvent('api-error', { detail: { message, status: error.response?.status } }));
    } else if (!isSilent && !error.response && error.message && !axios.isCancel(error)) {
      window.dispatchEvent(new CustomEvent('api-error', { detail: { message: 'Network error. Please check your connection.', status: 0 } }));
    }

    return Promise.reject(error);
  }
);

export default api;
