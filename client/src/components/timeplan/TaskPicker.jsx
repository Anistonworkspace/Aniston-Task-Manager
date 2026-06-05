import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, ChevronDown, X, Link2, Check, CircleSlash } from 'lucide-react';
import { format, parseISO, isToday, differenceInDays } from 'date-fns';
import api from '../../services/api';
import { sortTasksByPendingPriority, isOverdue, isCompletedStatus, getPriorityRank } from '../../utils/taskPrioritization';

const PRIORITY_DOT = { critical: '#d83a52', high: '#f59e0b', medium: '#0073ea', low: '#94a3b8' };

/**
 * Searchable, grouped task combobox for the planner modal. Replaces the raw
 * <select> — it fetches the current user's visible tasks once, groups them
 * (Overdue / Due Today / High Priority / Recent / Other), and filters by query.
 * The "No task linked" option always sits at the top for custom blocks.
 *
 * Controlled: pass `selectedTask` (full object or null); calls `onSelect(task|null)`.
 */
export default function TaskPicker({ selectedTask, onSelect }) {
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.get('/tasks?assignedTo=me&limit=100')
      .then((res) => { if (alive) setTasks(res.data.tasks || res.data.data?.tasks || []); })
      .catch(() => { if (alive) setTasks([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  // Close on outside click / Esc.
  useEffect(() => {
    if (!open) return undefined;
    function onDown(e) { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); }
    function onKey(e) { if (e.key === 'Escape') { setOpen(false); } }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    if (inputRef.current) inputRef.current.focus();
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = tasks
      .filter((t) => !isCompletedStatus(t.status))
      .filter((t) => !q || (t.title || '').toLowerCase().includes(q) || (t.board?.name || '').toLowerCase().includes(q));

    const buckets = { overdue: [], today: [], high: [], recent: [], other: [] };
    for (const t of filtered) {
      if (isOverdue(t)) buckets.overdue.push(t);
      else if (t.dueDate && isToday(parseISO(t.dueDate))) buckets.today.push(t);
      else if (getPriorityRank(t.priority) <= 1) buckets.high.push(t); // critical/high
      else if (t.createdAt && differenceInDays(new Date(), parseISO(t.createdAt)) <= 7) buckets.recent.push(t);
      else buckets.other.push(t);
    }
    return [
      { key: 'overdue', label: 'Overdue', tasks: sortTasksByPendingPriority(buckets.overdue) },
      { key: 'today', label: 'Due Today', tasks: sortTasksByPendingPriority(buckets.today) },
      { key: 'high', label: 'High Priority', tasks: sortTasksByPendingPriority(buckets.high) },
      { key: 'recent', label: 'Recently Added', tasks: sortTasksByPendingPriority(buckets.recent) },
      { key: 'other', label: 'Other Tasks', tasks: sortTasksByPendingPriority(buckets.other) },
    ].filter((g) => g.tasks.length > 0);
  }, [tasks, query]);

  function choose(task) {
    onSelect(task || null);
    setOpen(false);
    setQuery('');
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg border border-border bg-white px-3 py-2 text-left text-sm hover:border-primary/50 focus:border-primary focus:outline-none"
      >
        {selectedTask ? (
          <>
            <Link2 size={13} className="flex-shrink-0 text-primary" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-text-primary">{selectedTask.title}</span>
              {selectedTask.board?.name && (
                <span className="block truncate text-[11px] text-text-tertiary">{selectedTask.board.name}</span>
              )}
            </span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); choose(null); }}
              className="rounded p-0.5 text-text-tertiary hover:text-danger"
              aria-label="Clear linked task"
            >
              <X size={14} />
            </button>
          </>
        ) : (
          <>
            <CircleSlash size={13} className="flex-shrink-0 text-text-tertiary" />
            <span className="flex-1 text-text-tertiary">No task linked — custom block</span>
            <ChevronDown size={14} className="flex-shrink-0 text-text-tertiary" />
          </>
        )}
      </button>

      {open && (
        <div className="absolute z-50 mt-1 max-h-[320px] w-full overflow-hidden rounded-xl border border-border bg-white shadow-dropdown">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search size={14} className="text-text-tertiary" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your tasks…"
              className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
            />
          </div>

          <div className="max-h-[260px] overflow-y-auto py-1" role="listbox">
            {/* No task linked */}
            <button type="button" onClick={() => choose(null)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface">
              <CircleSlash size={13} className="text-text-tertiary" />
              <span className="text-sm font-medium text-text-primary">No task linked (custom block)</span>
              {!selectedTask && <Check size={14} className="ml-auto text-primary" />}
            </button>

            {loading ? (
              <p className="px-3 py-4 text-center text-xs text-text-tertiary">Loading tasks…</p>
            ) : groups.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-text-tertiary">No matching tasks.</p>
            ) : (
              groups.map((g) => (
                <div key={g.key}>
                  <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">{g.label}</p>
                  {g.tasks.map((t) => {
                    const selected = selectedTask?.id === t.id;
                    const overdue = isOverdue(t);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => choose(t)}
                        role="option"
                        aria-selected={selected}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface ${selected ? 'bg-primary/5' : ''}`}
                      >
                        <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: PRIORITY_DOT[t.priority] || PRIORITY_DOT.medium }} aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-text-primary">{t.title}</span>
                          <span className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
                            {t.board?.name && (
                              <span className="inline-flex items-center gap-1 truncate">
                                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: t.board?.color || '#94a3b8' }} />
                                {t.board.name}
                              </span>
                            )}
                            {t.status && <span className="truncate">· {String(t.status).replace(/_/g, ' ')}</span>}
                            {t.dueDate && <span className={overdue ? 'text-danger' : ''}>· {format(parseISO(t.dueDate), 'MMM d')}</span>}
                          </span>
                        </span>
                        {selected && <Check size={14} className="flex-shrink-0 text-primary" />}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
