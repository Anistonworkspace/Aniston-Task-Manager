import React, { useState } from 'react';
import { GripVertical, ArrowUp, ArrowDown } from 'lucide-react';
import Modal from '../common/Modal';
import api from '../../services/api';

// Drag-and-drop reorder list with up/down button fallback. The modal hands
// the new id order back to the parent via `onSaved(boardIds)` after the PUT
// resolves, so the sidebar can update optimistically without re-fetching.
//
// Props:
//   workspace — { id, name } the workspace being reordered.
//   boards    — array of boards already filtered to those visible to the
//               caller. Initial order is whatever the parent passes (the
//               same order the sidebar currently shows after applying any
//               prior preference).
export default function RearrangeBoardsModal({ workspace, boards = [], onClose, onSaved }) {
  const [order, setOrder] = useState(() => boards.map(b => ({ ...b })));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [dragId, setDragId] = useState(null);

  function move(idx, dir) {
    const target = idx + dir;
    if (target < 0 || target >= order.length) return;
    setOrder(prev => {
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }

  function onDragStart(id) { setDragId(id); }
  function onDragOver(e) { e.preventDefault(); }
  function onDrop(targetId) {
    if (!dragId || dragId === targetId) { setDragId(null); return; }
    setOrder(prev => {
      const fromIdx = prev.findIndex(b => b.id === dragId);
      const toIdx = prev.findIndex(b => b.id === targetId);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
    setDragId(null);
  }

  async function handleSave() {
    if (loading) return;

    // Defensive guards — these conditions shouldn't be reachable through
    // normal UI flow, but they have caused 404/400 responses in the past
    // when the modal was opened on stale state.
    if (!workspace?.id) {
      setError('No workspace selected. Please close and reopen this dialog.');
      return;
    }
    const boardIds = order.map(b => b.id).filter(Boolean);
    if (boardIds.length !== order.length) {
      setError('Some boards are missing identifiers. Please refresh and try again.');
      return;
    }

    setLoading(true);
    setError('');
    try {
      // Per-user board ordering is a workspace-scoped resource, mirroring the
      // /api/workspaces/:id/{boards,members} convention used elsewhere.
      await api.put(`/workspaces/${workspace.id}/board-order`, { boardIds });
      onSaved?.(boardIds);
    } catch (err) {
      // Always log the full failure for devs — status, body, and the URL we
      // actually hit. This is the single most useful artifact when the same
      // 404 shows up on a fresh checkout.
      const status = err?.response?.status;
      const backendMsg = err?.response?.data?.message;
      // eslint-disable-next-line no-console
      console.error('[RearrangeBoards] save failed:', status, err?.response?.data, '→ tried PUT /api/workspaces/' + workspace?.id + '/board-order');

      let msg;
      // Specifically catch the catch-all 404 from server.js. When this fires
      // it means the URL never matched any route — usually because the
      // backend process is older than the route file. Tell the user
      // exactly that, in dev or prod, since the fix is the same: restart.
      if (status === 404 && /route not found/i.test(backendMsg || '')) {
        msg = 'The board-order API route is not available on the running backend. Restart the backend dev server and try again.';
      } else if (backendMsg) {
        // Any other backend-supplied message is the most diagnostic option —
        // surface it verbatim ("Workspace not found.", "Some boards do not
        // belong to this workspace…", validation errors).
        msg = backendMsg;
      } else if (status === 400) msg = 'Could not save this order — the board list is invalid.';
      else if (status === 403) msg = 'You do not have permission to rearrange boards in this workspace.';
      else if (status === 404) msg = 'This workspace no longer exists. Please refresh.';
      else msg = 'Could not save board order. Please try again.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title="Rearrange Boards"
      size="md"
      footer={
        <>
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-md border border-border hover:bg-surface-100">
            Cancel
          </button>
          <button onClick={handleSave} disabled={loading || order.length === 0}
            className="px-4 py-1.5 text-sm rounded-md bg-primary text-white hover:bg-primary-hover disabled:opacity-60 font-medium">
            {loading ? 'Saving...' : 'Save Order'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="text-xs text-text-tertiary">
          Workspace: <span className="font-semibold text-text-secondary">{workspace?.name}</span>
        </div>
        {error && <div className="bg-danger/10 text-danger text-sm px-3 py-2 rounded-md">{error}</div>}

        {order.length === 0 && (
          <p className="text-sm text-text-tertiary text-center py-6">No boards to rearrange.</p>
        )}

        <div className="flex flex-col gap-1">
          {order.map((b, i) => (
            <div
              key={b.id}
              draggable
              onDragStart={() => onDragStart(b.id)}
              onDragOver={onDragOver}
              onDrop={() => onDrop(b.id)}
              className={`flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-surface-50 dark:bg-[#27272a] cursor-move ${dragId === b.id ? 'opacity-40' : ''}`}>
              <GripVertical size={14} className="text-text-tertiary flex-shrink-0" />
              <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: b.color || '#579bfc' }} />
              <span className="flex-1 text-sm truncate text-text-primary">{b.name}</span>
              <button onClick={() => move(i, -1)} disabled={i === 0}
                className="p-1 rounded hover:bg-surface-100 disabled:opacity-30" title="Move up">
                <ArrowUp size={12} />
              </button>
              <button onClick={() => move(i, 1)} disabled={i === order.length - 1}
                className="p-1 rounded hover:bg-surface-100 disabled:opacity-30" title="Move down">
                <ArrowDown size={12} />
              </button>
            </div>
          ))}
        </div>

        <p className="text-[11px] text-text-tertiary">
          This order is personal — only you see it. New boards added later append at the end.
        </p>
      </div>
    </Modal>
  );
}
