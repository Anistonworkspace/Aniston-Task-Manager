import React, { useState, useEffect, useRef } from 'react';
import { Plus, Trash2, GripVertical, ListChecks } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';
import useRealtimeEvent from '../../realtime/useRealtimeEvent';
import StatusCell from './StatusCell';
import PriorityCell from './PriorityCell';
import PersonCell from './PersonCell';
import DateCell from './DateCell';
import ProgressCell from './ProgressCell';

/**
 * Inline subtask section that renders directly under an expanded parent task
 * row in the board table. The layout exactly mirrors the parent grid:
 *   [color bar][checkbox spacer][indented title col][data columns][hover-actions]
 *
 * Self-fetches its subtasks on mount and stays in sync with the modal via
 * the `subtask:created`, `subtask:updated`, `subtask:deleted` socket events
 * — both views (board + modal) listen to the same channel.
 *
 * Permission model (mirrors backend in subtaskController.pickAllowedFields):
 *   - admin / manager / asst-mgr / super_admin → all fields editable
 *   - member → status, progress, title, description (within their own
 *     parent task or their own subtask)
 *   - assignee picker is locked to self when the actor cannot assign others
 *     (granularPermissions['tasks.assign_others'] === false)
 */
export default function BoardSubtaskSection({
  parentTask,
  members = [],
  columns = [],
  boardId,
  taskColWidth,
  color = '#579bfc',
  boardStatuses,
  // Called whenever the count changes — parent uses this to refresh the
  // ListChecks badge on the row title.
  onCountsChange,
}) {
  const { user, isAdmin, isManager, isAssistantManager, isSuperAdmin, granularPermissions } = useAuth();
  const [subtasks, setSubtasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [savingNew, setSavingNew] = useState(false);
  const addInputRef = useRef(null);

  // Stable refs for the parent count-change callback. The closure passed in
  // is recreated on every TaskGroup render (it captures `task.id`), so using
  // it directly in a useEffect dependency array would re-fire the load every
  // render — that was the production bug that triggered the rate-limit
  // cascade. Storing the latest function in a ref decouples identity from
  // value: handlers always invoke the freshest version, and the load effect
  // depends only on the parent task id.
  const onCountsChangeRef = useRef(onCountsChange);
  useEffect(() => { onCountsChangeRef.current = onCountsChange; }, [onCountsChange]);

  // In-flight guard. Prevents two concurrent fetches for the same parent
  // task — a defense against any edge case (StrictMode double-mount,
  // duplicate socket emit, etc.) that might otherwise re-enter `load`.
  const inFlightRef = useRef(false);

  // Permission flags — kept aligned with the backend whitelist.
  const canManageAll = isSuperAdmin || isAdmin || isManager || isAssistantManager;
  // Only privileged roles or super admin may assign subtasks to OTHER users.
  // Members and managers without `tasks.assign_others` may still self-assign.
  const canAssignOthers = isSuperAdmin || !!granularPermissions?.['tasks.assign_others'];
  // Member-mutability: a member can act on subtasks of their own parent
  // task or subtasks they themselves created. Mirrors the backend's
  // canMemberMutateSubtask check; backend remains source of truth.
  const isOwnParent = !!user?.id && (parentTask?.assignedTo === user.id || parentTask?.createdBy === user.id);
  const canMutate = canManageAll || isOwnParent;

  // ── Focus the "+ Add subitem" input WITHOUT scrolling ─────────────────
  // The HTML `autoFocus` attribute calls `.focus()` with default options,
  // which scrolls the nearest scrollable ancestor to bring the focused
  // element into view. The board table is horizontally scrollable, and
  // this footer cell sits at the panel's left edge, so default-focus
  // yanks the parent table's `scrollLeft` to the right and visibly jumps
  // the user's view. We replace the attribute with a manual focus call
  // that uses the documented `{ preventScroll: true }` option, so the
  // cursor still lands in the input but the table stays put.
  useEffect(() => {
    if (adding) addInputRef.current?.focus({ preventScroll: true });
  }, [adding]);

  // ── Count reporting via post-commit effect ─────────────────────────
  // The previous version called `reportCounts` from inside `setSubtasks`
  // updaters, which React (rightly) flags with "Cannot update a component
  // while rendering a different component" — those updaters can be invoked
  // during render (StrictMode replays them, concurrent mode batches them),
  // and triggering a parent setState there causes the warning and a
  // re-render storm that defeats our equality guard upstream. Computing
  // counts in a useEffect that watches `subtasks` keeps the parent setState
  // strictly post-commit. A last-reported ref prevents redundant calls when
  // the count didn't actually change (e.g. when only a title was edited).
  const lastReportedRef = useRef({ total: -1, done: -1 });
  useEffect(() => {
    const total = subtasks.length;
    const done = subtasks.filter((s) => s.status === 'done').length;
    const last = lastReportedRef.current;
    if (last.total === total && last.done === done) return;
    lastReportedRef.current = { total, done };
    onCountsChangeRef.current?.({ total, done });
  }, [subtasks]);

  // Load fires exactly once per parent task id. Errors are NOT toasted from
  // here — the global axios interceptor (services/api.js) already dispatches
  // an `api-error` toast for non-401/404 responses, so a manual toast here
  // would double up. We only flip `loadFailed` so the section can render an
  // inline retry hint instead.
  useEffect(() => {
    const taskId = parentTask?.id;
    if (!taskId) return;
    let cancelled = false;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    setLoadFailed(false);
    api.get(`/subtasks?taskId=${taskId}`)
      .then((res) => {
        if (cancelled) return;
        const list = res.data?.subtasks || res.data?.data?.subtasks || [];
        setSubtasks(list);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[BoardSubtaskSection] load error:', err);
        setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
        inFlightRef.current = false;
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ref-backed callbacks intentionally excluded; effect must run only when the parent task id changes.
  }, [parentTask?.id]);

  // ── Real-time sync: subtask events for this parent task ──
  // Updaters MUST be pure — no side effects (no parent setState). Count
  // reporting happens in the [subtasks] useEffect above.
  useRealtimeEvent('subtask:created', (data) => {
    if (!data?.subtask || data?.taskId !== parentTask?.id) return;
    setSubtasks((prev) => {
      if (prev.some((s) => s.id === data.subtask.id)) return prev;
      return [...prev, data.subtask].sort((a, b) => (a.position || 0) - (b.position || 0));
    });
  });
  useRealtimeEvent('subtask:updated', (data) => {
    if (!data?.subtask || data?.taskId !== parentTask?.id) return;
    setSubtasks((prev) => prev.map((s) => (s.id === data.subtask.id ? { ...s, ...data.subtask } : s)));
  });
  useRealtimeEvent('subtask:deleted', (data) => {
    if (!data?.subtaskId || data?.taskId !== parentTask?.id) return;
    setSubtasks((prev) => prev.filter((s) => s.id !== data.subtaskId));
  });

  // ── Mutations ────────────────────────────────────────────────────────

  async function handleCreate(title) {
    const trimmed = (title || '').trim();
    if (!trimmed) {
      setAdding(false);
      setNewTitle('');
      return;
    }
    if (savingNew) return;
    setSavingNew(true);
    try {
      const payload = { title: trimmed, taskId: parentTask.id };
      // Members without assign_others always create subtasks unassigned
      // (can self-assign later). Privileged roles also default to no
      // assignee — matches monday.com's "+ Add subitem" UX where you set
      // the owner after creation.
      const res = await api.post('/subtasks', payload);
      const created = res.data?.subtask || res.data?.data?.subtask;
      if (created) {
        // Optimistic insert (also covered by socket — but socket arrives
        // a tick later; merging here avoids a flash). Pure updater — count
        // reporting happens in the [subtasks] effect.
        setSubtasks((prev) => prev.some((s) => s.id === created.id) ? prev : [...prev, created]);
      }
      setNewTitle('');
      // Stay in "adding" mode so the user can keep typing more subtasks
      // — matches monday.com flow where Enter saves and primes the next one.
      // `preventScroll: true` is critical: the input lives at the panel's
      // left edge, so a default focus would scroll the parent board table
      // horizontally to bring the input into view. Mirrors the same option
      // used by the [adding] focus effect below.
      setTimeout(() => addInputRef.current?.focus({ preventScroll: true }), 0);
    } catch (err) {
      // The axios interceptor (services/api.js) dispatches a global toast
      // for non-401/404 errors; logging here is enough.
      console.error('[BoardSubtaskSection] create error:', err);
    } finally {
      setSavingNew(false);
    }
  }

  async function handleUpdate(subtaskId, updates) {
    // Optimistic patch — revert on error. Pure updater (no parent setState).
    let prevSnapshot;
    setSubtasks((prev) => {
      prevSnapshot = prev;
      return prev.map((s) => (s.id === subtaskId ? { ...s, ...updates } : s));
    });
    try {
      const res = await api.put(`/subtasks/${subtaskId}`, updates);
      const updated = res.data?.subtask || res.data?.data?.subtask;
      if (updated) {
        setSubtasks((prev) => prev.map((s) => (s.id === subtaskId ? { ...s, ...updated } : s)));
      }
    } catch (err) {
      // Global toast handled by axios interceptor; rollback locally.
      console.error('[BoardSubtaskSection] update error:', err);
      if (prevSnapshot) setSubtasks(prevSnapshot);
    }
  }

  async function handleDelete(subtaskId) {
    if (!window.confirm('Delete this subtask?')) return;
    let prevSnapshot;
    setSubtasks((prev) => {
      prevSnapshot = prev;
      return prev.filter((s) => s.id !== subtaskId);
    });
    try {
      await api.delete(`/subtasks/${subtaskId}`);
    } catch (err) {
      // Global toast handled by axios interceptor; rollback locally.
      console.error('[BoardSubtaskSection] delete error:', err);
      if (prevSnapshot) setSubtasks(prevSnapshot);
    }
  }

  // ── Cell rendering ───────────────────────────────────────────────────
  // Subtasks reuse the parent column layout but only render a subset that
  // makes sense at the subtask level. Custom (board-level) columns are
  // greyed out — not all main-task columns are meaningful for subtasks.

  function renderCell(subtask, col) {
    const isAssigneeOnly = subtask.assignedTo === user?.id;
    // Member can edit status/progress on subtasks they own (assigned to them)
    // OR on subtasks under a parent task they own. Privileged roles can edit
    // everything.
    const canEditField = canMutate || isAssigneeOnly;
    const onUpdate = (patch) => handleUpdate(subtask.id, patch);

    switch (col.type) {
      case 'status':
        return (
          <StatusCell
            value={subtask.status}
            onChange={canEditField ? (v) => onUpdate({ status: v, ...(v === 'done' ? { progress: 100 } : {}) }) : undefined}
            boardStatuses={boardStatuses}
          />
        );
      case 'priority':
        return canManageAll ? (
          <PriorityCell value={subtask.priority || 'medium'} onChange={(v) => onUpdate({ priority: v })} />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-[10px] text-text-tertiary">
            {subtask.priority || '—'}
          </div>
        );
      case 'person':
        return (
          <PersonCell
            value={subtask.assignedTo || subtask.assignee}
            members={members}
            taskAssignees={subtask.assignee ? [{ user: subtask.assignee, userId: subtask.assignee.id, role: 'assignee' }] : []}
            owners={[]}
            // Subtasks have a single assignee, so disable the multi-owner UI.
            // PersonCell handles the simple-assignee path via `value` + `onChange`.
            onChange={canMutate ? (v) => onUpdate({ assignedTo: v }) : undefined}
            assignSelfOnly={!canAssignOthers}
            currentUserId={user?.id}
            // Subtask doesn't enforce due-date-before-assign (there's no
            // calendar dependency on subtasks). Pass dueDate so the cell
            // suppresses the warning.
            dueDate={subtask.dueDate || new Date().toISOString()}
          />
        );
      case 'date':
        return (
          <DateCell
            value={subtask.dueDate ? String(subtask.dueDate).slice(0, 10) : ''}
            onChange={canManageAll ? (v) => onUpdate({ dueDate: v || null }) : undefined}
            taskId={subtask.id}
            assignedTo={subtask.assignedTo}
          />
        );
      case 'progress':
        return (
          <ProgressCell
            value={subtask.progress || 0}
            status={subtask.status}
            onChange={canEditField ? (v) => onUpdate({ progress: v }) : undefined}
          />
        );
      // Subtasks don't currently support per-column custom fields — they fall
      // through to a neutral placeholder that keeps grid alignment.
      default:
        return <div className="w-full h-full flex items-center justify-center text-[10px] text-text-tertiary">—</div>;
    }
  }

  const totalCount = subtasks.length;

  // ── Visual layout ──────────────────────────────────────────────────────
  // Monday.com-style nested panel. The subitem area is a self-contained
  // bordered card indented from the parent row's left edge, with its own
  // column widths (independent of parentTask's grid). The parent grid props
  // (`columns`, `taskColWidth`) are intentionally unused here — the visual
  // intent is "this subitem table is its own little surface, not a
  // continuation of the parent row." Functionally nothing else changes.
  //
  // Subitem column schema (fixed-width, in render order):
  //   Title (flex)  Status 132  Owner 96  Date 110  Priority 116  Progress 144  Actions 36
  // Total min ~924px. The card is `overflow-x-auto` so on narrow viewports
  // it scrolls horizontally rather than overlapping the parent table.
  const SUB_COLS = [
    { type: 'status', label: 'Status', width: 132 },
    { type: 'person', label: 'Owner', width: 96 },
    { type: 'date', label: 'Date', width: 110 },
    { type: 'priority', label: 'Priority', width: 116 },
    { type: 'progress', label: 'Progress', width: 144 },
  ];

  // ── Wrapper hierarchy ─────────────────────────────────────────────────
  // Three-layer structure, all unconditional (same DOM regardless of
  // adding / loading / loadFailed / subtasks.length):
  //
  //   indentWrap  → block, padding gives the left/right inset and vertical
  //                 breathing room. Padding (not margin) so the indent is
  //                 enforced by box geometry, not by sibling collapse rules.
  //   panel       → block, the bordered card; rounded corners + shadow +
  //                 left blue accent absolutely positioned inside.
  //   scrollWrap  → overflow-x-auto wrapper that lets the inner table
  //                 scroll horizontally inside the card on narrow viewports
  //                 without breaking the card border.
  //   table       → min-w pins a baseline column width so the columns
  //                 cannot collapse when the input replaces the button on
  //                 "+ Add subitem" — that was the regression: an
  //                 inline-block panel with `w-full` lost its width when a
  //                 full-width input took over the footer.
  return (
    <div
      className="subtask-section-fade-in pl-[48px] pr-3 py-2.5"
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="relative bg-white dark:bg-[#1f2024] border border-[#e0e3eb] dark:border-[#2a2b30] rounded-[8px] shadow-[0_1px_2px_rgba(15,23,42,0.04)] overflow-hidden"
        role="region"
        aria-label="Subitems"
      >
        {/* Left blue accent strip — sits above in-flow content via z-[1]. */}
        <div className="absolute left-0 top-0 bottom-0 w-[3px] bg-[#0073ea] z-[1]" aria-hidden="true" />

        <div className="overflow-x-auto">
          <div className="min-w-[760px]">
            {/* Subitem header — smaller font, lighter weight than the
                parent board's column header. */}
            <div className="flex items-stretch text-[10px] uppercase tracking-[0.04em] font-semibold text-[#9aa1ad] bg-[#f8f9fc] dark:bg-[#1a1b1e] border-b border-[#eef0f4] dark:border-[#2a2b30]">
              <div className="flex-1 min-w-[240px] pl-5 pr-3 py-2 flex items-center gap-1.5 border-r border-[#eef0f4] dark:border-[#2a2b30]">
                <ListChecks size={11} className="text-[#9aa1ad]" />
                <span>Subitem</span>
                {totalCount > 0 && (
                  <span className="ml-1 text-[10px] font-normal normal-case text-[#c4c4c4]">{totalCount}</span>
                )}
              </div>
              {SUB_COLS.map((col) => (
                <div
                  key={col.type}
                  style={{ width: col.width }}
                  className="flex-shrink-0 px-2 py-2 flex items-center justify-center border-r border-[#eef0f4] dark:border-[#2a2b30]"
                >
                  {col.label}
                </div>
              ))}
              <div className="w-[36px] flex-shrink-0" />
            </div>

            {/* Loading / failure */}
            {loading && (
              <div className="px-5 py-3 text-[12px] text-[#9aa1ad]">Loading subitems…</div>
            )}
            {!loading && loadFailed && (
              <div className="flex items-center justify-between px-5 py-3 text-[12px] text-[#9aa1ad] bg-[#fff4f4] dark:bg-[#2a1f22]">
                <span>Couldn't load subitems. The server may be busy.</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (inFlightRef.current) return;
                    inFlightRef.current = true;
                    setLoadFailed(false);
                    setLoading(true);
                    api.get(`/subtasks?taskId=${parentTask.id}`)
                      .then((res) => {
                        const list = res.data?.subtasks || res.data?.data?.subtasks || [];
                        setSubtasks(list);
                      })
                      .catch(() => setLoadFailed(true))
                      .finally(() => { setLoading(false); inFlightRef.current = false; });
                  }}
                  className="text-[#0073ea] hover:underline"
                >
                  Retry
                </button>
              </div>
            )}

            {/* Subitem rows */}
            {!loading && !loadFailed && subtasks.map((subtask) => {
              const isAssigneeOnly = subtask.assignedTo === user?.id;
              const canDelete = canManageAll || subtask.createdBy === user?.id;
              return (
                <div
                  key={subtask.id}
                  className="flex items-stretch border-b border-[#eef0f4] dark:border-[#2a2b30] hover:bg-[#f8f9fc] dark:hover:bg-[#1a1b1e] transition-colors group/subrow"
                >
                  {/* Title col — flex-1 so it absorbs free space; min-width
                      keeps the title legible even when many columns are
                      visible. */}
                  <div className="flex-1 min-w-[240px] pl-5 pr-3 py-2.5 flex items-center gap-2 border-r border-[#eef0f4] dark:border-[#2a2b30]">
                    <GripVertical size={12} className="text-[#c4c4c4] opacity-0 group-hover/subrow:opacity-100 transition-opacity flex-shrink-0" />
                    <SubtaskTitle
                      subtask={subtask}
                      canEdit={canMutate || isAssigneeOnly}
                      onChange={(title) => handleUpdate(subtask.id, { title })}
                    />
                  </div>

                  {/* Data columns — render via the existing cell switch.
                      Synthetic col objects since the new layout is
                      independent of the parent's `columns` prop. */}
                  {SUB_COLS.map((col) => (
                    <div
                      key={col.type}
                      style={{ width: col.width }}
                      className="flex-shrink-0 flex items-center justify-center border-r border-[#eef0f4] dark:border-[#2a2b30]"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {renderCell(subtask, col)}
                    </div>
                  ))}

                  {/* Row actions */}
                  <div className="w-[36px] flex-shrink-0 flex items-center justify-center opacity-0 group-hover/subrow:opacity-100 transition-opacity">
                    {canDelete && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(subtask.id); }}
                        className="p-1 rounded hover:bg-red-50 text-[#c4c4c4] hover:text-[#e2445c] transition-colors"
                        title="Delete subitem"
                        aria-label="Delete subitem"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {/* "+ Add subitem" — muted text-button row inside the card. The
                button↔input swap happens inside this footer cell ONLY; the
                wrapper hierarchy and the panel's width are unaffected. */}
            {canMutate && (
              <div className="pl-5 pr-3 py-2 border-t border-[#eef0f4] dark:border-[#2a2b30] bg-white dark:bg-[#1f2024]">
                {adding ? (
                  <input
                    ref={addInputRef}
                    type="text"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); handleCreate(newTitle); }
                      if (e.key === 'Escape') { setAdding(false); setNewTitle(''); }
                    }}
                    onBlur={() => { if (!newTitle.trim()) { setAdding(false); } }}
                    placeholder="+ Add subitem"
                    aria-label="New subitem title"
                    disabled={savingNew}
                    className="w-full text-[13px] border-none outline-none bg-transparent text-[#323338] dark:text-white placeholder:text-[#c4c4c4]"
                    /* Intentionally NO autoFocus — see the `[adding]` effect
                       above. The HTML attribute focuses with default options
                       which would scroll the board table horizontally. */
                  />
                ) : (
                  <button
                    onClick={() => setAdding(true)}
                    className="flex items-center gap-1.5 text-[13px] text-[#9aa1ad] hover:text-[#0073ea] transition-colors"
                    aria-label="Add a subitem"
                  >
                    <Plus size={13} /> Add subitem
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Inline-editable subtask title. Click to edit; Enter saves, Escape cancels. */
function SubtaskTitle({ subtask, canEdit, onChange }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(subtask.title || '');

  useEffect(() => { setDraft(subtask.title || ''); }, [subtask.title]);

  function commit() {
    const trimmed = (draft || '').trim();
    if (!trimmed || trimmed === subtask.title) {
      setDraft(subtask.title || '');
      setEditing(false);
      return;
    }
    onChange(trimmed);
    setEditing(false);
  }

  if (!canEdit) {
    return (
      <span className={`flex-1 truncate text-[13px] ${subtask.status === 'done' ? 'line-through text-[#9aa1ad]' : 'text-[#323338] dark:text-white'}`}>
        {subtask.title}
      </span>
    );
  }

  if (editing) {
    return (
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { setDraft(subtask.title || ''); setEditing(false); }
        }}
        className="flex-1 text-[13px] bg-transparent border-none outline-none text-[#323338] dark:text-white"
        autoFocus
        aria-label="Edit subitem title"
      />
    );
  }

  return (
    <button
      onClick={(e) => { e.stopPropagation(); setEditing(true); }}
      className={`flex-1 text-left truncate text-[13px] hover:text-[#0073ea] transition-colors ${subtask.status === 'done' ? 'line-through text-[#9aa1ad]' : 'text-[#323338] dark:text-white'}`}
      aria-label="Edit subitem title"
    >
      {subtask.title}
    </button>
  );
}
