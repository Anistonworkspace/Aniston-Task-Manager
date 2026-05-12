import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Search, Filter, SortAsc, Plus, Columns3, Calendar, Settings,
  LayoutGrid, Zap, Download, Upload, Eye, EyeOff, Archive, ChevronDown, GanttChart, MoreHorizontal,
  AlertCircle
} from 'lucide-react';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useT } from '../context/LanguageContext';
import useRealtimeQuery from '../realtime/useRealtimeQuery';
import useRealtimeEvent from '../realtime/useRealtimeEvent';
import { joinBoard, leaveBoard } from '../services/socket';
import { DEFAULT_COLUMNS, getBoardStatuses } from '../utils/constants';
import TaskGroup from '../components/board/TaskGroup';
import TaskModal from '../components/task/TaskModal';
import BoardSettingsModal from '../components/board/BoardSettingsModal';
import AdvancedFilters from '../components/board/AdvancedFilters';
import KanbanView from '../components/board/KanbanView';
import AutomationsPanel from '../components/board/AutomationsPanel';
import BulkActionBar from '../components/board/BulkActionBar';
import CalendarView from '../components/board/CalendarView';
import SortDropdown from '../components/board/SortDropdown';
import CSVImportModal from '../components/board/CSVImportModal';
import DueDateExtensionModal from '../components/board/DueDateExtensionModal';
import TimelineView from '../components/board/TimelineView';
import { SkeletonBoard } from '../components/common/Skeleton';
import { useToast } from '../components/common/Toast';
import { sortTasksByPendingPriority } from '../utils/taskPrioritization';
import { canUser as canUserFn } from '../utils/permissions';
import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';

// Compact "Create new group" dialog — replaces the legacy flow that created
// an immediate "New Group" placeholder and forced an inline rename. Same
// visual treatment as the rest of the app: white card on light, [#1E1F23]
// on dark, primary blue submit, ghost cancel. Validation rules:
//   - title required (no whitespace-only)
//   - max 80 chars (matches POST /api/boards/:id/groups validator)
//   - Enter submits, Escape closes, click-outside closes
//   - submit button stays disabled while the request is in flight
function CreateGroupDialog({ open, onClose, onCreate }) {
  const [name, setName] = React.useState('');
  const [error, setError] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const inputRef = React.useRef(null);
  const dialogRef = React.useRef(null);
  const MAX_LEN = 80;

  // Reset every time the dialog (re)opens so an old error doesn't survive
  // close → reopen, and autofocus the input for keyboard-first flow.
  React.useEffect(() => {
    if (open) {
      setName('');
      setError('');
      setSubmitting(false);
      // setTimeout so the input exists in the DOM before .focus() runs.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Escape closes; outside click closes (click-outside handler is attached
  // to the backdrop element below). Don't intercept Esc when not open.
  React.useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      if (e.key === 'Escape' && !submitting) onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, submitting, onClose]);

  if (!open) return null;

  async function handleSubmit(e) {
    e?.preventDefault?.();
    if (submitting) return;
    const trimmed = (name || '').trim();
    if (!trimmed) { setError('Group name is required.'); return; }
    if (trimmed.length > MAX_LEN) { setError(`Group name must be ${MAX_LEN} characters or fewer.`); return; }
    setSubmitting(true);
    setError('');
    try {
      await onCreate(trimmed);
      // Parent closes us on success.
    } catch (err) {
      // Keep the dialog open on failure and surface the message inline.
      const msg = err?.response?.data?.message || err?.message || 'Failed to create group.';
      setError(msg);
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[120] bg-black/40 flex items-center justify-center p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !submitting) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-group-dialog-title"
        className="w-full max-w-sm bg-white dark:bg-[#1E1F23] rounded-xl shadow-xl border border-border overflow-hidden"
      >
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-5">
          <h2
            id="create-group-dialog-title"
            className="text-base font-semibold text-text-primary dark:text-white"
          >
            Create new group
          </h2>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="create-group-input"
              className="text-xs font-medium text-text-secondary dark:text-zinc-300"
            >
              Group name
            </label>
            <input
              id="create-group-input"
              ref={inputRef}
              type="text"
              value={name}
              maxLength={MAX_LEN}
              onChange={(e) => { setName(e.target.value); if (error) setError(''); }}
              placeholder="e.g. Sprint 24"
              className="w-full px-3 py-2 text-sm rounded-md border border-border bg-white dark:bg-[#1E1F23] text-text-primary dark:text-white placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              disabled={submitting}
            />
            {error && (
              <span className="text-xs text-red-500 mt-0.5">{error}</span>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-3 py-1.5 text-sm rounded-md text-text-secondary hover:bg-surface-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-3 py-1.5 text-sm rounded-md bg-[#0073ea] text-white hover:bg-[#0060c2] transition-colors disabled:opacity-60 font-medium"
            >
              {submitting ? 'Creating…' : 'Create group'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Monday.com-style dropdown for "New task" split button
function NewTaskDropdown({ onNewGroup, onImport, canCreateGroup, canImport, onClose }) {
  const ref = React.useRef(null);
  const t = useT();
  React.useEffect(() => {
    function handleClick(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  return (
    <div ref={ref} className="absolute left-0 top-full mt-1 w-[200px] bg-white rounded-lg shadow-dropdown border border-[#e6e9ef] z-50 dropdown-enter overflow-hidden py-1">
      {canCreateGroup && (
        <button onClick={onNewGroup}
          className="w-full flex items-center gap-2.5 px-4 py-[8px] text-[13px] text-[#323338] hover:bg-[#f5f6f8] transition-colors">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="2" rx="0.5" fill="#676879"/><rect x="2" y="7" width="12" height="2" rx="0.5" fill="#676879"/><rect x="2" y="11" width="12" height="2" rx="0.5" fill="#676879"/></svg>
          {t('board.toolbar.newGroupOfTasks')}
        </button>
      )}
      {canImport && (
        <button onClick={onImport}
          className="w-full flex items-center gap-2.5 px-4 py-[8px] text-[13px] text-[#323338] hover:bg-[#f5f6f8] transition-colors">
          <Download size={15} className="text-[#676879]" />
          {t('board.toolbar.importTasks')}
        </button>
      )}
    </div>
  );
}

export default function BoardPage() {
  const { id: boardId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, canManage, isSuperAdmin, permissionGrants, effectivePermissions, granularPermissions } = useAuth();
  const t = useT();
  const canCreateTask = canUserFn(user?.role, 'create_task', isSuperAdmin, permissionGrants, effectivePermissions);
  const canEditBoard = canUserFn(user?.role, 'edit_board', isSuperAdmin, permissionGrants, effectivePermissions);
  // create_group is now base-allowed for every role. The user must already be
  // on the board page to reach this code, which means getBoard let them
  // through, so they have at least board view access. The backend
  // POST /boards/:id/groups controller does the canonical access check via
  // boardVisibilityService; this flag just matches that outcome for UX.
  const canCreateGroup = canUserFn(user?.role, 'create_group', isSuperAdmin, permissionGrants, effectivePermissions);
  // Whether the actor can assign tasks to other users. When false, the inline
  // "+ Add task" payload explicitly self-assigns so the task is created as a
  // personal task without going through the "missing owner" path on the server.
  const canAssignOthers = isSuperAdmin || !!granularPermissions?.['tasks.assign_others'];
  const { error: toastError, success: toastSuccess } = useToast();
  const [board, setBoard] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  // True iff the most recent loadBoard() OR loadTasks() failed with a server
  // error (5xx / network). Used to (a) hide misleading empty-state copy like
  // "No tasks assigned to you" while the server is broken, and (b) guarantee
  // a single user-facing toast per failed load even when both endpoints fail
  // in the same render — the global api.js interceptor is bypassed via
  // `_silent` on these two requests so we only show our own message here.
  const [loadError, setLoadError] = useState(null);
  const [selectedTask, setSelectedTask] = useState(null);
  const [viewTab, setViewTab] = useState('table');
  const [searchQuery, setSearchQuery] = useState('');
  const [advFilters, setAdvFilters] = useState({ status: [], priority: [], person: '' });
  const [showFilters, setShowFilters] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAutomations, setShowAutomations] = useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = useState([]);
  const [sortConfig, setSortConfig] = useState(null);
  const [showCSVImport, setShowCSVImport] = useState(false);
  const [extensionTask, setExtensionTask] = useState(null);
  const [showNewTaskMenu, setShowNewTaskMenu] = useState(false);
  // Controls the "Create new group" dialog. Replaces the legacy flow that
  // immediately created a placeholder "New Group" and forced inline rename.
  const [showCreateGroupDialog, setShowCreateGroupDialog] = useState(false);
  // Inline-subtask expanded set — array of task IDs that are currently
  // showing their nested subtask section in the board table. Lives on
  // BoardPage so it survives task-group re-renders.
  const [expandedTaskIds, setExpandedTaskIds] = useState([]);
  const [hiddenColumns, setHiddenColumns] = useState(() => {
    return JSON.parse(localStorage.getItem(`board_hidden_cols_${boardId}`) || '[]');
  });
  const [showHideColumns, setShowHideColumns] = useState(false);

  // Board columns — merge default + custom.
  //
  // Architecture note: the previous deploy stored references + links in
  // `board.columns` (the JSONB column on the Board model) via a server-side
  // backfill, but the FRONTEND never reads `board.columns` — it only reads
  // `DEFAULT_COLUMNS` (hardcoded) and `board.customColumns` (user-added).
  // That's why those columns were missing from the UI even though the DB
  // had them. The fix is to auto-append the new default columns here,
  // mirroring the existing pattern for `progress` and `label`. We dedup
  // on BOTH id and type so an existing custom column of the same kind
  // (e.g. a user manually added a 'references' column) doesn't render
  // twice. The hidden-columns localStorage filter still applies — if a
  // user explicitly hid the column via the Hide menu, that intent wins.
  const allColumns = useMemo(() => {
    const boardCustomCols = board?.customColumns || [];
    const baseCols = [...DEFAULT_COLUMNS];
    if (!baseCols.find(c => c.id === 'progress' || c.type === 'progress')) {
      baseCols.push({ id: 'progress', title: 'Progress', type: 'progress', width: 130 });
    }
    if (!baseCols.find(c => c.id === 'label' || c.type === 'label')) {
      baseCols.push({ id: 'label', title: 'Labels', type: 'label', width: 120 });
    }
    // P2-4 — dedup on TYPE only. The earlier `c.id === 'references' || c.type === 'references'`
    // version over-matched: a legacy custom column with `id: 'references'`
    // but a different `type` (e.g. text) would block the new default
    // references column from rendering. Type is the semantic identity
    // the renderer keys off, so dedup on type alone is the right rule.
    const combined = [...baseCols, ...boardCustomCols];
    if (!combined.find(c => c.type === 'references')) {
      baseCols.push({ id: 'references', title: 'Reference', type: 'references', width: 180 });
    }
    if (!combined.find(c => c.type === 'links')) {
      baseCols.push({ id: 'links', title: 'Link/URL', type: 'links', width: 180 });
    }
    return [...baseCols, ...boardCustomCols];
  }, [board?.customColumns]);

  // Visible columns (exclude hidden, apply saved widths + order)
  const visibleColumns = useMemo(() => {
    const widths = JSON.parse(localStorage.getItem(`board_col_widths_${boardId}`) || '{}');
    const savedOrder = JSON.parse(localStorage.getItem(`board_col_order_${boardId}`) || '[]');
    let cols = allColumns
      .filter(col => !hiddenColumns.includes(col.id))
      .map(col => ({ ...col, width: widths[col.id] || col.width }));
    // Apply saved column order if available
    if (savedOrder.length > 0) {
      cols.sort((a, b) => {
        const ai = savedOrder.indexOf(a.id);
        const bi = savedOrder.indexOf(b.id);
        // Columns not in savedOrder go to the end
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      });
    }
    return cols;
  }, [allColumns, hiddenColumns, board?._resizeTick, board?._reorderTick, boardId]);

  // Persist hidden columns
  useEffect(() => {
    localStorage.setItem(`board_hidden_cols_${boardId}`, JSON.stringify(hiddenColumns));
  }, [hiddenColumns, boardId]);

  const loadBoard = useCallback(async () => {
    try {
      const [boardRes, usersRes] = await Promise.all([
        // _silent suppresses the global api-error toast — we surface a single
        // local toast (or none, if loadTasks already did) so the user doesn't
        // see "Server error fetching board" stacked with our cleaner message.
        api.get(`/boards/${boardId}`, { _silent: true }),
        api.get('/auth/assignable-users'),
      ]);
      const data = boardRes.data.board || boardRes.data;
      setBoard(data);
      const allUsers = usersRes.data.users || usersRes.data || [];
      setMembers(allUsers.length > 0 ? allUsers : data.members || data.Users || []);
      setLoadError(null);
    } catch (err) {
      console.error('[BoardPage] loadBoard error:', err);
      // If access denied (403), redirect to home instead of showing broken board
      if (err?.response?.status === 403) {
        toastError('You do not have access to this board.');
        navigate('/');
        return;
      }
      if (err?.response?.status === 404) {
        toastError('This board no longer exists.');
        navigate('/');
        return;
      }
      // Server / network failure: set the error flag and emit ONE toast.
      // The toast component already dedupes identical (type+message) pairs in
      // a 1.5s window, so even if loadTasks fails moments later with the same
      // string, only one toast is rendered.
      setLoadError('board');
      toastError('We could not load this board. Please refresh the page.');
    }
  }, [boardId, navigate, toastError]);

  const loadTasks = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      params.set('boardId', boardId);
      if (advFilters.person) params.set('assignedTo', advFilters.person);
      if (searchQuery) params.set('search', searchQuery);
      const res = await api.get(`/tasks?${params.toString()}`, { _silent: true });
      let fetched = res.data.tasks || res.data || [];
      if (advFilters.status.length > 0) {
        fetched = fetched.filter(t => advFilters.status.includes(t.status));
      }
      if (advFilters.priority.length > 0) {
        fetched = fetched.filter(t => advFilters.priority.includes(t.priority));
      }
      // Filter out archived tasks
      fetched = fetched.filter(t => !t.isArchived);
      setTasks(fetched);
      // Only clear loadError if it was set by tasks specifically — leave a
      // 'board' error in place so the empty-state replacement still wins.
      setLoadError((cur) => (cur === 'tasks' ? null : cur));
    } catch (err) {
      console.error('[BoardPage] loadTasks error:', err);
      // If loadBoard already surfaced a toast for the same incident, the
      // dedup window in Toast.jsx will swallow this one. We still set the
      // error flag so the empty-state copy is replaced regardless.
      setLoadError((cur) => cur || 'tasks');
      toastError('We could not load this board. Please refresh the page.');
    } finally {
      setLoading(false);
    }
  }, [boardId, advFilters, searchQuery, toastError]);

  useEffect(() => { loadBoard(); }, [loadBoard]);
  useEffect(() => { loadTasks(); }, [loadTasks]);

  // Deep-link: open the task referenced by ?taskId=... once tasks finish loading.
  // Used by MemberDrillDown and RecurringWorkPage to jump from a task tile
  // straight into the TaskModal. The param is consumed (removed) on open so a
  // refresh doesn't re-open the modal and so closing the modal doesn't leave
  // a stale id in the URL.
  useEffect(() => {
    const targetId = searchParams.get('taskId');
    if (!targetId || loading) return;
    const target = tasks.find(t => t.id === targetId);
    if (!target) return;
    setSelectedTask(target);
    const next = new URLSearchParams(searchParams);
    next.delete('taskId');
    setSearchParams(next, { replace: true });
  }, [tasks, loading, searchParams, setSearchParams]);

  useEffect(() => {
    if (boardId) joinBoard(boardId);
    return () => { if (boardId) leaveBoard(boardId); };
  }, [boardId]);

  // ── Inline-subtask helpers ───────────────────────────────────────────
  const toggleSubtasksFor = useCallback((taskId) => {
    setExpandedTaskIds((prev) => prev.includes(taskId) ? prev.filter(id => id !== taskId) : [...prev, taskId]);
  }, []);
  // BoardSubtaskSection reports updated totals up so the ListChecks badge
  // on the row title reflects new/edited/deleted subtasks immediately,
  // even while the row stays loaded in memory.
  //
  // Equality guard: if total + done are already what the row holds, we MUST
  // skip setTasks. Otherwise every load() inside BoardSubtaskSection would
  // produce a new task object even when nothing changed — and a new task
  // object reference re-renders TaskGroup → re-renders BoardSubtaskSection
  // with a fresh `onCountsChange` closure → if any consumer ever uses that
  // closure as an effect dependency, it loops. Defensive at the source.
  const handleSubtaskCountsChange = useCallback((taskId, counts) => {
    setTasks(prev => {
      let changed = false;
      const next = prev.map(t => {
        if (t.id !== taskId) return t;
        if ((t.subtaskTotal || 0) === counts.total && (t.subtaskDone || 0) === counts.done) {
          return t;
        }
        changed = true;
        return { ...t, subtaskTotal: counts.total, subtaskDone: counts.done, _subtaskCounts: counts };
      });
      return changed ? next : prev;
    });
    setSelectedTask(prev => {
      if (!prev || prev.id !== taskId) return prev;
      if ((prev.subtaskTotal || 0) === counts.total && (prev.subtaskDone || 0) === counts.done) return prev;
      return { ...prev, subtaskTotal: counts.total, subtaskDone: counts.done, _subtaskCounts: counts };
    });
  }, []);

  // ── Realtime subscription via the Phase 3 invalidation registry ─────
  //
  // ONE queryKey replaces the old chain of useSocket('task:created'/...)
  // listeners. The eventRouter knows that any task/subtask/dependency event
  // for THIS board invalidates `tasks.board.<boardId>`, so loadTasks() runs
  // once. No more hand-maintaining "which 11 events make this page refetch?".
  useRealtimeQuery({
    queryKey: `tasks.board.${boardId}`,
    refetch: loadTasks,
    enabled: !!boardId,
  });

  // The events below still need the raw payload because they patch state
  // in place rather than refetching — keeping the row stable, preserving
  // scroll position, avoiding flicker on every status flip.

  // task:updated → patch in place (groupId / status / fields).
  useRealtimeEvent('task:updated', (data) => {
    const tBoardId = data?.boardId || data?.task?.boardId;
    if (tBoardId !== boardId) return;
    const tId = data?.taskId || data?.task?.id;
    if (!tId) return;
    setTasks(prev => prev.map(t => t.id === tId ? { ...t, ...(data.task || {}) } : t));
  });

  // task:deleted → drop the row immediately so the user sees it disappear
  // before the refetch fires.
  useRealtimeEvent('task:deleted', (data) => {
    const tId = data?.taskId;
    if (tId) setTasks(prev => prev.filter(t => t.id !== tId));
  });

  // board:updated → swap the board metadata (name, columns, groups).
  useRealtimeEvent('board:updated', (data) => {
    if (data?.board?.id === boardId) setBoard(data.board);
  });

  // board:memberRemoved → fired by socketService.emitToUser to the AFFECTED
  // user's room only (admin manual remove OR auto-cleanup after the user's
  // last task on this board is unassigned/deleted). If the recipient is
  // currently sitting on that board page, their next action would 403 —
  // bounce them to home with a toast instead. The targeted nature of the
  // emit (user-room, not board-room) means we can react unconditionally
  // when the boardId matches: the only way to receive it is to BE the
  // affected user.
  useRealtimeEvent('board:memberRemoved', (data) => {
    if (data?.boardId !== boardId) return;
    toastError('Your access to this board was removed.');
    navigate('/');
  });

  // Subtask badge bumps — keep the count accurate even when the section is
  // collapsed (BoardSubtaskSection handles itself when expanded).
  useRealtimeEvent('subtask:created', (data) => {
    const tId = data?.taskId;
    if (!tId) return;
    setTasks(prev => prev.map(t => t.id === tId
      ? { ...t, subtaskTotal: (t.subtaskTotal || 0) + 1 }
      : t));
  });
  useRealtimeEvent('subtask:deleted', (data) => {
    const tId = data?.taskId;
    if (!tId) return;
    setTasks(prev => prev.map(t => t.id === tId
      ? { ...t, subtaskTotal: Math.max(0, (t.subtaskTotal || 0) - 1) }
      : t));
  });

  // Approval flows — patch the in-row indicator AND any open TaskModal
  // (selectedTask is its own piece of state).
  useRealtimeEvent('task:approval-updated', (data) => {
    if (!data?.taskId || !Array.isArray(data?.flows)) return;
    setTasks(prev => prev.map(t => t.id === data.taskId ? { ...t, approvalFlows: data.flows } : t));
    setSelectedTask(prev => (prev && prev.id === data.taskId ? { ...prev, approvalFlows: data.flows } : prev));
  });

  // Receipts — only the assigner (creator) has a receipt row; skip otherwise.
  useRealtimeEvent('task:receipt', (data) => {
    if (!data?.taskId || !data?.summary) return;
    if (data.boardId && data.boardId !== boardId) return;
    if (data.createdBy && user?.id && data.createdBy !== user.id) return;
    setTasks(prev => prev.map(t => t.id === data.taskId ? { ...t, _receipt: data.summary } : t));
  });

  // References / Links — multi-value columns saved by ReferenceCell &
  // LinksCell directly against /api/task-references and /api/task-links.
  // The emitting tab already patched its own state; this listener handles
  // OTHER tabs / other users with the same board open. We refetch the
  // single task's collections rather than the whole board to keep it cheap.
  useRealtimeEvent('task:references_updated', async (data) => {
    const tId = data?.taskId;
    if (!tId) return;
    try {
      const res = await api.get(`/task-references/task/${tId}`);
      const references = res.data?.references || res.data?.data?.references || [];
      setTasks(prev => prev.map(t => t.id === tId ? { ...t, references } : t));
      setSelectedTask(prev => (prev && prev.id === tId ? { ...prev, references } : prev));
    } catch { /* non-fatal — next full refetch will heal */ }
  });
  useRealtimeEvent('task:links_updated', async (data) => {
    const tId = data?.taskId;
    if (!tId) return;
    try {
      const res = await api.get(`/task-links/task/${tId}`);
      const taskLinks = res.data?.links || res.data?.data?.links || [];
      setTasks(prev => prev.map(t => t.id === tId ? { ...t, taskLinks } : t));
      setSelectedTask(prev => (prev && prev.id === tId ? { ...prev, taskLinks } : prev));
    } catch { /* non-fatal */ }
  });

  // Labels — emitted by /api/labels/assign and /api/labels/unassign. We
  // refetch the task's labels via the dedicated /labels/task/:id endpoint
  // (cheap, returns just [{id, name, color}]) and patch both the row and
  // the open modal so the Labels column + the modal's Labels tile stay
  // identical without a full board reload.
  useRealtimeEvent('task:labels_updated', async (data) => {
    const tId = data?.taskId;
    if (!tId) return;
    try {
      const res = await api.get(`/labels/task/${tId}`);
      const labels = res.data?.labels || res.data?.data?.labels || [];
      setTasks(prev => prev.map(t => t.id === tId ? { ...t, labels } : t));
      setSelectedTask(prev => (prev && prev.id === tId ? { ...prev, labels } : prev));
    } catch { /* non-fatal */ }
  });

  async function handleAddTask(groupId, title, description) {
    // Quick-create payload: send ONLY the fields the user actually picked.
    // Reasons:
    //   - `assignedTo` is omitted because the global rule is "no assignment
    //     without a due date" and the inline row has no due-date input.
    //   - `priority` is omitted because the `tasks.set_priority` gate 403s a
    //     member who passes any priority value, even the default 'medium'.
    //     The backend already defaults Task.priority to 'medium' at the
    //     model layer, so the row still gets a Medium pill — we just don't
    //     pretend the user *chose* it.
    //   - `status` is omitted for the same reason; backend defaults to
    //     'not_started' and the validators are happy without it.
    // Position is the only derived value we still compute client-side
    // because the backend's append-to-end heuristic uses Task.max(), which
    // can lag behind the freshly-rendered list during rapid quick-adds.

    // ── Defensive client-side normalization ────────────────────────────
    // The production 400 audit showed every intermittent failure came from
    // an empty / over-long title or an accidentally-stringified groupId.
    // Normalize at the boundary so the only requests that leave the page
    // are ones the backend will accept; surface a specific, actionable
    // toast for anything we can catch locally.
    const cleanTitle = typeof title === 'string' ? title.trim() : '';
    if (!cleanTitle) {
      toastError('Task title is required.');
      const err = new Error('Task title is required.');
      err.code = 'client_validation';
      throw err;
    }
    if (cleanTitle.length > 300) {
      toastError('Task title is too long (max 300 characters). Please shorten it and try again.');
      const err = new Error('Task title is too long.');
      err.code = 'client_validation';
      throw err;
    }

    const cleanGroupId = typeof groupId === 'string' && groupId.trim() !== ''
      ? groupId.trim() : undefined;
    if (!boardId) {
      // boardId is set from useParams — if it's somehow missing the page is in
      // a broken state. Fail fast with a clear message rather than 400ing on
      // the server.
      toastError('Cannot add task: this board is no longer loaded. Please refresh the page.');
      const err = new Error('Missing boardId.');
      err.code = 'client_validation';
      throw err;
    }

    const payload = {
      title: cleanTitle,
      boardId,
      // Compute position client-side against the freshest tasks snapshot so
      // back-to-back quick-adds don't all land on the same position. The
      // backend re-derives position via Task.max(); this is purely a
      // tie-breaker so the optimistic row appears at the end of the group.
      position: tasks.filter(t => t.groupId === cleanGroupId).length,
    };
    if (cleanGroupId) payload.groupId = cleanGroupId;
    const trimmedDescription = typeof description === 'string' ? description.trim() : '';
    if (trimmedDescription) {
      payload.description = trimmedDescription;
    }
    try {
      // `_silent: true` keeps the global api-error toast from firing on top
      // of the local toast below — otherwise a 4xx surfaces TWO toasts
      // ("Request failed with status code 400" from the axios fallback +
      // "Failed to add task..." here), which is the exact double-toast
      // reported in production.
      const res = await api.post('/tasks', payload, { _silent: true });
      const newTask = res.data.task || res.data;
      setTasks(prev => [...prev, newTask]);
      return newTask;
    } catch (err) {
      console.error('[BoardPage] handleAddTask error:', err);
      // Prefer the server-supplied message (we now ALWAYS return a `message`
      // field — see taskController.createTask). Fall through to the
      // validator-error array if a legacy/older deploy is still returning
      // `errors` without a `message`. Last resort is the generic toast.
      const data = err?.response?.data || {};
      const apiMsg = data.message
        || (Array.isArray(data.errors) && data.errors[0] && (data.errors[0].msg || data.errors[0].message))
        || null;
      toastError(apiMsg || 'Failed to add task. Please try again.');
      // Re-throw so inline callers (e.g. TaskGroup) can keep the typed input
      // and avoid clearing the row on failure.
      throw err;
    }
  }

  async function handleTaskUpdate(taskId, updates) {
    try {
      const res = await api.put(`/tasks/${taskId}`, updates);
      // Use the full task from server response to get correct assignedTo/taskAssignees
      const serverTask = res.data?.task || res.data?.data?.task;
      const mergeData = serverTask || updates;
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, ...mergeData } : t));
      if (selectedTask?.id === taskId) setSelectedTask(prev => ({ ...prev, ...mergeData }));
    } catch (err) {
      console.error('[BoardPage] handleTaskUpdate error:', err);
      // 4xx responses already surface their specific server messages via
      // the global api-error → toast pipeline (e.g. "Dependency owners
      // cannot complete the parent task..."). Showing a generic "Failed to
      // update task" on top would contradict the real reason. Reserve the
      // generic toast for network failures and 5xx where the user has no
      // other useful text to read.
      const status = err.response?.status;
      if (!status || status >= 500) {
        toastError('Failed to update task. Please try again.');
      }
    }
  }

  async function handleArchiveTask(taskId) {
    try {
      await api.put(`/tasks/${taskId}`, { isArchived: true });
      setTasks(prev => prev.filter(t => t.id !== taskId));
    } catch (err) {
      console.error('[BoardPage] handleArchiveTask error:', err);
      toastError('Failed to archive task. Please try again.');
    }
  }

  function handleTaskDelete(taskId) {
    // NO DELETE — archive instead
    handleArchiveTask(taskId);
  }

  async function handleArchiveGroup(groupId) {
    try {
      // Archive all tasks in this group
      const groupTasks = tasks.filter(t => t.groupId === groupId);
      await Promise.all(groupTasks.map(t => api.put(`/tasks/${t.id}`, { isArchived: true })));

      // Move group from groups → archivedGroups (preserve group info)
      const archivedGroup = groups.find(g => g.id === groupId);
      const updatedGroups = groups.filter(g => g.id !== groupId);
      const currentArchivedGroups = board?.archivedGroups || [];
      const updatedArchivedGroups = [...currentArchivedGroups, { ...archivedGroup, archivedAt: new Date().toISOString(), taskCount: groupTasks.length }];

      await api.put(`/boards/${boardId}`, { groups: updatedGroups, archivedGroups: updatedArchivedGroups });
      setBoard(prev => ({ ...prev, groups: updatedGroups, archivedGroups: updatedArchivedGroups }));
      setTasks(prev => prev.filter(t => t.groupId !== groupId));
      toastSuccess('Group archived');
    } catch (err) {
      console.error('[BoardPage] handleArchiveGroup error:', err);
      toastError('Failed to archive group. Please try again.');
    }
  }

  // Rename a single group via the dedicated PATCH endpoint so members and
  // assistant managers (who only have create_board / rename_board, not
  // edit_board) can rename a group on a board they can reach. Backend gates
  // the route by boardVisibilityService.canUserSeeBoard.
  async function handleRenameGroup(groupId, newName) {
    const trimmed = (newName || '').trim();
    if (!trimmed) {
      toastError('Group name is required.');
      return;
    }
    try {
      const { data } = await api.patch(`/boards/${boardId}/groups/${groupId}`, {
        title: trimmed,
      });
      // Trust the canonical groups array the server returns over an
      // optimistic merge — it reflects sanitization and any concurrent
      // changes the socket broadcast may surface a moment later.
      const serverGroups = data?.data?.groups
        || (groups.map(g => g.id === groupId ? { ...g, title: trimmed, name: trimmed } : g));
      setBoard(prev => ({ ...prev, groups: serverGroups }));
      toastSuccess('Group renamed');
    } catch (err) {
      console.error('[BoardPage] handleRenameGroup error:', err);
      const msg = err?.response?.data?.message || 'Failed to rename group. Please try again.';
      toastError(msg);
    }
  }

  function handleSelectTask(taskId, selected) {
    setSelectedTaskIds(prev =>
      selected ? [...prev, taskId] : prev.filter(id => id !== taskId)
    );
  }

  // ── Column management ────────────────────────────────────────────────
  // All mutations use a single helper that optimistically applies the new
  // customColumns array, rolls the UI back if the server rejects, and lets
  // the global axios 403 interceptor handle the user-facing toast. This
  // prevents the "column appears, but 'no permission' toast fires" state
  // that the old silent .catch(console.error) left behind.
  async function saveCustomColumns(nextCols, { previousCols, failureToast } = {}) {
    const prevCols = previousCols ?? (board?.customColumns || []);
    setBoard(prev => ({ ...prev, customColumns: nextCols }));
    try {
      const res = await api.put(`/boards/${boardId}`, { customColumns: nextCols });
      // Trust the server response so we pick up any server-side normalisation.
      const serverBoard = res.data?.board || res.data?.data?.board;
      if (serverBoard?.customColumns) {
        setBoard(prev => ({ ...prev, customColumns: serverBoard.customColumns }));
      }
      return true;
    } catch (err) {
      console.error('[BoardPage] saveCustomColumns error:', err);
      setBoard(prev => ({ ...prev, customColumns: prevCols }));
      // The axios interceptor already surfaces 403/5xx toasts. Only add a
      // local toast for cases it wouldn't cover (network error, etc.).
      if (failureToast && !err.response) {
        toastError(failureToast);
      }
      return false;
    }
  }

  function handleEditColumn(colId, updates) {
    const prevCols = [...(board?.customColumns || [])];
    const idx = prevCols.findIndex(c => c.id === colId);
    if (idx >= 0) {
      const nextCols = [...prevCols];
      nextCols[idx] = { ...nextCols[idx], ...updates };
      saveCustomColumns(nextCols, { previousCols: prevCols });
    }
    // For default columns, we save title overrides in localStorage
    const overrides = JSON.parse(localStorage.getItem(`board_col_titles_${boardId}`) || '{}');
    overrides[colId] = updates.title;
    localStorage.setItem(`board_col_titles_${boardId}`, JSON.stringify(overrides));
  }

  function handleAddColumn(col, afterColumnId) {
    const prevCols = [...(board?.customColumns || [])];
    const nextCols = [...prevCols];
    if (afterColumnId) {
      const idx = nextCols.findIndex(c => c.id === afterColumnId);
      nextCols.splice(idx >= 0 ? idx + 1 : nextCols.length, 0, col);
    } else {
      nextCols.push(col);
    }
    saveCustomColumns(nextCols, { previousCols: prevCols });
  }

  function handleRemoveColumn(colId) {
    const prevCols = [...(board?.customColumns || [])];
    const nextCols = prevCols.filter(c => c.id !== colId);
    saveCustomColumns(nextCols, { previousCols: prevCols });
  }

  // Duplicate column
  function handleDuplicateColumn(column) {
    const newCol = {
      id: `custom_${Date.now()}`,
      title: `${column.title} (copy)`,
      type: column.type || 'text',
      width: column.width || 130,
    };
    const prevCols = [...(board?.customColumns || [])];
    const nextCols = [...prevCols];
    const idx = nextCols.findIndex(c => c.id === column.id);
    if (idx >= 0) {
      // Custom column — insert right after it
      nextCols.splice(idx + 1, 0, newCol);
    } else {
      // Built-in column — append to custom columns (will appear after built-ins)
      nextCols.push(newCol);
    }
    saveCustomColumns(nextCols, { previousCols: prevCols });
  }

  // Set column as required
  function handleSetColumnRequired(colId) {
    const prevCols = [...(board?.customColumns || [])];
    const nextCols = prevCols.map(c =>
      c.id === colId ? { ...c, required: !c.required } : c
    );
    saveCustomColumns(nextCols, { previousCols: prevCols });
  }

  // Set column description
  function handleSetColumnDescription(colId, description) {
    const prevCols = [...(board?.customColumns || [])];
    const nextCols = prevCols.map(c =>
      c.id === colId ? { ...c, description } : c
    );
    saveCustomColumns(nextCols, { previousCols: prevCols });
  }

  // Reorder columns via drag-and-drop
  function handleReorderColumns(draggedColId, targetColId) {
    // Save column order to localStorage (works for both built-in and custom)
    const currentOrder = visibleColumns.map(c => c.id);
    const fromIdx = currentOrder.indexOf(draggedColId);
    const toIdx = currentOrder.indexOf(targetColId);
    if (fromIdx < 0 || toIdx < 0) return;
    const newOrder = [...currentOrder];
    newOrder.splice(fromIdx, 1);
    newOrder.splice(toIdx, 0, draggedColId);
    localStorage.setItem(`board_col_order_${boardId}`, JSON.stringify(newOrder));
    setBoard(prev => ({ ...prev, _reorderTick: Date.now() })); // trigger re-render
  }

  // Change column type
  function handleChangeColumnType(colId, newType) {
    const prevCols = [...(board?.customColumns || [])];
    const nextCols = prevCols.map(c =>
      c.id === colId ? { ...c, type: newType } : c
    );
    saveCustomColumns(nextCols, { previousCols: prevCols });
  }

  // Column resize — update width in allColumns or customColumns
  function handleResizeColumn(colId, newWidth) {
    // Save to localStorage for persistence
    const widths = JSON.parse(localStorage.getItem(`board_col_widths_${boardId}`) || '{}');
    widths[colId] = newWidth;
    localStorage.setItem(`board_col_widths_${boardId}`, JSON.stringify(widths));
    // Force re-render by updating board state
    setBoard(prev => ({ ...prev, _resizeTick: Date.now() }));
  }

  // Add new group/sprint to board.
  //
  // Two callers:
  //   1. handleOpenCreateGroup() — bound to the "+ New group" button. Opens
  //      the CreateGroupDialog so the user names the group BEFORE it gets
  //      created, replacing the legacy "auto-create then inline-rename" flow.
  //   2. createGroupWithName(title) — invoked by the dialog's submit handler.
  //      Hits POST /boards/:id/groups so members and assistant managers can
  //      add a group to a board they have access to without needing the
  //      broader edit_board permission required to rewrite the structural
  //      groups array via PUT /:id.
  function handleOpenCreateGroup() {
    setShowCreateGroupDialog(true);
  }

  async function createGroupWithName(title) {
    const palette = ['#e2445c', '#fdab3d', '#00c875', '#579bfc', '#a25ddc', '#ff642e'];
    const color = palette[(board?.groups?.length || 0) % palette.length];
    // The dialog catches errors itself so it can keep the modal open and
    // surface inline validation. Don't swallow here — re-throw so it can.
    const { data } = await api.post(`/boards/${boardId}/groups`, { title, color });
    const updatedGroups = data?.data?.groups
      || [...(board?.groups || []), data?.data?.group].filter(Boolean);
    setBoard(prev => ({ ...prev, groups: updatedGroups }));
    setShowCreateGroupDialog(false);
    toastSuccess('New group created');
  }

  function toggleHideColumn(colId) {
    setHiddenColumns(prev =>
      prev.includes(colId) ? prev.filter(id => id !== colId) : [...prev, colId]
    );
  }

  // CSV Export
  async function handleExportCSV() {
    try {
      const wb = new ExcelJS.Workbook();
      wb.creator = 'Monday Aniston';
      wb.created = new Date();
      const ws = wb.addWorksheet(board?.name || 'Board Tasks');

      const boardGroups = board?.groups || [];
      const customCols = board?.customColumns || [];

      // Column headers
      const headers = ['Task', 'Status', 'Owner', 'Due Date', 'Start Date', 'Priority', 'Progress', 'Description', ...customCols.map(c => c.title)];

      // Status label map
      const statusLabels = { not_started: 'Not Started', working_on_it: 'Working on it', stuck: 'Stuck', done: 'Done', review: 'In Review' };
      const statusColors = { not_started: 'C4C4C4', working_on_it: 'FDAB3D', stuck: 'E2445C', done: '00C875', review: '579BFC' };
      const priorityColors = { critical: '333333', high: 'E2445C', medium: 'FDAB3D', low: '579BFC' };

      // Board title row
      const titleRow = ws.addRow([board?.name || 'Board Export']);
      titleRow.font = { bold: true, size: 16, color: { argb: 'FF323338' } };
      ws.mergeCells(1, 1, 1, headers.length);
      titleRow.alignment = { horizontal: 'left', vertical: 'middle' };
      titleRow.height = 32;
      ws.addRow([]); // spacing

      // Process each group
      const groupOrder = boardGroups.length > 0 ? boardGroups : [{ id: 'ungrouped', title: 'All Tasks', color: '#579bfc' }];

      for (const group of groupOrder) {
        const groupTasks = tasks.filter(t => boardGroups.length > 0 ? t.groupId === group.id : true);
        const groupColor = (group.color || '#579bfc').replace('#', '');

        // Group header row
        const groupRow = ws.addRow([`${group.title} (${groupTasks.length} items)`, ...Array(headers.length - 1).fill('')]);
        ws.mergeCells(groupRow.number, 1, groupRow.number, headers.length);
        groupRow.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
        groupRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${groupColor}` } };
        groupRow.alignment = { horizontal: 'left', vertical: 'middle' };
        groupRow.height = 28;

        // Column headers row
        const headerRow = ws.addRow(headers);
        headerRow.font = { bold: true, size: 10, color: { argb: 'FF676879' } };
        headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F6F8' } };
        headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
        headerRow.height = 24;
        headerRow.eachCell(cell => {
          cell.border = { bottom: { style: 'thin', color: { argb: 'FFE6E9EF' } } };
        });

        // Task rows
        if (groupTasks.length === 0) {
          const emptyRow = ws.addRow(['No tasks in this group', ...Array(headers.length - 1).fill('')]);
          emptyRow.font = { italic: true, color: { argb: 'FFC4C4C4' } };
          emptyRow.height = 22;
        } else {
          for (const t of groupTasks) {
            const owner = members.find(m => m.id === t.assignedTo)?.name || '';
            const statusLabel = statusLabels[t.status] || t.status || '';
            const row = ws.addRow([
              t.title || '',
              statusLabel,
              owner,
              t.dueDate ? t.dueDate.slice(0, 10) : '',
              t.startDate ? t.startDate.slice(0, 10) : '',
              (t.priority || 'medium').charAt(0).toUpperCase() + (t.priority || 'medium').slice(1),
              `${t.progress || 0}%`,
              t.description || '',
              ...customCols.map(c => t.customFields?.[c.id] || ''),
            ]);
            row.height = 22;
            row.alignment = { vertical: 'middle' };

            // Color the status cell
            const sColor = statusColors[t.status];
            if (sColor) {
              const statusCell = row.getCell(2);
              statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${sColor}` } };
              statusCell.font = { color: { argb: 'FFFFFFFF' }, bold: true, size: 9 };
              statusCell.alignment = { horizontal: 'center' };
            }

            // Color the priority cell
            const pColor = priorityColors[t.priority];
            if (pColor) {
              const prioCell = row.getCell(6);
              prioCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${pColor}` } };
              prioCell.font = { color: { argb: 'FFFFFFFF' }, bold: true, size: 9 };
              prioCell.alignment = { horizontal: 'center' };
            }

            // Light row border
            row.eachCell(cell => {
              cell.border = { bottom: { style: 'thin', color: { argb: 'FFF0F0F0' } } };
            });
          }
        }

        // Spacing between groups
        ws.addRow([]);
      }

      // Set column widths
      const widths = [35, 15, 20, 14, 14, 12, 10, 40, ...customCols.map(() => 15)];
      headers.forEach((_, i) => { ws.getColumn(i + 1).width = widths[i] || 15; });

      // Generate and download
      const buffer = await wb.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      saveAs(blob, `${board?.name || 'Board'}_export.xlsx`);
    } catch (err) {
      console.error('[BoardPage] handleExportCSV error:', err);
      toastError('Export failed. Please try again.');
    }
  }

  // Sort tasks: user-selected sort wins, otherwise default to pending priority
  const sortedTasks = useMemo(() => {
    if (sortConfig) {
      return [...tasks].sort((a, b) => {
        let aVal = a[sortConfig.key];
        let bVal = b[sortConfig.key];
        if (sortConfig.key === 'dueDate' || sortConfig.key === 'createdAt' || sortConfig.key === 'updatedAt') {
          aVal = aVal ? new Date(aVal).getTime() : 0;
          bVal = bVal ? new Date(bVal).getTime() : 0;
        }
        if (sortConfig.key === 'progress') {
          aVal = aVal || 0;
          bVal = bVal || 0;
        }
        if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
        if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
        return 0;
      });
    }
    // Default: pending task prioritization (stuck/overdue first, done last)
    return sortTasksByPendingPriority(tasks);
  }, [tasks, sortConfig]);

  async function handleDragEnd(result) {
    const { source, destination, type } = result;
    if (!destination) return;
    if (source.droppableId === destination.droppableId && source.index === destination.index) return;

    if (type === 'GROUP') {
      // Group reorder is board-global: every viewer sees the same order, so
      // we PUT the full new ordering to the server and let the socket
      // 'board:updated' broadcast push the change to other open sessions.
      // Local optimistic update keeps the drag feeling instant; on failure
      // we re-fetch the board to roll back to the server's truth.
      const currentGroups = Array.isArray(board?.groups) ? board.groups : [];
      if (currentGroups.length === 0) return;
      const reordered = [...currentGroups];
      const [moved] = reordered.splice(source.index, 1);
      if (!moved) return;
      reordered.splice(destination.index, 0, moved);
      const normalized = reordered.map((g, i) => ({ ...g, position: i }));

      const prevGroups = currentGroups;
      setBoard(prev => prev ? { ...prev, groups: normalized } : prev);

      try {
        await api.put(`/boards/${boardId}/groups/reorder`, {
          groups: normalized.map(g => ({ id: g.id })),
        });
      } catch (err) {
        // Roll back optimistic UI and surface the error so the user knows
        // their drag didn't persist. loadBoard() would also work but a
        // direct state revert is cheaper and matches the optimistic pattern
        // used elsewhere in this file.
        setBoard(prev => prev ? { ...prev, groups: prevGroups } : prev);
        const msg = err?.response?.data?.message || 'Failed to save group order. Please try again.';
        toastError(msg);
      }
      return;
    }

    if (type === 'TASK') {
      const sourceGroupId = source.droppableId;
      const destGroupId = destination.droppableId;
      const validGroupIds = groups.map(g => g.id);

      // Use sortedTasks to match the rendered order (DnD indices match rendered children)
      const getGroupTasks = (gId) => sortedTasks.filter(
        t => t.groupId === gId || ((!t.groupId || !validGroupIds.includes(t.groupId)) && gId === groups[0]?.id)
      );

      const sourceTasks = [...getGroupTasks(sourceGroupId)];
      const [movedTask] = sourceTasks.splice(source.index, 1);
      if (!movedTask) return;

      if (sourceGroupId === destGroupId) {
        sourceTasks.splice(destination.index, 0, movedTask);
        const reorderItems = sourceTasks.map((t, i) => ({ id: t.id, groupId: sourceGroupId, position: i }));
        setTasks(prev => prev.map(t => {
          const item = reorderItems.find(r => r.id === t.id);
          return item ? { ...t, position: item.position } : t;
        }));
        try { await api.put('/tasks/reorder', { boardId, items: reorderItems }); }
        catch { loadTasks(); }
      } else {
        const destTasks = [...getGroupTasks(destGroupId)];
        movedTask.groupId = destGroupId;
        destTasks.splice(destination.index, 0, movedTask);
        const reorderItems = [
          ...sourceTasks.map((t, i) => ({ id: t.id, groupId: sourceGroupId, position: i })),
          ...destTasks.map((t, i) => ({ id: t.id, groupId: destGroupId, position: i })),
        ];
        setTasks(prev => prev.map(t => {
          const item = reorderItems.find(r => r.id === t.id);
          return item ? { ...t, groupId: item.groupId, position: item.position } : t;
        }));
        try { await api.put('/tasks/reorder', { boardId, items: reorderItems }); }
        catch { loadTasks(); }
      }
    }
  }

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e) {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      // Ctrl+N or N: New task (only if user can create tasks)
      if ((e.key === 'n' || e.key === 'N') && canCreateTask) {
        if (e.ctrlKey || e.metaKey || !e.shiftKey) {
          e.preventDefault();
          const firstGroupId = board?.groups?.[0]?.id || 'new';
          // Toast already surfaced inside handleAddTask — swallow the
          // re-thrown error so the keyboard shortcut stays fire-and-forget.
          handleAddTask(firstGroupId, 'New Task').catch(() => {});
        }
      }
      // Ctrl+F or F: Toggle filters
      if (e.key === 'f' || e.key === 'F') {
        if (!e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          setShowFilters(prev => !prev);
        } else if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          document.querySelector('[data-search-input]')?.focus();
        }
      }
      // 1: Switch to Table view
      if (e.key === '1') { e.preventDefault(); setViewTab('table'); }
      // 2: Switch to Kanban view
      if (e.key === '2') { e.preventDefault(); setViewTab('kanban'); }
      // 3: Switch to Calendar view
      if (e.key === '3') { e.preventDefault(); setViewTab('calendar'); }
      // 4: Switch to Gantt view
      if (e.key === '4') { e.preventDefault(); setViewTab('gantt'); }
      if (e.key === 'Delete') {
        e.preventDefault();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [board]);

  if (loading) return <SkeletonBoard />;

  const groups = board?.groups || [
    { id: 'new', title: 'To-Do', color: '#579bfc' },
    { id: 'in_progress', title: 'In Progress', color: '#fdab3d' },
    { id: 'completed', title: 'Completed', color: '#00c875' },
  ];

  const activeFilterCount = (advFilters.status.length > 0 ? 1 : 0) + (advFilters.priority.length > 0 ? 1 : 0) + (advFilters.person ? 1 : 0);

  return (
    <div className="h-full flex flex-col">
      {/* Board Header — Monday.com style */}
      <div className="px-6 pt-4 pb-1">
        {/* Board Title */}
        <div className="flex items-center gap-2 mb-3">
          <h1 className="text-[22px] font-bold text-[#323338]">{board?.name || t('header.pages.board')}</h1>
          {board?.workspace?.name && (
            <span className="text-sm font-medium text-text-tertiary bg-surface px-2.5 py-0.5 rounded-full">{board.workspace.name}</span>
          )}
          {canManage && (
            <button onClick={() => setShowSettings(true)} className="p-1 rounded hover:bg-[#dcdfec] text-[#c4c4c4] hover:text-[#676879] transition-colors" title={t('board.toolbar.boardSettings')}>
              <Settings size={16} />
            </button>
          )}
        </div>

        {/* View Tabs — Monday.com style: Main table ... Gantt Calendar Kanban + */}
        <div className="flex items-center gap-0 mb-3 border-b border-[#e6e9ef]">
          {[
            { id: 'table', label: t('board.tabs.mainTable') },
            { id: 'gantt', label: t('board.tabs.gantt') },
            { id: 'calendar', label: t('board.tabs.calendar') },
            { id: 'kanban', label: t('board.tabs.kanban') },
          ].map(tab => (
            <button key={tab.id} onClick={() => setViewTab(tab.id)}
              className={`px-3 py-2 text-[14px] border-b-[3px] -mb-px transition-all duration-100 ${
                viewTab === tab.id
                  ? 'border-[#0073ea] text-[#323338] font-medium'
                  : 'border-transparent text-[#676879] hover:text-[#323338]'
              }`}>
              {tab.label}
            </button>
          ))}
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-1.5 py-1.5 flex-wrap">
          {/* New group split button with dropdown.
              - Primary "New group" button is gated by canCreateGroup, which is
                base-allowed for every role (member / assistant_manager /
                manager / admin). The backend POST /boards/:id/groups still
                enforces board access.
              - The chevron + dropdown is shown only when the user has access
                to at least one secondary action (currently CSV import, which
                the backend gates to manager+/admin). Members and assistant
                managers see the primary button only — no dangling dropdown. */}
          {(canCreateGroup || canEditBoard) && (
            <div className="flex items-center relative">
              {canCreateGroup && (
                <button onClick={handleOpenCreateGroup}
                  className={`flex items-center gap-1.5 h-[34px] px-4 bg-[#0073ea] hover:bg-[#0060c2] text-white text-[13px] font-medium transition-colors ${canEditBoard ? 'rounded-l-md' : 'rounded-md'}`}>
                  <Plus size={14} strokeWidth={2.5} /> {t('board.toolbar.newGroup')}
                </button>
              )}
              {canEditBoard && (
                <>
                  <button onClick={() => setShowNewTaskMenu(!showNewTaskMenu)}
                    className={`flex items-center justify-center h-[34px] w-[30px] bg-[#0060c2] hover:bg-[#004fa3] text-white border-l border-white/20 transition-colors ${canCreateGroup ? 'rounded-r-md' : 'rounded-md'}`}>
                    <ChevronDown size={13} className={`transition-transform duration-150 ${showNewTaskMenu ? 'rotate-180' : ''}`} />
                  </button>
                  {showNewTaskMenu && (
                    <NewTaskDropdown
                      canCreateGroup={canCreateGroup}
                      canImport={canEditBoard}
                      onNewGroup={() => { handleOpenCreateGroup(); setShowNewTaskMenu(false); }}
                      onImport={() => { setShowCSVImport(true); setShowNewTaskMenu(false); }}
                      onClose={() => setShowNewTaskMenu(false)}
                    />
                  )}
                </>
              )}
            </div>
          )}

          <div className="flex items-center gap-0.5 ml-2">
            {/* Search */}
            <button onClick={() => {
              const inp = document.querySelector('[data-search-input]');
              if (inp) { inp.style.width = '160px'; inp.focus(); }
            }} className={`flex items-center gap-1.5 px-2.5 py-[6px] text-[14px] rounded-[4px] transition-colors ${searchQuery ? 'bg-[#cce5ff] text-[#0073ea]' : 'text-[#676879] hover:bg-[#dcdfec]'}`}>
              <Search size={14} /> {t('board.toolbar.search')}
            </button>
            <input data-search-input type="text" placeholder={t('board.toolbar.searchTasks')} value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onBlur={(e) => { if (!e.target.value) e.target.style.width = '0'; }}
              className={`bg-transparent border-none outline-none text-[14px] text-[#323338] transition-all duration-300 ${searchQuery ? 'w-[160px] border-b border-[#0073ea] ml-1' : 'w-0'}`} />

            {/* Filter */}
            <button onClick={() => setShowFilters(!showFilters)}
              className={`flex items-center gap-1.5 px-2.5 py-[6px] text-[14px] rounded-[4px] transition-colors ${
                showFilters || activeFilterCount > 0 ? 'bg-[#cce5ff] text-[#0073ea]' : 'text-[#676879] hover:bg-[#dcdfec]'
              }`}>
              <Filter size={14} /> {t('board.toolbar.filter')}
              {activeFilterCount > 0 && <span className="text-[11px] font-bold">/ {activeFilterCount}</span>}
            </button>

            {/* Sort */}
            <SortDropdown sortConfig={sortConfig} onSort={setSortConfig} />

            {/* Hide */}
            <div className="relative">
              <button onClick={() => setShowHideColumns(!showHideColumns)}
                className={`flex items-center gap-1.5 px-2.5 py-[6px] text-[14px] rounded-[4px] transition-colors ${
                  hiddenColumns.length > 0 ? 'bg-[#cce5ff] text-[#0073ea]' : 'text-[#676879] hover:bg-[#dcdfec]'
                }`}>
                <Eye size={14} /> {t('board.toolbar.hide')}
                {hiddenColumns.length > 0 && <span className="text-[11px] font-bold">/ {hiddenColumns.length}</span>}
              </button>
              {showHideColumns && (
                <div className="absolute top-full left-0 mt-1 w-52 bg-white rounded-lg shadow-dropdown border border-[#e6e9ef] z-50 dropdown-enter p-2">
                  <p className="text-[11px] font-medium text-[#676879] px-2 pb-1.5">{t('board.toolbar.toggleColumns')}</p>
                  {allColumns.map(col => (
                    <label key={col.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[#f5f6f8] cursor-pointer transition-colors">
                      <input type="checkbox" checked={!hiddenColumns.includes(col.id)} onChange={() => toggleHideColumn(col.id)}
                        className="w-3.5 h-3.5 rounded border-[#c4c4c4] text-[#0073ea] focus:ring-[#0073ea]/20" />
                      <span className="text-[#323338] text-[13px]">{col.title}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

          </div>

          {/* Right side */}
          <div className="ml-auto flex items-center gap-1">
            {canEditBoard && (
              <button onClick={() => setShowCSVImport(true)} className="flex items-center gap-1 px-2 py-[6px] text-[13px] text-[#676879] hover:bg-[#dcdfec] rounded-[4px] transition-colors">
                <Upload size={13} /> {t('board.toolbar.import')}
              </button>
            )}
            <button onClick={handleExportCSV} className="flex items-center gap-1 px-2 py-[6px] text-[13px] text-[#676879] hover:bg-[#dcdfec] rounded-[4px] transition-colors">
              <Download size={13} /> {t('board.toolbar.export')}
            </button>
            {canManage && (
              <button onClick={() => setShowAutomations(true)} className="flex items-center gap-1 px-2 py-[6px] text-[13px] text-[#676879] hover:bg-[#dcdfec] rounded-[4px] transition-colors">
                <Zap size={13} /> {t('board.toolbar.automate')}
              </button>
            )}
          </div>
        </div>

        {/* Advanced Filters Panel */}
        {showFilters && (
          <div className="animate-fade-in">
            <AdvancedFilters
              filters={advFilters}
              onChange={setAdvFilters}
              members={members}
              boardStatuses={getBoardStatuses(board)}
              onClear={() => setAdvFilters({ status: [], priority: [], person: '' })}
            />
          </div>
        )}
      </div>

      {/* Board Content */}
      {viewTab === 'gantt' ? (
        <div className="flex-1 overflow-auto px-6 pb-6">
          <TimelineView tasks={sortedTasks} members={members} onTaskClick={setSelectedTask} />
        </div>
      ) : viewTab === 'calendar' ? (
        <div className="flex-1 overflow-auto px-6 pb-6">
          <CalendarView tasks={sortedTasks} members={members} onTaskClick={setSelectedTask} />
        </div>
      ) : viewTab === 'kanban' ? (
        <div className="flex-1 overflow-auto px-6 pb-6">
          <KanbanView
            tasks={sortedTasks}
            members={members}
            groups={groups}
            boardStatuses={getBoardStatuses(board)}
            onTaskClick={setSelectedTask}
            onTaskUpdate={(taskId, updates) => handleTaskUpdate(taskId, updates)}
            onAddTask={handleAddTask}
          />
        </div>
      ) : (
        <DragDropContext onDragEnd={handleDragEnd}>
          {/* Visual gutter (matches monday.com left/right breathing room)
              lives on this *outer* wrapper, NOT on the scroll container
              below. Putting it on the scroll container creates a
              padding-edge gap that `position: sticky; left: 0` can't cover
              — any data-cell scrolled into that gap bleeds out. Putting it
              here keeps the gutter as static, non-scrollable space. */}
          <div className="flex-1 flex flex-col px-2 sm:px-6 pb-6 min-h-0">
            <div className="flex-1 overflow-auto -webkit-overflow-scrolling-touch min-h-0" style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
            {/* Server / network failure — replaces the legitimate "no tasks"
                empty state so the user isn't told "no tasks assigned to you"
                while the API is actually broken. Shown only when the most
                recent load failed. The single toast in loadBoard/loadTasks
                handles the transient surface; this is the in-page fallback. */}
            {loadError && !loading && (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="w-16 h-16 rounded-full bg-danger/10 flex items-center justify-center mb-4">
                  <AlertCircle size={28} className="text-danger" />
                </div>
                <h3 className="text-lg font-semibold text-[#323338] mb-1">{t('board.loadFailedTitle')}</h3>
                <p className="text-sm text-[#676879] max-w-sm mb-4">{t('board.loadFailedSubtitle')}</p>
                <button
                  onClick={() => { setLoading(true); setLoadError(null); loadBoard(); loadTasks(); }}
                  className="px-4 py-2 text-sm rounded-md bg-[#0073ea] text-white hover:bg-[#0060c2] transition-colors font-medium"
                >
                  {t('common.retry')}
                </button>
              </div>
            )}
            {/* Empty state for employees with no visible tasks. Suppressed
                when loadError is set so we never show "No tasks assigned to
                you" alongside a server failure (production audit fix). */}
            {!loadError && sortedTasks.length === 0 && !loading && (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="w-16 h-16 rounded-full bg-surface-100 flex items-center justify-center mb-4">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#c4c4c4" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="2"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>
                </div>
                <h3 className="text-lg font-semibold text-[#323338] mb-1">{t('board.noTasksTitle')}</h3>
                <p className="text-sm text-[#676879] max-w-sm">{t('board.noTasksSubtitle')}</p>
              </div>
            )}
            {/* Group-level drag layer. `type="GROUP"` is type-scoped so it
                does not collide with the task-level Droppables (type="TASK")
                that TaskGroup renders internally — @hello-pangea/dnd only
                routes draggables to droppables of the matching type. Group
                order is a board-global property persisted via PUT
                /api/boards/:id/groups/reorder; the socket 'board:updated'
                broadcast carries the new order to other open viewers. */}
            <Droppable droppableId="board-groups" type="GROUP">
              {(dropProvided) => (
                <div ref={dropProvided.innerRef} {...dropProvided.droppableProps}>
                  {groups.map((group, idx) => {
                    const validGroupIds = groups.map(g => g.id);
                    const groupTasks = sortedTasks
                      .filter(t => t.groupId === group.id || ((!t.groupId || !validGroupIds.includes(t.groupId)) && group.id === groups[0]?.id));
                    return (
                      <Draggable key={group.id} draggableId={`group:${group.id}`} index={idx}>
                        {(dragProvided, dragSnapshot) => (
                          <div
                            ref={dragProvided.innerRef}
                            {...dragProvided.draggableProps}
                            className={dragSnapshot.isDragging ? 'shadow-xl rounded-lg ring-1 ring-[#0073ea]/30' : ''}
                          >
                            <TaskGroup
                              group={group}
                              tasks={groupTasks}
                              members={members}
                              columns={visibleColumns}
                              boardId={boardId}
                              boardStatuses={getBoardStatuses(board)}
                              color={group.color}
                              index={idx}
                              onTaskClick={setSelectedTask}
                              onTaskUpdate={handleTaskUpdate}
                              onAddTask={handleAddTask}
                              onArchiveTask={handleArchiveTask}
                              onRequestExtension={setExtensionTask}
                              onEditColumn={handleEditColumn}
                              onAddColumn={handleAddColumn}
                              onRemoveColumn={handleRemoveColumn}
                              onHideColumn={toggleHideColumn}
                              onResizeColumn={handleResizeColumn}
                              onSort={setSortConfig}
                              isDragEnabled={true}
                              selectedTaskIds={selectedTaskIds}
                              onSelectTask={handleSelectTask}
                              onArchiveGroup={handleArchiveGroup}
                              onRenameGroup={handleRenameGroup}
                              onGroupBy={(col) => {
                                const key = col.id === 'status' ? 'status' : col.id === 'date' ? 'dueDate' : col.id === 'priority' ? 'priority' : col.id;
                                setSortConfig({ key, direction: 'asc' });
                              }}
                              onDuplicateColumn={handleDuplicateColumn}
                              onChangeColumnType={handleChangeColumnType}
                              onSetColumnRequired={handleSetColumnRequired}
                              onSetColumnDescription={handleSetColumnDescription}
                              onReorderColumns={handleReorderColumns}
                              expandedTaskIds={expandedTaskIds}
                              onToggleSubtasks={toggleSubtasksFor}
                              onSubtaskCountsChange={handleSubtaskCountsChange}
                              groupDragHandleProps={dragProvided.dragHandleProps}
                              isGroupDragging={dragSnapshot.isDragging}
                            />
                          </div>
                        )}
                      </Draggable>
                    );
                  })}
                  {dropProvided.placeholder}
                </div>
              )}
            </Droppable>
            </div>
          </div>
        </DragDropContext>
      )}

      {/* Task Modal */}
      {selectedTask && (
        <TaskModal
          task={selectedTask}
          boardId={boardId}
          board={board}
          members={members}
          boardStatuses={getBoardStatuses(board)}
          onClose={() => setSelectedTask(null)}
          onUpdate={(updated) => {
            setTasks(prev => prev.map(t => t.id === updated.id ? updated : t));
            setSelectedTask(updated);
          }}
          onDelete={handleTaskDelete}
        />
      )}

      {/* Bulk Action Bar */}
      <BulkActionBar
        selectedIds={selectedTaskIds}
        members={members}
        boardStatuses={getBoardStatuses(board)}
        onDone={() => { setSelectedTaskIds([]); loadTasks(); }}
        onClear={() => setSelectedTaskIds([])}
      />

      {/* Automations Panel */}
      {showAutomations && <AutomationsPanel boardId={boardId} onClose={() => setShowAutomations(false)} />}

      {/* Board Settings Modal */}
      {showSettings && board && (
        <BoardSettingsModal
          board={{ ...board, members }}
          onClose={() => setShowSettings(false)}
          onUpdate={(updated) => { setBoard(updated); setMembers(updated.members || updated.Users || []); }}
          onDelete={() => navigate('/boards')}
        />
      )}

      {/* CSV Import Modal */}
      {showCSVImport && (
        <CSVImportModal boardId={boardId} board={board} columns={allColumns} members={members} onClose={() => setShowCSVImport(false)} onImported={loadTasks} />
      )}

      {/* Due Date Extension Modal */}
      {extensionTask && (
        <DueDateExtensionModal task={extensionTask} onClose={() => setExtensionTask(null)} onSubmit={loadTasks} />
      )}

      {/* Create Group Dialog — replaces the legacy auto-create-then-rename
          flow. Opens when the user clicks "+ New group". The dialog throws
          on failure so it can keep itself open and surface inline errors. */}
      <CreateGroupDialog
        open={showCreateGroupDialog}
        onClose={() => setShowCreateGroupDialog(false)}
        onCreate={createGroupWithName}
      />

    </div>
  );
}
