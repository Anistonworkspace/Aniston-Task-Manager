import React, { useState, useRef, useCallback } from 'react';
import { parseISO, isPast, isToday } from 'date-fns';
import { AlertTriangle } from 'lucide-react';
import api from '../../services/api';
import { formatTaskDate, toInputDate } from '../../utils/dateFormat';

/**
 * Inline date cell for the board table.
 *
 * UX (post-fix):
 *   - Click the cell → the native calendar picker opens immediately. No
 *     intermediate "type a date" stage; we render a hidden <input type="date">
 *     and call its `showPicker()` API so the user lands directly on the
 *     calendar.
 *   - Picking a date fires `onChange` with the new value, then we blur the
 *     input so the picker dismisses. No need to click outside.
 *   - Optimistic state: the visible label updates to the picked date right
 *     away. If the parent's save call rejects (e.g. backend 400/403), it does
 *     not advance `value` and our `useEffect`-free draft naturally resets on
 *     the next render — no stale UI.
 *   - Keyboard: Enter/Space on the trigger opens the picker; Esc inside the
 *     picker dismisses (browser default).
 *
 * `showPicker` browser support: Chrome 99+, Edge 99+, Safari 16.4+, Firefox
 * 101+. We feature-detect and fall back to focusing the input (browsers that
 * lack `showPicker` reveal their picker on focus anyway).
 */
export default function DateCell({ value, onChange, taskId, assignedTo, estimatedHours }) {
  const inputRef = useRef(null);
  const [hasConflict, setHasConflict] = useState(false);
  const [conflictTooltip, setConflictTooltip] = useState('');
  // Optimistic value — what the user just picked, before the parent's save
  // round-trip resolves. Falls back to `value` on the very next render if
  // the parent never updates props (failed save → silent revert).
  const [draft, setDraft] = useState(null);
  const displayValue = draft ?? value;
  const readOnly = typeof onChange !== 'function';

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

  function openPicker() {
    if (readOnly || !inputRef.current) return;
    // showPicker is the only reliable way to open the native calendar from
    // a click on a wrapper. focus() alone leaves the input in "type a date"
    // mode in some browsers.
    if (typeof inputRef.current.showPicker === 'function') {
      try { inputRef.current.showPicker(); return; } catch { /* fallthrough */ }
    }
    inputRef.current.focus();
  }

  function handleInputChange(e) {
    e.stopPropagation();
    const newVal = e.target.value || null;
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
    // Sync optimistic draft back to props on next tick so a successful save
    // (which makes `value === draft`) doesn't leave us holding a stale draft.
    // We don't await — letting the browser dismiss the picker on selection.
    queueMicrotask(() => {
      if (inputRef.current) inputRef.current.blur();
      setDraft(null);
    });
  }

  // Keyboard wrapper: Enter/Space opens the picker.
  function handleKeyDown(e) {
    if (readOnly) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      openPicker();
    }
  }

  // Compute display style state (overdue / today) using the same parse rules
  // the formatter uses, so visuals match the rendered label.
  let parsed = null;
  if (displayValue) {
    try { parsed = typeof displayValue === 'string' ? parseISO(displayValue.slice(0, 10)) : new Date(displayValue); }
    catch { parsed = null; }
  }
  const overdue = parsed && isPast(parsed) && !isToday(parsed);
  const today = parsed && isToday(parsed);

  // Hidden input is always rendered (even in read-only mode) so the trigger
  // and picker stay co-located in the DOM tree. We only attach `onChange`
  // when editable so a stray programmatic change can't fire a save.
  const hiddenInput = (
    <input
      ref={inputRef}
      type="date"
      value={toInputDate(displayValue)}
      onChange={readOnly ? undefined : handleInputChange}
      onClick={(e) => e.stopPropagation()}
      tabIndex={-1}
      aria-hidden="true"
      // The native control needs to render to be programmatically opened
      // via showPicker — `display: none` blocks that. We hide it visually
      // with width/height/opacity tricks instead, keeping it in the layout
      // flow but invisible.
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        opacity: 0,
        pointerEvents: 'none',
      }}
    />
  );

  // Empty cell (no date set yet). Whole tile is the trigger.
  if (!displayValue) {
    return (
      <div className="relative w-full h-full">
        {hiddenInput}
        <button
          type="button"
          disabled={readOnly}
          onClick={(e) => { e.stopPropagation(); openPicker(); }}
          onKeyDown={handleKeyDown}
          className={`w-full h-full flex items-center justify-center text-text-tertiary text-xs ${
            readOnly ? 'cursor-default' : 'hover:text-text-secondary cursor-pointer'
          }`}
          aria-label="Set due date"
        >
          —
        </button>
      </div>
    );
  }

  // Date set — show the formatted pill; clicking re-opens the picker.
  return (
    <div className="relative w-full h-full">
      {hiddenInput}
      <button
        type="button"
        disabled={readOnly}
        onClick={(e) => { e.stopPropagation(); openPicker(); }}
        onKeyDown={handleKeyDown}
        className={`w-full h-full text-xs font-medium inline-flex items-center justify-center gap-0.5 ${
          overdue ? 'text-danger' : today ? 'text-primary' : 'text-text-primary'
        } ${readOnly ? 'cursor-default' : 'hover:underline cursor-pointer'}`}
        title={hasConflict ? conflictTooltip : undefined}
      >
        {formatTaskDate(displayValue)}
        {hasConflict && <AlertTriangle size={10} className="text-yellow-500 ml-0.5" />}
      </button>
    </div>
  );
}
