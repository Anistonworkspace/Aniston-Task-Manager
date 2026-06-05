import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Plus, Search, Archive, Loader2, AtSign, Users, User as UserIcon, Inbox, Building2, ChevronDown, ChevronRight } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import {
  listMyDocs, createDoc as createDocApi,
  archiveDoc as archiveDocApi,
} from '../../services/docsService';
import safeLog from '../../utils/safeLog';
import { getErrorMessage } from '../../utils/errorMap';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../components/common/Toast';
import LetterAvatar from '../../components/common/LetterAvatar';
import EmptyState from '../../components/common/EmptyState';
// Phase 8 — listen for realtime access grants/revokes so /docs self-refreshes
// when someone shares a doc with us or removes our mention-derived access.
import useRealtimeEvent from '../../realtime/useRealtimeEvent';
// June 2026 — per-user department-collapse persistence, shared with the
// in-editor right side panel (DocsSidePanel) so collapse state stays in sync.
import { loadDeptCollapseState, saveDeptCollapseState } from './docsDeptCollapse';

// Phase 8 — filter chip definitions. Keys match the backend's `?filter=`
// query param. Icons are lucide-react; copy stays simple Notion-style.
const FILTERS = [
  { key: 'all',       label: 'All docs',      Icon: Inbox },
  { key: 'owned',     label: 'My docs',       Icon: UserIcon },
  { key: 'shared',    label: 'Shared with me', Icon: Users },
  { key: 'mentioned', label: 'Mentioned me',   Icon: AtSign },
];

// Bucket label for docs whose owner has no department set (Tier 1/2 view).
const NO_DEPT = 'No Department';

/**
 * DocsListPage — personal docs library.
 *
 * Route: `/docs`
 *
 * feat/docs-personal-notion Phase 2: backend is now personal-scoped
 * (GET /api/docs returns only docs the caller can see — owner + shared +
 * legacy-workspace backfill rows). No more workspace resolution; create
 * lands on POST /api/docs without a workspaceId.
 */

export default function DocsListPage() {
  const navigate = useNavigate();
  const { canManage, user } = useAuth();
  const toast = useToast();

  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  // Phase 8 — filter chip state. 'all' is the safe default; 'owned' /
  // 'shared' / 'mentioned' narrow the result set server-side.
  const [filter, setFilter] = useState('all');
  // June 2026 — Tier 1/2 see every doc grouped by the owner's department,
  // and can narrow to one department. 'all' shows every department.
  const [deptFilter, setDeptFilter] = useState('all');
  // Per-user collapse state for the department sections, hydrated from
  // localStorage so minimized departments stay minimized across refreshes.
  const [collapsedDepts, setCollapsedDepts] = useState(() => loadDeptCollapseState(user?.id));

  // Re-hydrate if the logged-in user changes (collapse state is per-user).
  useEffect(() => {
    setCollapsedDepts(loadDeptCollapseState(user?.id));
  }, [user?.id]);

  const toggleDept = useCallback((dept) => {
    setCollapsedDepts((prev) => {
      const next = { ...prev, [dept]: !prev[dept] };
      saveDeptCollapseState(user?.id, next);
      return next;
    });
  }, [user?.id]);

  // Distinct department list (Tier 1/2 only) derived from the loaded docs.
  const departments = useMemo(() => {
    const set = new Set();
    for (const d of docs) set.add(d.ownerDepartment || NO_DEPT);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [docs]);

  // Docs after applying the department filter (no-op for non-managers).
  const visibleDocs = useMemo(() => {
    if (!canManage || deptFilter === 'all') return docs;
    return docs.filter((d) => (d.ownerDepartment || NO_DEPT) === deptFilter);
  }, [docs, canManage, deptFilter]);

  // For Tier 1/2: docs grouped by department [ [deptName, docs[]], ... ].
  const groupedByDept = useMemo(() => {
    if (!canManage) return null;
    const map = new Map();
    for (const d of visibleDocs) {
      const key = d.ownerDepartment || NO_DEPT;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(d);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [visibleDocs, canManage]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // Archived docs are intentionally excluded — they live only in the
      // global Archive folder now (June 2026). The old inline "Show archived"
      // toggle was removed; restore/delete happen from /archive.
      const { docs: list } = await listMyDocs({
        q: query || undefined,
        filter: filter !== 'all' ? filter : undefined,
      });
      setDocs(Array.isArray(list) ? list : []);
    } catch (err) {
      safeLog.error('[DocsListPage] load error', err);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [query, filter]);

  // Debounce search by 250ms so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => { load(); }, query ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, query]);

  // Phase 8 — realtime self-refresh. When the user is granted or revoked
  // access in another tab / by another user's mention, the docs list
  // re-fetches in place. Cheap because the events are targeted (Phase 5
  // emitToUsers, so this only fires for events meant for THIS user).
  useRealtimeEvent('doc:access:granted', useCallback(() => { load(); }, [load]));
  useRealtimeEvent('doc:access:revoked', useCallback(() => { load(); }, [load]));

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    try {
      const { doc } = await createDocApi({ title: 'Untitled doc' });
      navigate(`/docs/${doc.id}`);
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
      toast.success('Doc archived — find it in Archive › Docs');
      setDocs((prev) => prev.filter((d) => d.id !== doc.id));
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

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
            <p className="text-xs text-text-tertiary">Your personal documents. Private by default — share via @mention or the Share panel.</p>
          </div>
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-primary text-white text-sm font-semibold hover:bg-primary-600 disabled:opacity-60 disabled:cursor-wait min-w-[110px] justify-center transition-colors"
          >
            {creating ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Creating…
              </>
            ) : (
              <>
                <Plus size={14} /> New doc
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
              placeholder="Search docs by title or content"
              className="w-full pl-8 pr-3 py-1.5 text-sm border border-border rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary"
            />
          </div>
          {/* June 2026 — department filter, Tier 1/2 only. Options derive
              from the owners of the docs currently loaded. */}
          {canManage && (
            <div className="relative">
              <Building2 size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
              <select
                value={deptFilter}
                onChange={(e) => setDeptFilter(e.target.value)}
                className="pl-8 pr-7 py-1.5 text-sm border border-border rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary appearance-none cursor-pointer"
                title="Filter by department"
              >
                <option value="all">All departments</option>
                {departments.map((dep) => (
                  <option key={dep} value={dep}>{dep}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Phase 8 — filter chip row. Sits below search so the filter
            applies on top of any query the user has typed. The 'all' chip
            is the safe default; backend narrows the result set when any
            other key is picked. */}
        <div className="mt-3 flex items-center gap-1.5 overflow-x-auto">
          {FILTERS.map(({ key, label, Icon }) => {
            const active = filter === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] font-medium transition-colors whitespace-nowrap border ${
                  active
                    ? 'bg-primary text-white border-primary'
                    : 'bg-surface text-text-secondary border-border hover:border-primary-300 hover:text-primary'
                }`}
                aria-pressed={active}
              >
                <Icon size={12} />
                {label}
              </button>
            );
          })}
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
        ) : visibleDocs.length === 0 ? (
          <EmptyState
            icon={<FileText size={48} className="text-text-tertiary" />}
            title={
              query ? 'No docs match'
                : (canManage && deptFilter !== 'all') ? `No docs in ${deptFilter}`
                : filter === 'shared' ? 'Nothing shared with you yet'
                : filter === 'mentioned' ? 'You haven\'t been @-mentioned yet'
                : filter === 'owned' ? 'You haven\'t created any docs yet'
                : 'No docs yet'
            }
            description={
              query ? 'Try a different search or filter.'
                : (canManage && deptFilter !== 'all') ? 'Try a different department or clear the filter.'
                : filter === 'shared' ? 'When someone shares a doc with you via the Share panel, it will show up here.'
                : filter === 'mentioned' ? 'When a teammate @-mentions you in a doc, you\'ll see it here.'
                : filter === 'owned' ? 'Create your first doc to draft a spec, capture meeting notes, or decide together.'
                : 'Create your first doc to draft a spec, capture meeting notes, or decide together.'
            }
            primaryAction={
              (!query && deptFilter === 'all' && (filter === 'all' || filter === 'owned'))
                ? { label: '+ Create doc', onClick: handleCreate }
                : undefined
            }
          />
        ) : canManage ? (
          // Tier 1/2 — docs grouped by the owner's department.
          <div className="space-y-5">
            {groupedByDept.map(([dept, deptDocs]) => {
              const collapsed = !!collapsedDepts[dept];
              return (
                <section key={dept}>
                  <button
                    type="button"
                    onClick={() => toggleDept(dept)}
                    aria-expanded={!collapsed}
                    className="flex items-center gap-2 mb-1.5 px-1 w-full text-left group"
                  >
                    {collapsed
                      ? <ChevronRight size={14} className="text-text-tertiary transition-colors group-hover:text-text-secondary" />
                      : <ChevronDown size={14} className="text-text-tertiary transition-colors group-hover:text-text-secondary" />}
                    <Building2 size={13} className="text-text-tertiary" />
                    <h2 className="text-xs font-bold uppercase tracking-wide text-text-secondary">{dept}</h2>
                    <span className="text-[11px] font-medium text-text-tertiary">{deptDocs.length}</span>
                  </button>
                  {!collapsed && (
                    <ul className="space-y-1 rounded-md border border-border-light overflow-hidden">
                      {deptDocs.map((doc, i) => (
                        <li key={doc.id}>
                          <DocRow
                            doc={doc}
                            onOpen={() => navigate(`/docs/${doc.id}`)}
                            onArchive={(e) => handleArchive(doc, e)}
                            canArchive={canManage}
                            isFirst={i === 0}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        ) : (
          <ul className="space-y-1 rounded-md border border-border-light overflow-hidden">
            {visibleDocs.map((doc, i) => (
              <li key={doc.id}>
                <DocRow
                  doc={doc}
                  onOpen={() => navigate(`/docs/${doc.id}`)}
                  onArchive={(e) => handleArchive(doc, e)}
                  // June 2026: Archive is a Tier 1/2 (canManage) action.
                  // Everyone else no longer sees the Archive affordance.
                  // Restore/permanent-delete live in the global Archive folder.
                  canArchive={canManage}
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

function DocRow({ doc, onOpen, onArchive, canArchive, isFirst }) {
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
          {/* Phase 8 — caller-relation badge. Server populates
              `callerRelation` so the UI can render a one-glance pill
              without extra round-trips. */}
          <RelationBadge relation={doc.callerRelation} />
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
        {canArchive && !doc.isArchived && (
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
      </div>
    </button>
  );
}

// Phase 8 — small pill in the doc row that surfaces the caller's
// relationship to this doc at a glance. Server populates `callerRelation`
// on every list response so this is a pure presentational lookup.
function RelationBadge({ relation }) {
  if (!relation || relation === 'owner') return null;
  const palette = {
    mentioned: { bg: 'rgba(157, 80, 221, 0.12)', fg: '#7c3aed', label: 'Mentioned' },
    shared:    { bg: 'rgba(0, 115, 234, 0.12)',  fg: '#0073ea', label: 'Shared' },
    legacy:    { bg: 'rgba(120, 120, 120, 0.12)', fg: '#6b7280', label: 'Legacy access' },
    super_admin: { bg: 'rgba(220, 38, 38, 0.10)', fg: '#dc2626', label: 'Super-admin view' },
    admin:     { bg: 'rgba(245, 158, 11, 0.12)', fg: '#b45309', label: 'Admin view' },
  };
  const tone = palette[relation];
  if (!tone) return null;
  return (
    <span
      className="ml-2 inline-block text-[10px] uppercase font-bold px-1.5 py-0.5 rounded"
      style={{ backgroundColor: tone.bg, color: tone.fg, letterSpacing: 0.3 }}
    >
      {tone.label}
    </span>
  );
}
