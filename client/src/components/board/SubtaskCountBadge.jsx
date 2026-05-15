import React from 'react';

/**
 * Small monday.com-style subtask count pill that sits next to a parent task
 * title. Renders nothing when the count is zero so unrelated rows stay clean.
 *
 * The component is purely presentational — it expects the caller to pass the
 * already-resolved counts. The board's source of truth lives on the task
 * record itself (`task.subtaskTotal` / `task.subtaskDone`), kept in sync by
 * `BoardPage.handleSubtaskCountsChange` and by the server's
 * `GET /api/tasks` aggregator. We never recompute or fetch here.
 */
export default function SubtaskCountBadge({ count = 0, doneCount = 0, className = '' }) {
  if (!count || count <= 0) return null;
  const safeDone = Math.max(0, Math.min(doneCount, count));
  const allDone = safeDone === count;

  // Two visual states:
  //   - default → muted gray pill (matches monday's neutral state)
  //   - allDone → soft green pill (matches monday's "all complete" state)
  // Dark-mode variants keep contrast above WCAG AA.
  const palette = allDone
    ? 'bg-[#e9f9ee] text-[#118a4f] border border-[#c8ecd5] dark:bg-[#0f3a25] dark:text-[#7adfa6] dark:border-[#1f5538]'
    : 'bg-[#f0f1f5] text-[#676879] border border-[#d0d4e4] dark:bg-[#27272a] dark:text-[#a8aab2] dark:border-[#3a3a3f]';

  return (
    <span
      className={`inline-flex items-center justify-center min-w-[20px] h-[18px] px-1.5 rounded-[6px] text-[11px] font-semibold leading-none flex-shrink-0 transition-colors ${palette} ${className}`}
      title={`${safeDone} of ${count} ${count === 1 ? 'subitem' : 'subitems'} done`}
      aria-label={`${count} ${count === 1 ? 'subitem' : 'subitems'}`}
    >
      {count}
    </span>
  );
}
