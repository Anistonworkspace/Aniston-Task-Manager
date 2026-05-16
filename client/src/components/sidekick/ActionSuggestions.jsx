import React from 'react';

/**
 * ActionSuggestions — clickable prompt chips for scoped Sidekick panels
 * (skill §7).
 *
 *   <ActionSuggestions
 *     suggestions={[{ id, label, icon }]}
 *     onSelect={(prompt) => ...}
 *   />
 *
 * The chip shows a small icon + the suggestion text. Clicking pre-fills the
 * composer (or directly sends, depending on the consumer's wiring).
 *
 * Catalogs per scope live in actionSuggestionCatalog.js — this component
 * just renders whatever the consumer hands it.
 */
export default function ActionSuggestions({
  suggestions = [],
  onSelect,
  heading = 'Action suggestions',
}) {
  if (!Array.isArray(suggestions) || suggestions.length === 0) return null;

  return (
    <div className="mt-3">
      <div className="px-1 mb-1.5 text-[10px] uppercase tracking-wide font-semibold text-text-tertiary">
        {heading}
      </div>
      <div className="flex flex-col gap-1">
        {suggestions.map((s) => {
          const Icon = s.icon;
          return (
            <button
              key={s.id || s.label}
              type="button"
              onClick={() => onSelect?.(s.label)}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-left text-sm text-text-secondary hover:bg-surface-100 hover:text-text-primary transition-colors"
            >
              {Icon && <Icon size={14} className="text-text-tertiary flex-shrink-0" />}
              <span className="flex-1 truncate">{s.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
