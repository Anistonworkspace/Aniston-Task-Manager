import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  FileText, Plus, Search, Loader2, Building2,
  ChevronDown, ChevronRight,
} from 'lucide-react';
import { listMyDocs, createDoc as createDocApi } from '../../services/docsService';
import safeLog from '../../utils/safeLog';
import { getErrorMessage } from '../../utils/errorMap';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../components/common/Toast';
import useRealtimeEvent from '../../realtime/useRealtimeEvent';
import { loadDeptCollapseState, saveDeptCollapseState } from './docsDeptCollapse';

// Bucket label for docs whose owner has no department set (Tier 1/2 view).
// Kept identical to DocsListPage so grouping is consistent between surfaces.
const NO_DEPT = 'No Department';

// Floating card width (224px, ~20% narrower than the original 280px) plus its
// horizontal margins. The outer animated wrapper grows to this total so the
// editor reflows smoothly as the rail slides in/out; the card itself stays a
// fixed width so its content never squishes mid-animation.
const CARD_WIDTH = 224;
const OUTER_WIDTH = CARD_WIDTH + 20; // 8px left gap + 12px right margin

/**
 * DocsSidePanel — the in-editor right rail that lets the user jump between
 * docs without bouncing back to /docs.
 *
 * Mirrors DocsListPage's data model:
 *   - Tier 1/2 (canManage): every doc grouped by the owner's department, each
 *     section collapsible (state shared with the home list via
 *     docsDeptCollapse).
 *   - Everyone else: a flat list of the docs they can see.
 *
 * The active doc (the one currently open in DocPage) is highlighted. Clicking
 * any row navigates to it; the editor stays mounted and re-loads for the new
 * docId. The panel self-manages its own fetch + create so DocPage only has to
 * pass the active doc id.
 *
 * Closing is owned solely by the header toggle in DocPage — the rail has no
 * close button of its own (one control, one mental model). DocPage wraps this
 * in <AnimatePresence> so the slide-in/out animation below runs on mount and
 * unmount.
 */
export default function DocsSidePanel({ activeDocId }) {
  const navigate = useNavigate();
  const { canManage, user } = useAuth();
  const toast = useToast();

  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [collapsedDepts, setCollapsedDepts] = useState(() => loadDeptCollapseState(user?.id));

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

  const load = useCallback(async () => {
    setError('');
    try {
      const { docs: list } = await listMyDocs();
      setDocs(Array.isArray(list) ? list : []);
    } catch (err) {
      safeLog.error('[DocsSidePanel] load error', err);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Keep the panel fresh when access changes elsewhere (mirrors DocsListPage).
  useRealtimeEvent('doc:access:granted', useCallback(() => { load(); }, [load]));
  useRealtimeEvent('doc:access:revoked', useCallback(() => { load(); }, [load]));

  // Client-side title/excerpt filter so typing feels instant (the list is
  // already in memory; no need to round-trip per keystroke here).
  const filteredDocs = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter((d) => {
      const title = (d.title || '').toLowerCase();
      const text = (d.contentText || '').toLowerCase();
      return title.includes(q) || text.includes(q);
    });
  }, [docs, query]);

  // Tier 1/2: [ [deptName, docs[]], ... ] sorted by department name.
  const groupedByDept = useMemo(() => {
    if (!canManage) return null;
    const map = new Map();
    for (const d of filteredDocs) {
      const key = d.ownerDepartment || NO_DEPT;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(d);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filteredDocs, canManage]);

  const handleCreate = useCallback(async () => {
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
  }, [creating, navigate, toast]);

  return (
    <motion.div
      className="docs-side-panel__outer"
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: OUTER_WIDTH, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ duration: 0.26, ease: [0.4, 0, 0.2, 1] }}
    >
    <aside className="docs-side-panel" style={{ width: CARD_WIDTH }}>
      <header className="docs-side-panel__header">
        <span className="docs-side-panel__title">
          <FileText size={15} className="docs-side-panel__title-icon" />
          Docs
        </span>
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating}
          className="docs-side-panel__icon-btn"
          title="New doc"
          aria-label="New doc"
        >
          {creating ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
        </button>
      </header>

      <div className="docs-side-panel__search">
        <Search size={13} className="docs-side-panel__search-icon" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search docs"
          className="docs-side-panel__search-input"
        />
      </div>

      <div className="docs-side-panel__scroll">
        {error && (
          <div className="px-3 py-2 text-xs text-red-600">{error}</div>
        )}

        {loading ? (
          <div className="p-2 space-y-1.5">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-9 rounded-md animate-pulse" style={{ backgroundColor: 'var(--surface-100, #f0f2f5)' }} />
            ))}
          </div>
        ) : filteredDocs.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-text-tertiary">
            {query ? 'No docs match your search.' : 'No docs yet.'}
          </div>
        ) : canManage ? (
          <div className="py-1">
            {groupedByDept.map(([dept, deptDocs]) => {
              const collapsed = !!collapsedDepts[dept];
              return (
                <section key={dept} className="px-1.5">
                  <button
                    type="button"
                    onClick={() => toggleDept(dept)}
                    aria-expanded={!collapsed}
                    className="docs-side-panel__dept"
                  >
                    {collapsed
                      ? <ChevronRight size={13} className="text-text-tertiary flex-shrink-0" />
                      : <ChevronDown size={13} className="text-text-tertiary flex-shrink-0" />}
                    <Building2 size={12} className="text-text-tertiary flex-shrink-0" />
                    <span className="docs-side-panel__dept-name">{dept}</span>
                    <span className="docs-side-panel__dept-count">{deptDocs.length}</span>
                  </button>
                  {!collapsed && (
                    <ul className="pb-1">
                      {deptDocs.map((doc) => (
                        <li key={doc.id}>
                          <DocPanelRow
                            doc={doc}
                            active={doc.id === activeDocId}
                            onOpen={() => navigate(`/docs/${doc.id}`)}
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
          <ul className="py-1 px-1.5">
            {filteredDocs.map((doc) => (
              <li key={doc.id}>
                <DocPanelRow
                  doc={doc}
                  active={doc.id === activeDocId}
                  onOpen={() => navigate(`/docs/${doc.id}`)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
    </motion.div>
  );
}

function DocPanelRow({ doc, active, onOpen }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`docs-side-panel__row${active ? ' docs-side-panel__row--active' : ''}`}
      title={doc.title || 'Untitled doc'}
      aria-current={active ? 'page' : undefined}
    >
      <FileText size={13} className="docs-side-panel__row-icon flex-shrink-0" />
      <span className="docs-side-panel__row-title">{doc.title || 'Untitled doc'}</span>
    </button>
  );
}
