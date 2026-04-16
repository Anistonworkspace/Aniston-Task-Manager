import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Type, Hash, Calendar, Circle, User, Flag, Tag, BarChart, CheckSquare, Link, Paperclip, Clock, X
} from 'lucide-react';

const COLUMN_OPTIONS = [
  { type: 'text', label: 'Text', icon: Type, desc: 'Single line text field' },
  { type: 'number', label: 'Number', icon: Hash, desc: 'Numeric values' },
  { type: 'date', label: 'Date', icon: Calendar, desc: 'Date picker' },
  { type: 'status', label: 'Status', icon: Circle, desc: 'Status labels with colors' },
  { type: 'person', label: 'Person', icon: User, desc: 'Assign team members' },
  { type: 'priority', label: 'Priority', icon: Flag, desc: 'Priority levels' },
  { type: 'label', label: 'Label', icon: Tag, desc: 'Colored tags' },
  { type: 'progress', label: 'Progress', icon: BarChart, desc: 'Completion percentage' },
  { type: 'checkbox', label: 'Checkbox', icon: CheckSquare, desc: 'Yes/No toggle' },
  { type: 'link', label: 'Link/URL', icon: Link, desc: 'Web links' },
  { type: 'file', label: 'File', icon: Paperclip, desc: 'File attachments' },
  { type: 'time_tracking', label: 'Time Tracking', icon: Clock, desc: 'Track time spent' },
];

export default function AddColumnModal({ onAdd, onClose, anchorRef }) {
  const [step, setStep] = useState(1);
  const [selectedType, setSelectedType] = useState(null);
  const [columnName, setColumnName] = useState('');
  const [search, setSearch] = useState('');
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const menuRef = useRef(null);

  // Position relative to anchor button
  useEffect(() => {
    if (anchorRef?.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      let left = rect.right - 288; // align right edge
      if (left < 8) left = 8;
      // Prevent clipping on right edge
      if (left + 288 > window.innerWidth - 16) {
        left = window.innerWidth - 288 - 16;
      }
      let top = rect.bottom + 4;
      // Flip upward if not enough space below
      const menuH = 420;
      if (top + menuH > window.innerHeight - 16) {
        top = Math.max(8, rect.top - menuH - 4);
      }
      setPos({ top, left });
    }
  }, [anchorRef]);

  // Close on outside click
  useEffect(() => {
    function handleClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target) && !anchorRef?.current?.contains(e.target)) onClose();
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose, anchorRef]);

  function handleSelectType(opt) {
    setSelectedType(opt);
    setColumnName(opt.label);
    setStep(2);
  }

  function handleAdd() {
    if (!columnName.trim() || !selectedType) return;
    onAdd({
      id: `custom_${Date.now()}`,
      title: columnName.trim(),
      type: selectedType.type,
      width: 130,
      isCustom: true,
    });
    onClose();
  }

  const filtered = search
    ? COLUMN_OPTIONS.filter(o => o.label.toLowerCase().includes(search.toLowerCase()))
    : COLUMN_OPTIONS;

  return createPortal(
    <div ref={menuRef} className="fixed w-72 bg-white dark:bg-[#1E1F23] rounded-xl shadow-dropdown border border-border dark:border-[#222327] dropdown-enter overflow-hidden"
      style={{ top: pos.top, left: pos.left, zIndex: 9999 }}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-border dark:border-[#222327]">
        <h4 className="text-sm font-semibold text-text-primary dark:text-white">
          {step === 1 ? 'Add Column' : 'Column Name'}
        </h4>
        <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
          <X size={16} />
        </button>
      </div>

      {step === 1 ? (
        <>
          <div className="px-3 pt-3 pb-2">
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search column type..."
              className="input-field text-xs py-2" autoFocus />
          </div>
          <div className="max-h-[300px] overflow-y-auto px-2 pb-2">
            {filtered.map(opt => (
              <button key={opt.type} onClick={() => handleSelectType(opt)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-surface-50 transition-colors text-left group">
                <div className="w-8 h-8 rounded-lg bg-primary-50 flex items-center justify-center text-primary-500 group-hover:bg-primary-500 group-hover:text-white transition-colors">
                  <opt.icon size={16} />
                </div>
                <div>
                  <p className="text-sm font-medium text-text-primary dark:text-white">{opt.label}</p>
                  <p className="text-[10px] text-text-tertiary">{opt.desc}</p>
                </div>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="p-4 space-y-4">
          <div className="flex items-center gap-3 p-3 bg-surface-50 rounded-lg">
            {selectedType && <selectedType.icon size={18} className="text-primary-500" />}
            <div>
              <p className="text-xs text-text-tertiary">Column type</p>
              <p className="text-sm font-medium text-text-primary dark:text-white">{selectedType?.label}</p>
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-text-secondary mb-1 block">Column Name</label>
            <input type="text" value={columnName} onChange={(e) => setColumnName(e.target.value)}
              className="input-field" onKeyDown={(e) => e.key === 'Enter' && handleAdd()} autoFocus />
          </div>
          <div className="flex gap-2">
            <button onClick={() => setStep(1)} className="btn-secondary flex-1 text-sm py-2">Back</button>
            <button onClick={handleAdd} className="btn-primary flex-1 text-sm py-2">Add Column</button>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}
