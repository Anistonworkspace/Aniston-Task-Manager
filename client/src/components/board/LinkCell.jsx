import React, { useState, useRef, useEffect } from 'react';
import { ExternalLink } from 'lucide-react';

export default function LinkCell({ value = '', onChange }) {
  const readOnly = typeof onChange !== 'function';
  const [editing, setEditing] = useState(false);
  const [localVal, setLocalVal] = useState(value || '');
  const inputRef = useRef(null);

  useEffect(() => { setLocalVal(value || ''); }, [value]);
  useEffect(() => { if (editing && inputRef.current) inputRef.current.focus(); }, [editing]);

  function handleSave() {
    if (!readOnly && localVal !== value) onChange(localVal);
    setEditing(false);
  }

  return (
    <div className="w-full h-full flex items-center px-2" onClick={(e) => e.stopPropagation()}>
      {editing && !readOnly ? (
        <input ref={inputRef} type="url" value={localVal} placeholder="https://..."
          onChange={(e) => setLocalVal(e.target.value)}
          onBlur={handleSave}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') { setLocalVal(value || ''); setEditing(false); } }}
          className="w-full text-xs bg-transparent border-b border-primary outline-none py-0.5"
          onClick={(e) => e.stopPropagation()} />
      ) : value ? (
        <div className="flex items-center gap-1 w-full">
          <a href={value} target="_blank" rel="noopener noreferrer"
            className="text-xs text-primary hover:underline truncate flex-1" onClick={(e) => e.stopPropagation()}>
            {value.replace(/^https?:\/\//, '').slice(0, 25)}
          </a>
          <ExternalLink size={10} className="text-primary flex-shrink-0" />
          {!readOnly && (
            <button onClick={() => setEditing(true)} className="text-[10px] text-text-tertiary hover:text-primary ml-auto">Edit</button>
          )}
        </div>
      ) : readOnly ? (
        <span className="text-xs text-text-tertiary">—</span>
      ) : (
        <button onClick={() => setEditing(true)} className="text-xs text-text-tertiary hover:text-primary">
          + Add link
        </button>
      )}
    </div>
  );
}
