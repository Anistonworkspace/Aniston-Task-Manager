import React, { useCallback, useId, useRef, useState } from 'react';

/**
 * Tabs primitive — generic_monday_ui.md §6.
 *
 * Two ways to use it:
 *
 *   // 1. Declarative items
 *   <Tabs
 *     items={[
 *       { id: 'a', label: 'Details', icon: Info,   content: <Details /> },
 *       { id: 'b', label: 'Files',   icon: Paper,  content: <Files /> },
 *     ]}
 *     defaultActiveId="a"
 *     size="md"
 *   />
 *
 *   // 2. Controlled-list mode (when the page already manages its own state)
 *   <Tabs.List size="md" stretched>
 *     <Tabs.Tab id="a" active={tab === 'a'} onSelect={setTab} icon={Info}>Details</Tabs.Tab>
 *     <Tabs.Tab id="b" active={tab === 'b'} onSelect={setTab} icon={Paper}>Files</Tabs.Tab>
 *   </Tabs.List>
 *   <Tabs.Panel>{tab === 'a' ? <Details /> : <Files />}</Tabs.Panel>
 */

const SIZE_CLASS = { sm: 'ds-tab-list--sm', md: 'ds-tab-list--md', lg: 'ds-tab-list--lg' };

function TabList({ size = 'md', stretched = false, ariaLabel, children, className = '' }) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={[
        'ds-tab-list',
        SIZE_CLASS[size] || SIZE_CLASS.md,
        stretched ? 'ds-tab-list--stretched' : '',
        className,
      ].filter(Boolean).join(' ')}
    >
      {children}
    </div>
  );
}

function Tab({ id, active = false, disabled = false, icon: Icon, iconTrailing = false, onSelect, children, ariaControls }) {
  const handleClick = useCallback(() => { if (!disabled) onSelect?.(id); }, [id, disabled, onSelect]);
  const handleKey = useCallback((e) => {
    if (disabled) return;
    // Activate on Enter or Space; arrow-key navigation is owned by TabList
    // consumers (see Tabs.Auto below for the built-in behavior).
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(id); }
  }, [id, disabled, onSelect]);

  return (
    <button
      type="button"
      role="tab"
      id={`tab-${id}`}
      aria-selected={active}
      aria-controls={ariaControls || `tabpanel-${id}`}
      aria-disabled={disabled || undefined}
      tabIndex={active ? 0 : -1}
      onClick={handleClick}
      onKeyDown={handleKey}
      className="ds-tab"
    >
      {Icon && !iconTrailing && <span className="ds-tab__icon"><Icon size={14} aria-hidden="true" /></span>}
      <span>{children}</span>
      {Icon && iconTrailing && <span className="ds-tab__icon"><Icon size={14} aria-hidden="true" /></span>}
    </button>
  );
}

function TabPanel({ id, hidden = false, children, className = '' }) {
  return (
    <div
      role="tabpanel"
      id={id ? `tabpanel-${id}` : undefined}
      aria-labelledby={id ? `tab-${id}` : undefined}
      hidden={hidden}
      className={`ds-tab-panel ${className}`}
    >
      {children}
    </div>
  );
}

// Convenience wrapper that owns the active-tab state and handles
// keyboard left/right roving focus on the tab list.
export default function Tabs({
  items = [],
  defaultActiveId,
  activeId: controlledActiveId,
  onChange,
  size = 'md',
  stretched = false,
  ariaLabel,
  className = '',
  panelClassName = '',
}) {
  const isControlled = controlledActiveId !== undefined;
  const [uncontrolledActiveId, setUncontrolledActiveId] = useState(
    defaultActiveId ?? items[0]?.id
  );
  const activeId = isControlled ? controlledActiveId : uncontrolledActiveId;
  const listRef = useRef(null);
  const reactId = useId();

  const setActive = useCallback((id) => {
    if (!isControlled) setUncontrolledActiveId(id);
    onChange?.(id);
  }, [isControlled, onChange]);

  const handleKey = useCallback((e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    const enabled = items.filter((it) => !it.disabled);
    if (enabled.length === 0) return;
    const idx = enabled.findIndex((it) => it.id === activeId);
    let nextIdx = idx;
    if (e.key === 'ArrowLeft')  nextIdx = (idx - 1 + enabled.length) % enabled.length;
    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % enabled.length;
    if (e.key === 'Home')        nextIdx = 0;
    if (e.key === 'End')         nextIdx = enabled.length - 1;
    if (nextIdx === idx) return;
    e.preventDefault();
    const nextId = enabled[nextIdx].id;
    setActive(nextId);
    // Move focus to the newly active tab button.
    requestAnimationFrame(() => {
      listRef.current?.querySelector(`#tab-${CSS.escape(nextId)}`)?.focus();
    });
  }, [items, activeId, setActive]);

  const activeItem = items.find((it) => it.id === activeId);

  return (
    <div className={className}>
      <div ref={listRef} onKeyDown={handleKey}>
        <TabList size={size} stretched={stretched} ariaLabel={ariaLabel || `tabs-${reactId}`}>
          {items.map((it) => (
            <Tab
              key={it.id}
              id={it.id}
              icon={it.icon}
              iconTrailing={it.iconTrailing}
              disabled={it.disabled}
              active={it.id === activeId}
              onSelect={setActive}
            >
              {it.label}
            </Tab>
          ))}
        </TabList>
      </div>
      <TabPanel id={activeItem?.id} className={panelClassName}>
        {activeItem?.content}
      </TabPanel>
    </div>
  );
}

Tabs.List = TabList;
Tabs.Tab = Tab;
Tabs.Panel = TabPanel;
