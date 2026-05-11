import React, { useState, useRef, useEffect } from 'react';
import { Plus, X, BookOpen } from 'lucide-react';
import PortalDropdown from '../common/PortalDropdown';
import api from '../../services/api';

// Renders the multi-value Reference column inside the board row AND inside
// the task modal. `value` is the array of {id, text} entries fetched as
// task.references on the server. The cell:
//   • shows the first entry inline + a "+N" badge when there are extras,
//   • opens a portal-based popover (escapes the board's overflow-x scroll)
//     containing the full list with delete X buttons and an add input,
//   • POSTs/DELETEs against /api/task-references and emits each change to
//     the parent via onChange so the in-memory task stays in sync without
//     a full refetch.
//
// Read-only mode kicks in when `readOnly` is true or no `onChange` is
// passed — used for lower-tier users without edit rights on this task.
export default function ReferenceCell({ taskId, value = [], onChange, readOnly = false }) {
  const [items, setItems] = useState(value || []);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const anchorRef = useRef(null);
  // See LabelCell for the latch rationale — same stale-prop revert bug
  // applied here. ReferenceCell's previous useEffect watched `value` and
  // reset local state on every parent re-render, which would undo an
  // optimistic add in the open modal.
  const pendingMutation = useRef(false);

  // Hydrate on task switch (rendered task changed).
  useEffect(() => {
    setItems(value || []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // Sync from a fresh server-pushed prop only when no local mutation is
  // in flight. Comparing the id list keeps this a no-op when local and
  // prop already agree.
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

  async function addReference() {
    const text = draft.trim();
    if (!text || !taskId) return;
    setSaving(true); setError('');
    pendingMutation.current = true;
    try {
      const res = await api.post('/task-references', { taskId, text });
      const created = res.data.reference || res.data?.data?.reference;
      emitChange([...items, created]);
      setDraft('');
    } catch (err) {
      setError(err?.response?.data?.message || 'Failed to add reference');
    } finally {
      setSaving(false);
      setTimeout(() => { pendingMutation.current = false; }, 800);
    }
  }

  async function removeReference(id) {
    const prev = items;
    pendingMutation.current = true;
    emitChange(items.filter(r => r.id !== id));
    try {
      await api.delete(`/task-references/${id}`);
    } catch (err) {
      // Roll back the optimistic delete if the server rejects (e.g. 403).
      setItems(prev);
      setError(err?.response?.data?.message || 'Failed to remove reference');
    } finally {
      setTimeout(() => { pendingMutation.current = false; }, 800);
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
        aria-label="Edit references"
      >
        {count === 0 ? (
          <span className="text-[11px] text-gray-400 flex items-center gap-0.5">
            <BookOpen size={10} /> {readOnly ? '—' : 'Add'}
          </span>
        ) : (
          <>
            <span
              className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-200 truncate max-w-[120px]"
              title={first.text}
            >
              {first.text}
            </span>
            {count > 1 && (
              <span className="text-[9px] font-semibold text-gray-500 px-1">+{count - 1}</span>
            )}
          </>
        )}
      </button>

      <PortalDropdown anchorRef={anchorRef} open={open} onClose={() => setOpen(false)} align="left" width={260}>
        <div className="bg-white dark:bg-zinc-800 rounded-lg shadow-lg border border-gray-200 dark:border-zinc-700 w-[260px] p-2">
          <div className="text-[10px] uppercase tracking-wider text-text-tertiary font-semibold px-1 pb-1.5 flex items-center gap-1">
            <BookOpen size={10} /> References
          </div>
          <div className="max-h-44 overflow-y-auto space-y-1">
            {items.length === 0 && (
              <p className="text-[11px] text-text-tertiary text-center py-2">No references yet</p>
            )}
            {items.map((r) => (
              <div key={r.id} className="group flex items-start gap-1.5 px-1.5 py-1 rounded hover:bg-gray-50 dark:hover:bg-zinc-700/50">
                <span className="flex-1 text-[11.5px] text-text-primary break-words leading-tight">{r.text}</span>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => removeReference(r.id)}
                    className="opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-rose-500 flex-shrink-0"
                    aria-label="Remove reference"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            ))}
          </div>
          {!readOnly && (
            <div className="mt-2 border-t border-gray-100 dark:border-zinc-700 pt-2">
              <div className="flex gap-1">
                <input
                  type="text"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addReference(); } }}
                  placeholder="Add reference…"
                  maxLength={500}
                  className="flex-1 text-[11.5px] border border-gray-200 dark:border-zinc-600 rounded px-2 py-1 focus:outline-none focus:border-primary bg-white dark:bg-zinc-700"
                  disabled={saving}
                  autoFocus
                />
                <button
                  type="button"
                  onClick={addReference}
                  disabled={!draft.trim() || saving}
                  className="text-[11px] bg-primary text-white rounded px-2 disabled:opacity-50"
                >
                  {saving ? '…' : <Plus size={12} />}
                </button>
              </div>
              {error && <p className="text-[10px] text-rose-500 mt-1">{error}</p>}
            </div>
          )}
        </div>
      </PortalDropdown>
    </>
  );
}
