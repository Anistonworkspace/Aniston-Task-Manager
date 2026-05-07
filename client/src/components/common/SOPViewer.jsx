import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Search, RotateCcw, BookOpen } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { SOP_CONTENT, sopForTier } from '../../utils/sopContent';
import { resolveTier } from '../../utils/tiers';

export default function SOPViewer({ onRestartTour }) {
  const { user } = useAuth();
  const [expandedSections, setExpandedSections] = useState({});
  const [searchQuery, setSearchQuery] = useState('');

  // Lookup by tier — never by role string. sopForTier maps the tier value to
  // the appropriate guide entry, falling back to the Tier 4 (member) guide.
  const sop = sopForTier(resolveTier(user)) || SOP_CONTENT.member;

  function toggleSection(idx) {
    setExpandedSections(prev => ({ ...prev, [idx]: !prev[idx] }));
  }

  function expandAll() {
    const all = {};
    sop.sections.forEach((_, i) => { all[i] = true; });
    setExpandedSections(all);
  }

  function collapseAll() {
    setExpandedSections({});
  }

  const filteredSections = sop.sections.filter(section => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    if (section.title.toLowerCase().includes(q)) return true;
    return section.steps.some(s =>
      s.title.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    );
  });

  return (
    <section className="rounded-2xl border border-border bg-[var(--bg-elevated)] shadow-[0_1px_3px_rgba(0,0,0,0.03)] overflow-hidden">
      {/* Header */}
      <header className="px-5 sm:px-6 py-5 border-b border-border-light">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
              <BookOpen size={18} className="text-primary" />
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-text-primary truncate">{sop.title}</h3>
              <p className="text-xs text-text-tertiary mt-0.5 truncate">{sop.subtitle}</p>
            </div>
          </div>
          {onRestartTour && (
            <button
              onClick={onRestartTour}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary border border-primary/20 hover:bg-primary/5 rounded-lg transition-colors"
            >
              <RotateCcw size={12} />
              Restart Tour
            </button>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="flex-1 min-w-[200px] relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search guide…"
              className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-lg bg-[var(--bg-elevated)] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors"
            />
          </div>
          <button
            onClick={expandAll}
            className="px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-surface-50 rounded-md transition-colors"
          >
            Expand all
          </button>
          <span className="text-text-tertiary text-xs">·</span>
          <button
            onClick={collapseAll}
            className="px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-surface-50 rounded-md transition-colors"
          >
            Collapse all
          </button>
        </div>
      </header>

      {/* Section grid */}
      <div className="p-4 sm:p-5">
        {filteredSections.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-text-tertiary">
            No matching sections found.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {filteredSections.map((section) => {
              const originalIdx = sop.sections.indexOf(section);
              const isExpanded = expandedSections[originalIdx];
              const Icon = section.icon;

              return (
                <article
                  key={originalIdx}
                  className={`rounded-xl border transition-colors ${
                    isExpanded
                      ? 'border-primary/30 bg-primary/[0.02]'
                      : 'border-border bg-[var(--bg-elevated)] hover:border-border-dark hover:bg-surface-50'
                  }`}
                >
                  <button
                    onClick={() => toggleSection(originalIdx)}
                    aria-expanded={isExpanded}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left"
                  >
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors ${
                      isExpanded ? 'bg-primary/15 text-primary' : 'bg-primary/10 text-primary'
                    }`}>
                      <Icon size={15} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-text-primary truncate">{section.title}</p>
                      <p className="text-[11px] text-text-tertiary mt-0.5">{section.steps.length} steps</p>
                    </div>
                    {isExpanded
                      ? <ChevronDown size={15} className="text-text-tertiary shrink-0" />
                      : <ChevronRight size={15} className="text-text-tertiary shrink-0" />}
                  </button>

                  {isExpanded && (
                    <div className="px-4 pb-4 animate-fade-in">
                      <ol className="ml-3 border-l-2 border-primary/15 pl-4 space-y-3">
                        {section.steps.map((s, stepIdx) => (
                          <li key={stepIdx} className="relative">
                            <span className="absolute -left-[19px] top-1 w-3 h-3 rounded-full bg-primary/15 flex items-center justify-center">
                              <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                            </span>
                            <h4 className="text-[13px] font-medium text-text-primary leading-snug">{s.title}</h4>
                            <p className="text-xs text-text-secondary leading-relaxed mt-0.5">{s.description}</p>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
