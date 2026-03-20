import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
  timeout: 30000, // 30 second timeout
});

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
    // Auto-unwrap backend's nested { success, data: { ... } } format
    // so frontend can access res.data.boards, res.data.tasks, etc. directly
    if (response.data && response.data.success && response.data.data) {
      response.data = { ...response.data, ...response.data.data };
    }
    return response;
  },
  (error) => {
    if (error.response && error.response.status === 401) {
      sessionStorage.removeItem('token');
      sessionStorage.removeItem('user');
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }

    // Emit global error event for toast notifications (skip 401 redirects and cancelled requests)
    if (error.response && error.response.status !== 401 && !axios.isCancel(error)) {
      const message = error.response?.data?.message || error.message || 'Something went wrong';
      window.dispatchEvent(new CustomEvent('api-error', { detail: { message, status: error.response?.status } }));
    } else if (!error.response && error.message && !axios.isCancel(error)) {
      window.dispatchEvent(new CustomEvent('api-error', { detail: { message: 'Network error. Please check your connection.', status: 0 } }));
    }

    return Promise.reject(error);
  }
);

export default api;
