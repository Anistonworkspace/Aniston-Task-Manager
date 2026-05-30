import axios from 'axios';
import { getErrorMessage, getErrorCode, getRequestId } from '../utils/errorMap';
import { getApiBaseUrl, navigateHard } from '../utils/runtime';

// URLs that are part of the auth-probe / login flow. Failures here are
// already handled by AuthContext (loadUser silently) and Login (inline
// red box), so emitting an `api-error` event would either duplicate or
// confuse the user with a generic toast layered on top of the form copy.
// Keep this list small and explicit.
const AUTH_PROBE_URL_PATTERNS = [
  /\/auth\/me\b/,
  /\/auth\/refresh\b/,
  /\/auth\/login\b/,
  /\/auth\/logout\b/,
  /\/auth\/sso-status\b/,
  /\/auth\/microsoft\b/,
  /\/auth\/login\/pending-sso\b/,
];

function isAuthProbeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return AUTH_PROBE_URL_PATTERNS.some((re) => re.test(url));
}

// baseURL is resolved at module load: web → '/api' (Vite proxy / nginx),
// desktop → 'https://monday.anistonav.com/api' (read from the preload's
// runtime config). See client/src/utils/runtime.js for the resolution order.
const api = axios.create({
  baseURL: getApiBaseUrl(),
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

// D-1 Phase 2: the request interceptor no longer attaches an Authorization
// header — auth rides the httpOnly cookie set by the server, sent automatically
// by the browser because the api instance has withCredentials: true.
//
// We DO still read leftover storage tokens here for one transitional reason:
// users who logged in BEFORE Phase 2 deployed have a token in storage but no
// cookie. Without the header, their first request after the deploy would 401
// and bounce them to the login page. The fallback below keeps those sessions
// alive until natural refresh (≤1 hour) — at which point the refresh response
// sets cookies and storage becomes irrelevant. After ~7 days (refresh TTL),
// no surviving session will rely on storage and this fallback is dead code,
// safe to remove in Phase 3.
api.interceptors.request.use(
  (config) => {
    const legacyToken = sessionStorage.getItem('token') || localStorage.getItem('token');
    if (legacyToken && !config.headers.Authorization) {
      config.headers.Authorization = `Bearer ${legacyToken}`;
    }
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

    // D-1 Phase 2: silent refresh on 401. The refresh JWT lives in an
    // httpOnly cookie — the browser sends it automatically because the
    // api instance has withCredentials. We don't need to read the token
    // from storage, don't post it in the body, and the response no longer
    // returns it. Success means new cookies were set; just retry the
    // original request and the new access cookie will be picked up.
    if (error.response?.status === 401 && !originalRequest._retry &&
        !originalRequest.url?.includes('/auth/login') &&
        !originalRequest.url?.includes('/auth/refresh')) {

      if (isRefreshing) {
        // Queue this request while refresh is in progress. We resolve with
        // a sentinel because the original request no longer needs an
        // Authorization header injected — the cookie does the job.
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then(() => api(originalRequest));
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        // Standalone axios call (not the `api` instance) so this attempt
        // never triggers the response interceptor that owns it. We rebuild
        // the absolute refresh URL via the same runtime helper that drives
        // `api.defaults.baseURL` — on the web that's '/api/auth/refresh',
        // on the desktop it's 'https://monday.anistonav.com/api/auth/refresh'.
        await axios.post(`${getApiBaseUrl()}/auth/refresh`, {}, { withCredentials: true });
        // No tokens in body to extract — the new cookies are set on the
        // response and the browser already wrote them. processQueue
        // signals queued callers to retry their requests.
        processQueue(null, null);
        return api(originalRequest);
      } catch (refreshError) {
        // Benign multi-tab refresh race. The other tab won, rotated the
        // refresh token, and set new cookies on its response. This tab's
        // refresh hit the now-rotated row and the server returned 401 +
        // TOKEN_RACE_RETRY instead of nuking the session chain. Wait long
        // enough for the winner's Set-Cookie to be committed by the
        // browser, then retry the ORIGINAL request — the new access
        // cookie will ride along automatically.
        const isRaceRetry = refreshError?.response?.data?.code === 'TOKEN_RACE_RETRY';
        if (isRaceRetry) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          processQueue(null, null);
          return api(originalRequest);
        }
        processQueue(refreshError, null);
        // Refresh failed — clear any leftover legacy storage and bounce
        // to login. Cookies were cleared server-side as part of the 401
        // response (or were already invalid).
        sessionStorage.removeItem('token');
        sessionStorage.removeItem('user');
        sessionStorage.removeItem('refreshToken');
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        localStorage.removeItem('refreshToken');
        // navigateHard handles the desktop/web split: under HashRouter it
        // sets location.hash, under BrowserRouter it does the same href
        // assignment the previous code did. Without this, packaged Electron
        // tries `file:///login`, hits ERR_FILE_NOT_FOUND, and the renderer
        // ends up on a blank white window.
        navigateHard('/login');
        // Tag the rejection so caller code (AuthContext.loadUser, etc.)
        // can recognise this is a refresh-chain failure rather than an
        // ordinary 4xx — useful for staying silent on the login page
        // boot probe, where the refresh status will be 400 (no cookie)
        // rather than the original 401 from /auth/me.
        try {
          refreshError._isRefreshFailure = true;
          refreshError._originalRequestUrl = originalRequest.url;
        } catch { /* ignore — frozen error */ }
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    // Stamp errors with the backend's correlation id (when present) so
    // callers can include it in support copy or per-page error banners.
    try {
      const rid = getRequestId(error);
      if (rid) error.requestId = rid;
      const ec = getErrorCode(error);
      if (ec) error.errorCode = ec;
    } catch { /* ignore — non-fatal */ }

    // Handle 403 Forbidden — permission denied (skip silent requests).
    // We route the message through errorMap so any future code-specific
    // copy override applies (e.g. PERMISSION_DENIED vs TIER_INSUFFICIENT).
    if (error.response?.status === 403) {
      if (!originalRequest?._silent && !isAuthProbeUrl(originalRequest?.url)) {
        const message = getErrorMessage(error);
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

      const isSilent = originalRequest?._silent || isAuthProbeUrl(originalRequest?.url);
      if (!isSilent && !rateLimited429SuppressedUntil) {
        rateLimited429SuppressedUntil = Date.now() + Math.min(retryAfterSec, 30) * 1000;
        // getErrorMessage falls back to the backend's `message` when
        // there's no recognised code — keeps the existing "wait Ns"
        // copy from the rate-limit handler intact.
        const message = getErrorMessage(error) || `Too many requests. Please wait ${retryAfterSec}s and try again.`;
        window.dispatchEvent(new CustomEvent('api-error', { detail: { message, status: 429, retryAfter: retryAfterSec } }));
        // Clear the guard once the suppression window passes so a NEW 429
        // event after recovery can still inform the user.
        setTimeout(() => { rateLimited429SuppressedUntil = 0; }, Math.min(retryAfterSec, 30) * 1000);
      }
      return Promise.reject(error);
    }

    // Emit global error event for toast notifications (skip 401 auth errors
    // and silent requests). 404 handling is nuanced: blanket suppression
    // (previous behavior) swallowed real mutation-failure 404s, hiding stale
    // task / board references from the user. We now ONLY suppress 404 for
    // GET requests against a small allowlist of endpoints that are expected
    // to legitimately 404 when no resource is present (e.g. the user has
    // no permission row yet, no unread notifications, etc.). Every other
    // 404 — especially POST/PUT/PATCH/DELETE — surfaces a toast so the user
    // knows the action targeted something that no longer exists.
    //
    // We ALSO suppress for the auth-probe URLs (/auth/me, /auth/refresh,
    // /auth/login, /auth/logout). Those are owned by the login page /
    // AuthContext, which renders its own inline error UI. A generic toast
    // here would either duplicate the inline error or — worse — fire on
    // the login page while the user is just sitting there (the screenshot
    // bug where /auth/me 401 + /auth/refresh 400 produced a console error).
    const url = originalRequest?.url || '';
    const isSilent = originalRequest?._silent || isAuthProbeUrl(url);
    const status = error.response?.status;
    const method = (originalRequest?.method || 'get').toLowerCase();

    // Endpoints that may legitimately 404 on GET as part of normal app
    // operation. Keep this list conservative and explicit — adding an
    // endpoint here silences a real error indicator for the user.
    const SILENT_404_GET_PATTERNS = [
      /\/notifications\/unread-count\b/,
      /\/users\/me\/permissions\b/,
      /\/auth\/me\b/,
      /\/teams\/status\b/,
      /\/integrations\/config\/[^/]+$/, // not-yet-configured providers
      /\/ai\/config\b/,
      /\/push\/subscription\b/,
    ];

    const isAllowlisted404 =
      status === 404 &&
      method === 'get' &&
      SILENT_404_GET_PATTERNS.some((re) => re.test(url));

    // A refresh-chain failure during a /me probe ends up here with the
    // refresh error (status 400) not the original 401. We already tagged
    // it with `_isRefreshFailure` above; honour that so the boot-time
    // anonymous probe never produces a user-facing toast.
    const isRefreshChainFailure = Boolean(error?._isRefreshFailure);

    if (!isSilent && !isRefreshChainFailure && error.response && status !== 401 && !isAllowlisted404 && !axios.isCancel(error)) {
      // Route through errorMap so backend `code` strings are translated to
      // the canonical user copy. The map falls back to the backend's
      // `message` when no code is recognised, preserving the existing
      // copy for legacy responses that don't yet carry a code.
      const message = getErrorMessage(error);
      window.dispatchEvent(new CustomEvent('api-error', { detail: { message, status, code: error.errorCode, requestId: error.requestId } }));
    } else if (!isSilent && !isRefreshChainFailure && !error.response && error.message && !axios.isCancel(error)) {
      window.dispatchEvent(new CustomEvent('api-error', { detail: { message: getErrorMessage(error), status: 0 } }));
    }

    return Promise.reject(error);
  }
);

// ─── In-flight GET deduplication ─────────────────────────────────────
//
// When a socket event triggers a refetch while a previous fetch for the
// same URL is still in flight (e.g. the previous one was slow or the user
// also navigated to the page at the same instant), we don't need a second
// network round-trip — both callers can latch onto the same response.
//
// Belt-and-suspenders to RealtimeProvider's per-queryKey debounce. The
// debounce collapses bursts within a 300ms window; the dedup catches the
// edge case where a refetch fires while an earlier identical request is
// still mid-flight (slow backend, large board, etc.). Together they were
// the primary mitigation for the 2026-05-23 13:41 IST rate-limit cascade.
//
// Scope: GET only, in-flight only. Callers that pass `_skipDedup: true`
// (e.g. polling that legitimately wants a fresh round-trip even when one
// is in flight) bypass this. AbortSignal-bearing requests also bypass —
// dedup would let one caller cancel a request another caller is awaiting.
const inflightGetPromises = new Map();

function dedupKey(url, config) {
  let key = `GET ${url}`;
  if (config && config.params) {
    try { key += `|${JSON.stringify(config.params)}`; } catch { /* ignore */ }
  }
  return key;
}

const originalGet = api.get.bind(api);
api.get = function dedupedGet(url, config) {
  if (config && (config._skipDedup || config.signal)) {
    return originalGet(url, config);
  }
  const key = dedupKey(url, config);
  const existing = inflightGetPromises.get(key);
  if (existing) return existing;
  const p = originalGet(url, config).finally(() => {
    if (inflightGetPromises.get(key) === p) inflightGetPromises.delete(key);
  });
  inflightGetPromises.set(key, p);
  return p;
};

export default api;
