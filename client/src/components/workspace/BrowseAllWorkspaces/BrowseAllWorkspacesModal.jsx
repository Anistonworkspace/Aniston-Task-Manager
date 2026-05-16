import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, FolderKanban, Clock, UserCheck, Users, UserPlus, Plus } from 'lucide-react';
import Modal from '../../common/Modal';
import LetterAvatar from '../../common/LetterAvatar';
import StatusPill from '../../common/StatusPill';
import EmptyState from '../../common/EmptyState';
import api from '../../../services/api';
import safeLog from '../../../utils/safeLog';
import { useAuth } from '../../../context/AuthContext';
import { getErrorMessage } from '../../../utils/errorMap';

/**
 * BrowseAllWorkspacesModal — full-page modal for exploring all workspaces
 * the user has access to (skill §8).
 *
 *   <BrowseAllWorkspacesModal
 *     isOpen={open}
 *     onClose={() => setOpen(false)}
 *     onCreateWorkspace={() => ...}
 *   />
 *
 * Layout:
 *   - Header: title + search + close
 *   - Body: left sub-sidebar (All / Recent / Owner / Member / Collaborator)
 *           + right 2-column workspace card grid
 *   - Card click → navigates to /workspaces/:id (the landing page)
 *
 * Data source is `/api/workspaces` (admin/manager) or `/api/workspaces/mine`
 * (members) — the server picks the right shape per tier already.
 */

const FILTERS = [
  { id: 'recent', label: 'Recent workspaces', icon: Clock },
  { id: 'all', label: 'All workspaces', icon: FolderKanban },
  { id: 'owner', label: 'Owner', icon: UserCheck, group: 'My workspaces' },
  { id: 'member', label: 'Member', icon: Users, group: 'My workspaces' },
  { id: 'collaborator', label: 'Collaborator', icon: UserPlus, group: 'My workspaces' },
];

const ROLE_LABEL = {
  owner: 'Owner',
  member: 'Member',
  collaborator: 'Collaborator',
};

const ROLE_COLOR = {
  owner: 'purple',
  member: 'blue',
  collaborator: 'gray',
};

// Recency for the "Recent workspaces" filter — uses localStorage usage memory
// written by the sidebar (`workspaceUsage`). Read-only here.
function readWorkspaceUsage() {
  try { return JSON.parse(localStorage.getItem('workspaceUsage') || '{}') || {}; }
  catch { return {}; }
}

function inferRole(ws, userId) {
  if (!ws || !userId) return 'member';
  if (ws.createdBy === userId || ws.creator?.id === userId) return 'owner';
  const member = ws.workspaceMembers?.find((m) => m.id === userId);
  if (member) {
    if (member.workspaceMember?.role === 'owner') return 'owner';
    if (member.workspaceMember?.role === 'collaborator') return 'collaborator';
    return 'member';
  }
  return 'member';
}

export default function BrowseAllWorkspacesModal({
  isOpen,
  onClose,
  onCreateWorkspace,
}) {
  const { user, canManage, isSuperAdmin } = useAuth();
  const navigate = useNavigate();

  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('recent');
  const [query, setQuery] = useState('');

  // Fetch on open. The server returns either `/workspaces` (all) for managers+
  // or `/workspaces/mine` for members, both shaped identically.
  useEffect(() => {
    if (!isOpen) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');

    const endpoint = (canManage || isSuperAdmin) ? '/workspaces' : '/workspaces/mine';
    api.get(endpoint)
      .then((res) => {
        if (cancelled) return;
        const data = res.data?.data?.workspaces || res.data?.workspaces || [];
        setWorkspaces(Array.isArray(data) ? data : []);
      })
      .catch((err) => {
        if (cancelled) return;
        safeLog.error('[BrowseAllWorkspaces] load error', err);
        setError(getErrorMessage(err));
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [isOpen, canManage, isSuperAdmin]);

  const usage = useMemo(() => (isOpen ? readWorkspaceUsage() : {}), [isOpen]);

  const filtered = useMemo(() => {
    const userId = user?.id;
    const annotated = workspaces.map((ws) => ({ ...ws, _role: inferRole(ws, userId) }));

    let list = annotated;
    if (filter === 'recent') {
      list = annotated
        .map((ws) => ({ ws, score: usage[ws.id]?.lastOpenedAt || 0 }))
        .sort((a, b) => b.score - a.score)
        .map(({ ws }) => ws);
    } else if (filter === 'owner') {
      list = annotated.filter((ws) => ws._role === 'owner');
    } else if (filter === 'member') {
      list = annotated.filter((ws) => ws._role === 'member');
    } else if (filter === 'collaborator') {
      list = annotated.filter((ws) => ws._role === 'collaborator');
    }

    const q = query.trim().toLowerCase();
    if (q) list = list.filter((ws) => (ws.name || '').toLowerCase().includes(q));

    return list;
  }, [workspaces, filter, query, user?.id, usage]);

  const sectionTitle = useMemo(() => {
    if (filter === 'recent') return 'Recent workspaces';
    if (filter === 'all') return 'All workspaces';
    if (filter === 'owner') return 'Workspaces you own';
    if (filter === 'member') return 'Workspaces you belong to';
    if (filter === 'collaborator') return 'Workspaces you collaborate on';
    return 'Workspaces';
  }, [filter]);

  function handleCardClick(ws) {
    onClose?.();
    navigate(`/workspaces/${ws.id}`);
  }

  function handleClearFilters() {
    setFilter('all');
    setQuery('');
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Browse all workspaces"
      size="fullView"
    >
      <div className="flex h-full -mx-8 -my-6">
        {/* Sub-sidebar */}
        <aside
          className="w-56 flex-shrink-0 flex flex-col py-4"
          style={{
            borderRight: '1px solid var(--layout-border-color, #e2e2e2)',
            backgroundColor: 'var(--surface-50, #f8f9fb)',
          }}
        >
          <div className="px-2">
            {FILTERS.filter((f) => !f.group).map((f) => {
              const Icon = f.icon;
              const active = filter === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFilter(f.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-1.5 rounded-md text-sm transition-colors ${
                    active
                      ? 'bg-primary-50 text-primary font-semibold'
                      : 'text-text-secondary hover:bg-surface-100'
                  }`}
                >
                  <Icon size={14} />
                  <span>{f.label}</span>
                </button>
              );
            })}
          </div>

          <div className="px-3 pt-4 pb-1 text-[10px] uppercase tracking-wide font-semibold text-text-tertiary">
            My workspaces
          </div>
          <div className="px-2">
            {FILTERS.filter((f) => f.group === 'My workspaces').map((f) => {
              const Icon = f.icon;
              const active = filter === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFilter(f.id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-1.5 rounded-md text-sm transition-colors ${
                    active
                      ? 'bg-primary-50 text-primary font-semibold'
                      : 'text-text-secondary hover:bg-surface-100'
                  }`}
                >
                  <Icon size={14} />
                  <span>{f.label}</span>
                </button>
              );
            })}
          </div>

          {(canManage || isSuperAdmin) && onCreateWorkspace && (
            <div className="mt-auto px-3 pb-2">
              <button
                type="button"
                onClick={() => { onClose?.(); onCreateWorkspace?.(); }}
                className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-primary text-white text-sm font-semibold hover:bg-primary-600 transition-colors"
              >
                <Plus size={14} /> Create workspace
              </button>
            </div>
          )}
        </aside>

        {/* Content */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex items-center gap-3 px-6 pt-4 pb-3">
            <h3 className="text-base font-semibold text-text-primary">{sectionTitle}</h3>
            <span className="text-sm text-text-tertiary">
              {loading ? '' : `${filtered.length} ${filtered.length === 1 ? 'workspace' : 'workspaces'}`}
            </span>
            <div className="ml-auto relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search workspaces"
                className="pl-8 pr-3 py-1.5 w-64 text-sm border border-border rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary"
              />
            </div>
          </div>

          <div className="flex-1 overflow-auto px-6 pb-6">
            {error && (
              <div className="my-4 p-3 rounded-md bg-red-50 text-red-700 text-sm">
                {error}
              </div>
            )}

            {loading ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-16 rounded-md animate-pulse"
                    style={{ backgroundColor: 'var(--surface-100, #f0f2f5)' }}
                  />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={<FolderKanban size={48} className="text-text-tertiary" />}
                title="No workspaces match your filter"
                description="Try clearing your filters or creating a new workspace."
                primaryAction={query || filter !== 'all' ? { label: 'Clear filters', onClick: handleClearFilters } : undefined}
                secondaryAction={onCreateWorkspace ? { label: '+ Create workspace', onClick: () => { onClose?.(); onCreateWorkspace?.(); } } : undefined}
              />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {filtered.map((ws) => (
                  <button
                    key={ws.id}
                    type="button"
                    onClick={() => handleCardClick(ws)}
                    className="flex items-center gap-3 p-3 rounded-md text-left transition-colors border bg-surface hover:bg-surface-50 hover:border-primary-300"
                    style={{ borderColor: 'var(--layout-border-color, #e2e2e2)' }}
                  >
                    <LetterAvatar
                      name={ws.name}
                      color={ws.color ? undefined : undefined}
                      size="lg"
                      shape="square"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-text-primary truncate">{ws.name}</div>
                      {ws.description && (
                        <div className="text-xs text-text-tertiary truncate">{ws.description}</div>
                      )}
                    </div>
                    <StatusPill
                      color={ROLE_COLOR[ws._role] || 'gray'}
                      label={ROLE_LABEL[ws._role] || 'Member'}
                      variant="outlined"
                      size="compact"
                    />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
