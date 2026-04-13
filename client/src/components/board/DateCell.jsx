import React, { useState, useCallback } from 'react';
import { format, parseISO, isPast, isToday } from 'date-fns';
import { AlertTriangle } from 'lucide-react';
import api from '../../services/api';

export default function DateCell({ value, onChange, taskId, assignedTo, estimatedHours }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');
  const [hasConflict, setHasConflict] = useState(false);
  const [conflictTooltip, setConflictTooltip] = useState('');

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

  function startEditing() {
    setDraft(value || '');
    setEditing(true);
  }

  function handleChange(e) {
    e.stopPropagation();
    setDraft(e.target.value);
  }

  function handleBlur() {
    const newVal = draft || null;
    if (newVal !== (value || null)) {
      onChange(newVal);
      checkConflictsForDate(newVal);
    }
    setEditing(false);
  }

  if (editing) {
    return (
      <input type="date" value={draft} onChange={handleChange} onBlur={handleBlur} autoFocus
        className="w-full h-full text-xs text-center bg-transparent border-none outline-none cursor-pointer" onClick={(e) => e.stopPropagation()} />
    );
  }

  if (!value) {
    return (
      <button onClick={(e) => { e.stopPropagation(); startEditing(); }} className="w-full h-full flex items-center justify-center text-text-tertiary hover:text-text-secondary text-xs">
        —
      </button>
    );
  }

  let date;
  try { date = typeof value === 'string' ? parseISO(value) : new Date(value); } catch { return <span className="text-xs text-text-tertiary">—</span>; }

  const overdue = isPast(date) && !isToday(date);
  const today = isToday(date);

  return (
    <button onClick={(e) => { e.stopPropagation(); startEditing(); }}
      className={`text-xs font-medium inline-flex items-center gap-0.5 ${overdue ? 'text-danger' : today ? 'text-primary' : 'text-text-primary'} hover:underline`}
      title={hasConflict ? conflictTooltip : undefined}
    >
      {format(date, 'MMM d')}
      {hasConflict && <AlertTriangle size={10} className="text-yellow-500 ml-0.5" />}
    </button>
  );
}
