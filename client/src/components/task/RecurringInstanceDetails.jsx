import React, { useMemo } from 'react';
import {
  RefreshCw, Clock, CalendarDays, ExternalLink,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { buildScheduleSummary } from '../../services/recurringTasks';

/**
 * RecurringInstanceDetails — compact schedule-summary card for the task
 * detail modal.
 *
 * Renders ONLY when `task.isRecurringInstance` is true. The parent
 * (TaskModal) lazy-fetches the recurring template on open and passes it
 * down. While the fetch is in flight `templateLoading` is true and we
 * render a small skeleton.
 *
 * Scope (intentionally narrow):
 *   - Frequency + selected days/dates
 *   - This occurrence
 *   - Due time + timezone
 *   - Active window (start → end / "no end date")
 *   - Last generated / Next run
 *   - Status pill (Active / Paused / Archived)
 *
 * NOT shown here:
 *   - Board, Group, Priority — already surfaced elsewhere in the modal
 *     (Status / Priority pills, board breadcrumb, Assign To row).
 *   - Template title — when distinct from task title, the badge in the
 *     modal header carries the template context already.
 *
 * Pure presentational — no DB calls, no socket subscriptions. The only side
 * effect is a navigation link to /recurring-work for users who can manage.
 */
export default function RecurringInstanceDetails({
  task,
  template,
  templateLoading,
  // `board` is accepted for prop-stability but no longer rendered — kept on
  // the signature so existing callers (TaskModal) compile unchanged.
  board, // eslint-disable-line no-unused-vars
  canManageTemplate,
}) {
  const schedule = useMemo(
    () => (template ? buildScheduleSummary(template) : null),
    [template]
  );

  const statusLabel = (() => {
    if (!template) return null;
    if (template.archivedAt) return { text: 'Archived', tone: 'gray' };
    if (template.isActive === false) return { text: 'Paused', tone: 'amber' };
    return { text: 'Active', tone: 'green' };
  })();

  return (
    <div className="mb-3 rounded-md border border-purple-200 dark:border-purple-900/40 bg-purple-50/40 dark:bg-purple-900/10 px-3 py-2">
      {/* Header row — heading + state pill + optional inline manage link.
          Putting the manage link inline (not on its own row) saves vertical
          height vs the previous full-card footer. */}
      <div className="flex items-center gap-2 mb-1.5">
        <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-purple-700 dark:text-purple-300">
          <RefreshCw size={11} />
          <span>Recurring Schedule</span>
        </div>
        {statusLabel && (
          <StatePill tone={statusLabel.tone}>{statusLabel.text}</StatePill>
        )}
        {canManageTemplate && template?.id && (
          <a
            href="/recurring-work"
            className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-purple-700 dark:text-purple-300 hover:underline"
          >
            <ExternalLink size={11} />
            <span>Manage</span>
          </a>
        )}
      </div>

      {templateLoading ? (
        <SkeletonRows />
      ) : !template ? (
        <FallbackCard task={task} />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1 text-[11px] leading-tight">
          {/* Frequency + selected days. The `sub` line carries the picked
              days/weekdays so the user reads "Monthly · Day 5, Day 15, Day 25"
              without needing a second row. */}
          <Detail
            label="Frequency"
            value={schedule?.kind || '—'}
            sub={schedule?.summary}
          />

          <Detail
            label="Occurrence"
            icon={CalendarDays}
            value={formatDate(task?.occurrenceDate || task?.dueDate)}
          />

          <Detail
            label="Due time"
            icon={Clock}
            value={`${schedule?.dueTime || '—'}${
              schedule?.timezone ? ` (${schedule.timezone})` : ''
            }`}
          />

          <Detail
            label="Window"
            value={`${schedule?.startDate || '—'}${
              schedule?.endDate ? ` → ${schedule.endDate}` : ' → no end'
            }`}
          />

          <Detail
            label="Last"
            value={template.lastGeneratedDate ? formatDate(template.lastGeneratedDate) : '—'}
          />

          <Detail
            label="Next"
            value={template.nextRunAt
              ? new Date(template.nextRunAt).toLocaleString()
              : 'Not scheduled'}
          />
        </div>
      )}
    </div>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────

function Detail({ label, icon: Icon, value, sub }) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] uppercase tracking-wide font-semibold text-text-tertiary">
        {label}
      </div>
      <div
        className="inline-flex items-center gap-1 text-text-primary truncate w-full"
        title={typeof value === 'string' ? value : undefined}
      >
        {Icon && <Icon size={10} className="text-text-tertiary flex-shrink-0" />}
        <span className="truncate">{value || '—'}</span>
      </div>
      {sub && sub !== value && (
        <div className="text-[10px] text-text-secondary truncate" title={sub}>
          {sub}
        </div>
      )}
    </div>
  );
}

function StatePill({ tone, children }) {
  const toneMap = {
    green: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300',
    amber: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
    gray: 'bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-gray-300',
  };
  return (
    <span className={`text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded ${toneMap[tone] || toneMap.gray}`}>
      {children}
    </span>
  );
}

function SkeletonRows() {
  // 6 placeholder rows match the new (compact) Detail count.
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1 animate-pulse">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="space-y-1">
          <div className="h-2 w-10 bg-purple-200/40 dark:bg-purple-900/30 rounded" />
          <div className="h-2.5 w-20 bg-purple-200/60 dark:bg-purple-900/40 rounded" />
        </div>
      ))}
    </div>
  );
}

/**
 * Fallback shown when `task.isRecurringInstance === true` but the template
 * association couldn't be loaded — typically because the FK was set NULL on
 * a hard-delete. We don't crash; we just show the bare instance metadata.
 */
function FallbackCard({ task }) {
  return (
    <div className="text-[11px] text-text-secondary space-y-0.5">
      <div className="font-medium text-text-primary">Recurring task instance</div>
      <div>
        Occurrence: <span className="text-text-primary">
          {formatDate(task?.occurrenceDate || task?.dueDate)}
        </span>
      </div>
    </div>
  );
}

function formatDate(value) {
  if (!value) return '—';
  // DATEONLY values come back as "YYYY-MM-DD" strings; full timestamps come
  // back as ISO. Handle both — parseISO works for either when the input is
  // a string, but plain strings give us a Date at local midnight which is
  // what we want for an "occurrence date".
  try {
    const d = typeof value === 'string' ? parseISO(value) : new Date(value);
    return format(d, 'MMM d, yyyy');
  } catch {
    return String(value);
  }
}
