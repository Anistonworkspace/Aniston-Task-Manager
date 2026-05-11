import React, { useState, useRef, useEffect } from 'react';
import { Plus, X, ExternalLink, Link2 } from 'lucide-react';
import PortalDropdown from '../common/PortalDropdown';
import api from '../../services/api';

// Multi-value URL column ('links' column type, backed by the task_links table).
// For the legacy single-value 'link' column (stored on task.customFields as a
// plain string) use LinkCell instead. Both are mounted from TaskRow.jsx —
// keeping them distinct because the storage model and column-type id differ.
//
// Matches ReferenceCell's UX (compact preview + portal popover) but every
// entry is also a clickable anchor — opens in a new tab with
// rel="noopener noreferrer" so the target page never gets a window.opener
// handle back into the app. URL validation lives server-side; this component
// just surfaces any 400 message it returns.
//
// We trim http(s):// off the preview so the cell can show the hostname/path
// in the limited width — the underlying value retains the full URL.
function previewLabel(link) {
  if (link.title) return link.title;
  try {
    const u = new URL(link.url);
    const path = u.pathname && u.pathname !== '/' ? u.pathname : '';
    return `${u.hostname}${path}`.slice(0, 30);
  } catch {
    return (link.url || '').replace(/^https?:\/\//, '').slice(0, 30);
  }
}

export default function LinksCell({ taskId, value = [], onChange, readOnly = false }) {
  const [items, setItems] = useState(value || []);
  const [open, setOpen] = useState(false);
  const [draftUrl, setDraftUrl] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [showTitle, setShowTitle] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const anchorRef = useRef(null);
  // See LabelCell — same stale-prop pattern: latch local mutations so
  // a parent re-render doesn't revert an optimistic add/remove.
  const pendingMutation = useRef(false);

  // P2-5 — mount safety. Closing the popover mid-mutation would otherwise
  // log "setState on unmounted component" warnings.
  const isMounted = useRef(true);
  const pendingTimeouts = useRef(new Set());
  useEffect(() => {
    return () => {
      isMounted.current = false;
      for (const id of pendingTimeouts.current) clearTimeout(id);
      pendingTimeouts.current.clear();
    };
  }, []);
  function safeSet(setter, value) { if (isMounted.current) setter(value); }
  function scheduleLatchRelease() {
    const id = setTimeout(() => {
      pendingMutation.current = false;
      pendingTimeouts.current.delete(id);
    }, 800);
    pendingTimeouts.current.add(id);
  }

  useEffect(() => {
    setItems(value || []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  useEffect(() => {
    if (pendingMutation.current) return;
    const propIds = (value || []).map(r => r.id).sort().join('|');
    const localIds = items.map(r => r.id).sort().join('|');
    if (propIds !== localIds) setItems(value || []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function emitChange(next) {
    setItems(next);
    if (typeof onChange === 'function') onChange(next);
  }

  async function addLink() {
    const url = draftUrl.trim();
    if (!url || !taskId) return;
    setSaving(true); setError('');
    pendingMutation.current = true;
    try {
      const res = await api.post('/task-links', { taskId, url, title: draftTitle.trim() || undefined });
      const created = res.data.link || res.data?.data?.link;
      if (isMounted.current) {
        emitChange([...items, created]);
        setDraftUrl(''); setDraftTitle(''); setShowTitle(false);
      }
    } catch (err) {
      safeSet(setError, err?.response?.data?.message || 'Failed to add link');
    } finally {
      safeSet(setSaving, false);
      scheduleLatchRelease();
    }
  }

  async function removeLink(id) {
    const prev = items;
    pendingMutation.current = true;
    emitChange(items.filter(r => r.id !== id));
    try {
      await api.delete(`/task-links/${id}`);
    } catch (err) {
      safeSet(setItems, prev);
      safeSet(setError, err?.response?.data?.message || 'Failed to remove link');
    } finally {
      scheduleLatchRelease();
    }
  }

  const count = items.length;
  const first = items[0];

  if (readOnly && count === 0) {
    return <span className="text-[11px] text-text-tertiary">—</span>;
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        className="w-full h-full flex items-center px-2 gap-1 text-left hover:bg-[#f5f6f8] dark:hover:bg-zinc-700/40 transition-colors"
        aria-label="Edit links"
      >
        {count === 0 ? (
          <span className="text-[11px] text-gray-400 flex items-center gap-0.5">
            <Link2 size={10} /> {readOnly ? '—' : 'Add'}
          </span>
        ) : (
          <>
            <span
              className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-200 truncate max-w-[120px] inline-flex items-center gap-0.5"
              title={first.title || first.url}
            >
              <ExternalLink size={9} className="flex-shrink-0" />
              <span className="truncate">{previewLabel(first)}</span>
            </span>
            {count > 1 && (
              <span className="text-[9px] font-semibold text-gray-500 px-1">+{count - 1}</span>
            )}
          </>
        )}
      </button>

      <PortalDropdown anchorRef={anchorRef} open={open} onClose={() => setOpen(false)} align="left" width={300}>
        <div className="bg-white dark:bg-zinc-800 rounded-lg shadow-lg border border-gray-200 dark:border-zinc-700 w-[300px] p-2">
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary font-semibold px-1 pb-1.5 flex items-center gap-1">
            <Link2 size={10} /> Links
          </div>
          <div className="max-h-44 overflow-y-auto space-y-1">
            {items.length === 0 && (
              <p className="text-[11px] text-text-tertiary text-center py-2">No links yet</p>
            )}
            {items.map((l) => (
              <div key={l.id} className="group flex items-start gap-1.5 px-1.5 py-1 rounded hover:bg-gray-50 dark:hover:bg-zinc-700/50">
                <a
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="flex-1 min-w-0 text-[11.5px] text-primary hover:underline break-all leading-tight inline-flex items-start gap-1"
                  title={l.url}
                >
                  <ExternalLink size={10} className="flex-shrink-0 mt-0.5" />
                  <span className="break-all">{l.title || l.url}</span>
                </a>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => removeLink(l.id)}
                    className="opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-rose-500 flex-shrink-0"
                    aria-label="Remove link"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            ))}
          </div>
          {!readOnly && (
            <div className="mt-2 border-t border-gray-100 dark:border-zinc-700 pt-2 space-y-1">
              <input
                type="url"
                value={draftUrl}
                onChange={(e) => setDraftUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !showTitle) { e.preventDefault(); addLink(); } }}
                placeholder="https://…"
                className="w-full text-[11.5px] border border-gray-200 dark:border-zinc-600 rounded px-2 py-1 focus:outline-none focus:border-primary bg-white dark:bg-zinc-700"
                disabled={saving}
                autoFocus
              />
              {showTitle && (
                <input
                  type="text"
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLink(); } }}
                  placeholder="Title (optional)"
                  maxLength={200}
                  className="w-full text-[11.5px] border border-gray-200 dark:border-zinc-600 rounded px-2 py-1 focus:outline-none focus:border-primary bg-white dark:bg-zinc-700"
                  disabled={saving}
                />
              )}
              <div className="flex items-center gap-1">
                {!showTitle && (
                  <button
                    type="button"
                    onClick={() => setShowTitle(true)}
                    className="text-[10px] text-text-tertiary hover:text-primary"
                  >
                    + Add title
                  </button>
                )}
                <button
                  type="button"
                  onClick={addLink}
                  disabled={!draftUrl.trim() || saving}
                  className="ml-auto text-[11px] bg-primary text-white rounded px-2 py-1 disabled:opacity-50 inline-flex items-center gap-1"
                >
                  {saving ? '…' : <><Plus size={11} /> Add</>}
                </button>
              </div>
              {error && <p className="text-[10px] text-rose-500">{error}</p>}
            </div>
          )}
        </div>
      </PortalDropdown>
    </>
  );
}
