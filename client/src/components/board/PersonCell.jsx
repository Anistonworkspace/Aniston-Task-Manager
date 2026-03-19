import React, { useState, useRef, useEffect } from 'react';
import { Search, X } from 'lucide-react';
import Avatar from '../common/Avatar';
import PortalDropdown from '../common/PortalDropdown';

export default function PersonCell({ value, members = [], onChange }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const btnRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  const assignee = value ? members.find(m => (m.id || m.user?.id) === (value?.id || value)) : null;
  const assigneeName = assignee?.name || assignee?.user?.name || value?.name;

  const filtered = search
    ? members.filter(m => (m.name || m.user?.name || '').toLowerCase().includes(search.toLowerCase()))
    : members;

  return (
    <div className="relative w-full h-full flex items-center justify-center">
      <button ref={btnRef} onClick={(e) => { e.stopPropagation(); if (!onChange) return; setOpen(!open); setSearch(''); }}
        className="flex items-center justify-center w-full h-full hover:bg-surface-50 rounded transition-colors">
        {assigneeName ? (
          <Avatar name={assigneeName} size="xs" />
        ) : (
          <div className="w-6 h-6 rounded-full border-2 border-dashed border-text-tertiary flex items-center justify-center">
            <span className="text-[10px] text-text-tertiary">+</span>
          </div>
        )}
      </button>

      <PortalDropdown anchorRef={btnRef} open={open} onClose={() => { setOpen(false); setSearch(''); }} width={240} align="center">
        <div className="bg-white dark:bg-[#1a1830] rounded-xl shadow-dropdown border border-border dark:border-[#2d2b45] overflow-hidden">
          {/* Search */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border dark:border-[#2d2b45]">
            <Search size={13} className="text-text-tertiary flex-shrink-0" />
            <input ref={inputRef} type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search people..." className="bg-transparent border-none outline-none text-xs w-full placeholder:text-text-tertiary shadow-none ring-0 focus:ring-0"
              onClick={e => e.stopPropagation()} />
            {search && (
              <button onClick={(e) => { e.stopPropagation(); setSearch(''); }} className="text-text-tertiary hover:text-text-secondary">
                <X size={12} />
              </button>
            )}
          </div>
          {/* Options */}
          <div className="max-h-[220px] overflow-y-auto py-1">
            <button onClick={(e) => { e.stopPropagation(); onChange(null); setOpen(false); setSearch(''); }}
              className="flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-surface-50 w-full text-text-secondary transition-colors">
              <div className="w-6 h-6 rounded-full bg-surface-100 flex items-center justify-center">
                <X size={12} className="text-text-tertiary" />
              </div>
              <span>Unassigned</span>
            </button>
            {filtered.map(m => {
              const mName = m.name || m.user?.name || 'Unknown';
              const mId = m.id || m.user?.id;
              const mRole = m.role || m.user?.role;
              const isSelected = mId === (value?.id || value);
              return (
                <button key={mId} onClick={(e) => { e.stopPropagation(); onChange(mId); setOpen(false); setSearch(''); }}
                  className={`flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-surface-50 w-full transition-colors ${isSelected ? 'bg-primary-50' : ''}`}>
                  <Avatar name={mName} size="xs" />
                  <div className="flex-1 min-w-0 text-left">
                    <span className="truncate block text-text-primary">{mName}</span>
                    {mRole && <span className="text-[10px] text-text-tertiary capitalize">{mRole}</span>}
                  </div>
                  {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-primary-500 flex-shrink-0" />}
                </button>
              );
            })}
            {filtered.length === 0 && (
              <p className="text-xs text-text-tertiary text-center py-3">No people found</p>
            )}
          </div>
        </div>
      </PortalDropdown>
    </div>
  );
}
