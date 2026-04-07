import React from 'react';
import { X, Keyboard } from 'lucide-react';

const SHORTCUTS = [
  { section: 'Navigation', items: [
    { keys: ['Ctrl', 'K'], desc: 'Open global search' },
    { keys: ['Esc'], desc: 'Close modal / panel' },
    { keys: ['?'], desc: 'Show keyboard shortcuts' },
  ]},
  { section: 'Board', items: [
    { keys: ['N'], desc: 'New task (when on board)' },
    { keys: ['F'], desc: 'Toggle filters' },
    { keys: ['1'], desc: 'Table view' },
    { keys: ['2'], desc: 'Kanban view' },
    { keys: ['3'], desc: 'Calendar view' },
    { keys: ['4'], desc: 'Gantt view' },
  ]},
  { section: 'Task', items: [
    { keys: ['Enter'], desc: 'Save / submit' },
    { keys: ['Esc'], desc: 'Cancel / close' },
    { keys: ['Tab'], desc: 'Next field' },
  ]},
];

export default function KeyboardShortcuts({ onClose }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60] p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-modal w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-text-primary flex items-center gap-2">
            <Keyboard size={18} className="text-primary" /> Keyboard Shortcuts
          </h2>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-surface text-text-secondary"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-5 max-h-[60vh] overflow-y-auto">
          {SHORTCUTS.map(section => (
            <div key={section.section}>
              <h3 className="text-[10px] uppercase tracking-widest font-semibold text-text-tertiary mb-2">{section.section}</h3>
              <div className="space-y-1.5">
                {section.items.map((item, i) => (
                  <div key={i} className="flex items-center justify-between py-1.5">
                    <span className="text-sm text-text-secondary">{item.desc}</span>
                    <div className="flex items-center gap-1">
                      {item.keys.map((key, j) => (
                        <React.Fragment key={j}>
                          {j > 0 && <span className="text-[10px] text-text-tertiary">+</span>}
                          <kbd className="px-2 py-0.5 text-[11px] font-mono font-medium bg-surface border border-border rounded text-text-primary shadow-sm">
                            {key}
                          </kbd>
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="px-5 py-3 border-t border-border text-center">
          <p className="text-[10px] text-text-tertiary">Press <kbd className="px-1 py-0.5 bg-surface border border-border rounded text-[9px] font-mono">?</kbd> anytime to show this</p>
        </div>
      </div>
    </div>
  );
}
