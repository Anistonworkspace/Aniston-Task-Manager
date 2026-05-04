import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, X, Check, Building2 } from 'lucide-react';
import PortalDropdown from './PortalDropdown';
import { OFFICIAL_DEPARTMENTS, DEPARTMENT_OTHER, isOfficialDepartment } from '../../utils/constants';

/**
 * Department picker bound to the official org-chart department list, with a
 * built-in "Other" custom-text fallback so existing free-form values are not
 * lost. Emits the effective string via onChange — callers persist it as-is.
 *
 * Modes:
 *   - empty / official → only the select trigger is visible
 *   - other            → trigger reads "Other (custom)" and a text input
 *                        appears beneath for the custom value
 *
 * "Other" mode is sticky for the lifetime of the component instance: clearing
 * the custom input does not snap back to "no selection", so the admin can
 * type-then-pause-then-type without losing context.
 */
export default function DepartmentSelect({
  value = '',
  onChange,
  onModeChange,
  disabled = false,
  placeholder = 'Select department',
  className = '',
  id,
  customPlaceholder = 'Type custom department',
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [otherMode, setOtherMode] = useState(
    () => typeof value === 'string' && value.trim() !== '' && !isOfficialDepartment(value),
  );

  const triggerRef = useRef(null);
  const searchRef = useRef(null);
  const customRef = useRef(null);

  // Sync external value → internal mode. Only flip out of Other mode when the
  // parent assigns an actual official value; an empty incoming value is
  // treated as "user is mid-edit", so we keep the custom input visible.
  useEffect(() => {
    if (typeof value === 'string' && value.trim() !== '' && isOfficialDepartment(value)) {
      setOtherMode(false);
    } else if (typeof value === 'string' && value.trim() !== '' && !isOfficialDepartment(value)) {
      setOtherMode(true);
    }
  }, [value]);

  // Surface the current mode so callers can validate "Other selected but
  // empty custom text" without having to peek at our internal state.
  useEffect(() => {
    if (typeof onModeChange !== 'function') return;
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (otherMode) onModeChange('other');
    else if (trimmed) onModeChange('official');
    else onModeChange('empty');
  }, [otherMode, value, onModeChange]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return OFFICIAL_DEPARTMENTS;
    return OFFICIAL_DEPARTMENTS.filter(d => d.toLowerCase().includes(q));
  }, [search]);

  function close() {
    setOpen(false);
    setSearch('');
  }

  function handlePickOfficial(name) {
    setOtherMode(false);
    onChange?.(name);
    close();
  }

  function handlePickOther() {
    // If the existing value happens to already be a custom string, keep it so
    // admins editing a legacy department do not have to retype.
    if (typeof value !== 'string' || value.trim() === '' || isOfficialDepartment(value)) {
      onChange?.('');
    }
    setOtherMode(true);
    close();
    // Focus the custom input on the next tick so the input is mounted.
    setTimeout(() => customRef.current?.focus(), 30);
  }

  function handleClear(e) {
    e.stopPropagation();
    setOtherMode(false);
    onChange?.('');
  }

  function handleTriggerKey(e) {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
    }
  }

  // Auto-focus search when the dropdown opens.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => searchRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open]);

  const showCustomInput = otherMode;
  const displayLabel = (() => {
    if (otherMode) return DEPARTMENT_OTHER;
    if (typeof value === 'string' && value.trim() !== '') return value;
    return '';
  })();

  const baseTriggerCls =
    'w-full flex items-center justify-between gap-2 px-3 py-2 border border-border rounded-lg text-sm bg-white dark:bg-[#1E1F23] text-text-primary transition-colors focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary disabled:opacity-50 disabled:cursor-not-allowed';

  return (
    <div className={className}>
      <button
        type="button"
        id={id}
        ref={triggerRef}
        disabled={disabled}
        onClick={() => !disabled && setOpen(o => !o)}
        onKeyDown={handleTriggerKey}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`${baseTriggerCls} hover:border-text-tertiary`}
      >
        <span className="flex items-center gap-2 min-w-0">
          <Building2 size={14} className="text-text-tertiary flex-shrink-0" />
          {displayLabel ? (
            <span className="truncate text-text-primary">{displayLabel}</span>
          ) : (
            <span className="truncate text-text-tertiary">{placeholder}</span>
          )}
          {otherMode && (
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-100 flex-shrink-0">
              Custom
            </span>
          )}
        </span>
        <span className="flex items-center gap-1 flex-shrink-0">
          {displayLabel && !disabled && (
            <span
              role="button"
              tabIndex={-1}
              onClick={handleClear}
              onMouseDown={(e) => e.preventDefault()}
              className="p-0.5 rounded text-text-tertiary hover:text-text-secondary hover:bg-surface-100"
              aria-label="Clear department"
            >
              <X size={12} />
            </span>
          )}
          <ChevronDown size={14} className={`text-text-tertiary transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>

      <PortalDropdown anchorRef={triggerRef} open={open} onClose={close} width={320} align="left">
        <div className="bg-white dark:bg-[#1E1F23] rounded-xl shadow-dropdown border border-border dark:border-[#222327] overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border dark:border-[#222327]">
            <Search size={13} className="text-text-tertiary flex-shrink-0" />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search departments..."
              className="bg-transparent border-none outline-none text-xs w-full placeholder:text-text-tertiary shadow-none ring-0 focus:ring-0"
              onClick={e => e.stopPropagation()}
            />
            {search && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setSearch(''); }}
                className="text-text-tertiary hover:text-text-secondary"
                aria-label="Clear search"
              >
                <X size={12} />
              </button>
            )}
          </div>

          <div className="max-h-[260px] overflow-y-auto py-1" role="listbox">
            {filtered.length === 0 && (
              <div className="px-3 py-4 text-xs text-text-tertiary text-center">
                No matching department.
              </div>
            )}
            {filtered.map(name => {
              const isSelected = !otherMode && value === name;
              return (
                <button
                  key={name}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => handlePickOfficial(name)}
                  className={`flex items-center justify-between gap-2 px-3 py-2 text-sm w-full text-left transition-colors hover:bg-surface-50 dark:hover:bg-zinc-800/40 ${
                    isSelected ? 'bg-primary-50 dark:bg-primary/10 text-primary-700 dark:text-primary-300 font-medium' : 'text-text-secondary'
                  }`}
                >
                  <span className="truncate">{name}</span>
                  {isSelected && <Check size={14} className="text-primary flex-shrink-0" />}
                </button>
              );
            })}
          </div>

          <div className="border-t border-border dark:border-[#222327] py-1">
            <button
              type="button"
              role="option"
              aria-selected={otherMode}
              onClick={handlePickOther}
              className={`flex items-center justify-between gap-2 px-3 py-2 text-sm w-full text-left transition-colors hover:bg-surface-50 dark:hover:bg-zinc-800/40 ${
                otherMode ? 'bg-amber-50 text-amber-700 font-medium' : 'text-text-secondary'
              }`}
            >
              <span className="flex items-center gap-2">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-amber-100 text-amber-700 text-[10px] font-semibold">+</span>
                {DEPARTMENT_OTHER} (custom)
              </span>
              {otherMode && <Check size={14} className="text-amber-600 flex-shrink-0" />}
            </button>
          </div>
        </div>
      </PortalDropdown>

      {showCustomInput && (
        <input
          ref={customRef}
          type="text"
          value={typeof value === 'string' ? value : ''}
          onChange={e => onChange?.(e.target.value)}
          onBlur={e => {
            const trimmed = e.target.value.trim();
            if (trimmed !== e.target.value) onChange?.(trimmed);
          }}
          placeholder={customPlaceholder}
          maxLength={100}
          disabled={disabled}
          className="mt-2 w-full px-3 py-2 border border-amber-200 bg-amber-50/40 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-300/40 focus:border-amber-400"
          aria-label="Custom department name"
        />
      )}
    </div>
  );
}
