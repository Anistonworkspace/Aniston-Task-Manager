import React, { useState, useEffect } from 'react';
import { RefreshCw } from 'lucide-react';

export default function UpdatePrompt() {
  const [showUpdate, setShowUpdate] = useState(false);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    // Listen for SW update available event
    function onUpdateAvailable(e) {
      setShowUpdate(true);
      // Auto-trigger update after 3 seconds if user doesn't click
      setTimeout(() => {
        triggerUpdate(e.detail);
      }, 5000);
    }

    // Listen for SW_UPDATED message from new service worker
    function onSWMessage(event) {
      if (event.data && event.data.type === 'SW_UPDATED') {
        // New SW is active — force reload to get new content
        window.location.reload();
      }
    }

    window.addEventListener('sw-update-available', onUpdateAvailable);
    navigator.serviceWorker?.addEventListener('message', onSWMessage);

    return () => {
      window.removeEventListener('sw-update-available', onUpdateAvailable);
      navigator.serviceWorker?.removeEventListener('message', onSWMessage);
    };
  }, []);

  function triggerUpdate(registration) {
    setUpdating(true);
    const waiting = registration?.waiting;
    if (waiting) {
      waiting.postMessage({ type: 'SKIP_WAITING' });
    } else {
      // No waiting worker — just reload
      window.location.reload();
    }
  }

  // Also listen for controller change (new SW took over)
  useEffect(() => {
    let refreshing = false;
    function onControllerChange() {
      if (!refreshing) {
        refreshing = true;
        window.location.reload();
      }
    }
    navigator.serviceWorker?.addEventListener('controllerchange', onControllerChange);
    return () => navigator.serviceWorker?.removeEventListener('controllerchange', onControllerChange);
  }, []);

  if (!showUpdate) return null;

  return (
    <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-white dark:bg-zinc-800 rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-r from-primary to-blue-500 px-6 py-5 text-white">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-white/20 flex items-center justify-center backdrop-blur-sm">
              <img src="/icons/anistonlogo.png" alt="Monday Aniston" className="w-8 h-8 object-contain" />
            </div>
            <div>
              <h2 className="text-lg font-bold">Update Available</h2>
              <p className="text-white/80 text-sm">Monday Aniston</p>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5">
          <p className="text-text-primary dark:text-zinc-100 text-sm leading-relaxed mb-2">
            A new version of Monday Aniston is available with the latest improvements and bug fixes.
          </p>
          <p className="text-text-secondary dark:text-zinc-400 text-xs">
            The application will update and reload automatically. This only takes a moment.
          </p>
        </div>

        {/* Action — NO dismiss/close button */}
        <div className="px-6 pb-5">
          <button
            onClick={() => triggerUpdate(null)}
            disabled={updating}
            className="w-full flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-white py-3 rounded-xl font-semibold text-sm transition-all disabled:opacity-70"
          >
            {updating ? (
              <>
                <RefreshCw size={16} className="animate-spin" />
                <span>Installing Update...</span>
              </>
            ) : (
              <>
                <RefreshCw size={16} />
                <span>Install Update Now</span>
              </>
            )}
          </button>
          <p className="text-center text-[10px] text-gray-400 mt-2">
            Auto-updating in a few seconds...
          </p>
        </div>
      </div>
    </div>
  );
}
