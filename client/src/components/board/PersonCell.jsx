import React, { useState, useRef, useEffect } from 'react';
import { Search, X, Star, Eye } from 'lucide-react';
import Avatar from '../common/Avatar';
import PortalDropdown from '../common/PortalDropdown';

export default function PersonCell({ value, owners = [], members = [], onChange, onOwnersChange, taskAssignees = [] }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [multiMode, setMultiMode] = useState(false);
  const [selectedOwnerIds, setSelectedOwnerIds] = useState([]);
  const btnRef = useRef(null);
  const inputRef = useRef(null);

  // Derive assignees and supervisors from taskAssignees
  const assigneeUsers = taskAssignees.filter(ta => ta.role === 'assignee');
  const supervisorUsers = taskAssignees.filter(ta => ta.role === 'supervisor');
  const hasTaskAssignees = assigneeUsers.length > 0 || supervisorUsers.length > 0;

  const hasOwners = !hasTaskAssignees && Array.isArray(owners) && owners.length > 0;

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
    if (open && (hasOwners || hasTaskAssignees)) {
      if (hasTaskAssignees) {
        setSelectedOwnerIds(assigneeUsers.map(ta => ta.user?.id || ta.userId));
      } else {
        setSelectedOwnerIds(owners.map(o => o.id));
      }
      setMultiMode(true);
    } else if (open) {
      setSelectedOwnerIds([]);
      setMultiMode(false);
    }
  }, [open]);

  const assignee = value ? members.find(m => (m.id || m.user?.id) === (value?.id || value)) : null;
  const assigneeName = assignee?.name || assignee?.user?.name || value?.name;

  const filtered = search
    ? members.filter(m => (m.name || m.user?.name || '').toLowerCase().includes(search.toLowerCase()))
    : members;

  // For display: use taskAssignees if available, else fall back to owners
  const displayPeople = hasTaskAssignees
    ? assigneeUsers.map(ta => ta.user).filter(Boolean).slice(0, 3)
    : hasOwners ? owners.slice(0, 3) : [];

  const primaryOwner = hasOwners
    ? owners.find(o => o.TaskOwner?.isPrimary) || owners[0]
    : null;

  const totalPeople = hasTaskAssignees ? assigneeUsers.length : (hasOwners ? owners.length : 0);
  const extraCount = Math.max(0, totalPeople - 3);

  function handleMultiToggle(mId) {
    setSelectedOwnerIds(prev => {
      if (prev.includes(mId)) {
        return prev.filter(id => id !== mId);
      }
      return [...prev, mId];
    });
  }

  function handleMultiSave() {
    if (onOwnersChange && selectedOwnerIds.length > 0) {
      onOwnersChange(selectedOwnerIds);
    } else if (onOwnersChange && selectedOwnerIds.length === 0) {
      onOwnersChange([]);
    }
    setOpen(false);
    setSearch('');
  }

  // Render stacked avatars for multi-assignee or multi-owner display
  if ((hasTaskAssignees || hasOwners) && !open) {
    return (
      <div className="relative w-full h-full flex items-center justify-center">
        <button ref={btnRef} onClick={(e) => { e.stopPropagation(); if (!onChange && !onOwnersChange) return; setOpen(!open); setSearch(''); }}
          className="flex items-center justify-center w-full h-full hover:bg-surface-50 rounded transition-colors">
          <div className="flex items-center -space-x-1.5">
            {displayPeople.map((person, idx) => (
              <div key={person.id} className="relative" style={{ zIndex: displayPeople.length - idx }}>
                <Avatar name={person.name} image={person.avatar ? `/uploads/avatars/${person.avatar}` : undefined} size="xs" />
                {!hasTaskAssignees && primaryOwner && primaryOwner.id === person.id && (
                  <Star size={8} className="absolute -top-0.5 -right-0.5 text-amber-400 fill-amber-400" />
                )}
              </div>
            ))}
            {supervisorUsers.length > 0 && (
              <div className="w-6 h-6 rounded-lg bg-yellow-100 flex items-center justify-center border border-white" style={{ zIndex: 0 }} title={`${supervisorUsers.length} supervisor(s)`}>
                <Eye size={10} className="text-yellow-600" />
              </div>
            )}
            {extraCount > 0 && (
              <div className="w-6 h-6 rounded-lg bg-surface-200 flex items-center justify-center text-[9px] font-semibold text-text-secondary border border-white" style={{ zIndex: 0 }}>
                +{extraCount}
              </div>
            )}
          </div>
        </button>

        <PortalDropdown anchorRef={btnRef} open={open} onClose={() => { setOpen(false); setSearch(''); }} width={260} align="center">
          {renderDropdownContent()}
        </PortalDropdown>
      </div>
    );
  }

  function renderDropdownContent() {
    return (
      <div className="bg-white dark:bg-[#1a1830] rounded-xl shadow-dropdown border border-border dark:border-[#2d2b45] overflow-hidden">
        {/* Header with mode toggle */}
        {onOwnersChange && (
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-border dark:border-[#2d2b45] bg-surface-50 dark:bg-[#151327]">
            <button
              onClick={(e) => { e.stopPropagation(); setMultiMode(false); }}
              className={`text-[10px] px-2 py-0.5 rounded-full transition-colors ${!multiMode ? 'bg-primary-500 text-white' : 'text-text-tertiary hover:text-text-secondary'}`}
            >Single</button>
            <button
              onClick={(e) => { e.stopPropagation(); setMultiMode(true); }}
              className={`text-[10px] px-2 py-0.5 rounded-full transition-colors ${multiMode ? 'bg-primary-500 text-white' : 'text-text-tertiary hover:text-text-secondary'}`}
            >Multi</button>
          </div>
        )}
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
          {!multiMode && (
            <button onClick={(e) => { e.stopPropagation(); onChange?.(null); onOwnersChange?.([]); setOpen(false); setSearch(''); }}
              className="flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-surface-50 w-full text-text-secondary transition-colors">
              <div className="w-6 h-6 rounded-full bg-surface-100 flex items-center justify-center">
                <X size={12} className="text-text-tertiary" />
              </div>
              <span>Unassigned</span>
            </button>
          )}
          {filtered.map(m => {
            const mName = m.name || m.user?.name || 'Unknown';
            const mId = m.id || m.user?.id;
            const mRole = m.role || m.user?.role;

            if (multiMode) {
              const isChecked = selectedOwnerIds.includes(mId);
              const isPrimary = selectedOwnerIds[0] === mId;
              return (
                <button key={mId} onClick={(e) => { e.stopPropagation(); handleMultiToggle(mId); }}
                  className={`flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-surface-50 w-full transition-colors ${isChecked ? 'bg-primary-50' : ''}`}>
                  <input type="checkbox" checked={isChecked} readOnly
                    className="w-3.5 h-3.5 rounded border-[#c4c4c4] text-[#0073ea] focus:ring-0 pointer-events-none" />
                  <Avatar name={mName} size="xs" />
                  <div className="flex-1 min-w-0 text-left">
                    <span className="truncate block text-text-primary">{mName}</span>
                    {mRole && <span className="text-[10px] text-text-tertiary capitalize">{mRole}</span>}
                  </div>
                  {isPrimary && isChecked && <Star size={12} className="text-amber-400 fill-amber-400 flex-shrink-0" />}
                </button>
              );
            }

            const isSelected = mId === (value?.id || value);
            return (
              <button key={mId} onClick={(e) => { e.stopPropagation(); onChange?.(mId); setOpen(false); setSearch(''); }}
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
        {/* Multi-mode save button */}
        {multiMode && (
          <div className="px-3 py-2 border-t border-border dark:border-[#2d2b45]">
            <button onClick={(e) => { e.stopPropagation(); handleMultiSave(); }}
              className="w-full py-1.5 bg-primary-500 text-white text-xs rounded-lg hover:bg-primary-600 transition-colors font-medium">
              Save {selectedOwnerIds.length > 0 ? `(${selectedOwnerIds.length})` : ''}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative w-full h-full flex items-center justify-center">
      <button ref={btnRef} onClick={(e) => { e.stopPropagation(); if (!onChange && !onOwnersChange) return; setOpen(!open); setSearch(''); }}
        className="flex items-center justify-center w-full h-full hover:bg-surface-50 rounded transition-colors">
        {assigneeName ? (
          <Avatar name={assigneeName} size="xs" />
        ) : (
          <div className="w-6 h-6 rounded-full border-2 border-dashed border-text-tertiary flex items-center justify-center">
            <span className="text-[10px] text-text-tertiary">+</span>
          </div>
        )}
      </button>

      <PortalDropdown anchorRef={btnRef} open={open} onClose={() => { setOpen(false); setSearch(''); }} width={260} align="center">
        {renderDropdownContent()}
      </PortalDropdown>
    </div>
  );
}
