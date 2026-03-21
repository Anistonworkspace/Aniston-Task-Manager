import React, { useState, useEffect } from 'react';
import { RefreshCw, X } from 'lucide-react';

export default function UpdatePrompt() {
  const [registration, setRegistration] = useState(null);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    function onUpdateAvailable(e) {
      setRegistration(e.detail);
    }

    window.addEventListener('sw-update-available', onUpdateAvailable);
    return () => window.removeEventListener('sw-update-available', onUpdateAvailable);
  }, []);

  if (!registration) return null;

  function handleUpdate() {
    setUpdating(true);
    const waiting = registration.waiting;
    if (waiting) {
      waiting.postMessage({ type: 'SKIP_WAITING' });
    }
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-zinc-800 rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden animate-in">
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
            Please install the update to continue using the application with the latest features. The page will reload automatically.
          </p>
        </div>

        {/* Action */}
        <div className="px-6 pb-5">
          <button
            onClick={handleUpdate}
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
                <span>Install Update & Reload</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
