import React, { useCallback, useEffect, useState } from 'react';
import { X, Users } from 'lucide-react';

import { listCollaborators, removeCollaborator } from '../../services/docsService';
import { useToast } from '../../components/common/Toast';
import { getErrorMessage } from '../../utils/errorMap';
import safeLog from '../../utils/safeLog';
import useRealtimeEvent from '../../realtime/useRealtimeEvent';

/**
 * DocSharedWithBar — slim "@name" chip row shown under the doc title.
 *
 * Surfaces everyone the doc is shared with as `@Name` mention-style chips
 * (the same visual language as in-body @mentions). The doc owner can
 * unshare a person inline via the × on each chip; viewers see the chips
 * read-only.
 *
 * Props:
 *   docId      — required.
 *   canEdit    — owner / super-admin → shows the inline unshare ×.
 *   reloadKey  — bump this (from the parent) to force a re-fetch after the
 *                Share panel mutates collaborators.
 *   onChanged  — called after a successful unshare so the parent can bump
 *                its own share version (keeps the Share panel + this bar in
 *                sync).
 *   onUnshare  — optional. When provided, unsharing a chip delegates to the
 *                parent (DocPage) so it can ALSO strip the person's @mention
 *                from the doc body — keeping the bar and the content in sync
 *                bidirectionally. Falls back to a plain removeCollaborator
 *                call when not provided.
 *
 * Self-hides when the doc has no collaborators — no empty-state noise on
 * private docs.
 */
export default function DocSharedWithBar({ docId, canEdit = false, reloadKey = 0, onChanged, onUnshare }) {
  const toast = useToast();
  const [collaborators, setCollaborators] = useState([]);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    if (!docId) return;
    try {
      const { collaborators: c } = await listCollaborators(docId);
      setCollaborators(Array.isArray(c) ? c : []);
    } catch (err) {
      // Non-fatal — the bar is a convenience surface; the Share panel is
      // the authoritative manager. Silently render nothing on failure.
      safeLog.warn('[DocSharedWithBar] load failed', err);
      setCollaborators([]);
    }
  }, [docId]);

  useEffect(() => { load(); }, [load, reloadKey]);

  // Live sync — when the collaborator set changes anywhere (a peer's @mention
  // edit, a share from another tab, an unshare), the server fans out
  // `doc:collaborators:changed` to everyone on the doc. Reload in place so
  // the @name chips appear/disappear without a manual refresh.
  useRealtimeEvent('doc:collaborators:changed', useCallback((payload) => {
    if (payload?.docId === docId) load();
  }, [docId, load]));

  const handleUnshare = useCallback(async (row) => {
    const userId = row.user?.id;
    if (!userId) return;
    setBusyId(userId);
    // Optimistic chip removal.
    setCollaborators((prev) => prev.filter((c) => c.user?.id !== userId));
    try {
      if (onUnshare) {
        // DocPage handles both the @mention removal from the body AND the
        // doc_access revoke so the two stay in sync.
        await onUnshare(row);
      } else {
        await removeCollaborator(docId, userId);
        toast?.success?.(`Removed ${row.user?.name || 'access'}`);
      }
      onChanged?.();
    } catch (err) {
      toast?.error?.(getErrorMessage(err));
      // Reload to undo the optimistic removal on failure.
      load();
    } finally {
      setBusyId(null);
    }
  }, [docId, toast, onChanged, onUnshare, load]);

  if (!collaborators.length) return null;

  return (
    <div className="mt-2 flex items-center flex-wrap gap-1.5 text-[12px]" data-testid="doc-shared-with-bar">
      <span className="inline-flex items-center gap-1 text-text-tertiary font-medium mr-0.5">
        <Users size={12} />
        Shared with
      </span>
      {collaborators.map((row) => {
        const name = row.user?.name || row.user?.email || 'user';
        const userId = row.user?.id;
        const levelLabel = row.accessLevel === 'edit'
          ? 'can edit'
          : row.accessLevel === 'comment' ? 'can comment' : 'can view';
        return (
          <span
            key={userId || row.id}
            className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-[#0073ea]/10 text-[#0073ea] font-medium max-w-[200px]"
            title={`@${name} · ${levelLabel}`}
          >
            <span className="truncate">@{name}</span>
            {canEdit && (
              <button
                type="button"
                onClick={() => handleUnshare(row)}
                disabled={busyId === userId}
                aria-label={`Unshare ${name}`}
                title={`Unshare ${name}`}
                className="flex-shrink-0 w-4 h-4 inline-flex items-center justify-center rounded-full hover:bg-[#0073ea]/20 disabled:opacity-50"
              >
                <X size={11} />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}
