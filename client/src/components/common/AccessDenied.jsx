import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldOff, Home, ArrowLeft } from 'lucide-react';

/**
 * AccessDenied — shown when an explicit permission DENY override blocks the
 * current user from accessing a page. Used by both the route guard
 * (PermissionRoute) and in-page guards (e.g. OrgChartPage) so the experience
 * is consistent regardless of how the user reached the route (sidebar click,
 * direct URL, deep link).
 */
export default function AccessDenied({ resourceLabel = 'this page', action = 'view', onBack }) {
  const navigate = useNavigate();
  return (
    <div className="flex-1 flex items-center justify-center p-6 bg-surface dark:bg-zinc-900">
      <div className="max-w-md w-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-2xl shadow-sm p-8 text-center">
        <div className="mx-auto w-14 h-14 rounded-full bg-red-50 dark:bg-red-500/10 flex items-center justify-center mb-4">
          <ShieldOff size={28} className="text-red-500" />
        </div>
        <h1 className="text-lg font-semibold text-text-primary dark:text-white mb-1">Access denied</h1>
        <p className="text-sm text-text-secondary dark:text-zinc-400 mb-6">
          You do not have permission to {action} {resourceLabel}. If you believe this is a mistake,
          please contact your administrator.
        </p>
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => (onBack ? onBack() : navigate(-1))}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 text-sm text-text-secondary dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700/40 transition-colors"
          >
            <ArrowLeft size={14} /> Go back
          </button>
          <button
            onClick={() => navigate('/')}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-white text-sm hover:bg-primary/90 transition-colors"
          >
            <Home size={14} /> Home
          </button>
        </div>
      </div>
    </div>
  );
}
