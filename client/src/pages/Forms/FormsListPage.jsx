import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FileSpreadsheet, Plus, Search, Loader2, Trash2, ExternalLink, Globe2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { listForms, createForm, deleteForm } from '../../services/formsService';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../components/common/Toast';
import EmptyState from '../../components/common/EmptyState';
import safeLog from '../../utils/safeLog';
import { getErrorMessage } from '../../utils/errorMap';

/**
 * FormsListPage — workspace-scoped (or all-workspaces) form library.
 *
 * Routes:
 *   /forms                              → every form the caller can see
 *   /workspaces/:workspaceId/forms      → future workspace-scoped variant
 *
 * Mirrors WorkflowsListPage's layout — header + search + grid of cards.
 * Creating a form POSTs a minimal draft (just name + workspace) and routes
 * straight into the builder.
 */

export default function FormsListPage() {
  const [searchParams] = useSearchParams();
  const workspaceId = searchParams.get('workspaceId') || null;

  const navigate = useNavigate();
  const { user } = useAuth();
  const toast = useToast();

  const [forms, setForms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  // Workspaces fetched lazily so "+ New form" can auto-pick when no
  // ?workspaceId= is in the URL (the sidebar "Forms" link routes here
  // without one). Without this, create couldn't proceed at all.
  const [workspaces, setWorkspaces] = useState([]);

  useEffect(() => {
    let cancelled = false;
    api.get('/workspaces').then((res) => {
      if (cancelled) return;
      const list = res.data?.data?.workspaces || res.data?.workspaces || res.data?.data || res.data || [];
      setWorkspaces(Array.isArray(list) ? list : []);
    }).catch((err) => safeLog.warn('[FormsListPage] workspaces load failed', err));
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { forms: list } = await listForms(workspaceId || undefined);
      setForms(Array.isArray(list) ? list : []);
    } catch (err) {
      safeLog.error('[FormsListPage] load error', err);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  async function handleCreate() {
    if (creating) return;
    // Resolve a workspaceId: URL wins; otherwise auto-pick the caller's
    // first visible workspace. The server requires workspaceId on create
    // — without this, the click did nothing useful (toast saying "open a
    // workspace" with no way to act on it).
    const targetWorkspaceId = workspaceId || workspaces[0]?.id;
    if (!targetWorkspaceId) {
      toast.error('You need at least one workspace before you can create a form.');
      return;
    }
    setCreating(true);
    try {
      const { form } = await createForm({ workspaceId: targetWorkspaceId, name: 'Untitled form' });
      navigate(`/forms/${form.id}`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(form) {
    if (!window.confirm(`Delete form "${form.name}"? All ${form.submissionCount || 0} submission(s) will be removed.`)) return;
    try {
      await deleteForm(form.id);
      toast.success('Form deleted');
      load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  const filtered = forms.filter((f) => {
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    return (f.name || '').toLowerCase().includes(q)
      || (f.description || '').toLowerCase().includes(q);
  });

  return (
    <div className="p-6 max-w-[1200px] mx-auto">
      <header className="flex items-center gap-3 mb-5">
        <span
          className="w-9 h-9 rounded-md inline-flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: 'rgba(14, 165, 233, 0.15)', color: '#0ea5e9' }}
        >
          <FileSpreadsheet size={16} />
        </span>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-text-primary">Forms</h1>
          <p className="text-xs text-text-secondary">
            Public &amp; internal data-collection forms scoped to your workspaces.
          </p>
        </div>
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-primary text-white hover:bg-primary-600 disabled:opacity-60"
        >
          {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
          New form
        </button>
      </header>

      <div className="relative max-w-md mb-4">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search forms"
          className="pl-8 pr-3 py-1.5 w-full text-sm border border-border rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary"
        />
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-32 bg-surface-100 rounded-md animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <EmptyState
          title="Couldn't load forms"
          description={error}
          primaryAction={{ label: 'Retry', onClick: load }}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<FileSpreadsheet size={48} className="text-text-tertiary" />}
          title={query ? 'No matching forms' : 'No forms yet'}
          description={
            query
              ? 'Try a different search term.'
              : 'Forms collect submissions from teammates or the public — great for requests, feedback, and intake.'
          }
          primaryAction={!query && (workspaceId || workspaces[0]?.id) ? { label: '+ New form', onClick: handleCreate } : undefined}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((form) => (
            <FormCard
              key={form.id}
              form={form}
              onOpen={() => navigate(`/forms/${form.id}`)}
              onDelete={() => handleDelete(form)}
              canDelete={user?.isSuperAdmin || user?.role === 'admin' || user?.role === 'manager' || form.createdBy === user?.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FormCard({ form, onOpen, onDelete, canDelete }) {
  const updatedRel = form.updatedAt
    ? formatDistanceToNow(new Date(form.updatedAt), { addSuffix: true })
    : '';
  return (
    <div
      className="group relative p-4 rounded-md bg-surface border border-border-light hover:border-primary hover:shadow-sm transition-all cursor-pointer"
      onClick={onOpen}
    >
      <div className="flex items-start gap-2.5">
        <span
          className="w-8 h-8 rounded inline-flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: 'rgba(14, 165, 233, 0.15)', color: '#0ea5e9' }}
        >
          <FileSpreadsheet size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <h3 className="text-sm font-semibold text-text-primary truncate">{form.name}</h3>
            {form.isPublic && (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200"
                title="Public form — anyone with the link can submit"
              >
                <Globe2 size={9} /> Public
              </span>
            )}
            {!form.isActive && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 border border-gray-200">
                Inactive
              </span>
            )}
          </div>
          {form.description && (
            <p className="text-xs text-text-secondary mt-1 line-clamp-2">{form.description}</p>
          )}
          <div className="flex items-center gap-2 mt-2 text-[11px] text-text-tertiary">
            <span>{form.submissionCount || 0} submission{(form.submissionCount || 0) === 1 ? '' : 's'}</span>
            {updatedRel && <><span>·</span><span>Updated {updatedRel}</span></>}
          </div>
        </div>
      </div>

      {/* Hover actions */}
      <div className="absolute right-2 top-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {form.isPublic && (
          <a
            href={`/f/${form.slug}`}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => e.stopPropagation()}
            title="Open public form"
            className="p-1.5 rounded text-text-tertiary hover:text-primary hover:bg-surface-100"
          >
            <ExternalLink size={12} />
          </a>
        )}
        {canDelete && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            title="Delete form"
            className="p-1.5 rounded text-text-tertiary hover:text-red-600 hover:bg-red-50"
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
