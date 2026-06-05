import React, { useEffect, useMemo, useState } from 'react';
import {
  X, AlertTriangle, CalendarClock, BadgeCheck, Ban, Flag, Inbox, Plus, Check, ListTodo,
} from 'lucide-react';
import { format, parseISO, isToday, differenceInDays } from 'date-fns';
import api from '../../services/api';
import { sortTasksByPendingPriority, isOverdue, isCompletedStatus, getPriorityRank } from '../../utils/taskPrioritization';

const PRIORITY_DOT = { critical: '#d83a52', high: '#f59e0b', medium: '#0073ea', low: '#94a3b8' };

const GROUP_META = {
  overdue:  { label: 'Overdue', Icon: AlertTriangle, color: '#d83a52' },
  today:    { label: 'Due Today', Icon: CalendarClock, color: '#f59e0b' },
  approval: { label: 'Approval Pending', Icon: BadgeCheck, color: '#8b5cf6' },
  blocked:  { label: 'Blocked', Icon: Ban, color: '#d83a52' },
  high:     { label: 'High Priority', Icon: Flag, color: '#f59e0b' },
  recent:   { label: 'Recently Assigned', Icon: Inbox, color: '#0073ea' },
};
const GROUP_ORDER = ['overdue', 'today', 'approval', 'blocked', 'high', 'recent'];

function isApprovalPending(t) {
  return !!t.approvalStatus && /pending/i.test(String(t.approvalStatus));
}
// "Blocked" proxy: the board's stuck/blocked status. (Dependency-graph state
// isn't on the task list payload; status is the visible signal we have.)
function isBlocked(t) {
  return /stuck|block/i.test(String(t.status || ''));
}

/**
 * "Plan from My Work" — a collapsible side panel of the user's actionable
 * tasks, bucketed so the most pressing work surfaces first. Click a task to
 * open the planner modal pre-linked to it (click-to-plan; no drag-and-drop in
 * this pass). Tasks already given a block this week show a "Planned" check.
 */
export default function WorkQueuePanel({ selectedDate, plannedTaskIds, reloadKey, onPlanTask, onClose }) {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.get('/tasks?assignedTo=me&limit=100')
      .then((res) => { if (alive) setTasks(res.data.tasks || res.data.data?.tasks || []); })
      .catch(() => { if (alive) setTasks([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [reloadKey]);

  const groups = useMemo(() => {
    const buckets = { overdue: [], today: [], approval: [], blocked: [], high: [], recent: [] };
    for (const t of tasks) {
      if (isCompletedStatus(t.status)) continue;
      if (isOverdue(t)) buckets.overdue.push(t);
      else if (t.dueDate && isToday(parseISO(t.dueDate))) buckets.today.push(t);
      else if (isApprovalPending(t)) buckets.approval.push(t);
      else if (isBlocked(t)) buckets.blocked.push(t);
      else if (getPriorityRank(t.priority) <= 1) buckets.high.push(t);
      else if (t.createdAt && differenceInDays(new Date(), parseISO(t.createdAt)) <= 7) buckets.recent.push(t);
    }
    return GROUP_ORDER
      .map((key) => ({ key, ...GROUP_META[key], tasks: sortTasksByPendingPriority(buckets[key]) }))
      .filter((g) => g.tasks.length > 0);
  }, [tasks]);

  const total = groups.reduce((s, g) => s + g.tasks.length, 0);

  return (
    <aside className="w-full flex-shrink-0 lg:w-80">
      <div className="flex max-h-[calc(100vh-9rem)] flex-col overflow-hidden rounded-2xl border border-border bg-white shadow-card lg:sticky lg:top-4">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <ListTodo size={16} className="text-primary" />
            <h3 className="font-title text-sm font-bold text-text-primary">Plan from My Work</h3>
            {total > 0 && <span className="rounded-full bg-surface px-1.5 py-0.5 text-[10px] font-semibold text-text-secondary">{total}</span>}
          </div>
          {onClose && (
            <button type="button" onClick={onClose} className="rounded-md p-1 text-text-secondary hover:bg-surface" aria-label="Hide work queue"><X size={15} /></button>
          )}
        </div>

        <p className="border-b border-border bg-surface/30 px-4 py-1.5 text-[11px] text-text-tertiary">
          Click a task to plan it on <span className="font-medium text-text-secondary">{format(parseISO(selectedDate), 'EEE, MMM d')}</span>
        </p>

        <div className="flex-1 overflow-y-auto py-1">
          {loading ? (
            <div className="space-y-2 p-3">
              {[0, 1, 2, 3].map((i) => <div key={i} className="h-10 animate-pulse rounded-lg bg-surface" />)}
            </div>
          ) : total === 0 ? (
            <div className="px-4 py-10 text-center">
              <Check size={28} className="mx-auto mb-2 text-success" />
              <p className="text-sm font-medium text-text-primary">You’re all caught up</p>
              <p className="mt-0.5 text-xs text-text-tertiary">No open tasks need planning.</p>
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.key} className="mb-1">
                <div className="flex items-center gap-1.5 px-4 pb-1 pt-2">
                  <g.Icon size={12} style={{ color: g.color }} />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">{g.label}</span>
                  <span className="text-[10px] text-text-tertiary">· {g.tasks.length}</span>
                </div>
                {g.tasks.map((t) => {
                  const planned = plannedTaskIds?.has(t.id);
                  const overdue = isOverdue(t);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => onPlanTask(t)}
                      className="group flex w-full items-start gap-2 px-4 py-2 text-left transition-colors hover:bg-surface"
                    >
                      <span className="mt-1 h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: PRIORITY_DOT[t.priority] || PRIORITY_DOT.medium }} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-text-primary">{t.title}</span>
                        <span className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
                          {t.board?.name && (
                            <span className="inline-flex items-center gap-1 truncate">
                              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: t.board?.color || '#94a3b8' }} />
                              {t.board.name}
                            </span>
                          )}
                          {t.dueDate && <span className={overdue ? 'text-danger' : ''}>· {format(parseISO(t.dueDate), 'MMM d')}</span>}
                        </span>
                      </span>
                      {planned ? (
                        <span className="mt-0.5 inline-flex items-center gap-0.5 rounded-full bg-success/10 px-1.5 py-0.5 text-[9px] font-semibold text-success" title="Already planned this week">
                          <Check size={9} /> Planned
                        </span>
                      ) : (
                        <Plus size={14} className="mt-0.5 flex-shrink-0 text-text-tertiary opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </aside>
  );
}
