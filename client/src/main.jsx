import React from 'react'; // eslint-disable-line no-unused-vars
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { RealtimeProvider } from './realtime';
import { ToastProvider } from './components/common/Toast';
import { ConfirmProvider } from './components/common/ConfirmDialog';
import { ThemeProvider } from './context/ThemeContext';
import { FontSizeProvider } from './context/FontSizeContext';
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

// Register Service Worker for PWA + force updates
if ('serviceWorker' in navigator) {
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

ReactDOM.createRoot(document.getElementById('root')).render(
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ThemeProvider>
        <AuthProvider>
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
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
);

// Render UpdatePrompt in a separate root so it shows even if the main app crashes
const updateRoot = document.createElement('div');
updateRoot.id = 'update-prompt-root';
document.body.appendChild(updateRoot);
ReactDOM.createRoot(updateRoot).render(<UpdatePrompt />);
