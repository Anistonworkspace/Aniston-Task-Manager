import React, { useState, useRef, useEffect } from 'react';

export default function NumberCell({ value, onChange }) {
  const readOnly = typeof onChange !== 'function';
  const [editing, setEditing] = useState(false);
  const [localVal, setLocalVal] = useState(value ?? '');
  const inputRef = useRef(null);

  useEffect(() => { setLocalVal(value ?? ''); }, [value]);
  useEffect(() => { if (editing && inputRef.current) inputRef.current.focus(); }, [editing]);

  function handleSave() {
    const v = localVal === '' ? null : Number(localVal);
    if (!readOnly && v !== value) onChange(v);
    setEditing(false);
  }

  return (
    <div
      className={`w-full h-full flex items-center justify-center px-2 ${readOnly ? 'cursor-default' : 'cursor-text'}`}
      onClick={(e) => { e.stopPropagation(); if (!readOnly) setEditing(true); }}
    >
      {editing ? (
        <input ref={inputRef} type="number" value={localVal}
          onChange={(e) => setLocalVal(e.target.value)}
          onBlur={handleSave}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') { setLocalVal(value ?? ''); setEditing(false); } }}
          className="w-full text-xs text-center bg-transparent border-b border-primary outline-none py-0.5"
          onClick={(e) => e.stopPropagation()} />
      ) : (
        <span className={`text-xs font-medium ${value != null ? 'text-text-primary' : 'text-text-tertiary'}`}>
          {value != null ? value : '-'}
        </span>
      )}
    </div>
  );
}
