import React from 'react'; // eslint-disable-line no-unused-vars
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { RealtimeProvider } from './realtime';
import { ToastProvider } from './components/common/Toast';
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
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type !== 'AUTH_CHECK') return;
    const port = event.ports?.[0];
    if (!port) return;
    const authenticated = !!(sessionStorage.getItem('token') || localStorage.getItem('token'));
    try { port.postMessage({ authenticated }); } catch { /* ignore */ }
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
                  <ErrorBoundary>
                    <App />
                  </ErrorBoundary>
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
