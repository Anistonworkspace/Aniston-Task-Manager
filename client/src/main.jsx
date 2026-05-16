import React from 'react'; // eslint-disable-line no-unused-vars
import ReactDOM from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import { isDesktopApp } from './utils/runtime';
import App from './App';

// Pick the router that matches the runtime. The web app stays on
// BrowserRouter (clean URLs like /boards/123, served by nginx/Vite with a
// catch-all to index.html). The packaged desktop app is loaded via
// file:///.../index.html — under that origin BrowserRouter's pathname is
// the absolute filesystem path of the html file, every <Navigate> tries to
// rewrite location.pathname which Chromium treats as a real filesystem
// navigation, and any auth redirect ends up at file:///C:/login →
// ERR_FILE_NOT_FOUND → blank white window. HashRouter sidesteps all of
// that: routes live in location.hash, the underlying filesystem URL never
// changes, and navigation is a same-document hashchange.
const AppRouter = isDesktopApp() ? HashRouter : BrowserRouter;
import { AuthProvider } from './context/AuthContext';
import { RealtimeProvider } from './realtime';
import { ToastProvider } from './components/common/Toast';
import { ConfirmProvider } from './components/common/ConfirmDialog';
import { ThemeProvider } from './context/ThemeContext';
import { FontSizeProvider } from './context/FontSizeContext';
import { LanguageProvider } from './context/LanguageContext';
import { UndoProvider } from './context/UndoContext';
import ErrorBoundary from './components/common/ErrorBoundary';
import UpdatePrompt from './components/common/UpdatePrompt';
import './index.css';

// Respond to AUTH_CHECK pings from the service worker. The SW asks every
// open client whether the user is currently authenticated before showing
// a push notification body — if no client is authenticated (e.g. user just
// logged out and a stale push lands), the SW shows a generic "sign in to
// view" card instead of the actual message body.
//
// D-1 Phase 2 migration: the auth token now lives in an httpOnly cookie, so
// we cannot read it from JS. AuthContext sets `window.__ANISTON_AUTH__` to
// 'authenticated' or 'loggedOut' as the source of truth for this check.
// Fallback to legacy storage keys is kept for any pre-Phase-2 sessions that
// haven't reloaded yet.
//
// Also handle SW → client NAVIGATE messages so service-worker-driven
// notification clicks land on the right SPA route via React Router.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data;
    if (!data) return;
    if (data.type === 'AUTH_CHECK') {
      const port = event.ports?.[0];
      if (!port) return;
      const flag = (typeof window !== 'undefined' && window.__ANISTON_AUTH__) || null;
      const authenticated = flag
        ? flag === 'authenticated'
        : !!(sessionStorage.getItem('token') || localStorage.getItem('token'));
      try { port.postMessage({ authenticated }); } catch { /* ignore */ }
      return;
    }
    if (data.type === 'NAVIGATE' && typeof data.url === 'string') {
      try {
        // Defer to history API; the BrowserRouter picks it up. Use full URL
        // construction so query strings (?taskId=…) are preserved.
        const url = new URL(data.url, window.location.origin);
        window.history.pushState({}, '', url.pathname + url.search + url.hash);
        // Nudge React Router to re-evaluate the location.
        window.dispatchEvent(new PopStateEvent('popstate'));
      } catch { /* ignore */ }
      return;
    }
  });
}

// Register Service Worker for PWA + force updates — production only.
//
// In dev, a registered SW fights Vite HMR (it caches stale module URLs and
// turns Vite-server outages into misleading 503s because the SW's catch-all
// fetch fallback returns a synthetic 503 when upstream is down). We register
// only when the production build runs. If a stale dev SW from a prior run
// is still active we unregister it so the dev session has a clean slate.
// Service-worker registration is skipped in packaged Electron: the renderer
// is loaded via file://, navigator.serviceWorker.register('/sw.js') resolves
// to file:///sw.js and throws, and even if it didn't, native Electron
// notifications + the main-process IPC bridge already replace the SW push
// path. Leaving the registration as a quiet failure is harmless but noisy
// in the desktop log.
const SW_ENABLED = import.meta.env.PROD && !isDesktopApp();
if ('serviceWorker' in navigator && SW_ENABLED) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => {
        // Check for updates immediately
        reg.update();

        // If a new SW is already waiting, trigger update
        if (reg.waiting) {
          window.dispatchEvent(new CustomEvent('sw-update-available', { detail: reg }));
        }

        // Watch for new SW installing
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;

          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              window.dispatchEvent(new CustomEvent('sw-update-available', { detail: reg }));
            }
          });
        });

        // Check for updates every 30 seconds (faster detection)
        setInterval(() => reg.update(), 30 * 1000);
      })
      .catch((err) => console.warn('[SW] Registration failed:', err));
  });
}

// Dev-mode cleanup: a SW from a prior production preview or pre-fix dev
// session may still be controlling this origin. Unregister it AND clear its
// caches so the NEXT manual reload loads fresh modules from Vite. Without
// this the browser would keep returning the SW's synthetic 503 fallback
// whenever Vite is restarting or briefly unreachable.
//
// We intentionally do NOT auto-reload here. The unregister + cache wipe is
// quiet and idempotent; we log a one-line console hint so the developer
// knows a manual reload is needed for this session. Subsequent sessions
// load without the SW automatically because registration is gated above.
// No-op in production builds.
if ('serviceWorker' in navigator && !SW_ENABLED) {
  navigator.serviceWorker.getRegistrations()
    .then((regs) => Promise.all(regs.map((r) => r.unregister())))
    .then((unregistered) => {
      if (unregistered.some(Boolean)) {
        if (typeof caches !== 'undefined' && caches.keys) {
          caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))));
        }
        console.info('[SW] dev-mode cleanup: unregistered stale service worker + cleared caches. Reload the tab once to drop SW control of the current document.');
      }
    })
    .catch(() => { /* best-effort cleanup; non-fatal */ });
}

ReactDOM.createRoot(document.getElementById('root')).render(
    <AppRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ThemeProvider>
        <AuthProvider>
          <LanguageProvider>
          <FontSizeProvider>
            <RealtimeProvider>
              <UndoProvider>
                <ToastProvider>
                  <ConfirmProvider>
                    <ErrorBoundary>
                      <App />
                    </ErrorBoundary>
                  </ConfirmProvider>
                </ToastProvider>
              </UndoProvider>
            </RealtimeProvider>
          </FontSizeProvider>
          </LanguageProvider>
        </AuthProvider>
      </ThemeProvider>
    </AppRouter>
);

// Render UpdatePrompt in a separate root so it shows even if the main app crashes
const updateRoot = document.createElement('div');
updateRoot.id = 'update-prompt-root';
document.body.appendChild(updateRoot);
ReactDOM.createRoot(updateRoot).render(<UpdatePrompt />);
