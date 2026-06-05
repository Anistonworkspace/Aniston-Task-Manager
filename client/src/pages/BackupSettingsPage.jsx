/**
 * Tier-1 (Super Admin) database backup management page.
 *
 * Routed at /admin/backups. Gated by StrictAdminRoute in App.jsx AND
 * re-checked here against `isSuperAdmin` — if a non-Tier-1 user somehow
 * lands on this page, they see the AccessDenied fallback instead of the
 * controls (defence in depth — the backend rejects their API calls anyway).
 *
 * UI shape mirrors the HRMS backup reference:
 *   • Section header with Restore-from-File + Create-DB-Backup buttons.
 *   • Table of backups with filename / created / size / trigger / status /
 *     actions. The latest scheduled or manual completed row carries a
 *     "latest" badge.
 *   • Files backup placeholder section ("coming next") so the surface area
 *     matches the reference without shipping half-implemented behaviour.
 *
 * Restore safety:
 *   • Two confirmation steps. First click on a restore action opens a modal
 *     with a typed-confirmation input. The Restore button is disabled until
 *     the input matches exactly "RESTORE DATABASE".
 *   • The backend re-validates the same phrase server-side. Removing the
 *     UI gate alone does NOT bypass the server check.
 */

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Database,
  Plus,
  Upload,
  Download,
  Trash2,
  RotateCcw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Loader2,
  Calendar,
  Archive,
  ShieldAlert,
  FileArchive,
} from 'lucide-react';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/common/Toast';
import Modal from '../components/common/Modal';
import AccessDenied from '../components/common/AccessDenied';
import safeLog from '../utils/safeLog';

// ── Constants ────────────────────────────────────────────────────────────
// Matches the backend gate in adminBackupsController.RESTORE_CONFIRM_PHRASE.
const RESTORE_CONFIRM_PHRASE = 'RESTORE DATABASE';
// Matches adminBackupsController.FILES_RESTORE_CONFIRM_PHRASE. Different phrase
// so a DB-restore confirmation can't be pasted into a files restore by habit.
const FILES_RESTORE_CONFIRM_PHRASE = 'RESTORE FILES';

// ── Helpers ──────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes == null) return '—';
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function relativeAge(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} wk${weeks === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  return `${months} mo ago`;
}

// Trigger pill styles — must stay in sync with the backup_records CHECK.
const TRIGGER_STYLES = {
  scheduled: 'bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:ring-blue-500/30',
  manual:    'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30',
  uploaded:  'bg-purple-50 text-purple-700 ring-purple-200 dark:bg-purple-500/10 dark:text-purple-300 dark:ring-purple-500/30',
  pre_restore: 'bg-zinc-100 text-zinc-700 ring-zinc-200 dark:bg-zinc-500/10 dark:text-zinc-300 dark:ring-zinc-500/30',
};

const TRIGGER_ICON = {
  scheduled: Calendar,
  manual: Plus,
  uploaded: Upload,
  pre_restore: ShieldAlert,
};

const STATUS_STYLES = {
  completed: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30',
  running:   'bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:ring-blue-500/30',
  failed:    'bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/30',
};

const STATUS_ICON = {
  completed: CheckCircle2,
  running: Loader2,
  failed: XCircle,
};

function StatusPill({ status, progressPercent }) {
  const Icon = STATUS_ICON[status] || CheckCircle2;
  const animate = status === 'running' ? 'animate-spin' : '';
  // While running, the pill also carries the live percentage so an operator
  // can tell at a glance whether the job is making progress vs hung.
  const label = status === 'running' && Number.isFinite(progressPercent)
    ? `Running ${Math.max(0, Math.min(100, Math.floor(progressPercent)))}%`
    : status;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ring-1 ${STATUS_STYLES[status] || ''}`}>
      <Icon size={12} className={animate} />
      <span className="capitalize">{label}</span>
    </span>
  );
}

// Linear progress bar shown inline under the status pill while a backup is
// running. Anchored to the actual `progressPercent` written by the
// backend; the indeterminate-shimmer (animate-pulse) only kicks in when
// progress is genuinely 0 so the bar feels alive even before the first
// bytes are written.
function ProgressBar({ percent }) {
  const safe = Math.max(0, Math.min(100, Math.floor(percent || 0)));
  return (
    <div className="mt-1.5 w-44">
      <div className="h-1.5 w-full rounded-full bg-zinc-200 dark:bg-zinc-700/60 overflow-hidden">
        <div
          className={`h-full rounded-full bg-blue-500 dark:bg-blue-400 transition-all duration-500 ${safe === 0 ? 'animate-pulse' : ''}`}
          style={{ width: `${Math.max(safe, 4)}%` }}
        />
      </div>
    </div>
  );
}

function TriggerPill({ trigger }) {
  const Icon = TRIGGER_ICON[trigger] || Calendar;
  const label = trigger === 'pre_restore' ? 'Pre-restore' : trigger.charAt(0).toUpperCase() + trigger.slice(1);
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ring-1 ${TRIGGER_STYLES[trigger] || ''}`}>
      <Icon size={12} />
      {label}
    </span>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────

export default function BackupSettingsPage() {
  const { isSuperAdmin } = useAuth();
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState([]);
  const [retentionDays, setRetentionDays] = useState(30);

  const [creating, setCreating] = useState(false);
  const [downloadingId, setDownloadingId] = useState(null);

  // Confirmation modals are funnelled through a single state object so only
  // one is ever open at a time. `kind` discriminates between delete and the
  // two restore variants; `payload` carries whatever the action needs.
  const [confirm, setConfirm] = useState(null); // { kind, payload } | null

  // Upload-restore is a special case — we hold the File reference here so
  // the typed-confirmation modal can show its name before the user commits.
  const fileInputRef = useRef(null);

  // ── Files-backup state (parallel to the DB state above, fully separate) ──
  const [filesItems, setFilesItems] = useState([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [filesRetentionDays, setFilesRetentionDays] = useState(30);
  const [filesCreating, setFilesCreating] = useState(false);
  const [filesDownloadingId, setFilesDownloadingId] = useState(null);
  // Separate confirm state so the files modals never couple to the DB ones.
  const [filesConfirm, setFilesConfirm] = useState(null); // { kind, payload } | null
  const filesFileInputRef = useRef(null);

  const fetchBackups = useCallback(async () => {
    try {
      const res = await api.get('/admin/backups/database');
      const data = res.data?.data || {};
      setItems(Array.isArray(data.items) ? data.items : []);
      if (data.retentionDays) setRetentionDays(data.retentionDays);
    } catch (err) {
      safeLog.error('[BackupSettingsPage] list error', err);
      if (err?.response?.status === 403) {
        // Re-render path will switch to AccessDenied via isSuperAdmin guard;
        // until then surface the toast so the page is never silently blank.
        toast.error('Super Admin privileges are required to view backups.');
      } else {
        toast.error('Failed to load backups.');
      }
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (!isSuperAdmin) { setLoading(false); return; }
    fetchBackups();
  }, [isSuperAdmin, fetchBackups]);

  // Background poll while any row is `running` so the UI updates without a
  // manual refresh. Polls only when an in-flight row exists — the
  // steady-state cost is zero. 2.5 s is a sweet spot: fast enough that the
  // progress bar feels live, slow enough to not hammer the API.
  useEffect(() => {
    if (!isSuperAdmin) return undefined;
    const hasRunning = items.some((r) => r.status === 'running');
    if (!hasRunning) return undefined;
    const handle = setInterval(fetchBackups, 2500);
    return () => clearInterval(handle);
  }, [items, isSuperAdmin, fetchBackups]);

  // Surface whether a backup is currently in flight. Used to disable the
  // "Create DB Backup" button (the backend would 409 anyway, but a disabled
  // button + tooltip is friendlier than a click → toast loop).
  const hasRunningBackup = useMemo(
    () => items.some((r) => r.status === 'running'),
    [items]
  );

  // Latest completed row used for the "latest" badge. Manual and scheduled
  // both qualify (operators may want to spot their last manual snapshot too).
  const latestCompletedId = useMemo(() => {
    const eligible = items
      .filter((r) => r.status === 'completed' && (r.trigger === 'scheduled' || r.trigger === 'manual'))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return eligible[0]?.id || null;
  }, [items]);

  // ── Action handlers ────────────────────────────────────────────────────

  const handleCreate = async () => {
    if (creating || hasRunningBackup) return;
    setCreating(true);
    try {
      const res = await api.post('/admin/backups/database');
      const fresh = res.data?.data;
      toast.success(fresh?.filename ? `Backup created: ${fresh.filename}` : 'Backup created.');
      // The response already represents the completed row, but refetch so
      // ordering / "latest" badge update consistently.
      await fetchBackups();
    } catch (err) {
      safeLog.error('[BackupSettingsPage] create error', err);
      // 409 from the backend = a backup is already in flight. Show as a
      // warning, not an error — the UI will pick the running row up via
      // its poll loop and the user can wait for it.
      if (err?.response?.status === 409) {
        toast.warning(err.response.data?.message || 'A backup is already running. Wait for it to finish.');
        await fetchBackups();
      } else {
        toast.error(err?.response?.data?.message || 'Backup failed. Check server logs.');
      }
    } finally {
      setCreating(false);
    }
  };

  // Download is a regular GET with the auth cookies; rather than letting
  // axios buffer the response into memory, we hand the URL to a hidden
  // <a download> click. Browser handles auth via cookies (withCredentials).
  // For full robustness across Vite proxy + nginx we still fetch via the
  // axios baseURL prefix.
  const handleDownload = async (record) => {
    setDownloadingId(record.id);
    try {
      const res = await api.get(`/admin/backups/database/${record.id}/download`, {
        responseType: 'blob',
      });
      const blob = res.data instanceof Blob ? res.data : new Blob([res.data], { type: 'application/gzip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = record.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Defer revoke so the download has time to start. 10s is generous.
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      safeLog.error('[BackupSettingsPage] download error', err);
      toast.error(err?.response?.data?.message || 'Download failed.');
    } finally {
      setDownloadingId(null);
    }
  };

  const handleDelete = async ({ id }) => {
    try {
      await api.delete(`/admin/backups/database/${id}`);
      toast.success('Backup deleted.');
      await fetchBackups();
    } catch (err) {
      safeLog.error('[BackupSettingsPage] delete error', err);
      toast.error(err?.response?.data?.message || 'Delete failed.');
    }
  };

  const handleRestore = async ({ id }) => {
    try {
      const res = await api.post(`/admin/backups/database/${id}/restore`, {
        confirmation: RESTORE_CONFIRM_PHRASE,
      });
      const preRestoreId = res.data?.data?.preRestoreBackupId;
      toast.success(
        preRestoreId
          ? 'Restore complete. A pre-restore safety backup was created automatically.'
          : 'Restore complete.'
      );
      await fetchBackups();
    } catch (err) {
      safeLog.error('[BackupSettingsPage] restore error', err);
      const preRestoreId = err?.response?.data?.data?.preRestoreBackupId;
      toast.error(
        preRestoreId
          ? 'Restore failed. Pre-restore safety backup is preserved — recovery is still possible.'
          : (err?.response?.data?.message || 'Restore failed.')
      );
      await fetchBackups();
    }
  };

  const handleUploadRestore = async ({ file }) => {
    const form = new FormData();
    form.append('backup', file);
    form.append('confirmation', RESTORE_CONFIRM_PHRASE);
    try {
      const res = await api.post('/admin/backups/database/restore-upload', form);
      const preRestoreId = res.data?.data?.preRestoreBackupId;
      toast.success(
        preRestoreId
          ? `Restored from ${file.name}. Pre-restore safety backup created.`
          : `Restored from ${file.name}.`
      );
      await fetchBackups();
    } catch (err) {
      safeLog.error('[BackupSettingsPage] upload-restore error', err);
      const preRestoreId = err?.response?.data?.data?.preRestoreBackupId;
      toast.error(
        preRestoreId
          ? 'Restore failed. Pre-restore safety backup is preserved.'
          : (err?.response?.data?.message || 'Upload restore failed.')
      );
      await fetchBackups();
    }
  };

  const onFileInputChange = (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so picking the same file twice still fires
    if (!file) return;
    if (!/\.(sql\.gz|gz)$/i.test(file.name)) {
      toast.error('Backup files must end in .sql.gz');
      return;
    }
    setConfirm({ kind: 'restore-upload', payload: { file } });
  };

  // ── Files-backup fetch / poll / handlers ────────────────────────────────

  const fetchFiles = useCallback(async () => {
    try {
      const res = await api.get('/admin/backups/files');
      const data = res.data?.data || {};
      setFilesItems(Array.isArray(data.items) ? data.items : []);
      if (data.retentionDays) setFilesRetentionDays(data.retentionDays);
    } catch (err) {
      safeLog.error('[BackupSettingsPage] files list error', err);
      if (err?.response?.status !== 403) toast.error('Failed to load files backups.');
    } finally {
      setFilesLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (!isSuperAdmin) { setFilesLoading(false); return; }
    fetchFiles();
  }, [isSuperAdmin, fetchFiles]);

  // Poll while any files backup is running (zero cost in steady state).
  useEffect(() => {
    if (!isSuperAdmin) return undefined;
    const hasRunning = filesItems.some((r) => r.status === 'running');
    if (!hasRunning) return undefined;
    const handle = setInterval(fetchFiles, 2500);
    return () => clearInterval(handle);
  }, [filesItems, isSuperAdmin, fetchFiles]);

  const hasRunningFilesBackup = useMemo(
    () => filesItems.some((r) => r.status === 'running'),
    [filesItems]
  );

  const latestCompletedFilesId = useMemo(() => {
    const eligible = filesItems
      .filter((r) => r.status === 'completed' && (r.trigger === 'scheduled' || r.trigger === 'manual'))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return eligible[0]?.id || null;
  }, [filesItems]);

  const handleFilesCreate = async () => {
    if (filesCreating || hasRunningFilesBackup) return;
    setFilesCreating(true);
    try {
      const res = await api.post('/admin/backups/files');
      const fresh = res.data?.data;
      toast.success(fresh?.filename ? `Files backup created: ${fresh.filename}` : 'Files backup created.');
      await fetchFiles();
    } catch (err) {
      safeLog.error('[BackupSettingsPage] files create error', err);
      if (err?.response?.status === 409) {
        toast.warning(err.response.data?.message || 'A files backup is already running. Wait for it to finish.');
        await fetchFiles();
      } else {
        toast.error(err?.response?.data?.message || 'Files backup failed. Check server logs.');
      }
    } finally {
      setFilesCreating(false);
    }
  };

  const handleFilesDownload = async (record) => {
    setFilesDownloadingId(record.id);
    try {
      const res = await api.get(`/admin/backups/files/${record.id}/download`, { responseType: 'blob' });
      const blob = res.data instanceof Blob ? res.data : new Blob([res.data], { type: 'application/gzip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = record.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      safeLog.error('[BackupSettingsPage] files download error', err);
      toast.error(err?.response?.data?.message || 'Download failed.');
    } finally {
      setFilesDownloadingId(null);
    }
  };

  const handleFilesDelete = async ({ id }) => {
    try {
      await api.delete(`/admin/backups/files/${id}`);
      toast.success('Files backup deleted.');
      await fetchFiles();
    } catch (err) {
      safeLog.error('[BackupSettingsPage] files delete error', err);
      toast.error(err?.response?.data?.message || 'Delete failed.');
    }
  };

  const handleFilesRestore = async ({ id }) => {
    try {
      const res = await api.post(`/admin/backups/files/${id}/restore`, {
        confirmation: FILES_RESTORE_CONFIRM_PHRASE,
      });
      const preRestoreId = res.data?.data?.preRestoreBackupId;
      toast.success(
        preRestoreId
          ? 'Files restored. A pre-restore safety archive was created automatically.'
          : 'Files restored.'
      );
      await fetchFiles();
    } catch (err) {
      safeLog.error('[BackupSettingsPage] files restore error', err);
      const preRestoreId = err?.response?.data?.data?.preRestoreBackupId;
      toast.error(
        preRestoreId
          ? 'Files restore failed. Pre-restore safety archive is preserved.'
          : (err?.response?.data?.message || 'Files restore failed.')
      );
      await fetchFiles();
    }
  };

  const handleFilesUploadRestore = async ({ file }) => {
    const form = new FormData();
    form.append('backup', file);
    form.append('confirmation', FILES_RESTORE_CONFIRM_PHRASE);
    try {
      const res = await api.post('/admin/backups/files/restore-upload', form);
      const preRestoreId = res.data?.data?.preRestoreBackupId;
      toast.success(
        preRestoreId
          ? `Restored uploads from ${file.name}. Pre-restore safety archive created.`
          : `Restored uploads from ${file.name}.`
      );
      await fetchFiles();
    } catch (err) {
      safeLog.error('[BackupSettingsPage] files upload-restore error', err);
      const preRestoreId = err?.response?.data?.data?.preRestoreBackupId;
      toast.error(
        preRestoreId
          ? 'Files restore failed. Pre-restore safety archive is preserved.'
          : (err?.response?.data?.message || 'Files upload restore failed.')
      );
      await fetchFiles();
    }
  };

  const onFilesFileInputChange = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/\.(tar\.gz|tgz)$/i.test(file.name)) {
      toast.error('Files backups must end in .tar.gz');
      return;
    }
    setFilesConfirm({ kind: 'restore-upload', payload: { file } });
  };

  // ── Guards ─────────────────────────────────────────────────────────────

  if (!isSuperAdmin) {
    return <AccessDenied resourceLabel="Database Backups" action="manage" />;
  }

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <div className="mb-6 flex items-center gap-2">
        <Database size={22} className="text-primary" />
        <div>
          <h1 className="text-xl font-bold text-gray-800 dark:text-gray-100">Backups</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Daily automatic snapshots and on-demand backups of the production database <span className="font-medium">and</span> uploaded files.
            Retention: scheduled backups older than {retentionDays} days are pruned automatically.
          </p>
        </div>
      </div>

      {/* ─── Database backups card ─────────────────────────────────────── */}
      <section className="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
        <header className="flex items-center justify-between gap-3 px-6 py-4 border-b border-gray-200 dark:border-zinc-800">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
              <Database size={18} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Database Backups</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                pg_dump compressed SQL (<code>.sql.gz</code>) — restore overwrites all database rows.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 dark:border-zinc-700 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-zinc-800 transition-colors"
            >
              <Upload size={14} /> Restore from File
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".gz,application/gzip,application/x-gzip"
              className="hidden"
              onChange={onFileInputChange}
            />
            <button
              type="button"
              onClick={handleCreate}
              disabled={creating || hasRunningBackup}
              title={hasRunningBackup ? 'A backup is already running. Wait for it to finish.' : undefined}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {(creating || hasRunningBackup) ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              {hasRunningBackup ? 'Backup running…' : (creating ? 'Creating…' : 'Create DB Backup')}
            </button>
          </div>
        </header>

        {loading ? (
          <div className="flex items-center justify-center py-12 text-gray-500">
            <Loader2 size={20} className="animate-spin mr-2" /> Loading backups…
          </div>
        ) : items.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <Archive size={28} className="mx-auto text-gray-400 dark:text-zinc-500 mb-2" />
            <p className="text-sm text-gray-600 dark:text-gray-400">No backups yet.</p>
            <p className="text-xs text-gray-500 dark:text-gray-500 mt-1">
              The first scheduled backup runs at 6:00 PM server time. You can also create one now.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            {/* table-fixed forces the browser to honour the per-th widths
                below. Without it, long filenames or long error messages
                expand their cell auto-fit-style and blow the table past
                the viewport — causing the horizontal scroll that hid the
                Actions column. The widths sum to ~1080px which fits the
                content card on a typical 1280px+ viewport; on narrower
                screens overflow-x-auto kicks in cleanly with only the
                table scrolling, not the Status error text. */}
            <table className="w-full table-fixed text-sm">
              <thead className="text-xs uppercase tracking-wide text-gray-500 dark:text-zinc-400 bg-gray-50 dark:bg-zinc-800/40">
                <tr>
                  <th className="px-6 py-3 text-left font-medium w-[280px]">Filename</th>
                  <th className="px-6 py-3 text-left font-medium w-[140px]">Created</th>
                  <th className="px-6 py-3 text-left font-medium w-[90px]">Size</th>
                  <th className="px-6 py-3 text-left font-medium w-[120px]">Trigger</th>
                  <th className="px-6 py-3 text-left font-medium w-[260px]">Status</th>
                  <th className="px-6 py-3 text-right font-medium w-[140px]">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-zinc-800">
                {items.map((r) => {
                  const isLatest = r.id === latestCompletedId;
                  const canAct = r.status === 'completed';
                  return (
                    <tr key={r.id} className="hover:bg-gray-50/50 dark:hover:bg-zinc-800/30 transition-colors">
                      <td className="px-6 py-3 align-top">
                        <div className="flex items-center gap-2">
                          <FileArchive size={14} className="text-gray-400 shrink-0" />
                          <div className="min-w-0">
                            <div className="font-mono text-xs text-gray-800 dark:text-gray-100 truncate" title={r.filename}>
                              {r.filename}
                            </div>
                            {isLatest && (
                              <span className="inline-block mt-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300">
                                Latest
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-3 align-top">
                        <div className="text-gray-700 dark:text-gray-200">{formatDateTime(r.createdAt)}</div>
                        <div className="text-xs text-gray-500 dark:text-zinc-400">{relativeAge(r.createdAt)}</div>
                      </td>
                      <td className="px-6 py-3 align-top text-gray-700 dark:text-gray-200">{formatBytes(r.sizeBytes)}</td>
                      <td className="px-6 py-3 align-top"><TriggerPill trigger={r.trigger} /></td>
                      <td className="px-6 py-3 align-top">
                        <StatusPill status={r.status} progressPercent={r.progressPercent} />
                        {r.status === 'running' && <ProgressBar percent={r.progressPercent} />}
                        {r.status === 'failed' && r.errorMessage && (
                          // Wrap the error text inside the fixed-width
                          // Status cell instead of letting it expand the
                          // column. `break-words` handles long unbroken
                          // tokens (paths, error codes); `line-clamp-4`
                          // caps the row height so a multi-line stack
                          // trace can't make one row dwarf the others.
                          // Full text remains available via the title
                          // tooltip.
                          <div
                            className="text-[11px] text-red-600 dark:text-red-400 mt-1 break-words whitespace-normal line-clamp-4"
                            title={r.errorMessage}
                          >
                            {r.errorMessage}
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-3 align-top">
                        <div className="flex items-center justify-end gap-1">
                          <IconAction
                            label="Download"
                            disabled={!canAct || downloadingId === r.id}
                            loading={downloadingId === r.id}
                            onClick={() => handleDownload(r)}
                            icon={Download}
                          />
                          <IconAction
                            label="Restore"
                            disabled={!canAct}
                            onClick={() => setConfirm({ kind: 'restore', payload: { id: r.id, filename: r.filename } })}
                            icon={RotateCcw}
                          />
                          <IconAction
                            label="Delete"
                            danger
                            onClick={() => setConfirm({ kind: 'delete', payload: { id: r.id, filename: r.filename } })}
                            icon={Trash2}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ─── Uploaded files backups card ───────────────────────────────── */}
      <section className="mt-6 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800 rounded-2xl overflow-hidden">
        <header className="flex items-center justify-between gap-3 px-6 py-4 border-b border-gray-200 dark:border-zinc-800">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300 flex items-center justify-center">
              <FileArchive size={18} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Uploaded Files Backups</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                <code>tar.gz</code> archive of the <code>uploads/</code> directory (avatars, attachments, voice notes).
                These bytes live on disk, not in the database dump — back them up to avoid dangling file references after a DB restore.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => filesFileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 dark:border-zinc-700 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-zinc-800 transition-colors"
            >
              <Upload size={14} /> Restore from File
            </button>
            <input
              ref={filesFileInputRef}
              type="file"
              accept=".gz,.tgz,application/gzip,application/x-gzip"
              className="hidden"
              onChange={onFilesFileInputChange}
            />
            <button
              type="button"
              onClick={handleFilesCreate}
              disabled={filesCreating || hasRunningFilesBackup}
              title={hasRunningFilesBackup ? 'A files backup is already running. Wait for it to finish.' : undefined}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-600/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {(filesCreating || hasRunningFilesBackup) ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              {hasRunningFilesBackup ? 'Backup running…' : (filesCreating ? 'Creating…' : 'Create Files Backup')}
            </button>
          </div>
        </header>

        {filesLoading ? (
          <div className="flex items-center justify-center py-12 text-gray-500">
            <Loader2 size={20} className="animate-spin mr-2" /> Loading files backups…
          </div>
        ) : filesItems.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <Archive size={28} className="mx-auto text-gray-400 dark:text-zinc-500 mb-2" />
            <p className="text-sm text-gray-600 dark:text-gray-400">No files backups yet.</p>
            <p className="text-xs text-gray-500 dark:text-gray-500 mt-1">
              The first scheduled files backup runs at 6:30 PM server time. You can also create one now.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full table-fixed text-sm">
              <thead className="text-xs uppercase tracking-wide text-gray-500 dark:text-zinc-400 bg-gray-50 dark:bg-zinc-800/40">
                <tr>
                  <th className="px-6 py-3 text-left font-medium w-[280px]">Filename</th>
                  <th className="px-6 py-3 text-left font-medium w-[140px]">Created</th>
                  <th className="px-6 py-3 text-left font-medium w-[90px]">Size</th>
                  <th className="px-6 py-3 text-left font-medium w-[120px]">Trigger</th>
                  <th className="px-6 py-3 text-left font-medium w-[260px]">Status</th>
                  <th className="px-6 py-3 text-right font-medium w-[140px]">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-zinc-800">
                {filesItems.map((r) => {
                  const isLatest = r.id === latestCompletedFilesId;
                  const canAct = r.status === 'completed';
                  return (
                    <tr key={r.id} className="hover:bg-gray-50/50 dark:hover:bg-zinc-800/30 transition-colors">
                      <td className="px-6 py-3 align-top">
                        <div className="flex items-center gap-2">
                          <FileArchive size={14} className="text-gray-400 shrink-0" />
                          <div className="min-w-0">
                            <div className="font-mono text-xs text-gray-800 dark:text-gray-100 truncate" title={r.filename}>
                              {r.filename}
                            </div>
                            {isLatest && (
                              <span className="inline-block mt-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300">
                                Latest
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-3 align-top">
                        <div className="text-gray-700 dark:text-gray-200">{formatDateTime(r.createdAt)}</div>
                        <div className="text-xs text-gray-500 dark:text-zinc-400">{relativeAge(r.createdAt)}</div>
                      </td>
                      <td className="px-6 py-3 align-top text-gray-700 dark:text-gray-200">{formatBytes(r.sizeBytes)}</td>
                      <td className="px-6 py-3 align-top"><TriggerPill trigger={r.trigger} /></td>
                      <td className="px-6 py-3 align-top">
                        <StatusPill status={r.status} progressPercent={r.progressPercent} />
                        {r.status === 'running' && <ProgressBar percent={r.progressPercent} />}
                        {r.status === 'failed' && r.errorMessage && (
                          <div
                            className="text-[11px] text-red-600 dark:text-red-400 mt-1 break-words whitespace-normal line-clamp-4"
                            title={r.errorMessage}
                          >
                            {r.errorMessage}
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-3 align-top">
                        <div className="flex items-center justify-end gap-1">
                          <IconAction
                            label="Download"
                            disabled={!canAct || filesDownloadingId === r.id}
                            loading={filesDownloadingId === r.id}
                            onClick={() => handleFilesDownload(r)}
                            icon={Download}
                          />
                          <IconAction
                            label="Restore"
                            disabled={!canAct}
                            onClick={() => setFilesConfirm({ kind: 'restore', payload: { id: r.id, filename: r.filename } })}
                            icon={RotateCcw}
                          />
                          <IconAction
                            label="Delete"
                            danger
                            onClick={() => setFilesConfirm({ kind: 'delete', payload: { id: r.id, filename: r.filename } })}
                            icon={Trash2}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="px-6 py-3 border-t border-gray-200 dark:border-zinc-800">
          <p className="text-xs text-gray-500 dark:text-zinc-400">
            Retention: scheduled files backups older than {filesRetentionDays} days are pruned automatically.
            Restore overlays the archive onto the live <code>uploads/</code> directory (it never deletes files added after the backup).
          </p>
        </div>
      </section>

      {/* ─── Confirmation modals ───────────────────────────────────────── */}
      {confirm?.kind === 'delete' && (
        <DeleteConfirmModal
          filename={confirm.payload.filename}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const payload = confirm.payload;
            setConfirm(null);
            await handleDelete(payload);
          }}
        />
      )}
      {confirm?.kind === 'restore' && (
        <RestoreConfirmModal
          title="Restore from this backup?"
          description="This will OVERWRITE every row currently in the database with the contents of the selected backup file."
          targetLabel={confirm.payload.filename}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const payload = confirm.payload;
            setConfirm(null);
            await handleRestore(payload);
          }}
        />
      )}
      {confirm?.kind === 'restore-upload' && (
        <RestoreConfirmModal
          title="Restore from uploaded file?"
          description="The uploaded file will be validated, then restored over the live database. A pre-restore safety backup of the current database is taken automatically before the overwrite."
          targetLabel={confirm.payload.file.name}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const payload = confirm.payload;
            setConfirm(null);
            await handleUploadRestore(payload);
          }}
        />
      )}

      {/* ─── Files-backup confirmation modals ──────────────────────────── */}
      {filesConfirm?.kind === 'delete' && (
        <DeleteConfirmModal
          filename={filesConfirm.payload.filename}
          onCancel={() => setFilesConfirm(null)}
          onConfirm={async () => {
            const payload = filesConfirm.payload;
            setFilesConfirm(null);
            await handleFilesDelete(payload);
          }}
        />
      )}
      {filesConfirm?.kind === 'restore' && (
        <RestoreConfirmModal
          title="Restore uploaded files from this backup?"
          description="This extracts the archived files back into the live uploads/ directory, overwriting any current file with the same name. Files added after this backup are left untouched."
          targetLabel={filesConfirm.payload.filename}
          confirmPhrase={FILES_RESTORE_CONFIRM_PHRASE}
          onCancel={() => setFilesConfirm(null)}
          onConfirm={async () => {
            const payload = filesConfirm.payload;
            setFilesConfirm(null);
            await handleFilesRestore(payload);
          }}
        />
      )}
      {filesConfirm?.kind === 'restore-upload' && (
        <RestoreConfirmModal
          title="Restore from uploaded archive?"
          description="The uploaded .tar.gz will be validated, then extracted over the live uploads/ directory. A pre-restore safety archive of the current files is taken automatically before the overwrite."
          targetLabel={filesConfirm.payload.file.name}
          confirmPhrase={FILES_RESTORE_CONFIRM_PHRASE}
          onCancel={() => setFilesConfirm(null)}
          onConfirm={async () => {
            const payload = filesConfirm.payload;
            setFilesConfirm(null);
            await handleFilesUploadRestore(payload);
          }}
        />
      )}
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────

function IconAction({ icon: Icon, label, onClick, disabled, danger, loading }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={
        `p-1.5 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ` +
        (danger
          ? 'text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10'
          : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-700/50')
      }
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} />}
    </button>
  );
}

function DeleteConfirmModal({ filename, onCancel, onConfirm }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      isOpen
      onClose={onCancel}
      title="Delete this backup?"
      size="sm"
      footer={(
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 rounded-lg border border-gray-300 dark:border-zinc-700 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-60"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            Delete
          </button>
        </div>
      )}
    >
      <div className="space-y-3 text-sm text-gray-700 dark:text-gray-200">
        <div className="flex items-start gap-2">
          <AlertTriangle size={18} className="text-amber-500 shrink-0 mt-0.5" />
          <p>This permanently deletes the backup file from disk. The database itself is not affected.</p>
        </div>
        <div className="font-mono text-xs bg-gray-50 dark:bg-zinc-800/50 border border-gray-200 dark:border-zinc-700 rounded p-2 break-all">
          {filename}
        </div>
      </div>
    </Modal>
  );
}

function RestoreConfirmModal({ title, description, targetLabel, onCancel, onConfirm, confirmPhrase = RESTORE_CONFIRM_PHRASE }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = typed.trim() === confirmPhrase;
  return (
    <Modal
      isOpen
      onClose={busy ? undefined : onCancel}
      title={title}
      size="md"
      footer={(
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 rounded-lg border border-gray-300 dark:border-zinc-700 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!ok || busy}
            onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
            Restore database
          </button>
        </div>
      )}
    >
      <div className="space-y-4 text-sm">
        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 dark:bg-red-500/10 dark:border-red-500/30">
          <AlertTriangle size={18} className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
          <div className="text-red-700 dark:text-red-300">
            <p className="font-medium">Restore overwrites current database rows.</p>
            <p className="mt-1">{description}</p>
          </div>
        </div>

        <div className="text-gray-700 dark:text-gray-200">
          <div className="text-xs text-gray-500 dark:text-zinc-400 mb-1">Target</div>
          <div className="font-mono text-xs bg-gray-50 dark:bg-zinc-800/50 border border-gray-200 dark:border-zinc-700 rounded p-2 break-all">
            {targetLabel}
          </div>
        </div>

        <div>
          <label className="block text-xs text-gray-500 dark:text-zinc-400 mb-1">
            Type <span className="font-mono text-gray-700 dark:text-gray-200">{confirmPhrase}</span> to confirm
          </label>
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-gray-900 dark:text-gray-100 font-mono focus:outline-none focus:ring-2 focus:ring-red-500/40"
            placeholder={confirmPhrase}
          />
        </div>

        <p className="text-xs text-gray-500 dark:text-zinc-400">
          A pre-restore safety backup of the current state will be created automatically before the overwrite.
        </p>
      </div>
    </Modal>
  );
}
