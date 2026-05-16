import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FileText, Plus, Search, Archive, RotateCcw, MoreHorizontal } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import {
  listWorkspaceDocs, createDoc as createDocApi,
  archiveDoc as archiveDocApi, restoreDoc as restoreDocApi,
} from '../../services/docsService';
import safeLog from '../../utils/safeLog';
import { getErrorMessage } from '../../utils/errorMap';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../components/common/Toast';
import LetterAvatar from '../../components/common/LetterAvatar';
import EmptyState from '../../components/common/EmptyState';

/**
 * DocsListPage — workspace-scoped doc library (Doc Editor Phase B).
 *
 * Route: `/workspaces/:workspaceId/docs`
 *
 * Renders every doc in the workspace the caller can see. Optimistic create
 * → navigate straight into the new DocPage. Search runs server-side via
 * the `q=` query param (which matches both title and contentText).
 */

export default function DocsListPage() {
  const { workspaceId } = useParams();
  const navigate = useNavigate();
  const { user, isSuperAdmin, canManage } = useAuth();
  const toast = useToast();

  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError('');
    try {
      const { docs: list } = await listWorkspaceDocs(workspaceId, {
        q: query || undefined,
        archived: includeArchived,
      });
      setDocs(Array.isArray(list) ? list : []);
    } catch (err) {
      safeLog.error('[DocsListPage] load error', err);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [workspaceId, query, includeArchived]);

  // Debounce search by 250ms so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => { load(); }, query ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, query]);

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    try {
      const { doc } = await createDocApi(workspaceId, { title: 'Untitled doc' });
      navigate(`/workspaces/${workspaceId}/docs/${doc.id}`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleArchive(doc, e) {
    e?.stopPropagation();
    try {
      await archiveDocApi(doc.id);
      toast.success('Doc archived');
      setDocs((prev) => prev.filter((d) => d.id !== doc.id));
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  async function handleRestore(doc, e) {
    e?.stopPropagation();
    try {
      await restoreDocApi(doc.id);
      toast.success('Doc restored');
      load();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  const activeDocs = useMemo(() => docs.filter((d) => includeArchived || !d.isArchived), [docs, includeArchived]);

  return (
    <div className="flex flex-col h-full">
      <header
        className="px-6 pt-6 pb-4"
        style={{ borderBottom: '1px solid var(--layout-border-color, #e2e2e2)' }}
      >
        <div className="flex items-center gap-3">
          <span
            className="w-9 h-9 rounded-md inline-flex items-center justify-center"
            style={{ backgroundColor: 'rgba(87, 155, 252, 0.15)', color: '#579bfc' }}
          >
            <FileText size={18} />
          </span>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold text-text-primary">Docs</h1>
            <p className="text-xs text-text-tertiary">Collaborative documents in this workspace.</p>
          </div>
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-primary text-white text-sm font-semibold hover:bg-primary-600 disabled:opacity-60"
          >
            <Plus size={14} /> New doc
          </button>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <div className="relative flex-1 max-w-md">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search docs by title or content"
              className="w-full pl-8 pr-3 py-1.5 text-sm border border-border rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary"
            />
          </div>
          <label className="inline-flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
            />
            Show archived
          </label>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-6">
        {error && (
          <div className="mb-3 p-3 rounded-md bg-red-50 text-sm text-red-700">{error}</div>
        )}

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-14 rounded-md animate-pulse" style={{ backgroundColor: 'var(--surface-100, #f0f2f5)' }} />
            ))}
          </div>
        ) : activeDocs.length === 0 ? (
          <EmptyState
            icon={<FileText size={48} className="text-text-tertiary" />}
            title={query ? 'No docs match' : 'No docs yet'}
            description={query
              ? 'Try a different search.'
              : 'Create your first doc to draft a spec, capture meeting notes, or decide together.'}
            primaryAction={!query ? { label: '+ Create doc', onClick: handleCreate } : undefined}
          />
        ) : (
          <ul className="space-y-1 rounded-md border border-border-light overflow-hidden">
            {activeDocs.map((doc, i) => (
              <li key={doc.id}>
                <DocRow
                  doc={doc}
                  onOpen={() => navigate(`/workspaces/${workspaceId}/docs/${doc.id}`)}
                  onArchive={(e) => handleArchive(doc, e)}
                  onRestore={(e) => handleRestore(doc, e)}
                  canEdit={isSuperAdmin || canManage || doc.createdBy === user?.id}
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

function DocRow({ doc, onOpen, onArchive, onRestore, canEdit, isFirst }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`w-full grid items-center px-3 py-2.5 hover:bg-surface-50 transition-colors text-left ${
        isFirst ? '' : 'border-t border-border-light'
      } ${doc.isArchived ? 'opacity-60' : ''}`}
      style={{ gridTemplateColumns: '32px 1fr 200px 160px 90px' }}
    >
      <span
        className="w-7 h-7 rounded-md inline-flex items-center justify-center flex-shrink-0"
        style={{ backgroundColor: 'rgba(87, 155, 252, 0.15)', color: '#579bfc' }}
      >
        <FileText size={13} />
      </span>
      <div className="min-w-0 pr-3">
        <div className="text-sm font-semibold text-text-primary truncate">
          {doc.title || 'Untitled doc'}
          {doc.isArchived && <span className="ml-2 text-[10px] uppercase font-bold text-amber-600">Archived</span>}
        </div>
        {doc.contentText && (
          <div className="text-xs text-text-tertiary truncate">
            {doc.contentText.slice(0, 160)}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5 min-w-0">
        {doc.lastEditor ? (
          <>
            <LetterAvatar name={doc.lastEditor.name} size="xs" shape="circle" />
            <span className="text-xs text-text-secondary truncate">{doc.lastEditor.name}</span>
          </>
        ) : doc.creator ? (
          <>
            <LetterAvatar name={doc.creator.name} size="xs" shape="circle" />
            <span className="text-xs text-text-secondary truncate">{doc.creator.name}</span>
          </>
        ) : null}
      </div>
      <div className="text-xs text-text-tertiary">
        {doc.lastEditedAt
          ? formatDistanceToNow(new Date(doc.lastEditedAt), { addSuffix: true })
          : (doc.updatedAt ? formatDistanceToNow(new Date(doc.updatedAt), { addSuffix: true }) : '—')}
      </div>
      <div className="justify-self-end flex items-center gap-1">
        {canEdit && !doc.isArchived && (
          <span
            role="button"
            aria-label="Archive"
            tabIndex={0}
            onClick={onArchive}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onArchive(e); } }}
            className="p-1 rounded text-text-tertiary hover:bg-surface-100 hover:text-text-secondary cursor-pointer"
            title="Archive doc"
          >
            <Archive size={12} />
          </span>
        )}
        {canEdit && doc.isArchived && (
          <span
            role="button"
            aria-label="Restore"
            tabIndex={0}
            onClick={onRestore}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRestore(e); } }}
            className="p-1 rounded text-text-tertiary hover:bg-surface-100 hover:text-primary cursor-pointer"
            title="Restore doc"
          >
            <RotateCcw size={12} />
          </span>
        )}
      </div>
    </button>
  );
}
