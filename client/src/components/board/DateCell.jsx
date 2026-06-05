import React, { useState, useCallback, useMemo } from 'react';
import { parseISO, isPast, isToday, format } from 'date-fns';
import { AlertTriangle, Lock } from 'lucide-react';
import api from '../../services/api';
import { formatTaskDate } from '../../utils/dateFormat';
import DatePicker from '../common/DatePicker';

/**
 * Inline date cell for the board table.
 *
 * UX (post-fix):
 *   - Click the cell → an in-app calendar popover (`DatePicker`) opens. We use
 *     the custom calendar — NOT the native `<input type="date">` picker —
 *     because the native OS picker commits a date as soon as you navigate
 *     months with the arrows. With the custom calendar, the prev/next-month
 *     arrows ONLY change the displayed month; a date is committed solely when
 *     the user clicks an actual day cell. This matters most for Tier 3/4 users,
 *     who may not re-edit a due date once it's set, so an accidental commit
 *     while browsing months would lock in the wrong date.
 *   - Picking a day fires `onChange` with the new `YYYY-MM-DD` value and the
 *     popover closes itself.
 *   - Optimistic state: the visible label updates to the picked date right
 *     away. If the parent's save call rejects (e.g. backend 400/403), it does
 *     not advance `value` and our draft resets on the next render — no stale UI.
 *   - Keyboard: Enter/Space on the trigger opens the calendar; arrow keys move
 *     the focused day, PageUp/PageDown change month, Enter selects, Esc closes
 *     (all handled inside `DatePicker`).
 */
export default function DateCell({ value, onChange, taskId, assignedTo, estimatedHours, lockedReason }) {
  const [hasConflict, setHasConflict] = useState(false);
  const [conflictTooltip, setConflictTooltip] = useState('');
  // Optimistic value — what the user just picked, before the parent's save
  // round-trip resolves. Falls back to `value` on the next render if the
  // parent never updates props (failed save → silent revert).
  const [draft, setDraft] = useState(null);
  const displayValue = draft ?? value;
  const readOnly = typeof onChange !== 'function';
  // `lockedReason` is set when read-only-ness comes from a tier rule (e.g.
  // Tier 3/4 may not change a due date that's already set) rather than
  // generic non-editability (no permission at all). When present we render
  // the field as read-only WITH a lock affordance + tooltip so the user
  // can see the date but understands why they cannot change it.
  const isTierLocked = readOnly && !!lockedReason;

  const checkConflictsForDate = useCallback(async (dateVal) => {
    if (!dateVal || !assignedTo) {
      setHasConflict(false);
      return;
    }
    try {
      const startTime = new Date(dateVal);
      const endTime = new Date(startTime.getTime() + (estimatedHours || 1) * 60 * 60 * 1000);
      const res = await api.post('/tasks/check-conflicts', {
        userId: assignedTo,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        excludeTaskId: taskId,
      });
      const data = res.data || res;
      if (data.hasConflicts) {
        setHasConflict(true);
        setConflictTooltip(`Conflicts with: ${data.conflicts.map(c => c.title).join(', ')}`);
      } else {
        setHasConflict(false);
        setConflictTooltip('');
      }
    } catch {
      setHasConflict(false);
    }
  }, [assignedTo, taskId, estimatedHours]);

  // Commit a picked day. `picked` is a Date (from DatePicker) or null (Clear).
  function handlePick(picked) {
    if (readOnly) return;
    const newVal = picked ? format(picked, 'yyyy-MM-dd') : null;
    if (newVal === (value || null)) {
      setDraft(null);
      return;
    }
    setDraft(newVal);
    // Save immediately. The parent (BoardPage.handleTaskUpdate) is
    // non-optimistic — it only commits to state on success — so a failed
    // save means `value` stays at the prior date and our next render swaps
    // the draft back without any explicit revert here.
    onChange(newVal);
    checkConflictsForDate(newVal);
    // Drop the optimistic draft on the next tick so a successful save (which
    // makes `value === draft`) doesn't leave us holding a stale draft, and a
    // failed save reverts to the prior `value`.
    queueMicrotask(() => setDraft(null));
  }

  // Compute display style state (overdue / today) using the same parse rules
  // the formatter uses, so visuals match the rendered label. Memoized by the
  // string value so a board re-render while the calendar is open doesn't hand
  // DatePicker a fresh Date reference (which would reset the browsed month).
  const parsed = useMemo(() => {
    if (!displayValue) return null;
    try { return typeof displayValue === 'string' ? parseISO(displayValue.slice(0, 10)) : new Date(displayValue); }
    catch { return null; }
  }, [displayValue]);
  const overdue = parsed && isPast(parsed) && !isToday(parsed);
  const today = parsed && isToday(parsed);

  // ── Empty cell (no date set yet) ──────────────────────────────────────
  if (!displayValue) {
    const emptyBtn = (interactive) => (
      <button
        type="button"
        disabled={!interactive}
        onClick={(e) => e.stopPropagation()}
        className={`w-full h-full flex items-center justify-center text-text-tertiary text-xs ${
          interactive ? 'hover:text-text-secondary cursor-pointer' : 'cursor-default'
        }`}
        title={isTierLocked ? lockedReason : undefined}
        aria-label={isTierLocked ? lockedReason : 'Set due date'}
      >
        —
      </button>
    );

    if (readOnly) {
      return <div className="relative w-full h-full">{emptyBtn(false)}</div>;
    }
    return (
      <div className="relative w-full h-full">
        <DatePicker
          value={null}
          onChange={handlePick}
          triggerRender={() => emptyBtn(true)}
        />
      </div>
    );
  }

  // ── Date set — show the formatted pill; clicking re-opens the calendar ──
  // When tier-locked, the cell stays visible but is non-interactive, and a
  // Lock icon + tooltip make the restriction obvious. Conflict warning still
  // wins for the tooltip slot when both apply.
  const tooltip = hasConflict ? conflictTooltip : (isTierLocked ? lockedReason : undefined);
  const pill = (interactive) => (
    <button
      type="button"
      disabled={!interactive}
      onClick={(e) => e.stopPropagation()}
      className={`w-full h-full text-xs font-medium inline-flex items-center justify-center gap-0.5 ${
        overdue ? 'text-danger' : today ? 'text-primary' : 'text-text-primary'
      } ${interactive ? 'hover:underline cursor-pointer' : 'cursor-default'} ${
        isTierLocked ? 'opacity-80' : ''
      }`}
      title={tooltip}
      aria-label={isTierLocked ? `${formatTaskDate(displayValue)} — ${lockedReason}` : undefined}
    >
      {formatTaskDate(displayValue)}
      {hasConflict && <AlertTriangle size={10} className="text-yellow-500 ml-0.5" />}
      {isTierLocked && !hasConflict && <Lock size={9} className="text-text-tertiary ml-0.5" aria-hidden="true" />}
    </button>
  );

  if (readOnly) {
    return <div className="relative w-full h-full">{pill(false)}</div>;
  }
  return (
    <div className="relative w-full h-full">
      <DatePicker
        value={parsed}
        onChange={handlePick}
        triggerRender={() => pill(true)}
      />
    </div>
  );
}
