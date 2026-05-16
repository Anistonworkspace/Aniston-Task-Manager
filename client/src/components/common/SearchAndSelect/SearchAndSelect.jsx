import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Check, Plus, X } from 'lucide-react';

/**
 * SearchAndSelect — picker with search input + grouped list + selection.
 *
 *   <SearchAndSelect
 *     items={users}
 *     selected={selectedIds}
 *     onChange={setSelectedIds}
 *     mode="multi"
 *     getId={(u) => u.id}
 *     getLabel={(u) => u.name}
 *     getSecondary={(u) => u.email}
 *     getAvatar={(u) => <LetterAvatar name={u.name} shape="circle" size="sm" />}
 *     groupBy={(u) => u.department}
 *     allowCreate
 *     onCreate={(name) => createUser(name)}
 *   />
 *
 * This is meant to be rendered inside a Popover / SidePanel — it doesn't own
 * the overlay layer. The consumer wires open/close at their level.
 */
export default function SearchAndSelect({
  items = [],
  selected,
  onChange,
  mode = 'single',
  searchPlaceholder = 'Search…',
  getId = (item) => item.id,
  getLabel = (item) => item.label || item.name,
  getSecondary,
  getAvatar,
  groupBy,
  allowCreate = false,
  onCreate,
  loading = false,
  emptyMessage = 'No matches found',
  maxHeight = 320,
  autoFocus = true,
  className = '',
}) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const isMulti = mode === 'multi';
  const selectedArr = useMemo(() => {
    if (!selected) return [];
    return Array.isArray(selected) ? selected : [selected];
  }, [selected]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => {
      const label = String(getLabel(it) || '').toLowerCase();
      const secondary = getSecondary ? String(getSecondary(it) || '').toLowerCase() : '';
      return label.includes(q) || secondary.includes(q);
    });
  }, [items, query, getLabel, getSecondary]);

  const groupedEntries = useMemo(() => {
    if (!groupBy) return [[null, filtered]];
    const map = new Map();
    for (const it of filtered) {
      const key = groupBy(it) || '';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(it);
    }
    return Array.from(map.entries());
  }, [filtered, groupBy]);

  const flatList = useMemo(() => filtered, [filtered]);

  const showInlineCreate = allowCreate
    && query.trim().length > 0
    && !filtered.some((it) => String(getLabel(it) || '').toLowerCase() === query.trim().toLowerCase());

  function isSelected(item) {
    const id = getId(item);
    return selectedArr.some((s) => (typeof s === 'object' ? getId(s) : s) === id);
  }

  function toggle(item) {
    const id = getId(item);
    if (isMulti) {
      const exists = isSelected(item);
      const next = exists
        ? selectedArr.filter((s) => (typeof s === 'object' ? getId(s) : s) !== id)
        : [...selectedArr, id];
      onChange?.(next);
    } else {
      onChange?.(id);
    }
  }

  function deselect(idOrItem) {
    if (!isMulti) {
      onChange?.(null);
      return;
    }
    const id = typeof idOrItem === 'object' ? getId(idOrItem) : idOrItem;
    onChange?.(selectedArr.filter((s) => (typeof s === 'object' ? getId(s) : s) !== id));
  }

  async function handleCreate() {
    if (!onCreate) return;
    const text = query.trim();
    if (!text) return;
    const created = await onCreate(text);
    if (created) {
      toggle(created);
      setQuery('');
    }
  }

  function handleKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, flatList.length - 1 + (showInlineCreate ? 1 : 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex === flatList.length && showInlineCreate) {
        handleCreate();
      } else if (flatList[activeIndex]) {
        toggle(flatList[activeIndex]);
      }
    }
  }

  // Resolve selected items back to full objects for chip rendering.
  const selectedItems = useMemo(() => {
    if (!isMulti) return [];
    return selectedArr
      .map((s) => (typeof s === 'object' ? s : items.find((it) => getId(it) === s)))
      .filter(Boolean);
  }, [isMulti, selectedArr, items, getId]);

  return (
    <div className={`flex flex-col ${className}`} style={{ maxHeight }}>
      {/* Selected chips (multi mode) */}
      {isMulti && selectedItems.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-3 pb-2 border-b border-border-light">
          {selectedItems.map((it) => (
            <span
              key={getId(it)}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-primary-50 text-primary-700 text-xs font-medium"
            >
              {getLabel(it)}
              <button
                type="button"
                onClick={() => deselect(it)}
                aria-label={`Remove ${getLabel(it)}`}
                className="hover:bg-primary-100 rounded-sm"
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Search input */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-light">
        <Search size={14} className="text-text-tertiary flex-shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); }}
          onKeyDown={handleKey}
          placeholder={searchPlaceholder}
          className="flex-1 text-sm bg-transparent focus:outline-none placeholder:text-text-tertiary"
        />
      </div>

      {/* List */}
      <div ref={listRef} className="flex-1 overflow-auto py-1">
        {loading ? (
          <div className="px-3 py-6 text-center text-sm text-text-tertiary">Loading…</div>
        ) : flatList.length === 0 && !showInlineCreate ? (
          <div className="px-3 py-6 text-center text-sm text-text-tertiary">{emptyMessage}</div>
        ) : (
          <>
            {groupedEntries.map(([group, groupItems], gIdx) => (
              <div key={group ?? `__g${gIdx}`}>
                {group && (
                  <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide font-semibold text-text-tertiary">
                    {group}
                  </div>
                )}
                {groupItems.map((it) => {
                  const flatIdx = flatList.indexOf(it);
                  const selected = isSelected(it);
                  return (
                    <button
                      key={getId(it)}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => toggle(it)}
                      onMouseEnter={() => setActiveIndex(flatIdx)}
                      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left outline-none ${
                        flatIdx === activeIndex ? 'bg-surface-100' : 'hover:bg-surface-100'
                      }`}
                    >
                      {getAvatar && (
                        <div className="flex-shrink-0">{getAvatar(it)}</div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="truncate text-text-primary">{getLabel(it)}</div>
                        {getSecondary && (
                          <div className="truncate text-xs text-text-tertiary">{getSecondary(it)}</div>
                        )}
                      </div>
                      {isMulti ? (
                        <span
                          className={`flex-shrink-0 w-4 h-4 rounded-sm border ${
                            selected
                              ? 'bg-primary border-primary text-white'
                              : 'border-border bg-transparent'
                          } inline-flex items-center justify-center`}
                          aria-hidden="true"
                        >
                          {selected && <Check size={12} />}
                        </span>
                      ) : (
                        selected && <Check size={14} className="text-primary flex-shrink-0" />
                      )}
                    </button>
                  );
                })}
              </div>
            ))}

            {showInlineCreate && (
              <button
                type="button"
                onClick={handleCreate}
                onMouseEnter={() => setActiveIndex(flatList.length)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left border-t border-border-light ${
                  activeIndex === flatList.length ? 'bg-success/10' : 'hover:bg-success/10'
                }`}
              >
                <Plus size={14} className="text-success flex-shrink-0" />
                <span className="text-text-primary">
                  Create &quot;<strong>{query.trim()}</strong>&quot;
                </span>
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
