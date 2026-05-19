import React, { useEffect, useMemo, useState } from 'react';
import { Search, Check, Loader2, UserMinus, Copy, Link as LinkIcon, X } from 'lucide-react';
import Modal from '../common/Modal';
import LetterAvatar from '../common/LetterAvatar';
import api from '../../services/api';
import safeLog from '../../utils/safeLog';
import { getErrorMessage } from '../../utils/errorMap';
import { useToast } from '../common/Toast';

/**
 * WorkspaceShareModal — invite users to a workspace, manage existing
 * members, and copy a shareable workspace link.
 *
 * Wired from WorkspacePage's "Share" / "Invite" buttons (May 2026 fix).
 * Backend endpoints:
 *   GET    /api/auth/users               → directory for adding members
 *   POST   /api/workspaces/:id/members   → add one-or-many userIds
 *   DELETE /api/workspaces/:id/members/:userId → remove one
 *
 * Permissions are enforced server-side (workspaceMutate middleware).
 * The modal only renders the affordances that match the caller's
 * permissions (read-only mode when isOwner === false).
 *
 *   <WorkspaceShareModal
 *     isOpen={open}
 *     onClose={() => setOpen(false)}
 *     workspace={workspace}         // { id, name, workspaceMembers: [...] }
 *     isOwner={isOwner}             // gates add/remove affordances
 *     onChanged={(updatedWorkspace) => setWorkspace(updatedWorkspace)}
 *   />
 */
export default function WorkspaceShareModal({ isOpen, onClose, workspace, isOwner, onChanged }) {
  const toast = useToast();
  const [directory, setDirectory] = useState([]);
  const [loadingDir, setLoadingDir] = useState(false);
  const [search, setSearch] = useState('');
  const [busyUserId, setBusyUserId] = useState(null);
  const [error, setError] = useState('');
  const [memberCache, setMemberCache] = useState(workspace?.workspaceMembers || []);

  // Refresh the local member cache when the parent re-passes the workspace.
  useEffect(() => {
    setMemberCache(workspace?.workspaceMembers || []);
  }, [workspace?.id, workspace?.workspaceMembers]);

  // Lazy-load the user directory the first time the modal opens, then keep
  // the list around so re-opens are instant.
  useEffect(() => {
    if (!isOpen || directory.length > 0) return;
    setLoadingDir(true);
    api.get('/auth/users')
      .then((res) => {
        const list = res.data?.users || res.data?.data?.users || res.data?.data || res.data || [];
        setDirectory(Array.isArray(list) ? list : []);
      })
      .catch((err) => safeLog.warn('[WorkspaceShareModal] directory load failed', err))
      .finally(() => setLoadingDir(false));
  }, [isOpen, directory.length]);

  const memberIds = useMemo(
    () => new Set((memberCache || []).map((m) => m.id)),
    [memberCache]
  );

  const filteredDirectory = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return directory;
    return directory.filter((u) =>
      (u.name || '').toLowerCase().includes(q)
      || (u.email || '').toLowerCase().includes(q)
    );
  }, [directory, search]);

  async function addMember(userId) {
    if (!isOwner || !workspace?.id) return;
    setError('');
    setBusyUserId(userId);
    try {
      const res = await api.post(`/workspaces/${workspace.id}/members`, { userIds: [userId] });
      const updated = res.data?.workspace || res.data?.data?.workspace || null;
      const added = directory.find((u) => u.id === userId);
      // Optimistic local cache — append the new member if we know about them.
      if (added) {
        setMemberCache((prev) => [...prev, added]);
      }
      onChanged?.(updated);
      toast.success(`${added?.name || 'Member'} added to workspace`);
    } catch (err) {
      const msg = getErrorMessage(err);
      setError(msg);
      toast.error(msg);
    } finally {
      setBusyUserId(null);
    }
  }

  async function removeMember(userId) {
    if (!isOwner || !workspace?.id) return;
    setError('');
    setBusyUserId(userId);
    try {
      const res = await api.delete(`/workspaces/${workspace.id}/members/${userId}`);
      const updated = res.data?.workspace || res.data?.data?.workspace || null;
      setMemberCache((prev) => prev.filter((m) => m.id !== userId));
      onChanged?.(updated);
      toast.success('Member removed');
    } catch (err) {
      const msg = getErrorMessage(err);
      setError(msg);
      toast.error(msg);
    } finally {
      setBusyUserId(null);
    }
  }

  function copyLink() {
    const url = `${window.location.origin}/workspaces/${workspace?.id}`;
    if (!navigator.clipboard?.writeText) {
      toast.info(`Link: ${url}`);
      return;
    }
    navigator.clipboard.writeText(url).then(
      () => toast.success('Workspace link copied'),
      () => toast.error('Copy failed — try again')
    );
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Share "${workspace?.name || 'workspace'}"`}
      size="lg"
    >
      <div className="p-5 space-y-5">
        {/* Copy-link row — always available to whoever can see the
            workspace; visibility on the linked URL is still enforced
            server-side by the workspace's regular access rules. */}
        <div className="flex items-center gap-2 p-3 rounded-md border border-border bg-surface-50">
          <span className="w-9 h-9 rounded-md inline-flex items-center justify-center bg-primary-50 text-primary">
            <LinkIcon size={16} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-text-primary">Workspace link</div>
            <div className="text-xs text-text-tertiary truncate">
              {window.location.origin}/workspaces/{workspace?.id}
            </div>
          </div>
          <button
            type="button"
            onClick={copyLink}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-text-secondary border border-border bg-surface hover:border-primary-300 hover:text-primary transition-colors"
          >
            <Copy size={12} /> Copy
          </button>
        </div>

        {/* Existing members */}
        <section>
          <h3 className="text-xs uppercase tracking-wide font-semibold text-text-tertiary mb-2">
            Members ({memberCache.length})
          </h3>
          {memberCache.length === 0 ? (
            <div className="text-sm text-text-tertiary p-3 rounded-md bg-surface-50 border border-border-light">
              No members yet. {isOwner ? 'Add people from the list below.' : 'Ask the workspace owner to add you.'}
            </div>
          ) : (
            <ul className="rounded-md border border-border-light divide-y divide-border-light max-h-44 overflow-auto">
              {memberCache.map((m) => (
                <li key={m.id} className="flex items-center gap-3 px-3 py-2">
                  <LetterAvatar name={m.name} size="sm" shape="circle" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-text-primary truncate">{m.name}</div>
                    <div className="text-xs text-text-tertiary truncate">{m.email}</div>
                  </div>
                  {isOwner && workspace?.createdBy !== m.id && (
                    <button
                      type="button"
                      onClick={() => removeMember(m.id)}
                      disabled={busyUserId === m.id}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-red-500 hover:bg-red-50 border border-transparent hover:border-red-200 disabled:opacity-50"
                      title="Remove from workspace"
                    >
                      {busyUserId === m.id ? <Loader2 size={11} className="animate-spin" /> : <UserMinus size={11} />}
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Add members — owner-only */}
        {isOwner && (
          <section>
            <h3 className="text-xs uppercase tracking-wide font-semibold text-text-tertiary mb-2">
              Invite people
            </h3>
            <div className="relative mb-2">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or email"
                className="w-full pl-8 pr-8 py-1.5 text-sm border border-border rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary"
                  aria-label="Clear search"
                >
                  <X size={12} />
                </button>
              )}
            </div>

            {loadingDir ? (
              <div className="text-sm text-text-tertiary p-3 inline-flex items-center gap-2">
                <Loader2 size={12} className="animate-spin" /> Loading users…
              </div>
            ) : filteredDirectory.length === 0 ? (
              <div className="text-sm text-text-tertiary p-3 rounded-md bg-surface-50 border border-border-light">
                {search ? 'No users match.' : 'No users found.'}
              </div>
            ) : (
              <ul className="rounded-md border border-border-light divide-y divide-border-light max-h-60 overflow-auto">
                {filteredDirectory.map((u) => {
                  const isMember = memberIds.has(u.id);
                  return (
                    <li key={u.id} className="flex items-center gap-3 px-3 py-2">
                      <LetterAvatar name={u.name} size="sm" shape="circle" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-text-primary truncate">{u.name}</div>
                        <div className="text-xs text-text-tertiary truncate">{u.email}</div>
                      </div>
                      {isMember ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-600">
                          <Check size={11} /> Member
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => addMember(u.id)}
                          disabled={busyUserId === u.id}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold text-white bg-primary hover:bg-primary-600 disabled:opacity-60"
                        >
                          {busyUserId === u.id ? <Loader2 size={11} className="animate-spin" /> : null}
                          Add
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {error && (
          <div className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
