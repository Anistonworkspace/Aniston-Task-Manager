import React, { useState, useEffect, useMemo, useRef } from 'react';
import { X, Save, BookmarkCheck, ChevronDown, Filter, Clock, AlertCircle, Calendar, User, Tag, Search } from 'lucide-react';
import { STATUS_CONFIG, PRIORITY_CONFIG, DEFAULT_STATUSES, buildStatusLookup } from '../../utils/constants';

const SMART_VIEWS = [
  { id: 'overdue', label: 'Overdue', icon: AlertCircle, color: '#e2445c', filter: { dateFilter: 'overdue' } },
  { id: 'due_today', label: 'Due Today', icon: Clock, color: '#fdab3d', filter: { dateFilter: 'today' } },
  { id: 'my_tasks', label: 'My Tasks', icon: User, color: '#0073ea', filter: { assignedToMe: true } },
  { id: 'pending_approval', label: 'Pending Approval', icon: BookmarkCheck, color: '#a25ddc', filter: { approvalStatus: 'pending_approval' } },
  { id: 'this_week', label: 'This Week', icon: Calendar, color: '#00c875', filter: { dateFilter: 'this_week' } },
  { id: 'stuck', label: 'Stuck Tasks', icon: AlertCircle, color: '#e2445c', filter: { status: ['stuck'] } },
  { id: 'high_priority', label: 'High Priority', icon: Tag, color: '#e2445c', filter: { priority: ['high', 'critical'] } },
  { id: 'unassigned', label: 'Unassigned', icon: User, color: '#c4c4c4', filter: { unassigned: true } },
];

export default function AdvancedFilters({ filters, onChange, members = [], onClear, currentUserId, boardStatuses, boardLabels = [] }) {
  const { status = [], priority = [], person = '', dateFilter = '', approvalStatus = '', tags = [], labels = [], assignedToMe = false, unassigned = false, createdByMe = false, hasSubtasks = '', dueDateRange = '' } = filters;
  const [showSaved, setShowSaved] = useState(false);
  const [showSmartViews, setShowSmartViews] = useState(false);
  const [savedFilters, setSavedFilters] = useState([]);
  const [saveName, setSaveName] = useState('');
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [labelSearch, setLabelSearch] = useState('');
  const [showLabelMenu, setShowLabelMenu] = useState(false);
  const labelBoxRef = useRef(null);

  // Click-outside closes the label suggestion dropdown so it doesn't linger
  // when the user moves to another filter chip.
  useEffect(() => {
    if (!showLabelMenu) return undefined;
    function onDocClick(e) {
      if (labelBoxRef.current && !labelBoxRef.current.contains(e.target)) {
        setShowLabelMenu(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [showLabelMenu]);

  useEffect(() => {
    const saved = localStorage.getItem('savedFilters');
    if (saved) setSavedFilters(JSON.parse(saved));
  }, []);

  function toggleStatus(val) {
    const next = status.includes(val) ? status.filter(s => s !== val) : [...status, val];
    onChange({ ...filters, status: next });
  }

  function togglePriority(val) {
    const next = priority.includes(val) ? priority.filter(p => p !== val) : [...priority, val];
    onChange({ ...filters, priority: next });
  }

  function setPerson(val) {
    onChange({ ...filters, person: val });
  }

  function setDateFilter(val) {
    onChange({ ...filters, dateFilter: val });
  }

  function setApprovalFilter(val) {
    onChange({ ...filters, approvalStatus: val });
  }

  function toggleAssignedToMe() {
    onChange({ ...filters, assignedToMe: !assignedToMe, person: '' });
  }

  function toggleUnassigned() {
    onChange({ ...filters, unassigned: !unassigned, person: '' });
  }

  function toggleCreatedByMe() {
    onChange({ ...filters, createdByMe: !createdByMe });
  }

  function applySmartView(view) {
    onChange({ ...getDefaultFilters(), ...view.filter });
    setShowSmartViews(false);
  }

  function saveCurrentFilter() {
    if (!saveName.trim()) return;
    const newSaved = [...savedFilters, { name: saveName, filters: { ...filters }, id: Date.now() }];
    setSavedFilters(newSaved);
    localStorage.setItem('savedFilters', JSON.stringify(newSaved));
    setSaveName('');
    setShowSaveInput(false);
  }

  function applySavedFilter(sf) {
    onChange(sf.filters);
    setShowSaved(false);
  }

  function deleteSavedFilter(id) {
    const newSaved = savedFilters.filter(s => s.id !== id);
    setSavedFilters(newSaved);
    localStorage.setItem('savedFilters', JSON.stringify(newSaved));
  }

  function getDefaultFilters() {
    return { status: [], priority: [], person: '', dateFilter: '', approvalStatus: '', tags: [], labels: [], assignedToMe: false, unassigned: false, createdByMe: false, hasSubtasks: '', dueDateRange: '' };
  }

  // Label filter helpers — `labels` in the filter state is an array of
  // stable label IDs (strings). We never store the full label object to
  // avoid stale colour/name when a label is renamed elsewhere; the chip
  // colour/name is always looked up from `boardLabels` at render time.
  function toggleLabel(id) {
    if (!id) return;
    const next = labels.includes(id) ? labels.filter(l => l !== id) : [...labels, id];
    onChange({ ...filters, labels: next });
  }

  function removeLabel(id) {
    onChange({ ...filters, labels: labels.filter(l => l !== id) });
  }

  // Case-insensitive search across the board's known labels. We exclude
  // labels that are already selected so the dropdown only ever offers
  // new picks, which keeps the suggestion list short and obvious.
  const filteredLabelSuggestions = useMemo(() => {
    const q = labelSearch.trim().toLowerCase();
    return (boardLabels || []).filter(l => {
      if (!l || !l.id) return false;
      if (labels.includes(l.id)) return false;
      if (!q) return true;
      return (l.name || '').toLowerCase().includes(q);
    });
  }, [boardLabels, labelSearch, labels]);

  const selectedLabelObjects = useMemo(() => {
    const byId = new Map((boardLabels || []).map(l => [l.id, l]));
    return labels
      .map(id => byId.get(id) || { id, name: id, color: '#c4c4c4' })
      .filter(Boolean);
  }, [boardLabels, labels]);

  const hasFilters = status.length > 0 || priority.length > 0 || person || dateFilter || approvalStatus || assignedToMe || unassigned || createdByMe || labels.length > 0;
  const filterCount = [status.length > 0, priority.length > 0, !!person, !!dateFilter, !!approvalStatus, assignedToMe, unassigned, createdByMe, labels.length > 0].filter(Boolean).length;

  return (
    <div className="bg-surface/40 rounded-lg mb-2 border border-border/40 animate-fade-in">
      {/* Top row */}
      <div className="flex items-center gap-2 py-2 px-3 flex-wrap">
        {/* Smart Views */}
        <div className="relative">
          <button onClick={() => setShowSmartViews(!showSmartViews)}
            className="flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1.5 rounded-md bg-primary/5 text-primary hover:bg-primary/10 transition-colors border border-primary/20">
            <BookmarkCheck size={13} /> Smart Views <ChevronDown size={11} />
          </button>
          {showSmartViews && (
            <div className="absolute top-full left-0 mt-1 w-52 bg-white dark:bg-zinc-800 rounded-lg shadow-lg border border-gray-200 dark:border-zinc-700 z-50 py-1">
              {SMART_VIEWS.map(v => (
                <button key={v.id} onClick={() => applySmartView(v)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-gray-50 dark:hover:bg-zinc-700 text-left">
                  <v.icon size={13} style={{ color: v.color }} />
                  <span className="text-gray-700 dark:text-gray-300">{v.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Status chips */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] uppercase tracking-wider text-text-tertiary font-semibold mr-0.5">Status</span>
          {(boardStatuses && boardStatuses.length > 0 ? boardStatuses : DEFAULT_STATUSES).map(s => {
            const cfg = buildStatusLookup([s])[s.key];
            return (
              <button key={s.key} onClick={() => toggleStatus(s.key)}
                className={`text-[11px] font-medium px-2 py-1 rounded-md transition-all border ${
                  status.includes(s.key) ? 'text-white border-transparent shadow-sm' : 'bg-white dark:bg-zinc-700 text-text-secondary border-border/60 hover:border-border'
                }`}
                style={status.includes(s.key) ? { backgroundColor: cfg.color } : {}}>
                {cfg.label}
              </button>
            );
          })}
        </div>

        <div className="w-px h-5 bg-border/60" />

        {/* Priority chips */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] uppercase tracking-wider text-text-tertiary font-semibold mr-0.5">Priority</span>
          {Object.entries(PRIORITY_CONFIG).map(([key, cfg]) => (
            <button key={key} onClick={() => togglePriority(key)}
              className={`text-[11px] font-medium px-2 py-1 rounded-md transition-all border ${
                priority.includes(key) ? 'text-white border-transparent shadow-sm' : 'bg-white dark:bg-zinc-700 text-text-secondary border-border/60 hover:border-border'
              }`}
              style={priority.includes(key) ? { backgroundColor: cfg.color } : {}}>
              {cfg.label}
            </button>
          ))}
        </div>

        <div className="w-px h-5 bg-border/60" />

        {/* Person select */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] uppercase tracking-wider text-text-tertiary font-semibold mr-0.5">Person</span>
          <select value={person} onChange={e => setPerson(e.target.value)}
            className="text-xs border border-border/60 rounded-md px-2 py-1 bg-white dark:bg-zinc-700 text-text-secondary focus:outline-none focus:border-primary min-w-[100px]">
            <option value="">All</option>
            {members.map(m => (
              <option key={m.id || m.user?.id} value={m.id || m.user?.id}>{m.name || m.user?.name}</option>
            ))}
          </select>
        </div>

        <div className="w-px h-5 bg-border/60" />

        {/* Labels filter — searchable, multi-select. Placed beside Person so
            it sits next to the other task-attribute filters and lines up
            visually with the Status / Priority chips above. The dropdown
            is a sibling absolute-positioned panel rather than a portal,
            since the filter row itself is not inside an overflow-clip
            container — this keeps the markup simple and matches the
            other inline filters here. */}
        <div className="flex items-center gap-1" ref={labelBoxRef}>
          <span className="text-[10px] uppercase tracking-wider text-text-tertiary font-semibold mr-0.5">Labels</span>
          <div className="relative">
            <div
              className="flex items-center gap-1 flex-wrap bg-white dark:bg-zinc-700 border border-border/60 rounded-md px-1.5 py-0.5 min-w-[140px] max-w-[260px] focus-within:border-primary"
              onClick={() => setShowLabelMenu(true)}
            >
              {selectedLabelObjects.map(l => (
                <span
                  key={l.id}
                  className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full text-white"
                  style={{ backgroundColor: l.color || '#c4c4c4' }}
                  title={l.name}
                >
                  <span className="truncate max-w-[80px]">{l.name}</span>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); removeLabel(l.id); }}
                    className="hover:bg-black/20 rounded-full p-0.5"
                    aria-label={`Remove ${l.name} filter`}
                  >
                    <X size={9} />
                  </button>
                </span>
              ))}
              <div className="relative flex-1 min-w-[60px] flex items-center">
                {selectedLabelObjects.length === 0 && (
                  <Search size={10} className="text-text-tertiary mr-1" />
                )}
                <input
                  type="text"
                  value={labelSearch}
                  onChange={(e) => { setLabelSearch(e.target.value); setShowLabelMenu(true); }}
                  onFocus={() => setShowLabelMenu(true)}
                  placeholder={selectedLabelObjects.length === 0 ? 'Search labels…' : ''}
                  className="bg-transparent text-[11px] py-0.5 focus:outline-none flex-1 min-w-[60px] text-text-secondary"
                  aria-label="Search labels"
                />
              </div>
            </div>
            {showLabelMenu && (
              <div className="absolute top-full left-0 mt-1 w-56 bg-white dark:bg-zinc-800 rounded-lg shadow-lg border border-gray-200 dark:border-zinc-700 z-50 py-1 max-h-56 overflow-y-auto">
                {(!boardLabels || boardLabels.length === 0) ? (
                  <p className="text-[11px] text-text-tertiary px-3 py-2 text-center">No labels found</p>
                ) : filteredLabelSuggestions.length === 0 ? (
                  <p className="text-[11px] text-text-tertiary px-3 py-2 text-center">
                    {labelSearch ? 'No matching labels' : 'All labels selected'}
                  </p>
                ) : (
                  filteredLabelSuggestions.map(l => (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() => { toggleLabel(l.id); setLabelSearch(''); }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-gray-50 dark:hover:bg-zinc-700 text-left"
                    >
                      <span
                        className="w-3 h-3 rounded-full flex-shrink-0"
                        style={{ backgroundColor: l.color || '#c4c4c4' }}
                      />
                      <span className="text-gray-700 dark:text-gray-300 truncate">{l.name}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        {/* Toggle expanded */}
        <button onClick={() => setExpanded(!expanded)}
          className="ml-auto flex items-center gap-1 text-[10px] text-text-tertiary hover:text-primary transition-colors">
          <Filter size={11} /> {expanded ? 'Less' : 'More'} filters {filterCount > 0 && <span className="bg-primary text-white rounded-full w-4 h-4 flex items-center justify-center text-[9px]">{filterCount}</span>}
        </button>

        {hasFilters && (
          <button onClick={onClear}
            className="flex items-center gap-1 text-xs text-primary hover:text-primary-dark font-medium px-2 py-1 rounded-md hover:bg-primary/5 transition-colors">
            <X size={13} /> Clear
          </button>
        )}
      </div>

      {/* Expanded filters row */}
      {expanded && (
        <div className="flex items-center gap-3 px-3 pb-2.5 flex-wrap border-t border-border/30 pt-2">
          {/* Date filter */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] uppercase tracking-wider text-text-tertiary font-semibold">Date</span>
            <select value={dateFilter} onChange={e => setDateFilter(e.target.value)}
              className="text-xs border border-border/60 rounded-md px-2 py-1 bg-white dark:bg-zinc-700 text-text-secondary focus:outline-none focus:border-primary">
              <option value="">All dates</option>
              <option value="overdue">Overdue</option>
              <option value="today">Due today</option>
              <option value="tomorrow">Due tomorrow</option>
              <option value="this_week">This week</option>
              <option value="next_week">Next week</option>
              <option value="this_month">This month</option>
              <option value="no_date">No due date</option>
            </select>
          </div>

          <div className="w-px h-5 bg-border/60" />

          {/* Approval status */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] uppercase tracking-wider text-text-tertiary font-semibold">Approval</span>
            <select value={approvalStatus} onChange={e => setApprovalFilter(e.target.value)}
              className="text-xs border border-border/60 rounded-md px-2 py-1 bg-white dark:bg-zinc-700 text-text-secondary focus:outline-none focus:border-primary">
              <option value="">All</option>
              <option value="pending_approval">Pending</option>
              <option value="approved">Approved</option>
              <option value="changes_requested">Changes Requested</option>
            </select>
          </div>

          <div className="w-px h-5 bg-border/60" />

          {/* Quick toggles */}
          <button onClick={toggleAssignedToMe}
            className={`text-[11px] font-medium px-2.5 py-1 rounded-md border transition-all ${
              assignedToMe ? 'bg-primary text-white border-primary' : 'bg-white dark:bg-zinc-700 text-text-secondary border-border/60'
            }`}>
            My Tasks
          </button>
          <button onClick={toggleUnassigned}
            className={`text-[11px] font-medium px-2.5 py-1 rounded-md border transition-all ${
              unassigned ? 'bg-primary text-white border-primary' : 'bg-white dark:bg-zinc-700 text-text-secondary border-border/60'
            }`}>
            Unassigned
          </button>
          <button onClick={toggleCreatedByMe}
            className={`text-[11px] font-medium px-2.5 py-1 rounded-md border transition-all ${
              createdByMe ? 'bg-primary text-white border-primary' : 'bg-white dark:bg-zinc-700 text-text-secondary border-border/60'
            }`}>
            Created by Me
          </button>

          <div className="w-px h-5 bg-border/60" />

          {/* Save filter */}
          <div className="relative ml-auto flex items-center gap-1">
            {showSaveInput ? (
              <div className="flex items-center gap-1">
                <input type="text" value={saveName} onChange={e => setSaveName(e.target.value)}
                  placeholder="Filter name..." className="text-xs border border-border rounded-md px-2 py-1 w-28 focus:outline-none focus:border-primary"
                  onKeyDown={e => e.key === 'Enter' && saveCurrentFilter()} autoFocus />
                <button onClick={saveCurrentFilter} className="text-xs text-primary font-medium">Save</button>
                <button onClick={() => setShowSaveInput(false)} className="text-xs text-gray-400"><X size={12} /></button>
              </div>
            ) : (
              <button onClick={() => hasFilters && setShowSaveInput(true)}
                className={`flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-md transition-colors ${hasFilters ? 'text-primary hover:bg-primary/5' : 'text-gray-300 cursor-not-allowed'}`}>
                <Save size={12} /> Save Filter
              </button>
            )}

            {/* Saved filters list */}
            <div className="relative">
              <button onClick={() => setShowSaved(!showSaved)}
                className="flex items-center gap-1 text-[11px] text-text-tertiary hover:text-primary px-2 py-1 rounded-md">
                <BookmarkCheck size={12} /> Saved ({savedFilters.length})
              </button>
              {showSaved && savedFilters.length > 0 && (
                <div className="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-zinc-800 rounded-lg shadow-lg border border-gray-200 dark:border-zinc-700 z-50 py-1">
                  {savedFilters.map(sf => (
                    <div key={sf.id} className="flex items-center justify-between px-3 py-2 hover:bg-gray-50 dark:hover:bg-zinc-700">
                      <button onClick={() => applySavedFilter(sf)} className="text-xs text-gray-700 dark:text-gray-300 truncate flex-1 text-left">{sf.name}</button>
                      <button onClick={() => deleteSavedFilter(sf.id)} className="text-gray-400 hover:text-red-500 ml-1"><X size={11} /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
