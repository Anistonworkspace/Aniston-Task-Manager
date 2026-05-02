import React, { useState, useEffect, useRef } from 'react';

function getProgressColor(val) {
  if (val <= 25) return '#e2445c';
  if (val <= 50) return '#fdab3d';
  if (val <= 75) return '#cab641';
  return '#00c875';
}

export default function ProgressCell({ value = 0, onChange, status, approvalRequired = false }) {
  const isDone = status === 'done';
  // When status === 'done', display always reads 100 even if the row hasn't yet
  // received the persisted update. Prevents a stale 0% flicker right after a
  // status change.
  const displayValue = isDone ? 100 : Math.max(0, Math.min(100, Number(value) || 0));
  const [editing, setEditing] = useState(false);
  const [draftVal, setDraftVal] = useState(displayValue);
  const lastCommittedRef = useRef(displayValue);
  const color = getProgressColor(displayValue);
  const readOnly = !onChange || isDone;
  // When the task needs approval before completion, the slider must not be
  // draggable to 100%. The backend approval gate would 403 anyway; clamping
  // client-side avoids the confusing toast and matches the "you must submit
  // for approval to complete" UX. Approved rows and super admins keep 0-100.
  const sliderMax = approvalRequired && !isDone ? 95 : 100;

  // Keep the draft in sync when the row's value updates externally (socket
  // events, server response, status flip to done) and we're not actively
  // dragging.
  useEffect(() => {
    if (!editing) {
      setDraftVal(displayValue);
      lastCommittedRef.current = displayValue;
    }
  }, [displayValue, editing]);

  function handleSliderChange(e) {
    const v = Math.max(0, Math.min(sliderMax, Number(e.target.value) || 0));
    setDraftVal(v);
  }

  function commit() {
    setEditing(false);
    if (readOnly) return;
    if (draftVal !== lastCommittedRef.current) {
      lastCommittedRef.current = draftVal;
      onChange(draftVal);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') { e.target.blur(); }
    if (e.key === 'Escape') {
      setDraftVal(lastCommittedRef.current);
      setEditing(false);
      e.target.blur();
    }
  }

  return (
    <div
      className="w-full h-full flex items-center justify-center px-2 gap-2"
      onClick={(e) => e.stopPropagation()}
      title={
        readOnly
          ? `${displayValue}%${isDone ? ' (locked — task is done)' : ''}`
          : approvalRequired
            ? `Drag to change progress (${draftVal}%) — submit for approval to reach 100%`
            : `Drag to change progress (${draftVal}%)`
      }
    >
      <div className="flex-1 flex items-center gap-1.5 min-w-0">
        <div className="flex-1 relative h-2">
          {/* Background track */}
          <div className="absolute inset-0 bg-gray-200 dark:bg-zinc-600 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-200"
              style={{ width: `${editing ? draftVal : displayValue}%`, backgroundColor: color }}
            />
          </div>
          {/* Slider input — overlaid so it's invisible but interactive */}
          {!readOnly && (
            <input
              type="range"
              min={0}
              max={sliderMax}
              step={5}
              value={Math.min(draftVal, sliderMax)}
              onChange={handleSliderChange}
              onMouseDown={() => setEditing(true)}
              onTouchStart={() => setEditing(true)}
              onMouseUp={commit}
              onTouchEnd={commit}
              onBlur={commit}
              onKeyDown={handleKeyDown}
              aria-label="Task progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={editing ? draftVal : displayValue}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
            />
          )}
        </div>
        <span
          className="text-[10px] font-semibold min-w-[28px] text-right select-none tabular-nums"
          style={{ color }}
        >
          {editing ? draftVal : displayValue}%
        </span>
      </div>
    </div>
  );
}
