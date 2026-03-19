import React, { useState } from 'react';
import { format, parseISO, isPast, isToday } from 'date-fns';

export default function DateCell({ value, onChange }) {
  const [editing, setEditing] = useState(false);

  function handleChange(e) {
    e.stopPropagation();
    onChange(e.target.value || null);
    setEditing(false);
  }

  if (editing) {
    return (
      <input type="date" value={value || ''} onChange={handleChange} onBlur={() => setEditing(false)} autoFocus
        className="w-full h-full text-xs text-center bg-transparent border-none outline-none cursor-pointer" onClick={(e) => e.stopPropagation()} />
    );
  }

  if (!value) {
    return (
      <button onClick={(e) => { e.stopPropagation(); setEditing(true); }} className="w-full h-full flex items-center justify-center text-text-tertiary hover:text-text-secondary text-xs">
        —
      </button>
    );
  }

  let date;
  try { date = typeof value === 'string' ? parseISO(value) : new Date(value); } catch { return <span className="text-xs text-text-tertiary">—</span>; }

  const overdue = isPast(date) && !isToday(date);
  const today = isToday(date);

  return (
    <button onClick={(e) => { e.stopPropagation(); setEditing(true); }} className={`text-xs font-medium ${overdue ? 'text-danger' : today ? 'text-primary' : 'text-text-primary'} hover:underline`}>
      {format(date, 'MMM d')}
    </button>
  );
}
