import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Search, RotateCcw, BookOpen, CheckCircle2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { SOP_CONTENT } from '../../utils/sopContent';

export default function SOPViewer({ onRestartTour }) {
  const { user } = useAuth();
  const [expandedSections, setExpandedSections] = useState({});
  const [searchQuery, setSearchQuery] = useState('');

  const role = user?.role || 'member';
  const sop = SOP_CONTENT[role] || SOP_CONTENT.member;

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

  // Filter sections by search
  const filteredSections = sop.sections.filter(section => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    if (section.title.toLowerCase().includes(q)) return true;
    return section.steps.some(s =>
      s.title.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    );
  });

  return (
    <div className="bg-white dark:bg-zinc-800 rounded-xl border border-border dark:border-zinc-700 overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border dark:border-zinc-700 bg-gradient-to-r from-primary/5 to-blue-500/5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <BookOpen size={20} className="text-primary" />
            </div>
            <div>
              <h3 className="text-base font-bold text-text-primary dark:text-zinc-100">{sop.title}</h3>
              <p className="text-xs text-text-tertiary dark:text-zinc-400">{sop.subtitle}</p>
            </div>
          </div>
          {onRestartTour && (
            <button
              onClick={onRestartTour}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10 rounded-lg transition-colors"
            >
              <RotateCcw size={13} />
              Restart Tour
            </button>
          )}
        </div>

        {/* Search + controls */}
        <div className="flex items-center gap-2">
          <div className="flex-1 relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search SOP..."
              className="w-full pl-9 pr-3 py-1.5 text-sm border border-border dark:border-zinc-600 rounded-lg bg-white dark:bg-zinc-700 text-text-primary dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <button onClick={expandAll} className="text-xs text-text-tertiary hover:text-primary px-2 py-1 transition-colors">
            Expand All
          </button>
          <button onClick={collapseAll} className="text-xs text-text-tertiary hover:text-primary px-2 py-1 transition-colors">
            Collapse All
          </button>
        </div>
      </div>

      {/* Sections */}
      <div className="divide-y divide-border dark:divide-zinc-700">
        {filteredSections.length === 0 && (
          <div className="px-6 py-8 text-center text-sm text-text-tertiary dark:text-zinc-400">
            No matching sections found.
          </div>
        )}

        {filteredSections.map((section, sIdx) => {
          const originalIdx = sop.sections.indexOf(section);
          const isExpanded = expandedSections[originalIdx];
          const Icon = section.icon;

          return (
            <div key={originalIdx}>
              {/* Section header */}
              <button
                onClick={() => toggleSection(originalIdx)}
                className="w-full flex items-center gap-3 px-6 py-3 hover:bg-gray-50 dark:hover:bg-zinc-700/50 transition-colors text-left"
              >
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <Icon size={16} className="text-primary" />
                </div>
                <span className="flex-1 text-sm font-semibold text-text-primary dark:text-zinc-100">
                  {section.title}
                </span>
                <span className="text-xs text-text-tertiary dark:text-zinc-400 mr-2">
                  {section.steps.length} steps
                </span>
                {isExpanded
                  ? <ChevronDown size={16} className="text-text-tertiary" />
                  : <ChevronRight size={16} className="text-text-tertiary" />
                }
              </button>

              {/* Steps */}
              {isExpanded && (
                <div className="px-6 pb-4">
                  <div className="ml-4 border-l-2 border-primary/20 pl-6 space-y-3">
                    {section.steps.map((s, stepIdx) => (
                      <div key={stepIdx} className="relative">
                        {/* Dot on the line */}
                        <div className="absolute -left-[31px] top-1 w-4 h-4 rounded-full bg-primary/20 flex items-center justify-center">
                          <div className="w-2 h-2 rounded-full bg-primary" />
                        </div>
                        <div>
                          <h4 className="text-sm font-medium text-text-primary dark:text-zinc-200">
                            {s.title}
                          </h4>
                          <p className="text-xs text-text-secondary dark:text-zinc-400 leading-relaxed mt-0.5">
                            {s.description}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
