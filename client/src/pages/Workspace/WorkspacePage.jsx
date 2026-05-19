import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Star, StarOff, Plus, Share2, MoreHorizontal, LayoutGrid, FileText, BarChart3, Search, ChevronRight } from 'lucide-react';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import safeLog from '../../utils/safeLog';
import { getErrorMessage } from '../../utils/errorMap';
import Tabs from '../../components/common/Tabs';
import LetterAvatar from '../../components/common/LetterAvatar';
import EmptyState from '../../components/common/EmptyState';
import StatusPill from '../../components/common/StatusPill';
import { useToast } from '../../components/common/Toast';
// May 2026 — replaces the old "Share" = copy-URL + "Invite" = navigate-to-users
// behavior with a single dialog that lists members and the user directory.
import WorkspaceShareModal from '../../components/workspace/WorkspaceShareModal';

/**
 * WorkspacePage — workspace landing surface (skill §7).
 *
 * Route: `/workspaces/:id`
 *
 * Three tabs:
 *   - Recents (default): recently-touched items inside the workspace.
 *   - Content: full content tree (boards / dashboards / docs / folders).
 *   - Permissions: tier × resource matrix (view-only for non-owners).
 *
 * The page also renders an editable name + description header and a right
 * cluster (Share / Invite / overflow). It does NOT replace the board page;
 * clicking a board still navigates to /boards/:id as before.
 */

// Iso illustration banner — sits above WorkspaceHeader and gives the landing
// page warmth (skill §7). Tints itself from the workspace color so each
// workspace feels distinct. Pure inline SVG; no external assets.
function WorkspaceBanner({ color = '#0073ea' }) {
  return (
    <div
      className="relative h-24 overflow-hidden"
      style={{ background: `linear-gradient(135deg, ${color}1f 0%, ${color}33 100%)` }}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 600 96"
        preserveAspectRatio="xMaxYMid slice"
        className="absolute inset-y-0 right-0 h-full opacity-90"
      >
        <defs>
          <linearGradient id="ws-card-a" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0.55" />
          </linearGradient>
          <linearGradient id="ws-card-b" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%"   stopColor={color} stopOpacity="0.75" />
            <stop offset="100%" stopColor={color} stopOpacity="0.4" />
          </linearGradient>
        </defs>
        {/* Iso back card */}
        <polygon points="430,18 540,18 580,38 470,38" fill="url(#ws-card-a)" stroke="#ffffff" strokeOpacity="0.6" />
        <polygon points="470,38 580,38 580,78 470,78" fill="#ffffff" fillOpacity="0.55" />
        <polygon points="430,18 470,38 470,78 430,58" fill={color} fillOpacity="0.18" />
        {/* Iso front card */}
        <polygon points="370,42 480,42 520,62 410,62" fill="url(#ws-card-b)" stroke="#ffffff" strokeOpacity="0.5" />
        <polygon points="410,62 520,62 520,90 410,90" fill={color} fillOpacity="0.35" />
        <polygon points="370,42 410,62 410,90 370,70" fill={color} fillOpacity="0.55" />
        {/* sparkle dots */}
        <circle cx="350" cy="22" r="2" fill="#ffcb00" />
        <circle cx="365" cy="60" r="1.5" fill="#ff158a" />
        <circle cx="555" cy="50" r="2" fill="#00c875" />
      </svg>
    </div>
  );
}

function WorkspaceHeader({ workspace, isOwner, onSave, onShare, onInvite }) {
  const [editingName, setEditingName] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [name, setName] = useState(workspace?.name || '');
  const [description, setDescription] = useState(workspace?.description || '');
  const toast = useToast();

  useEffect(() => {
    setName(workspace?.name || '');
    setDescription(workspace?.description || '');
  }, [workspace?.id, workspace?.name, workspace?.description]);

  async function commitName() {
    setEditingName(false);
    const trimmed = name.trim();
    if (!trimmed || trimmed === workspace?.name) {
      setName(workspace?.name || '');
      return;
    }
    try {
      await onSave({ name: trimmed });
      toast.success('Workspace renamed');
    } catch (err) {
      setName(workspace?.name || '');
      toast.error(getErrorMessage(err));
    }
  }

  async function commitDesc() {
    setEditingDesc(false);
    if (description === (workspace?.description || '')) return;
    try {
      await onSave({ description });
      toast.success('Description saved');
    } catch (err) {
      setDescription(workspace?.description || '');
      toast.error(getErrorMessage(err));
    }
  }

  return (
    <div
      className="flex items-start gap-4 px-6 pt-6 pb-4"
      style={{ borderBottom: '1px solid var(--layout-border-color, #e2e2e2)' }}
    >
      <LetterAvatar name={workspace?.name} size="xl" shape="square" />
      <div className="flex-1 min-w-0">
        {editingName ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitName(); }
              if (e.key === 'Escape') { setEditingName(false); setName(workspace?.name || ''); }
            }}
            className="text-2xl font-bold text-text-primary bg-transparent border-b-2 border-primary outline-none w-full"
          />
        ) : (
          <h1
            className={`text-2xl font-bold text-text-primary truncate ${isOwner ? 'cursor-pointer hover:bg-surface-50 rounded px-1 -ml-1' : ''}`}
            onClick={() => isOwner && setEditingName(true)}
            title={isOwner ? 'Click to rename' : workspace?.name}
          >
            {workspace?.name || 'Workspace'}
          </h1>
        )}
        {editingDesc ? (
          <textarea
            autoFocus
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={commitDesc}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitDesc(); }
              if (e.key === 'Escape') { setEditingDesc(false); setDescription(workspace?.description || ''); }
            }}
            rows={2}
            className="mt-2 w-full text-sm text-text-secondary bg-transparent border border-border rounded p-2 outline-none focus:border-primary"
            placeholder="Add a description"
          />
        ) : (
          <p
            className={`mt-1 text-sm text-text-secondary ${isOwner ? 'cursor-pointer hover:bg-surface-50 rounded px-1 -ml-1' : ''}`}
            onClick={() => isOwner && setEditingDesc(true)}
          >
            {workspace?.description || (isOwner ? 'Add workspace description' : ' ')}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          type="button"
          onClick={onShare}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border border-border bg-surface text-text-secondary hover:border-primary-300 hover:text-primary"
        >
          <Share2 size={14} /> Share
        </button>
        <button
          type="button"
          onClick={onInvite}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-semibold bg-primary text-white hover:bg-primary-600"
        >
          <Plus size={14} /> Invite
        </button>
        <button
          type="button"
          className="p-1.5 rounded-md text-text-secondary hover:bg-surface-100"
          aria-label="More options"
        >
          <MoreHorizontal size={16} />
        </button>
      </div>
    </div>
  );
}

function RecentsTab({ workspace }) {
  const navigate = useNavigate();
  const boards = (workspace?.boards || []).slice(0, 20);

  if (boards.length === 0) {
    return (
      <EmptyState
        icon={<LayoutGrid size={48} className="text-text-tertiary" />}
        title="No recent activity"
        description="Boards, docs, and dashboards you open will show up here."
      />
    );
  }

  return (
    <div className="space-y-1">
      {boards.map((board) => (
        <button
          key={board.id}
          type="button"
          onClick={() => navigate(`/boards/${board.id}`)}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-left transition-colors hover:bg-surface-100 hover:ring-2 hover:ring-primary-200"
        >
          <span
            className="w-8 h-8 rounded-md flex-shrink-0 inline-flex items-center justify-center"
            style={{ backgroundColor: (board.color || '#0073ea') + '20', color: board.color || '#0073ea' }}
          >
            <LayoutGrid size={14} />
          </span>
          <span className="flex-1 min-w-0">
            <span className="block font-semibold text-text-primary truncate">{board.name}</span>
            <span className="block text-xs text-text-tertiary">Board</span>
          </span>
          <Star size={14} className="text-text-tertiary flex-shrink-0" />
        </button>
      ))}
    </div>
  );
}

function ContentTab({ workspace, query }) {
  const navigate = useNavigate();
  const boards = useMemo(() => {
    const all = workspace?.boards || [];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((b) => (b.name || '').toLowerCase().includes(q));
  }, [workspace?.boards, query]);

  if (boards.length === 0) {
    return (
      <EmptyState
        icon={<FileText size={48} className="text-text-tertiary" />}
        title={query ? 'No matches' : 'No content yet'}
        description={query ? 'Try a different search term.' : 'Use the "+" menu in the sidebar to add a board, doc, or dashboard.'}
      />
    );
  }

  return (
    <div className="rounded-md border border-border-light overflow-hidden">
      {boards.map((board, i) => (
        <button
          key={board.id}
          type="button"
          onClick={() => navigate(`/boards/${board.id}`)}
          className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-surface-50 ${
            i > 0 ? 'border-t border-border-light' : ''
          }`}
        >
          <span
            className="w-7 h-7 rounded-md flex-shrink-0 inline-flex items-center justify-center"
            style={{ backgroundColor: (board.color || '#0073ea') + '20', color: board.color || '#0073ea' }}
          >
            <LayoutGrid size={13} />
          </span>
          <span className="flex-1 min-w-0">
            <span className="block font-medium text-text-primary truncate">{board.name}</span>
          </span>
          <ChevronRight size={14} className="text-text-tertiary flex-shrink-0" />
        </button>
      ))}
    </div>
  );
}

function PermissionsTab({ workspace, isOwner }) {
  const members = workspace?.workspaceMembers || [];

  return (
    <div>
      <div className="mb-4 p-3 rounded-md bg-blue-50 dark:bg-blue-900/20 text-sm text-blue-700 dark:text-blue-300">
        {isOwner
          ? 'You can manage who has access to this workspace and what they can do.'
          : 'You can view current access. Only the workspace owner can change permissions.'}
      </div>

      {members.length === 0 ? (
        <EmptyState
          title="No members yet"
          description="Use the Invite button to add people to this workspace."
        />
      ) : (
        <div className="rounded-md border border-border-light overflow-hidden">
          <div className="grid grid-cols-[1fr,160px,160px] px-3 py-2 text-[10px] uppercase tracking-wide font-semibold text-text-tertiary bg-surface-50 border-b border-border-light">
            <span>Member</span>
            <span>Role</span>
            <span>Joined</span>
          </div>
          {members.map((m, i) => (
            <div
              key={m.id}
              className={`grid grid-cols-[1fr,160px,160px] items-center px-3 py-2.5 ${
                i > 0 ? 'border-t border-border-light' : ''
              }`}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <LetterAvatar name={m.name} size="sm" shape="circle" />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-text-primary truncate">{m.name}</div>
                  <div className="text-xs text-text-tertiary truncate">{m.email}</div>
                </div>
              </div>
              <div>
                <StatusPill
                  color={m.workspaceMember?.role === 'owner' ? 'purple' : m.workspaceMember?.role === 'collaborator' ? 'gray' : 'blue'}
                  label={m.workspaceMember?.role === 'owner' ? 'Owner' : m.workspaceMember?.role === 'collaborator' ? 'Collaborator' : 'Member'}
                  variant="outlined"
                  size="compact"
                />
              </div>
              <div className="text-xs text-text-tertiary">
                {m.workspaceMember?.createdAt ? new Date(m.workspaceMember.createdAt).toLocaleDateString() : ' '}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function WorkspacePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user, isSuperAdmin } = useAuth();
  const toast = useToast();
  const [workspace, setWorkspace] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('recents');
  const [contentQuery, setContentQuery] = useState('');
  // May 2026 — the Share / Invite buttons both open WorkspaceShareModal.
  // Older copy-link-only flow lives behind the modal's "Copy" affordance.
  const [shareOpen, setShareOpen] = useState(false);
  const aliveRef = useRef(true);

  useEffect(() => () => { aliveRef.current = false; }, []);

  useEffect(() => {
    if (!id) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    api.get(`/workspaces/${id}`)
      .then((res) => {
        if (cancelled) return;
        const data = res.data?.data?.workspace || res.data?.workspace || res.data?.data || res.data;
        setWorkspace(data);
      })
      .catch((err) => {
        if (cancelled) return;
        safeLog.error('[WorkspacePage] load error', err);
        setError(getErrorMessage(err));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  const isOwner = useMemo(() => {
    if (!workspace || !user) return false;
    if (isSuperAdmin) return true;
    if (workspace.createdBy === user.id) return true;
    if (workspace.creator?.id === user.id) return true;
    const mem = workspace.workspaceMembers?.find((m) => m.id === user.id);
    return mem?.workspaceMember?.role === 'owner';
  }, [workspace, user, isSuperAdmin]);

  async function handleSaveWorkspace(patch) {
    const res = await api.put(`/workspaces/${id}`, patch);
    const updated = res.data?.data?.workspace || res.data?.workspace || res.data?.data || res.data;
    setWorkspace((prev) => ({ ...prev, ...updated }));
    return updated;
  }

  function handleShare() {
    setShareOpen(true);
  }

  function handleInvite() {
    if (!isOwner) {
      toast.info('Only workspace owners can invite members.');
      return;
    }
    setShareOpen(true);
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="h-12 w-64 bg-surface-100 rounded-md animate-pulse mb-3" />
        <div className="h-5 w-96 bg-surface-100 rounded-md animate-pulse mb-6" />
        <div className="grid grid-cols-1 gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-12 bg-surface-100 rounded-md animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !workspace) {
    return (
      <div className="p-6">
        <EmptyState
          title="Couldn't load this workspace"
          description={error || 'The workspace may have been deleted or you may not have access.'}
          primaryAction={{ label: 'Back to boards', onClick: () => navigate('/boards') }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <WorkspaceBanner color={workspace.color} />
      <WorkspaceHeader
        workspace={workspace}
        isOwner={isOwner}
        onSave={handleSaveWorkspace}
        onShare={handleShare}
        onInvite={handleInvite}
      />

      <div
        className="flex items-center gap-2 px-6 pt-3"
        style={{ borderBottom: '1px solid var(--layout-border-color, #e2e2e2)' }}
      >
        <Tabs.List ariaLabel="Workspace sections">
          <Tabs.Tab id="recents" active={tab === 'recents'} onSelect={setTab}>Recents</Tabs.Tab>
          <Tabs.Tab id="content" active={tab === 'content'} onSelect={setTab}>Content</Tabs.Tab>
          <Tabs.Tab id="permissions" active={tab === 'permissions'} onSelect={setTab}>Permissions</Tabs.Tab>
        </Tabs.List>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {tab === 'recents' && <RecentsTab workspace={workspace} />}
        {tab === 'content' && (
          <>
            <div className="relative max-w-md mb-4">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
              <input
                type="text"
                value={contentQuery}
                onChange={(e) => setContentQuery(e.target.value)}
                placeholder="Search workspace content"
                className="pl-8 pr-3 py-1.5 w-full text-sm border border-border rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary"
              />
            </div>
            <ContentTab workspace={workspace} query={contentQuery} />
          </>
        )}
        {tab === 'permissions' && <PermissionsTab workspace={workspace} isOwner={isOwner} />}
      </div>

      <WorkspaceShareModal
        isOpen={shareOpen}
        onClose={() => setShareOpen(false)}
        workspace={workspace}
        isOwner={isOwner}
        onChanged={(updated) => {
          // The server returns the canonical workspace on add/remove; if it
          // didn't, refetch to keep the member list authoritative.
          if (updated) {
            setWorkspace((prev) => ({ ...prev, ...updated }));
          } else {
            api.get(`/workspaces/${id}`)
              .then((res) => {
                const data = res.data?.data?.workspace || res.data?.workspace || res.data?.data || res.data;
                if (data) setWorkspace(data);
              })
              .catch((err) => safeLog.warn('[WorkspacePage] refetch after share failed', err));
          }
        }}
      />
    </div>
  );
}
