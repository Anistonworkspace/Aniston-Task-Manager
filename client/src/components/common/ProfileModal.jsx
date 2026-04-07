import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import ProfilePage from '../../pages/ProfilePage';

export default function ProfileModal({ onClose }) {
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-stretch justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-fade-in" onClick={onClose} />

      {/* Slide-over panel */}
      <div className="relative w-full max-w-2xl bg-surface flex flex-col shadow-2xl animate-slide-in-right overflow-hidden">
        {/* Header bar */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-white flex-shrink-0">
          <h2 className="text-lg font-semibold text-text-primary">Account Settings</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-surface transition-all"
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable content — reuse ProfilePage */}
        <div className="flex-1 overflow-y-auto">
          <ProfilePage />
        </div>
      </div>
    </div>,
    document.body
  );
}
