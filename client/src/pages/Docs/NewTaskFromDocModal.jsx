import React, { useEffect, useState } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import Modal from '../../components/common/Modal';
import api from '../../services/api';
import { getErrorMessage } from '../../utils/errorMap';
import safeLog from '../../utils/safeLog';

/**
 * NewTaskFromDocModal — Phase D Slice 2b.
 *
 * Lightweight create-task modal triggered from inside a doc's `+` task
 * picker when the user picks the "Create '<query>' as new task" row. The
 * doc captures the cursor range BEFORE this modal opens; on submit we
 * resolve the created task back to the doc so it can insert the chip at
 * the saved range.
 *
 * Props:
 *   isOpen          — modal open state
 *   workspaceId     — the doc's workspace (boards must belong to it)
 *   initialTitle    — pre-filled from the picker's query
 *   onSubmit(task)  — fires once the task is created server-side
 *   onClose()       — dismiss without creating
 */
export default function NewTaskFromDocModal({
  isOpen, workspaceId, initialTitle, onSubmit, onClose,
}) {
  const [title, setTitle] = useState(initialTitle || '');
  const [boards, setBoards] = useState([]);
  const [boardId, setBoardId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [loadingBoards, setLoadingBoards] = useState(true);
  const [boardsError, setBoardsError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  // Reset state every time the modal opens with a (potentially new) query.
  useEffect(() => {
    if (!isOpen) return;
    setTitle(initialTitle || '');
    setSubmitError('');
    setSubmitting(false);
  }, [isOpen, initialTitle]);

  // Load boards in the doc's workspace. The Slice 2 task picker already
  // walked these via the searchable-tasks endpoint, but the picker doesn't
  // expose the board list separately — we re-fetch from the workspace
  // detail endpoint to get the list + groups.
  useEffect(() => {
    if (!isOpen || !workspaceId) return undefined;
    let cancelled = false;
    setLoadingBoards(true);
    setBoardsError('');
    api.get(`/workspaces/${workspaceId}`)
      .then((res) => {
        if (cancelled) return;
        const data = res.data?.data ?? res.data ?? {};
        const ws = data.workspace || data;
        const list = Array.isArray(ws?.boards) ? ws.boards : [];
        setBoards(list);
        if (list.length > 0) {
          setBoardId(list[0].id);
          const firstGroup = (list[0].groups && list[0].groups[0]) || null;
          setGroupId(firstGroup?.id || '');
        }
      })
      .catch((err) => {
        safeLog.warn('[NewTaskFromDocModal] load boards', err);
        if (!cancelled) setBoardsError(getErrorMessage(err));
      })
      .finally(() => { if (!cancelled) setLoadingBoards(false); });
    return () => { cancelled = true; };
  }, [isOpen, workspaceId]);

  // When the selected board changes, default the group to its first group.
  useEffect(() => {
    if (!boardId) { setGroupId(''); return; }
    const b = boards.find((x) => x.id === boardId);
    const firstGroup = (b?.groups && b.groups[0]) || null;
    setGroupId(firstGroup?.id || '');
  }, [boardId, boards]);

  const canSubmit = !!title.trim() && !!boardId && !submitting;

  async function handleSubmit(e) {
    e?.preventDefault?.();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const payload = { title: title.trim(), boardId };
      if (groupId) payload.groupId = groupId;
      const res = await api.post('/tasks', payload);
      const body = res.data?.data ?? res.data ?? {};
      const task = body.task || body;
      if (!task?.id) throw new Error('Server returned no task.');
      onSubmit?.(task);
      onClose?.();
    } catch (err) {
      safeLog.error('[NewTaskFromDocModal] create task error', err);
      setSubmitError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  const selectedBoard = boards.find((b) => b.id === boardId);
  const groups = Array.isArray(selectedBoard?.groups) ? selectedBoard.groups : [];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Create new task"
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-[12px] font-medium text-text-secondary border border-border bg-surface rounded-md hover:bg-surface-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold text-white bg-primary rounded-md hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting && <Loader2 size={12} className="animate-spin" />}
            Create + insert chip
          </button>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="block text-[11px] font-semibold text-text-secondary mb-1 uppercase tracking-wide">
            Title
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs to be done?"
            maxLength={300}
            className="w-full px-2.5 py-1.5 text-sm bg-surface border border-border rounded-md outline-none focus:border-primary"
          />
        </div>

        <div>
          <label className="block text-[11px] font-semibold text-text-secondary mb-1 uppercase tracking-wide">
            Board
          </label>
          {loadingBoards ? (
            <div className="text-[12px] text-text-tertiary inline-flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin" /> Loading workspace boards…
            </div>
          ) : boardsError ? (
            <div className="text-[12px] text-danger inline-flex items-center gap-1.5">
              <AlertCircle size={12} /> {boardsError}
            </div>
          ) : boards.length === 0 ? (
            <div className="text-[12px] text-text-tertiary">
              This workspace has no boards yet. Create one first.
            </div>
          ) : (
            <select
              value={boardId}
              onChange={(e) => setBoardId(e.target.value)}
              className="w-full px-2.5 py-1.5 text-sm bg-surface border border-border rounded-md outline-none focus:border-primary"
            >
              {boards.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          )}
        </div>

        {groups.length > 0 && (
          <div>
            <label className="block text-[11px] font-semibold text-text-secondary mb-1 uppercase tracking-wide">
              Group
            </label>
            <select
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              className="w-full px-2.5 py-1.5 text-sm bg-surface border border-border rounded-md outline-none focus:border-primary"
            >
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.title || g.name || 'Untitled group'}</option>
              ))}
            </select>
          </div>
        )}

        {submitError && (
          <div className="text-[12px] text-danger inline-flex items-center gap-1.5">
            <AlertCircle size={12} /> {submitError}
          </div>
        )}
      </form>
    </Modal>
  );
}
