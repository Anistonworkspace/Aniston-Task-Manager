import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
  timeout: 30000,
});

let isRefreshing = false;
let failedQueue = [];

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
          const res = await axios.post('/api/auth/refresh', { refreshToken });
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

    // Handle 403 Forbidden — permission denied
    if (error.response?.status === 403) {
      const message = error.response?.data?.message || "You don't have permission to perform this action.";
      window.dispatchEvent(new CustomEvent('api-error', { detail: { message, status: 403 } }));
      return Promise.reject(error);
    }

    // Emit global error event for toast notifications (skip 401 auth errors and 404 not-found)
    if (error.response && error.response.status !== 401 && error.response.status !== 404 && !axios.isCancel(error)) {
      const message = error.response?.data?.message || error.message || 'Something went wrong';
      window.dispatchEvent(new CustomEvent('api-error', { detail: { message, status: error.response?.status } }));
    } else if (!error.response && error.message && !axios.isCancel(error)) {
      window.dispatchEvent(new CustomEvent('api-error', { detail: { message: 'Network error. Please check your connection.', status: 0 } }));
    }

    return Promise.reject(error);
  }
);

export default api;
