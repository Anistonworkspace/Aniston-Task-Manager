import React, { useState, useRef, useEffect } from 'react';
import { ArrowUpDown, ArrowUp, ArrowDown, X } from 'lucide-react';

const SORT_OPTIONS = [
  { key: 'title', label: 'Task Name' },
  { key: 'status', label: 'Status' },
  { key: 'priority', label: 'Priority' },
  { key: 'dueDate', label: 'Due Date' },
  { key: 'assignedTo', label: 'Owner' },
  { key: 'progress', label: 'Progress' },
  { key: 'createdAt', label: 'Created Date' },
  { key: 'updatedAt', label: 'Last Updated' },
];

export default function SortDropdown({ sortConfig, onSort }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function handleClick(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function handleSort(key) {
    if (sortConfig?.key === key) {
      if (sortConfig.direction === 'asc') {
        onSort({ key, direction: 'desc' });
      } else {
        onSort(null); // Clear sort on third click
      }
    } else {
      onSort({ key, direction: 'asc' });
    }
  }

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 px-2.5 py-[6px] text-[14px] rounded-[4px] transition-colors ${
          sortConfig ? 'bg-[#cce5ff] text-[#0073ea]' : 'text-[#676879] hover:bg-[#dcdfec]'
        }`}>
        <ArrowUpDown size={14} /> Sort
        {sortConfig && (
          <button onClick={(e) => { e.stopPropagation(); onSort(null); }} className="ml-1 hover:text-danger">
            <X size={12} />
          </button>
        )}
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-56 bg-white dark:bg-zinc-800 rounded-xl shadow-dropdown border border-border dark:border-zinc-700 z-50 dropdown-enter overflow-hidden">
          <div className="px-3 py-2 border-b border-border dark:border-zinc-700">
            <p className="text-xs font-medium text-text-tertiary">Sort by</p>
          </div>
          <div className="py-1 max-h-[250px] overflow-y-auto">
            {SORT_OPTIONS.map(opt => {
              const isActive = sortConfig?.key === opt.key;
              return (
                <button key={opt.key} onClick={() => { handleSort(opt.key); setOpen(false); }}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-surface dark:hover:bg-zinc-700 transition-colors ${
                    isActive ? 'text-primary bg-primary/5' : 'text-text-primary dark:text-gray-300'
                  }`}>
                  <span className="flex-1 text-left">{opt.label}</span>
                  {isActive && (
                    sortConfig.direction === 'asc'
                      ? <ArrowUp size={14} className="text-primary" />
                      : <ArrowDown size={14} className="text-primary" />
                  )}
                </button>
              );
            })}
          </div>
          {sortConfig && (
            <div className="px-3 py-2 border-t border-border dark:border-zinc-700">
              <button onClick={() => { onSort(null); setOpen(false); }}
                className="text-xs text-danger hover:underline">Clear sort</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
