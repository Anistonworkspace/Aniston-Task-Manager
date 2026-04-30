import React, { useState, useRef, useEffect } from 'react';
import { Search, X, Star, Eye, AlertTriangle } from 'lucide-react';
import Avatar from '../common/Avatar';
import PortalDropdown from '../common/PortalDropdown';
import { useToast } from '../common/Toast';

export default function PersonCell({
  value,
  owners = [],
  members = [],
  onChange,
  onOwnersChange,
  taskAssignees = [],
  dueDate = null,
  /**
   * When true, the picker only shows the current user — used for members
   * without the `tasks.assign_others` permission. Backend is the source of
   * truth; this is a UX guardrail to avoid letting them try to assign others.
   */
  assignSelfOnly = false,
  currentUserId = null,
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [multiMode, setMultiMode] = useState(false);
  const [selectedOwnerIds, setSelectedOwnerIds] = useState([]);
  const btnRef = useRef(null);
  const inputRef = useRef(null);
  const { error: toastError } = useToast();
  // Removing assignees is always allowed; only adding a *non-self* assignee
  // requires a due date. Self-only assignment (members claiming their own
  // task) is exempt — mirrors the backend rule in taskController.js.
  function blockIfNoDueDate(targetIds = []) {
    if (dueDate) return false;
    const ids = (Array.isArray(targetIds) ? targetIds : [targetIds]).filter(Boolean);
    const hasOther = ids.some((id) => id !== currentUserId);
    if (!hasOther) return false;
    toastError('Please set a due date before assigning this task to another user.');
    return true;
  }

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

  // When the actor cannot assign others, restrict the picker to just them.
  const visibleMembers = assignSelfOnly && currentUserId
    ? members.filter(m => (m.id || m.user?.id) === currentUserId)
    : members;

  const filtered = search
    ? visibleMembers.filter(m => (m.name || m.user?.name || '').toLowerCase().includes(search.toLowerCase()))
    : visibleMembers;

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
      const isAdding = !prev.includes(mId);
      if (isAdding && blockIfNoDueDate([mId])) return prev;
      if (!isAdding) return prev.filter(id => id !== mId);
      return [...prev, mId];
    });
  }

  function handleMultiSave() {
    // Only block if the user is trying to leave anyone assigned. An empty
    // selection means "remove all", which is allowed even with no due date.
    if (selectedOwnerIds.length > 0 && blockIfNoDueDate(selectedOwnerIds)) return;
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
                <Avatar name={person.name} image={person.avatar || undefined} size="xs" />
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
      <div className="bg-white dark:bg-[#1E1F23] rounded-xl shadow-dropdown border border-border dark:border-[#222327] overflow-hidden">
        {/* Header with mode toggle (hidden when locked to self) */}
        {onOwnersChange && !assignSelfOnly && (
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-border dark:border-[#222327] bg-surface-50 dark:bg-[#17181C]">
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
        {assignSelfOnly && (
          <div className="px-3 py-1.5 border-b border-border dark:border-[#222327] bg-amber-50 dark:bg-amber-900/20">
            <div className="flex items-center gap-1.5 text-[10px] text-amber-700 dark:text-amber-400">
              <AlertTriangle size={10} />
              <span>You can only assign tasks to yourself.</span>
            </div>
          </div>
        )}
        {/* Search */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border dark:border-[#222327]">
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
            const mAvatar = m.avatar || m.user?.avatar || undefined;

            if (multiMode) {
              const isChecked = selectedOwnerIds.includes(mId);
              const isPrimary = selectedOwnerIds[0] === mId;
              return (
                <button key={mId} onClick={(e) => { e.stopPropagation(); handleMultiToggle(mId); }}
                  className={`flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-surface-50 w-full transition-colors ${isChecked ? 'bg-primary-50' : ''}`}>
                  <input type="checkbox" checked={isChecked} readOnly
                    className="w-3.5 h-3.5 rounded border-[#c4c4c4] text-[#0073ea] focus:ring-0 pointer-events-none" />
                  <Avatar name={mName} image={mAvatar} size="xs" />
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
              <button key={mId} onClick={(e) => { e.stopPropagation(); if (blockIfNoDueDate([mId])) return; onChange?.(mId); setOpen(false); setSearch(''); }}
                className={`flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-surface-50 w-full transition-colors ${isSelected ? 'bg-primary-50' : ''}`}>
                <Avatar name={mName} image={mAvatar} size="xs" />
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
          <div className="px-3 py-2 border-t border-border dark:border-[#222327]">
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
          <Avatar name={assigneeName} image={assignee?.avatar || undefined} size="xs" />
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
