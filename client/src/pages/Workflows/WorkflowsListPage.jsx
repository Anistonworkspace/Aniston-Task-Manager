import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Workflow, Plus, Search, Loader2, MoreHorizontal, Trash2,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import {
  listWorkflows, createWorkflow as createWorkflowApi,
  deleteWorkflow as deleteWorkflowApi,
} from '../../services/workflowsService';
import api from '../../services/api';
import safeLog from '../../utils/safeLog';
import { getErrorMessage } from '../../utils/errorMap';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../components/common/Toast';
import LetterAvatar from '../../components/common/LetterAvatar';
import EmptyState from '../../components/common/EmptyState';

/**
 * WorkflowsListPage — workspace-scoped (or all-workspaces) workflow library.
 *
 * Routes:
 *   /workflows                       → all workflows the caller can see
 *   /workspaces/:workspaceId/workflows (future) → workspace-scoped variant
 *
 * Mirrors DocsListPage's header + search + create-row layout. Each row shows
 * the workflow name, an Active / Draft pill, the last-run status when
 * present, the creator, and a relative "last edited" timestamp.
 *
 * Create flow: "+ New workflow" POSTs an empty-named draft, then navigates
 * straight into the canvas — the canvas owns the rename UX.
 */

export default function WorkflowsListPage() {
  // workspaceId can come from the path (future workspace-scoped variant) or
  // ?workspaceId=… (the current global /workflows route). Both are optional;
  // when absent, the server returns every workflow the caller can see.
  const params = useParams();
  const [searchParams] = useSearchParams();
  const workspaceId = params.workspaceId || searchParams.get('workspaceId') || null;

  const navigate = useNavigate();
  const { user } = useAuth();
  const toast = useToast();

  const [workflows, setWorkflows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  // Workspaces the caller can see — fetched lazily so the "+ New workflow"
  // button can auto-pick one when the URL is the global /workflows path
  // (no ?workspaceId=…). Without this, the create POST would 400 on the
  // server-side "workspaceId is required" guard.
  const [workspaces, setWorkspaces] = useState([]);

  useEffect(() => {
    let cancelled = false;
    api.get('/workspaces').then((res) => {
      if (cancelled) return;
      const list = res.data?.data?.workspaces || res.data?.workspaces || res.data?.data || res.data || [];
      setWorkspaces(Array.isArray(list) ? list : []);
    }).catch((err) => safeLog.warn('[WorkflowsListPage] workspaces load failed', err));
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { workflows: list } = await listWorkflows(workspaceId || undefined);
      setWorkflows(Array.isArray(list) ? list : []);
    } catch (err) {
      safeLog.error('[WorkflowsListPage] load error', err);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  async function handleCreate() {
    if (creating) return;
    // Resolve a workspaceId: URL takes priority; otherwise auto-pick the
    // caller's first visible workspace. The server requires workspaceId on
    // create (workflows are workspace-scoped), so sending `undefined` would
    // 400 — which is what the user was seeing on the global /workflows view.
    const targetWorkspaceId = workspaceId || workspaces[0]?.id;
    if (!targetWorkspaceId) {
      toast.error('You need at least one workspace before you can create a workflow.');
      return;
    }
    setCreating(true);
    try {
      const { workflow } = await createWorkflowApi({
        workspaceId: targetWorkspaceId,
        name: 'Untitled workflow',
      });
      navigate(`/workflows/${workflow.id}`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(wf, e) {
    e?.stopPropagation();
    const ok = window.confirm(`Delete "${wf.name || 'Untitled workflow'}"? This cannot be undone.`);
    if (!ok) return;
    try {
      await deleteWorkflowApi(wf.id);
      toast.success('Workflow deleted');
      setWorkflows((prev) => prev.filter((w) => w.id !== wf.id));
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  // Client-side search — small N (workflows per workspace are dozens, not
  // thousands), so we don't need server-side ?q. If this list ever grows,
  // mirror docsService.listWorkspaceDocs and push it server-side.
  const filteredWorkflows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return workflows;
    return workflows.filter((w) => (w.name || '').toLowerCase().includes(q));
  }, [workflows, query]);

  return (
    <div className="flex flex-col h-full">
      <header
        className="px-6 pt-6 pb-4"
        style={{ borderBottom: '1px solid var(--layout-border-color, #e2e2e2)' }}
      >
        <div className="flex items-center gap-3">
          <span
            className="w-9 h-9 rounded-md inline-flex items-center justify-center"
            style={{ backgroundColor: 'rgba(168, 85, 247, 0.15)', color: '#a855f7' }}
          >
            <Workflow size={18} />
          </span>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold text-text-primary">Workflows</h1>
            <p className="text-xs text-text-tertiary">
              Automate work with triggers and actions. Drop a trigger on the canvas,
              connect actions, and publish.
            </p>
          </div>
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-primary text-white text-sm font-semibold hover:bg-primary-600 disabled:opacity-60 disabled:cursor-wait min-w-[140px] justify-center transition-colors"
          >
            {creating ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Creating…
              </>
            ) : (
              <>
                <Plus size={14} /> New workflow
              </>
            )}
          </button>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <div className="relative flex-1 max-w-md">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search workflows by name"
              className="w-full pl-8 pr-3 py-1.5 text-sm border border-border rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary"
            />
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-6">
        {error && (
          <div className="mb-3 p-3 rounded-md bg-red-50 text-sm text-red-700">{error}</div>
        )}

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-14 rounded-md animate-pulse"
                style={{ backgroundColor: 'var(--surface-100, #f0f2f5)' }}
              />
            ))}
          </div>
        ) : filteredWorkflows.length === 0 ? (
          <EmptyState
            icon={<Workflow size={48} className="text-text-tertiary" />}
            title={query ? 'No workflows match' : 'No workflows yet'}
            description={query
              ? 'Try a different search.'
              : 'Create your first workflow to automate notifications, status changes, or task assignments.'}
            primaryAction={!query ? { label: '+ Create workflow', onClick: handleCreate } : undefined}
          />
        ) : (
          <ul className="space-y-1 rounded-md border border-border-light overflow-hidden">
            {filteredWorkflows.map((wf, i) => (
              <li key={wf.id}>
                <WorkflowRow
                  wf={wf}
                  onOpen={() => navigate(`/workflows/${wf.id}`)}
                  onDelete={(e) => handleDelete(wf, e)}
                  canDelete={user?.id === wf.createdBy || user?.role === 'admin' || user?.isSuperAdmin}
                  isFirst={i === 0}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatusPill({ isActive }) {
  if (isActive) {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-emerald-100 text-emerald-700"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" /> Active
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-zinc-200 text-zinc-700">
      <span className="w-1.5 h-1.5 rounded-full bg-zinc-500" /> Draft
    </span>
  );
}

function LastRunBadge({ status }) {
  if (!status) return <span className="text-xs text-text-tertiary">—</span>;
  const map = {
    success: { label: 'Succeeded', cls: 'text-emerald-700' },
    failed:  { label: 'Failed',    cls: 'text-red-700' },
    running: { label: 'Running',   cls: 'text-blue-700' },
    pending: { label: 'Pending',   cls: 'text-amber-700' },
  };
  const entry = map[status] || { label: status, cls: 'text-text-secondary' };
  return <span className={`text-xs font-medium ${entry.cls}`}>{entry.label}</span>;
}

function WorkflowRow({ wf, onOpen, onDelete, canDelete, isFirst }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`w-full grid items-center px-3 py-2.5 hover:bg-surface-50 transition-colors text-left ${
        isFirst ? '' : 'border-t border-border-light'
      }`}
      style={{ gridTemplateColumns: '32px 1fr 90px 110px 200px 160px 50px' }}
    >
      <span
        className="w-7 h-7 rounded-md inline-flex items-center justify-center flex-shrink-0"
        style={{ backgroundColor: 'rgba(168, 85, 247, 0.15)', color: '#a855f7' }}
      >
        <Workflow size={13} />
      </span>
      <div className="min-w-0 pr-3">
        <div className="text-sm font-semibold text-text-primary truncate">
          {wf.name || 'Untitled workflow'}
        </div>
        {wf.description && (
          <div className="text-xs text-text-tertiary truncate">{wf.description}</div>
        )}
      </div>
      <div>
        <StatusPill isActive={!!wf.isActive} />
      </div>
      <div>
        <LastRunBadge status={wf.lastRunStatus} />
      </div>
      <div className="flex items-center gap-1.5 min-w-0">
        {wf.creator ? (
          <>
            <LetterAvatar name={wf.creator.name} size="xs" shape="circle" />
            <span className="text-xs text-text-secondary truncate">{wf.creator.name}</span>
          </>
        ) : null}
      </div>
      <div className="text-xs text-text-tertiary">
        {wf.updatedAt
          ? formatDistanceToNow(new Date(wf.updatedAt), { addSuffix: true })
          : '—'}
      </div>
      <div className="justify-self-end flex items-center gap-1">
        {canDelete && (
          <span
            role="button"
            aria-label="Delete"
            tabIndex={0}
            onClick={onDelete}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onDelete(e); }
            }}
            className="p-1 rounded text-text-tertiary hover:bg-surface-100 hover:text-red-600 cursor-pointer"
            title="Delete workflow"
          >
            <Trash2 size={12} />
          </span>
        )}
        <span
          aria-hidden
          className="p-1 rounded text-text-tertiary"
          title="More options coming soon"
        >
          <MoreHorizontal size={12} />
        </span>
      </div>
    </button>
  );
}
