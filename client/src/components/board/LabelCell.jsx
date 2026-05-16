import React, { useState, useRef, useEffect } from 'react';
import { Plus, X, Search, Tag, Trash2 } from 'lucide-react';
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
// Props:
//   - canEdit   — caller can apply / unassign EXISTING labels on this task
//                 (gated upstream by explicit DENY on labels.add_to_task).
//                 The backend's taskVisibility.canViewTask check is the
//                 security boundary, so default-true is intentional.
//   - canCreate — caller can mint a NEW label via the inline Create form.
//                 Phase A (May 2026) split this out of canEdit because
//                 the one-click create-and-attach flow now requires BOTH
//                 labels.create AND labels.add_to_task on the backend.
//                 Defaults to canEdit for back-compat with older callers
//                 that haven't been updated yet.
//   - canManage — caller can permanently delete a label from the board's
//                 library (T1 / T2 only). Hides the trash icon for
//                 everyone else; the API still 403s if a caller forges
//                 the request.
//
// `labels` prop is the array of {id, name, color} attached to a task (via
// task.labels in the GET response). Local state mirrors it for optimistic
// updates; the parent eventually refetches on the next socket-driven reload.
export default function LabelCell({ taskId, boardId, labels: initialLabels = [], canEdit = true, canCreate, canManage = false, onLabelsChange }) {
  // Back-compat: callers that haven't been updated to pass canCreate fall
  // back to canEdit so the existing assign/unassign flow still works. The
  // server enforces labels.create on the actual write so an out-of-date
  // caller hits a 403 toast rather than getting away with privilege
  // escalation through stale frontend code.
  const canCreateLabel = typeof canCreate === 'boolean' ? canCreate : canEdit;
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

  // P2-5 — mount-safety. If the user closes the modal (unmounts this
  // cell) while a label mutation is in flight, the in-flight promise's
  // setState calls would log "Can't perform a React state update on an
  // unmounted component" warnings. We track mount state in a ref and
  // gate every post-await setState through it. Also tracks pending
  // setTimeouts so they can be cleared at unmount.
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
      safeSet(setLabels, prev);
      safeSet(setError, err?.response?.data?.message || 'Failed to update label');
    } finally {
      safeSet(setBusy, false);
      scheduleLatchRelease();
    }
  }

  // Permanently delete a label from the board's library (NOT just unassign
  // it from this task). Only rendered when canManage is true (T1 / T2).
  // The backend transactionally removes the TaskLabel join rows for every
  // task on the board, so the label disappears from sibling rows as well —
  // we rely on the `task:labels_updated` socket fan-out to refresh those.
  // For THIS task we shrink the local labels state immediately so the chip
  // disappears without waiting for the socket round-trip.
  async function deleteLabelFromLibrary(label) {
    if (!canManage || busy) return;
    if (typeof window !== 'undefined' && !window.confirm(`Delete label "${label.name}" from this board? This removes it from every task.`)) return;
    setBusy(true); setError('');
    pendingMutation.current = true;
    try {
      await api.delete(`/labels/${label.id}`);
      if (isMounted.current) {
        setAllLabels(prev => prev.filter(l => l.id !== label.id));
        const next = labels.filter(l => l.id !== label.id);
        setLabels(next);
        if (typeof onLabelsChange === 'function') onLabelsChange(next);
      }
    } catch (err) {
      const data = err?.response?.data;
      let msg = data?.message || 'Failed to delete label';
      if (data?.detail && data.detail !== data.message) msg = `${msg} — ${data.detail}`;
      safeSet(setError, msg);
    } finally {
      safeSet(setBusy, false);
      scheduleLatchRelease();
    }
  }

  async function createLabel() {
    // Phase A — Create requires the dedicated create gate (backend
    // enforces labels.create + labels.add_to_task in a single
    // transaction). Falls back to canEdit when canCreate prop wasn't
    // passed, preserving old behaviour while parent components migrate.
    if (!canCreateLabel) return;
    if (!newName.trim()) return;
    setBusy(true); setError('');
    pendingMutation.current = true;
    try {
      // P2-2 — server-side atomic create + assign. If the assign fails,
      // the label create is rolled back inside a single transaction, so
      // we no longer accumulate orphan labels in the DB when the second
      // POST fails. Replaces the prior two-call client flow.
      const res = await api.post('/labels', {
        name: newName.trim(),
        color: newColor,
        boardId,
        assignToTaskId: taskId,
      });
      const label = res.data.label || res.data?.data?.label;
      if (!label) throw new Error('Bad response');
      if (isMounted.current) {
        setAllLabels(prev => [...prev, label]);
        const next = [...labels, label];
        setLabels(next);
        if (typeof onLabelsChange === 'function') onLabelsChange(next);
        setNewName('');
        setShowCreate(false);
      }
    } catch (err) {
      // In dev mode the server attaches `detail` to its 500 envelope so the
      // root cause surfaces directly to the cell instead of being buried in
      // server logs. We append it after the user-facing message; in
      // production responses `detail` is omitted and the message-only fall
      // back below kicks in unchanged.
      const data = err?.response?.data;
      let msg = data?.message || 'Failed to create label';
      if (data?.detail && data.detail !== data.message) {
        msg = `${msg} — ${data.detail}`;
      }
      safeSet(setError, msg);
    } finally {
      safeSet(setBusy, false);
      scheduleLatchRelease();
    }
  }

  const filtered = allLabels.filter(l => !search || l.name.toLowerCase().includes(search.toLowerCase()));
  const COLORS = ['#579bfc', '#00c875', '#fdab3d', '#df2f4a', '#9d50dd', '#ff642e', '#cab641', '#ff158a', '#66ccff', '#333'];

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
            {/* Pill UI — bumped from 9px/px-1.5 to 11px/px-2.5/py-1 so the
                tag is actually readable in the row. max-w increased from
                80px to 120px; long names truncate with an ellipsis and the
                full name is shown in the native title tooltip. Row height
                stays bounded because the cell is fixed-height — pills
                shrink/wrap-suppressed within. */}
            {labels.slice(0, 3).map(l => (
              <span
                key={l.id}
                className="inline-flex items-center text-[11px] leading-none font-medium px-2.5 py-1 rounded-full text-white truncate max-w-[120px] shadow-sm"
                style={{ backgroundColor: l.color }}
                title={l.name}
              >
                {l.name}
              </span>
            ))}
            {labels.length > 3 && (
              <span className="text-[11px] text-gray-500 dark:text-gray-400 font-semibold ml-0.5">+{labels.length - 3}</span>
            )}
          </>
        ) : (
          <span className="text-[12px] text-gray-400 flex items-center gap-1">
            <Tag size={12} /> Add
          </span>
        )}
      </button>

      <PortalDropdown anchorRef={anchorRef} open={open} onClose={() => setOpen(false)} align="left" width={260}>
        <div className="bg-white dark:bg-zinc-800 rounded-lg shadow-lg border border-gray-200 dark:border-zinc-700 w-[260px]">
          <div className="p-2">
            <div className="relative mb-2">
              <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search labels…"
                className="w-full pl-7 pr-2 py-1.5 text-xs border border-gray-200 dark:border-zinc-600 rounded focus:outline-none focus:border-primary bg-white dark:bg-zinc-700"
              />
            </div>
            <div className="max-h-44 overflow-y-auto space-y-0.5">
              {filtered.map(l => {
                const isActive = labels.some(lb => lb.id === l.id);
                return (
                  <div
                    key={l.id}
                    className={`group flex items-center rounded text-xs hover:bg-gray-50 dark:hover:bg-zinc-700 ${isActive ? 'bg-gray-50 dark:bg-zinc-700' : ''}`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleLabel(l)}
                      disabled={busy || !canEdit}
                      className="flex-1 flex items-center gap-2 px-2 py-1.5 text-left disabled:opacity-60 min-w-0"
                      title={l.name}
                    >
                      <span
                        className="inline-flex items-center text-[11px] leading-none font-medium px-2 py-1 rounded-full text-white truncate max-w-[150px] shadow-sm flex-shrink-0"
                        style={{ backgroundColor: l.color }}
                      >
                        {l.name}
                      </span>
                      {isActive && <span className="text-primary text-[11px] font-bold ml-auto pl-1">✓</span>}
                    </button>
                    {canManage && (
                      <button
                        type="button"
                        onClick={() => deleteLabelFromLibrary(l)}
                        disabled={busy}
                        className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1.5 mr-1 text-gray-400 hover:text-rose-500 rounded transition-opacity disabled:opacity-30"
                        title={`Delete label "${l.name}" from this board`}
                        aria-label={`Delete label ${l.name}`}
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                );
              })}
              {filtered.length === 0 && (
                <p className="text-[11px] text-gray-400 py-2 text-center">No labels found</p>
              )}
            </div>
          </div>
          {canCreateLabel && (
            <div className="border-t border-gray-100 dark:border-zinc-700 p-2">
              {showCreate ? (
                <div className="space-y-1.5">
                  <input
                    type="text"
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    placeholder="Label name"
                    maxLength={100}
                    className="w-full text-xs border border-gray-200 dark:border-zinc-600 rounded px-2 py-1.5 focus:outline-none focus:border-primary bg-white dark:bg-zinc-700"
                    onKeyDown={e => { if (e.key === 'Enter') createLabel(); }}
                    autoFocus
                  />
                  <div className="flex gap-1 flex-wrap">
                    {COLORS.map(c => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setNewColor(c)}
                        className={`w-4 h-4 rounded-full ${newColor === c ? 'ring-2 ring-offset-1 ring-gray-400' : ''}`}
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
                      className="flex-1 text-[11px] bg-primary text-white rounded py-1.5 disabled:opacity-50 font-medium"
                    >
                      {busy ? '…' : 'Create'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setShowCreate(false); setNewName(''); }}
                      className="text-[11px] text-gray-400 px-2"
                    >Cancel</button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowCreate(true)}
                  className="flex items-center gap-1.5 w-full text-xs text-gray-600 dark:text-gray-300 hover:text-primary px-1.5 py-1.5 rounded hover:bg-gray-50 dark:hover:bg-zinc-700"
                >
                  <Plus size={13} /> Create label
                </button>
              )}
              {error && <p className="text-[11px] text-rose-500 mt-1">{error}</p>}
            </div>
          )}
          {!canCreateLabel && !canEdit && error && (
            <div className="border-t border-gray-100 dark:border-zinc-700 p-2">
              <p className="text-[11px] text-rose-500">{error}</p>
            </div>
          )}
        </div>
      </PortalDropdown>
    </>
  );
}
