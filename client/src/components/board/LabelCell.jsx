import React, { useState, useRef, useEffect } from 'react';
import { Plus, X, Search, Tag } from 'lucide-react';
import PortalDropdown from '../common/PortalDropdown';
import api from '../../services/api';

// LabelCell — renders the colored-tag chips in the board's Labels column
// (and, via TaskModal, in the task detail bento grid). Each cell is a real
// Label entity in the database (junction via TaskLabel); this is intentionally
// NOT the same as task.tags, the free-string array used elsewhere in the
// modal — those two systems were previously confused, which is why label
// edits in the modal didn't propagate to the board.
//
// Two bugs fixed here vs. the earlier implementation:
//   1. The picker used an `absolute` positioned div whose parent lived inside
//      the board's overflow-x scroll container. The dropdown got clipped on
//      the right edge of every row that wasn't the leftmost. We now portal
//      the menu to <body> via PortalDropdown — same pattern used by
//      Priority/Status/Date pickers — so it always renders above everything.
//   2. The assign / unassign endpoints sit behind managerOrAdmin server-side.
//      Members would click "Add" and silently 403. The cell now exposes the
//      caller-supplied `canEdit` flag so the UI renders read-only chips for
//      lower tiers instead of a clickable button that just fails.
//
// `labels` prop is the array of {id, name, color} attached to a task (via
// task.labels in the GET response). Local state mirrors it for optimistic
// updates; the parent eventually refetches on the next socket-driven reload.
export default function LabelCell({ taskId, boardId, labels: initialLabels = [], canEdit = true, onLabelsChange }) {
  const [open, setOpen] = useState(false);
  const [labels, setLabels] = useState(initialLabels);
  const [allLabels, setAllLabels] = useState([]);
  const [search, setSearch] = useState('');
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('#579bfc');
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const anchorRef = useRef(null);
  // Local-mutation latch: bumped on every toggleLabel/createLabel so
  // the "sync from prop" effect below knows to skip during the brief
  // window between the user's click and the server-pushed refresh.
  // Without this latch, every parent re-render with the still-stale
  // task.labels prop would revert the optimistic add — that was the
  // exact "labels disappear from the modal" bug the user reported.
  const pendingMutation = useRef(false);

  // ⚠ Sync rules:
  //  • Always re-hydrate when the rendered task changes (taskId switch).
  //  • Otherwise, sync from prop only when (a) the id-list genuinely
  //    differs from local state, AND (b) we don't have a local mutation
  //    in flight. Case (b) is what stops the stale-prop revert during
  //    same-tab parent re-renders; the prop is fresh again after the
  //    task:labels_updated socket event fires and BoardPage refetches.
  useEffect(() => {
    setLabels(initialLabels || []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  useEffect(() => {
    if (pendingMutation.current) return;
    const propIds = (initialLabels || []).map(l => l.id).sort().join('|');
    const localIds = labels.map(l => l.id).sort().join('|');
    if (propIds !== localIds) setLabels(initialLabels || []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLabels]);

  // Lazy-load the full label list only when the picker opens. boardId is
  // included so the same label set follows the user across boards (labels
  // scope to a single board today; nullable boardId means it's a global one).
  useEffect(() => {
    if (open && boardId) {
      api.get(`/labels?boardId=${boardId}`)
        .then(res => setAllLabels(res.data.labels || res.data?.data?.labels || []))
        .catch(() => { /* read errors are non-fatal — show empty list */ });
    }
  }, [open, boardId]);

  async function toggleLabel(label) {
    if (!canEdit || busy) return;
    setBusy(true); setError('');
    pendingMutation.current = true;
    const isAssigned = labels.some(l => l.id === label.id);
    const prev = labels;
    const next = isAssigned ? labels.filter(l => l.id !== label.id) : [...labels, label];
    setLabels(next);
    try {
      if (isAssigned) {
        await api.post('/labels/unassign', { taskId, labelId: label.id });
      } else {
        await api.post('/labels/assign', { taskId, labelId: label.id });
      }
      if (typeof onLabelsChange === 'function') onLabelsChange(next);
    } catch (err) {
      setLabels(prev);
      setError(err?.response?.data?.message || 'Failed to update label');
    } finally {
      setBusy(false);
      // Hold the latch briefly so the socket-driven refetch round-trip
      // can land and the prop sync pass that follows sees pending=false
      // with a fresh prop that already matches local. 800ms is enough
      // for localhost; in production the round-trip is typically <250ms
      // so any value here that's well above network jitter works.
      setTimeout(() => { pendingMutation.current = false; }, 800);
    }
  }

  async function createLabel() {
    if (!canEdit) return;
    if (!newName.trim()) return;
    setBusy(true); setError('');
    pendingMutation.current = true;
    try {
      const res = await api.post('/labels', { name: newName.trim(), color: newColor, boardId });
      const label = res.data.label || res.data?.data?.label;
      if (!label) throw new Error('Bad response');
      setAllLabels(prev => [...prev, label]);
      await api.post('/labels/assign', { taskId, labelId: label.id });
      const next = [...labels, label];
      setLabels(next);
      if (typeof onLabelsChange === 'function') onLabelsChange(next);
      setNewName('');
      setShowCreate(false);
    } catch (err) {
      setError(err?.response?.data?.message || 'Failed to create label');
    } finally {
      setBusy(false);
      setTimeout(() => { pendingMutation.current = false; }, 800);
    }
  }

  const filtered = allLabels.filter(l => !search || l.name.toLowerCase().includes(search.toLowerCase()));
  const COLORS = ['#579bfc', '#00c875', '#fdab3d', '#e2445c', '#a25ddc', '#ff642e', '#cab641', '#ff158a', '#66ccff', '#333'];

  // Read-only render: no button, just the chips (or em-dash). Keeps the
  // column consistent without dangling an inert "Add" hint that misleads
  // the user about their permission level.
  if (!canEdit && labels.length === 0) {
    return <span className="text-[11px] text-text-tertiary px-2">—</span>;
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); if (canEdit) setOpen(o => !o); }}
        disabled={!canEdit && labels.length === 0}
        className="w-full h-full flex items-center px-2 gap-1 text-left hover:bg-[#f5f6f8] dark:hover:bg-zinc-700/40 transition-colors"
        aria-label="Edit labels"
      >
        {labels.length > 0 ? (
          <>
            {labels.slice(0, 3).map(l => (
              <span
                key={l.id}
                className="text-[9px] font-medium px-1.5 py-0.5 rounded-full text-white truncate max-w-[80px]"
                style={{ backgroundColor: l.color }}
                title={l.name}
              >
                {l.name}
              </span>
            ))}
            {labels.length > 3 && (
              <span className="text-[9px] text-gray-500 font-semibold">+{labels.length - 3}</span>
            )}
          </>
        ) : (
          <span className="text-[11px] text-gray-400 flex items-center gap-0.5">
            <Tag size={10} /> Add
          </span>
        )}
      </button>

      <PortalDropdown anchorRef={anchorRef} open={open} onClose={() => setOpen(false)} align="left" width={220}>
        <div className="bg-white dark:bg-zinc-800 rounded-lg shadow-lg border border-gray-200 dark:border-zinc-700 w-[220px]">
          <div className="p-2">
            <div className="relative mb-2">
              <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search labels…"
                className="w-full pl-7 pr-2 py-1 text-xs border border-gray-200 dark:border-zinc-600 rounded focus:outline-none focus:border-primary bg-white dark:bg-zinc-700"
              />
            </div>
            <div className="max-h-36 overflow-y-auto space-y-0.5">
              {filtered.map(l => {
                const isActive = labels.some(lb => lb.id === l.id);
                return (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => toggleLabel(l)}
                    disabled={busy}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-gray-50 dark:hover:bg-zinc-700 ${isActive ? 'bg-gray-50 dark:bg-zinc-700' : ''} disabled:opacity-60`}
                  >
                    <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: l.color }} />
                    <span className="flex-1 text-left text-gray-700 dark:text-gray-300 truncate">{l.name}</span>
                    {isActive && <span className="text-primary text-[10px] font-bold">✓</span>}
                  </button>
                );
              })}
              {filtered.length === 0 && (
                <p className="text-[10px] text-gray-400 py-2 text-center">No labels found</p>
              )}
            </div>
          </div>
          <div className="border-t border-gray-100 dark:border-zinc-700 p-2">
            {showCreate ? (
              <div className="space-y-1.5">
                <input
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="Label name"
                  maxLength={100}
                  className="w-full text-xs border border-gray-200 dark:border-zinc-600 rounded px-2 py-1 focus:outline-none focus:border-primary bg-white dark:bg-zinc-700"
                  onKeyDown={e => { if (e.key === 'Enter') createLabel(); }}
                  autoFocus
                />
                <div className="flex gap-1 flex-wrap">
                  {COLORS.map(c => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setNewColor(c)}
                      className={`w-3.5 h-3.5 rounded-full ${newColor === c ? 'ring-2 ring-offset-1 ring-gray-400' : ''}`}
                      style={{ backgroundColor: c }}
                      aria-label={`Pick color ${c}`}
                    />
                  ))}
                </div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={createLabel}
                    disabled={busy || !newName.trim()}
                    className="flex-1 text-[10px] bg-primary text-white rounded py-1 disabled:opacity-50"
                  >
                    {busy ? '…' : 'Create'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowCreate(false); setNewName(''); }}
                    className="text-[10px] text-gray-400 px-2"
                  >Cancel</button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className="flex items-center gap-1 w-full text-xs text-gray-500 hover:text-primary px-1 py-1 rounded hover:bg-gray-50 dark:hover:bg-zinc-700"
              >
                <Plus size={11} /> Create label
              </button>
            )}
            {error && <p className="text-[10px] text-rose-500 mt-1">{error}</p>}
          </div>
        </div>
      </PortalDropdown>
    </>
  );
}
