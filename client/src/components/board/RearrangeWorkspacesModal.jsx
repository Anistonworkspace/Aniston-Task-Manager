import React, { useState } from 'react';
import { GripVertical, ArrowUp, ArrowDown } from 'lucide-react';
import Modal from '../common/Modal';
import api from '../../services/api';

// Per-user workspace ordering for the sidebar. Companion to
// RearrangeBoardsModal — same drag-and-drop pattern, same up/down fallback,
// same save-then-callback flow. The parent passes the visible workspaces in
// their current display order so the modal opens already matching what the
// user sees in the sidebar.
//
// Props:
//   workspaces — array of { id, name, color } already filtered to those
//                visible to the caller. Initial order matches what the
//                sidebar is currently rendering.
//   onClose    — close the modal without saving.
//   onSaved(workspaceIds) — fired after the PUT resolves so the sidebar can
//                update optimistically without a full re-fetch.
export default function RearrangeWorkspacesModal({ workspaces = [], onClose, onSaved }) {
  const [order, setOrder] = useState(() => workspaces.map(w => ({ ...w })));
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
      const fromIdx = prev.findIndex(w => w.id === dragId);
      const toIdx = prev.findIndex(w => w.id === targetId);
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

    const workspaceIds = order.map(w => w.id).filter(Boolean);
    if (workspaceIds.length !== order.length) {
      setError('Some workspaces are missing identifiers. Please refresh and try again.');
      return;
    }

    setLoading(true);
    setError('');
    try {
      await api.put('/workspaces/order', { workspaceIds });
      onSaved?.(workspaceIds);
    } catch (err) {
      const status = err?.response?.status;
      const backendMsg = err?.response?.data?.message || '';
      // eslint-disable-next-line no-console
      console.error('[RearrangeWorkspaces] save failed:', status, err?.response?.data, '→ tried PUT /api/workspaces/order');

      // Detect the smoking-gun symptom: a stale backend that doesn't have
      // the literal `/order` route registered before `/:id`, so the request
      // gets handled by `updateWorkspace` (which then 500s with "Failed to
      // update workspace.") or by `getWorkspace` ("Failed to fetch
      // workspace."). If we see those, surface a precise restart-the-backend
      // message — never echo them back to the user as-is, because they're
      // misleading for a reorder action.
      const looksLikeWrongHandler = /failed to (update|fetch) workspace/i.test(backendMsg);

      let msg;
      if (status === 404 && /route not found/i.test(backendMsg)) {
        msg = 'Workspace order API route is not available. Please restart the backend or check route registration.';
      } else if (looksLikeWrongHandler) {
        msg = 'Workspace order API route is not available on the running backend (request was handled by the workspace update route). Please restart the backend dev server.';
      } else if (status === 400 && /no longer accessible|do not belong|refresh/i.test(backendMsg)) {
        msg = 'Some workspaces are no longer available. Please refresh and try again.';
      } else if (status === 400) {
        msg = 'Could not save workspace order because the workspace list is invalid.';
      } else if (status === 401) {
        msg = 'Your session has expired. Please log in again and retry.';
      } else if (status === 403) {
        msg = 'You do not have permission to rearrange these workspaces.';
      } else {
        msg = 'Could not save workspace order. Please try again.';
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title="Rearrange Workspaces"
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
        {error && <div className="bg-danger/10 text-danger text-sm px-3 py-2 rounded-md">{error}</div>}

        {order.length === 0 && (
          <p className="text-sm text-text-tertiary text-center py-6">No workspaces to rearrange.</p>
        )}

        <div className="flex flex-col gap-1 max-h-[360px] overflow-y-auto pr-1">
          {order.map((w, i) => {
            const boardCount = Array.isArray(w.boards) ? w.boards.length : null;
            return (
              <div
                key={w.id}
                draggable
                onDragStart={() => onDragStart(w.id)}
                onDragOver={onDragOver}
                onDrop={() => onDrop(w.id)}
                className={`flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-surface-50 dark:bg-[#27272a] cursor-move ${dragId === w.id ? 'opacity-40' : ''}`}>
                <GripVertical size={14} className="text-text-tertiary flex-shrink-0" />
                <div
                  className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0 text-white text-[10px] font-bold"
                  style={{ backgroundColor: w.color || '#0073ea' }}>
                  {(w.name || '?').charAt(0).toUpperCase()}
                </div>
                <span className="flex-1 text-sm truncate text-text-primary">{w.name}</span>
                {boardCount !== null && (
                  <span className="text-[11px] text-text-tertiary flex-shrink-0">
                    {boardCount} {boardCount === 1 ? 'board' : 'boards'}
                  </span>
                )}
                <button onClick={() => move(i, -1)} disabled={i === 0}
                  className="p-1 rounded hover:bg-surface-100 disabled:opacity-30" title="Move up">
                  <ArrowUp size={12} />
                </button>
                <button onClick={() => move(i, 1)} disabled={i === order.length - 1}
                  className="p-1 rounded hover:bg-surface-100 disabled:opacity-30" title="Move down">
                  <ArrowDown size={12} />
                </button>
              </div>
            );
          })}
        </div>

        <p className="text-[11px] text-text-tertiary">
          This order is personal — only you see it. New workspaces added later appear at the end.
        </p>
      </div>
    </Modal>
  );
}
