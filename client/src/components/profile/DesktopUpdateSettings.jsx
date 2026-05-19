import React, { useEffect, useState, useCallback } from 'react';
import { Download, RefreshCw, Check, AlertCircle, Loader2 } from 'lucide-react';
import { isDesktopApp } from '../../utils/runtime';

/**
 * DesktopUpdateSettings
 *
 * Renders ONLY when running inside the Electron desktop wrapper. On the
 * web bundle this component returns null — it never appears in a normal
 * browser. The component talks to the desktop main process via the
 * preload bridge (`window.anistonDesktop.getUpdateStatus / checkForUpdates
 * / installUpdate / onUpdateState`). No direct IPC access from the
 * renderer; no auth tokens cross the boundary.
 *
 * State machine (mirrors updater.js):
 *   idle        — nothing happening; user can click Check
 *   checking    — manifest fetch in flight
 *   up-to-date  — caught up; user can re-check
 *   available   — newer version detected; user can Install now
 *   declined    — user clicked Later this session (still re-checkable)
 *   downloading — installer streaming in (progress 0..1)
 *   verifying   — SHA-256 hash check running
 *   ready       — verified, about to launch installer
 *   launching   — child installer spawned, app quitting
 *   error       — fatal; error string surfaces a friendly message
 */
function fmtBytes(n) {
  if (!n || n <= 0) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtTimestamp(iso) {
  if (!iso) return null;
  try { return new Date(iso).toLocaleString(); }
  catch { return null; }
}

export default function DesktopUpdateSettings() {
  // Bail BEFORE any hooks if not in desktop runtime — the preload bridge
  // isn't there to talk to, and we don't want a wasted re-render layer
  // in every web user's Profile page.
  if (!isDesktopApp() || !window.anistonDesktop || typeof window.anistonDesktop.onUpdateState !== 'function') {
    return null;
  }

  const [state, setState] = useState({
    status: 'idle',
    currentVersion: window.anistonDesktop.appVersion || null,
    latestVersion: null,
    releaseNotes: '',
    sizeBytes: 0,
    mandatory: false,
    progress: 0,
    error: null,
    lastCheckedAt: null,
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Replay the current snapshot once on mount so we don't show stale
    // defaults if the startup auto-check already ran.
    window.anistonDesktop.getUpdateStatus().then((snap) => {
      if (cancelled) return;
      if (snap && typeof snap === 'object') setState((prev) => ({ ...prev, ...snap }));
    }).catch(() => { /* ignore */ });

    // Subscribe to live state pushes for download progress + transitions.
    const dispose = window.anistonDesktop.onUpdateState((next) => {
      if (cancelled) return;
      setState(next);
    });
    return () => {
      cancelled = true;
      if (typeof dispose === 'function') dispose();
    };
  }, []);

  const handleCheck = useCallback(async () => {
    setBusy(true);
    try { await window.anistonDesktop.checkForUpdates(); }
    catch { /* state.error will surface failure */ }
    finally { setBusy(false); }
  }, []);

  const handleInstall = useCallback(async () => {
    setBusy(true);
    try { await window.anistonDesktop.installUpdate(); }
    catch { /* updater state will reflect outcome */ }
    finally { setBusy(false); }
  }, []);

  const {
    status, currentVersion, latestVersion, releaseNotes,
    sizeBytes, mandatory, progress, error, lastCheckedAt,
  } = state;

  // Map status → presentation. We compute everything once per render so
  // the JSX below stays declarative.
  const isWorking = ['checking', 'downloading', 'verifying', 'ready', 'launching'].includes(status);
  const hasUpdate = status === 'available' || status === 'declined' || status === 'downloading' || status === 'verifying' || status === 'ready' || status === 'launching';
  const showInstall = (status === 'available' || status === 'declined') && !mandatory;
  const showInstallMandatory = (status === 'available' || status === 'declined') && mandatory;

  let statusLine;
  let statusIcon;
  let statusColor;
  if (status === 'checking') {
    statusLine = 'Checking for updates...';
    statusIcon = <Loader2 size={14} className="animate-spin" />;
    statusColor = 'text-text-secondary';
  } else if (status === 'up-to-date') {
    statusLine = `You are running the latest version (${currentVersion || '—'}).`;
    statusIcon = <Check size={14} />;
    statusColor = 'text-emerald-600';
  } else if (status === 'available' || status === 'declined') {
    statusLine = `Update available: ${latestVersion}${sizeBytes ? ` (${fmtBytes(sizeBytes)})` : ''}.`;
    statusIcon = <Download size={14} />;
    statusColor = 'text-primary';
  } else if (status === 'downloading') {
    statusLine = `Downloading update... ${(progress * 100).toFixed(0)}%`;
    statusIcon = <Loader2 size={14} className="animate-spin" />;
    statusColor = 'text-primary';
  } else if (status === 'verifying') {
    statusLine = 'Verifying installer integrity...';
    statusIcon = <Loader2 size={14} className="animate-spin" />;
    statusColor = 'text-primary';
  } else if (status === 'ready') {
    statusLine = 'Installer ready. Launching...';
    statusIcon = <Loader2 size={14} className="animate-spin" />;
    statusColor = 'text-primary';
  } else if (status === 'launching') {
    statusLine = 'Closing app to install update...';
    statusIcon = <Loader2 size={14} className="animate-spin" />;
    statusColor = 'text-primary';
  } else if (status === 'error') {
    statusLine = error || 'Update failed. Please try again.';
    statusIcon = <AlertCircle size={14} />;
    statusColor = 'text-danger';
  } else {
    statusLine = 'No update checked yet this session.';
    statusIcon = null;
    statusColor = 'text-text-tertiary';
  }

  return (
    <div className="bg-[var(--bg-elevated)] border border-border rounded-xl p-4 sm:p-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <Download size={15} className="text-primary" />
            Desktop App Updates
          </h3>
          <p className="text-xs text-text-secondary mt-1">
            Your Monday Aniston desktop app checks for updates automatically.
            You can also check manually here.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        <div className="bg-surface/50 border border-border rounded-lg px-3 py-2.5">
          <div className="text-[11px] uppercase tracking-wide text-text-tertiary font-medium">Installed version</div>
          <div className="text-sm font-semibold text-text-primary font-mono mt-0.5">{currentVersion || '—'}</div>
        </div>
        <div className="bg-surface/50 border border-border rounded-lg px-3 py-2.5">
          <div className="text-[11px] uppercase tracking-wide text-text-tertiary font-medium">Latest available</div>
          <div className="text-sm font-semibold text-text-primary font-mono mt-0.5">{latestVersion || '—'}</div>
        </div>
      </div>

      <div className={`flex items-center gap-2 text-xs ${statusColor} mb-3`}>
        {statusIcon}
        <span>{statusLine}</span>
        {lastCheckedAt && status === 'up-to-date' && (
          <span className="text-text-tertiary">· Checked {fmtTimestamp(lastCheckedAt)}</span>
        )}
      </div>

      {status === 'downloading' && (
        <div className="w-full bg-surface-100 rounded-full h-1.5 mb-3 overflow-hidden">
          <div
            className="bg-primary h-full transition-all duration-200 ease-linear"
            style={{ width: `${Math.max(2, Math.min(100, progress * 100))}%` }}
          />
        </div>
      )}

      {hasUpdate && releaseNotes && (
        <div className="bg-surface/30 border border-border rounded-lg p-3 mb-3">
          <div className="text-[11px] uppercase tracking-wide text-text-tertiary font-medium mb-1">What's new</div>
          <p className="text-xs text-text-secondary whitespace-pre-line leading-relaxed">{releaseNotes}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleCheck}
          disabled={busy || isWorking}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-primary rounded-md border border-border hover:bg-surface-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <RefreshCw size={12} className={isWorking ? 'animate-spin' : ''} />
          Check for updates
        </button>

        {showInstall && (
          <button
            type="button"
            onClick={handleInstall}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-primary hover:bg-primary-hover rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Download size={12} />
            Install update
          </button>
        )}
        {showInstallMandatory && (
          <button
            type="button"
            onClick={handleInstall}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-danger hover:bg-danger/90 rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Download size={12} />
            Install required update
          </button>
        )}
      </div>

      {mandatory && (status === 'available' || status === 'declined') && (
        <p className="text-[11px] text-danger mt-2">
          This update is marked as required by your administrator.
        </p>
      )}
    </div>
  );
}
