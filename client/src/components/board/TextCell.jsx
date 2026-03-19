import React, { useState, useRef, useEffect } from 'react';

export default function TextCell({ value = '', onChange, placeholder = 'Enter text...' }) {
  const [editing, setEditing] = useState(false);
  const [localVal, setLocalVal] = useState(value || '');
  const inputRef = useRef(null);

  useEffect(() => { setLocalVal(value || ''); }, [value]);
  useEffect(() => { if (editing && inputRef.current) inputRef.current.focus(); }, [editing]);

  function handleSave() {
    if (localVal !== value) onChange(localVal);
    setEditing(false);
  }

  return (
    <div className="w-full h-full flex items-center px-2 cursor-text" onClick={(e) => { e.stopPropagation(); setEditing(true); }}>
      {editing ? (
        <input ref={inputRef} type="text" value={localVal}
          onChange={(e) => setLocalVal(e.target.value)}
          onBlur={handleSave}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') { setLocalVal(value || ''); setEditing(false); } }}
          className="w-full text-xs bg-transparent border-b border-primary outline-none py-0.5 text-text-primary"
          onClick={(e) => e.stopPropagation()} />
      ) : (
        <span className={`text-xs truncate ${value ? 'text-text-primary' : 'text-text-tertiary'}`}>
          {value || placeholder}
        </span>
      )}
    </div>
  );
}
