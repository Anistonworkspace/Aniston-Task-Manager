import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './components/common/Toast';
import { ThemeProvider } from './context/ThemeContext';
import { UndoProvider } from './context/UndoContext';
import ErrorBoundary from './components/common/ErrorBoundary';
import UpdatePrompt from './components/common/UpdatePrompt';
import './index.css';

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

// Render UpdatePrompt in a separate root so it shows even if the main app crashes
const updateRoot = document.createElement('div');
updateRoot.id = 'update-prompt-root';
document.body.appendChild(updateRoot);
ReactDOM.createRoot(updateRoot).render(<UpdatePrompt />);
