import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './components/common/Toast';
import { ThemeProvider } from './context/ThemeContext';
import { UndoProvider } from './context/UndoContext';
import ErrorBoundary from './components/common/ErrorBoundary';
import './index.css';

// Register Service Worker for PWA + detect updates
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => {
        console.log('[SW] Registered:', reg.scope);

        // Check for updates on page load
        reg.update();

        // When a new SW is found waiting, notify the app
        if (reg.waiting) {
          window.dispatchEvent(new CustomEvent('sw-update-available', { detail: reg }));
        }

        // Listen for new SW installing
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;

          newWorker.addEventListener('statechange', () => {
            // New SW is installed and waiting — show update prompt
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              window.dispatchEvent(new CustomEvent('sw-update-available', { detail: reg }));
            }
          });
        });

        // Periodically check for updates (every 60 seconds)
        setInterval(() => reg.update(), 60 * 1000);
      })
      .catch((err) => console.warn('[SW] Registration failed:', err));
  });

  // When the new SW takes over, reload the page
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!refreshing) {
      refreshing = true;
      window.location.reload();
    }
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ThemeProvider>
        <AuthProvider>
          <UndoProvider>
            <ToastProvider>
              <ErrorBoundary>
                <App />
              </ErrorBoundary>
            </ToastProvider>
          </UndoProvider>
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>
);
