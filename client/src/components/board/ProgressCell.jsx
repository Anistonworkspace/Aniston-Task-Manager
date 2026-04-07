import React, { useState } from 'react';

function getProgressColor(val) {
  if (val <= 25) return '#e2445c';
  if (val <= 50) return '#fdab3d';
  if (val <= 75) return '#cab641';
  return '#00c875';
}

export default function ProgressCell({ value = 0, onChange }) {
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState(value);
  const color = getProgressColor(value);

  function handleSave() {
    const clamped = Math.max(0, Math.min(100, Number(inputVal) || 0));
    onChange(clamped);
    setEditing(false);
  }

  return (
    <div className="w-full h-full flex items-center justify-center px-2" onClick={(e) => { e.stopPropagation(); setEditing(true); }}>
      {editing ? (
        <input type="number" min={0} max={100} value={inputVal} onChange={e => setInputVal(e.target.value)}
          onBlur={handleSave} onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') setEditing(false); }}
          className="w-14 text-xs text-center border border-primary rounded px-1 py-0.5 focus:outline-none" autoFocus />
      ) : (
        <div className="flex items-center gap-1.5 w-full cursor-pointer" title={`${value}%`}>
          <div className="flex-1 h-2 bg-gray-200 dark:bg-zinc-600 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all duration-300" style={{ width: `${value}%`, backgroundColor: color }} />
          </div>
          <span className="text-[10px] font-semibold min-w-[28px] text-right" style={{ color }}>{value}%</span>
        </div>
      )}
    </div>
  );
}
