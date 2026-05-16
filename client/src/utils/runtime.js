/**
 * Runtime resolver for backend URLs.
 *
 * Single source of truth for "where is the backend?" — read by `services/api.js`
 * and `services/socket.js` at module load. Adding any new HTTP/WS client in the
 * app SHOULD import from here rather than hard-coding an origin.
 *
 * Resolution order
 * ----------------
 * 1. `window.anistonDesktop.config` — set by the Electron preload (`desktop/preload.js`)
 *    when the renderer is running inside the desktop wrapper. Carries either
 *    production URLs (packaged build, hard-coded) or dev URLs (launched against
 *    a local backend, with env-var overrides at the Electron-main level).
 * 2. Web fallback — preserves the exact pre-desktop behaviour byte-for-byte:
 *      apiBaseUrl → '/api'                 (Vite proxy / nginx serve the rest)
 *      socketUrl  → window.location.origin (Socket.io same-origin handshake)
 *
 * Why a helper instead of an `import.meta.env` constant
 * -----------------------------------------------------
 * The same compiled JS bundle is shipped to both:
 *   - the web at https://monday.anistonav.com   → window.anistonDesktop undefined
 *   - the packaged desktop EXE                   → window.anistonDesktop present
 *
 * A build-time constant would force two separate bundles. Reading from
 * `window` at call time lets one bundle serve both runtimes safely. The cost
 * is one property access per call — negligible.
 */

function getDesktopBridge() {
  if (typeof window === 'undefined') return null;
  const bridge = window.anistonDesktop;
  if (!bridge || bridge.isDesktop !== true) return null;
  return bridge;
}

export function isDesktopApp() {
  return getDesktopBridge() !== null;
}

export function getApiBaseUrl() {
  const bridge = getDesktopBridge();
  const desktopUrl = bridge && bridge.config && bridge.config.apiBaseUrl;
  if (typeof desktopUrl === 'string' && desktopUrl.length > 0) {
    return desktopUrl;
  }
  return '/api';
}

export function getSocketUrl() {
  const bridge = getDesktopBridge();
  const desktopUrl = bridge && bridge.config && bridge.config.socketUrl;
  if (typeof desktopUrl === 'string' && desktopUrl.length > 0) {
    return desktopUrl;
  }
  if (typeof window !== 'undefined' && window.location && window.location.origin) {
    return window.location.origin;
  }
  return '';
}

/**
 * Hard-navigate to an in-app SPA path, picking the form that works for the
 * current runtime.
 *
 * Why this exists
 * ---------------
 * In the web app, `window.location.href = '/login'` does a clean full-page
 * load: same origin, the dev server / nginx serves index.html for the route,
 * BrowserRouter resolves and shows the Login page.
 *
 * In the packaged desktop app, the renderer is loaded via `file://` (Electron
 * loadFile). On that origin, `window.location.href = '/login'` is resolved by
 * Chromium as an ABSOLUTE FILESYSTEM PATH — it becomes `file:///C:/login`,
 * the file doesn't exist, the main frame navigation fails with
 * ERR_FILE_NOT_FOUND, and the user sees a blank white window.
 *
 * Under HashRouter (which the desktop main.jsx uses), the safe equivalent is
 * setting `location.hash` so the page URL becomes
 * `file:///.../index.html#/login` — same document, just a hash change, picked
 * up by HashRouter without any filesystem navigation.
 *
 * Single helper instead of inlining: every auth-redirect site (AuthContext,
 * api.js refresh failure, ErrorBoundary fallback) goes through here so we
 * cannot regress one and forget another. The cost on the web is one extra
 * isDesktopApp() check — negligible.
 */
export function navigateHard(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return;
  const desktop = isDesktopApp();
  if (desktop) {
    // HashRouter form. `location.hash` set with a leading '/' becomes
    // `#/login`, exactly what HashRouter expects. We do NOT touch
    // location.pathname under file:// — that path is read-only for the
    // mounted document and trying to assign it triggers a navigation.
    const target = path.startsWith('#') ? path : `#${path}`;
    if (window.location.hash !== target) {
      window.location.hash = target;
    }
    return;
  }
  // Web: keep the existing behaviour byte-for-byte. A hard navigation here
  // is intentional — it resets in-memory state (AuthContext, sockets) the
  // same way the previous code did.
  if (window.location.pathname !== path) {
    window.location.href = path;
  }
}

/**
 * Returns metadata describing the desktop runtime, or null when running in
 * a browser. Future slices (notification adapter, About dialog) read from
 * this rather than poking at `window.anistonDesktop` directly.
 */
export function getDesktopMeta() {
  const bridge = getDesktopBridge();
  if (!bridge) return null;
  return {
    isPackaged: !!bridge.isPackaged,
    appVersion: bridge.appVersion || null,
    platform: bridge.platform || null,
  };
}
