import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X, Search, Send, Link2, AlertCircle, Users, Calendar, Flag, FileText, Lock } from 'lucide-react';
import api from '../../services/api';
import Avatar from '../common/Avatar';
import { useToast } from '../common/Toast';

const PRIORITIES = [
  { value: 'low',      label: 'Low',      color: '#9aa6b8' },
  { value: 'medium',   label: 'Medium',   color: '#fdab3d' },
  { value: 'high',     label: 'High',     color: '#ff7575' },
  { value: 'critical', label: 'Critical', color: '#e2445c' },
];

const STATUS_LABELS = {
  not_started:  'Not Started',
  working_on_it: 'Working on it',
  stuck:         'Stuck',
  done:          'Done',
  review:        'Review',
};

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Add Dependency dialog.
 *
 * Phase 6: refactored to create a Dependency Request (no Task is created).
 * Body shape matches the canonical POST /api/tasks/:taskId/dependencies:
 *   { title, blockingReason, assignedToUserId, dueDate, priority }
 *
 * Props:
 *   - task        — full parent task object (preferred). Drives the parent
 *                   summary panel.
 *   - taskId      — fallback when task is not available (back-compat).
 *   - taskTitle   — fallback (back-compat).
 *   - boardId     — fallback (back-compat).
 *   - boardName   — optional, surfaced in the parent summary if provided.
 *   - onClose
 *   - onCreated   — called with the new dependency request payload after a
 *                   successful create.
 */
export default function DependencySelector({
  task,
  taskId: taskIdProp,
  taskTitle: taskTitleProp,
  boardId: boardIdProp,
  boardName,
  onClose,
  onCreated,
}) {
  const toast = useToast();

  const taskId = task?.id || taskIdProp;
  const taskTitle = task?.title || taskTitleProp;
  const boardId = task?.boardId || boardIdProp;
  const parentDueDate = task?.dueDate ? String(task.dueDate).slice(0, 10) : null;
  const parentStatus = task?.status || null;
  const parentOwner = task?.assignee || null;
  const parentBoardName = task?.board?.name || boardName || null;

  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState('');
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [title, setTitle] = useState('');
  const [blockingReason, setBlockingReason] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [priority, setPriority] = useState('medium');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useRef(null);

  useEffect(() => {
    api.get('/auth/users').then(res => {
      const all = res.data.users || res.data || [];
      setUsers(all);
    }).catch(() => {});
  }, []);

  // Capture-phase Escape/Tab so this dialog wins over the parent TaskModal's
  // DetailModalShell listeners — without stopImmediatePropagation, Escape
  // would also close the underlying TaskModal, and Tab would let the parent's
  // focus trap pull focus back into the task panel.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        onClose?.();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        const focusable = dialogRef.current.querySelectorAll(FOCUSABLE);
        if (focusable.length === 0) {
          e.preventDefault();
          dialogRef.current.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        const inside = dialogRef.current.contains(active);
        if (e.shiftKey) {
          if (!inside || active === first) { e.preventDefault(); last.focus(); }
        } else {
          if (!inside || active === last) { e.preventDefault(); first.focus(); }
        }
      }
    };
    document.addEventListener('keydown', onKey, true);

    // Move initial focus into this dialog so the user lands here, not in the
    // task modal underneath.
    const focusTimer = setTimeout(() => {
      if (!dialogRef.current) return;
      const first = dialogRef.current.querySelector(FOCUSABLE);
      (first || dialogRef.current).focus({ preventScroll: true });
    }, 60);

    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const filtered = useMemo(() => {
    if (!search) return users;
    const q = search.toLowerCase();
    return users.filter(u =>
      u.name?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q)
    );
  }, [users, search]);

  const selectedUser = users.find(u => u.id === selectedUserId);

  // Soft warning if the dependency due date falls AFTER the parent's due date —
  // doesn't block creation, just warns the requester.
  const dueDateWarning = useMemo(() => {
    if (!dueDate || !parentDueDate) return null;
    return dueDate > parentDueDate
      ? `Heads up: this is after the parent task's due date (${parentDueDate}).`
      : null;
  }, [dueDate, parentDueDate]);

  const canSubmit = !!selectedUserId && !!title.trim() && !saving;

  async function handleSubmit() {
    if (!canSubmit) {
      if (!selectedUserId) setError('Select a teammate to assign.');
      else if (!title.trim()) setError('Enter a dependency title.');
      return;
    }
    setError('');
    setSaving(true);
    try {
      // Canonical endpoint — server dispatcher routes to createDependencyRequest
      // because the body shape (assignedToUserId + title, no dependsOnTaskId)
      // signals a request rather than a legacy task-to-task link.
      const res = await api.post(`/tasks/${taskId}/dependencies`, {
        title: title.trim(),
        blockingReason: blockingReason.trim() || null,
        assignedToUserId: selectedUserId,
        dueDate: dueDate || null,
        priority,
      });
      const created = res.data?.data?.dependencyRequest || res.data?.dependencyRequest || null;
      const assigneeName = selectedUser?.name || 'teammate';
      toast.success(`Dependency request sent to ${assigneeName}.`);
      onCreated?.(created);
      onClose?.();
    } catch (err) {
      const msg = err.response?.data?.message || 'Failed to create dependency request.';
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  // Portal to <body> so this dialog escapes the TaskModal/DetailModalShell
  // stacking context and can render above its z-[100] backdrop. z-[120]
  // matches HelpRequestModal — the established pattern for nested dialogs
  // launched from the task modal.
  return createPortal(
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-[120] p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Add Dependency Request"
        tabIndex={-1}
        className="bg-white rounded-xl shadow-modal w-full max-w-md max-h-[90vh] flex flex-col focus:outline-none"
        onClick={e => e.stopPropagation()}
        onMouseDown={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <div>
            <h2 className="text-base font-semibold text-text-primary flex items-center gap-2">
              <Link2 size={16} className="text-primary" /> Add Dependency
            </h2>
            <p className="text-xs text-text-tertiary mt-0.5">
              Request work from a teammate that must complete before this task can move forward
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-surface text-text-secondary"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {error && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-danger/10 text-danger text-sm">
              <AlertCircle size={14} /> {error}
            </div>
          )}

          {/* Parent task summary — context for the requester so they know
              what they're blocking. */}
          {taskTitle && (
            <div className="px-3 py-2.5 rounded-lg bg-surface/50 border border-border">
              <p className="text-[10px] font-medium text-text-tertiary uppercase tracking-wide mb-1.5">Parent Task</p>
              <p className="text-sm font-semibold text-text-primary mb-1.5">{taskTitle}</p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-tertiary">
                {parentOwner && (
                  <span className="flex items-center gap-1">
                    <Avatar name={parentOwner.name} size="xs" />
                    <span>{parentOwner.name}</span>
                  </span>
                )}
                {parentBoardName && (
                  <span className="flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-sm bg-primary" />
                    {parentBoardName}
                  </span>
                )}
                {parentDueDate && (
                  <span className="flex items-center gap-1">
                    <Calendar size={10} />
                    {parentDueDate}
                  </span>
                )}
                {parentStatus && (
                  <span className="flex items-center gap-1">
                    <Lock size={10} />
                    {STATUS_LABELS[parentStatus] || parentStatus.replace(/_/g, ' ')}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Assignee selector */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              <Users size={11} className="inline mr-1" />
              Assign to *
            </label>
            {selectedUser ? (
              <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-primary/50 bg-primary/5">
                <Avatar name={selectedUser.name} size="xs" />
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-text-primary">{selectedUser.name}</span>
                  <span className="text-[10px] text-text-tertiary ml-2 capitalize">{selectedUser.role}</span>
                </div>
                <button onClick={() => { setSelectedUserId(null); setSearch(''); }}
                  className="p-0.5 rounded hover:bg-surface text-text-tertiary"><X size={14} /></button>
              </div>
            ) : (
              <div className="border border-border rounded-lg overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface/30">
                  <Search size={13} className="text-text-tertiary" />
                  <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                    className="bg-transparent border-none outline-none text-xs w-full placeholder:text-text-tertiary"
                    placeholder="Search teammates..." />
                </div>
                <div className="max-h-[180px] overflow-y-auto">
                  {filtered.length === 0 ? (
                    <p className="text-xs text-text-tertiary text-center py-4">No teammates found</p>
                  ) : filtered.map(u => (
                    <button key={u.id} onClick={() => { setSelectedUserId(u.id); setSearch(''); }}
                      className="flex items-center gap-2.5 w-full px-3 py-2 text-left hover:bg-surface transition-colors">
                      <Avatar name={u.name} size="xs" />
                      <div className="flex-1 min-w-0">
                        <span className="text-xs font-medium text-text-primary">{u.name}</span>
                        <span className="text-[10px] text-text-tertiary ml-1.5 capitalize">({u.role})</span>
                      </div>
                      {u.department && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-surface text-text-tertiary">{u.department}</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Dependency title */}
          {selectedUserId && (
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                Dependency title *
              </label>
              <input type="text" value={title} onChange={e => setTitle(e.target.value)}
                placeholder="e.g., Complete design mockups, Review API specs..."
                className="w-full px-3 py-2 rounded-lg border border-border text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary" />
            </div>
          )}

          {/* Blocking reason */}
          {selectedUserId && (
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                <FileText size={11} className="inline mr-1" />
                Blocking reason (optional)
              </label>
              <textarea value={blockingReason} onChange={e => setBlockingReason(e.target.value)}
                placeholder="Why does this work block the parent task?"
                rows={2}
                className="w-full px-3 py-2 rounded-lg border border-border text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none" />
            </div>
          )}

          {/* Due date + priority — two-column on small screens, fine */}
          {selectedUserId && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">
                  <Calendar size={11} className="inline mr-1" />
                  Due date
                </label>
                <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary" />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">
                  <Flag size={11} className="inline mr-1" />
                  Priority
                </label>
                <select value={priority} onChange={e => setPriority(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary">
                  {PRIORITIES.map(p => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* Soft warning when dep due date is later than parent due date —
              spec calls it out as an edge case worth surfacing without
              blocking submission. */}
          {dueDateWarning && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-orange-50 text-orange-700 text-xs border border-orange-200">
              <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
              <span>{dueDateWarning}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-border flex-shrink-0">
          <button onClick={onClose}
            className="px-4 py-2 text-sm text-text-secondary hover:bg-surface rounded-lg transition-colors">
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={!canSubmit}
            className="flex items-center gap-2 px-5 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-hover disabled:opacity-50 transition-colors shadow-sm">
            {saving
              ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              : <Send size={14} />
            }
            Create Dependency Request
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
