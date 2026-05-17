import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { History, RotateCcw, AlertTriangle } from 'lucide-react';

import Modal from '../../components/common/Modal';
import LetterAvatar from '../../components/common/LetterAvatar';
import { useToast } from '../../components/common/Toast';
import { listVersions, restoreVersion } from '../../services/docsService';
import { getErrorMessage } from '../../utils/errorMap';
import safeLog from '../../utils/safeLog';

/**
 * DocVersionHistoryModal — Phase H.
 *
 *   <DocVersionHistoryModal
 *     isOpen={open}
 *     onClose={() => setOpen(false)}
 *     docId={docId}
 *     currentDocTitle={doc?.title}
 *     onRestored={(version) => refreshDoc()}
 *   />
 *
 * On open: fetches versions via `listVersions(docId)`. Each row shows
 * timestamp + author + optional note ("Restored from version X") and a
 * primary "Restore" button. Clicking Restore reveals an inline
 * confirmation row (Confirm / Cancel) so users don't blow away the
 * current doc by mis-clicking.
 *
 * Pagination: the server returns up to 100 versions. We show 10 at a
 * time on the client and reveal more in 10-step chunks via "Show more".
 *
 * Restore success → close modal + fire `onRestored(version)` + toast.
 * Restore failure → toast + stay on the list (the modal does NOT close,
 * because the user might want to retry or pick a different version).
 */

const PAGE_SIZE = 10;

export default function DocVersionHistoryModal({
  isOpen,
  onClose,
  docId,
  currentDocTitle,
  onRestored,
}) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [versions, setVersions] = useState([]);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [confirmingId, setConfirmingId] = useState(null);
  const [restoringId, setRestoringId] = useState(null);
  const [loadError, setLoadError] = useState(null);

  // Reset local UI state every time the modal re-opens — without this,
  // closing mid-confirmation and reopening would leave the inline
  // confirm row open against a possibly-different doc.
  useEffect(() => {
    if (!isOpen) {
      setConfirmingId(null);
      setRestoringId(null);
      setVisibleCount(PAGE_SIZE);
      setLoadError(null);
      return;
    }
    if (!docId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const out = await listVersions(docId);
        if (cancelled) return;
        const list = Array.isArray(out?.versions) ? out.versions : [];
        setVersions(list);
      } catch (err) {
        if (cancelled) return;
        safeLog.error('[DocVersionHistoryModal] listVersions failed', err);
        setLoadError(getErrorMessage(err));
        setVersions([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, docId]);

  const visibleVersions = useMemo(
    () => versions.slice(0, visibleCount),
    [versions, visibleCount]
  );
  const hasMore = versions.length > visibleCount;

  const handleRestoreClick = useCallback((versionId) => {
    setConfirmingId(versionId);
  }, []);

  const handleCancelConfirm = useCallback(() => {
    setConfirmingId(null);
  }, []);

  const handleConfirmRestore = useCallback(async (version) => {
    if (!version?.id || !docId) return;
    setRestoringId(version.id);
    try {
      await restoreVersion(docId, version.id);
      toast?.success?.('Version restored.');
      try { onRestored?.(version); } catch { /* non-fatal */ }
      onClose?.();
    } catch (err) {
      safeLog.error('[DocVersionHistoryModal] restoreVersion failed', err);
      toast?.error?.(getErrorMessage(err));
      setConfirmingId(null);
    } finally {
      setRestoringId(null);
    }
  }, [docId, onClose, onRestored, toast]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Version history" size="lg">
      <div className="flex flex-col gap-3" data-testid="doc-version-history">
        {currentDocTitle && (
          <div className="text-xs text-text-tertiary">
            Showing saved snapshots for <span className="font-semibold">{currentDocTitle}</span>.
          </div>
        )}

        {loading && (
          <ul className="flex flex-col gap-2" data-testid="version-skeleton">
            {Array.from({ length: 4 }).map((_, i) => (
              <li
                key={i}
                className="animate-pulse flex items-center gap-3 px-3 py-3 rounded-md border border-zinc-200 dark:border-zinc-700"
              >
                <div className="w-8 h-8 rounded-full bg-zinc-200 dark:bg-zinc-700" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-32 rounded bg-zinc-200 dark:bg-zinc-700" />
                  <div className="h-2.5 w-48 rounded bg-zinc-200 dark:bg-zinc-700" />
                </div>
                <div className="h-7 w-20 rounded bg-zinc-200 dark:bg-zinc-700" />
              </li>
            ))}
          </ul>
        )}

        {!loading && loadError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-800 px-3 py-2 text-sm text-red-700 dark:text-red-300"
          >
            <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
            <span>{loadError}</span>
          </div>
        )}

        {!loading && !loadError && versions.length === 0 && (
          <div
            className="flex flex-col items-center gap-2 py-10 text-center text-sm text-text-tertiary"
            data-testid="version-empty"
          >
            <History size={28} className="text-text-tertiary opacity-70" />
            <p>No saved versions yet. Versions snapshot automatically every ~10 saves.</p>
          </div>
        )}

        {!loading && !loadError && versions.length > 0 && (
          <ul className="flex flex-col gap-2">
            {visibleVersions.map((v) => {
              const isConfirming = confirmingId === v.id;
              const isRestoring = restoringId === v.id;
              const authorName = v.author?.name || 'Unknown';
              const when = v.createdAt
                ? formatDistanceToNow(new Date(v.createdAt), { addSuffix: true })
                : '—';
              return (
                <li
                  key={v.id}
                  className="rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900/40"
                  data-testid={`version-row-${v.id}`}
                >
                  <div className="flex items-center gap-3 px-3 py-2.5">
                    <LetterAvatar
                      name={authorName}
                      image={v.author?.avatar || null}
                      shape="circle"
                      size="sm"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-text-primary truncate">
                        {when}
                      </div>
                      <div className="text-xs text-text-tertiary truncate">
                        by {authorName}
                        {v.note ? <> · {v.note}</> : null}
                      </div>
                    </div>
                    {!isConfirming && (
                      <button
                        type="button"
                        onClick={() => handleRestoreClick(v.id)}
                        className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-md bg-primary text-white hover:opacity-90 transition-opacity disabled:opacity-50"
                        disabled={isRestoring}
                      >
                        <RotateCcw size={12} />
                        Restore
                      </button>
                    )}
                  </div>

                  {isConfirming && (
                    <div
                      className="flex items-center gap-2 px-3 py-2 border-t border-zinc-200 dark:border-zinc-700 bg-amber-50 dark:bg-amber-900/20"
                      data-testid={`version-confirm-${v.id}`}
                    >
                      <AlertTriangle size={14} className="text-amber-600 flex-shrink-0" />
                      <span className="flex-1 text-xs text-amber-800 dark:text-amber-200">
                        This will overwrite the current doc. Restore?
                      </span>
                      <button
                        type="button"
                        onClick={handleCancelConfirm}
                        className="text-xs px-2 py-1 rounded text-text-secondary hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        disabled={isRestoring}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => handleConfirmRestore(v)}
                        className="text-xs px-2.5 py-1 rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-60"
                        disabled={isRestoring}
                      >
                        {isRestoring ? 'Restoring…' : 'Confirm'}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
            {hasMore && (
              <li>
                <button
                  type="button"
                  onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                  className="w-full text-xs text-primary hover:underline py-2"
                  data-testid="version-show-more"
                >
                  Show more ({versions.length - visibleCount} hidden)
                </button>
              </li>
            )}
          </ul>
        )}
      </div>
    </Modal>
  );
}
