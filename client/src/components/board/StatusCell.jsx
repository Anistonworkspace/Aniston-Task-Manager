import React, { useState, useRef } from 'react';
import { Edit2, Plus, X, Check } from 'lucide-react';
import { STATUS_CONFIG, STATUS_PRESET_COLORS } from '../../utils/constants';
import PortalDropdown from '../common/PortalDropdown';

export default function StatusCell({ value, onChange, customStatuses, onEditStatuses, approvalStatus }) {
  const [open, setOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newColor, setNewColor] = useState('#3b82f6');
  const btnRef = useRef(null);

  const allStatuses = { ...STATUS_CONFIG };
  if (customStatuses) {
    customStatuses.forEach(cs => {
      allStatuses[cs.key] = { label: cs.label, color: cs.color, bgColor: cs.color, textColor: '#ffffff' };
    });
  }

  const config = allStatuses[value] || allStatuses.not_started;

  function handleAddCustom() {
    if (!newLabel.trim()) return;
    const key = newLabel.toLowerCase().replace(/\s+/g, '_');
    const newStatus = { key, label: newLabel, color: newColor };
    if (onEditStatuses) onEditStatuses([...(customStatuses || []), newStatus]);
    setNewLabel('');
    setNewColor('#3b82f6');
  }

  function handleRemoveCustom(key) {
    if (onEditStatuses) onEditStatuses((customStatuses || []).filter(cs => cs.key !== key));
  }

  return (
    <div className="relative w-full h-full flex items-center justify-center">
      {approvalStatus === 'approved' && (
        <span className="absolute -top-1 -right-1 z-10 w-4 h-4 rounded-full bg-green-500 text-white flex items-center justify-center text-[8px] font-bold shadow-sm" title="Approved">✓</span>
      )}
      <button ref={btnRef} onClick={(e) => { e.stopPropagation(); if (onChange) setOpen(!open); }}
        className={`status-pill w-full ${!onChange ? 'cursor-default opacity-75' : ''}`} style={{ backgroundColor: config.bgColor || config.color }}>
        {config.label}
      </button>

      <PortalDropdown anchorRef={btnRef} open={open} onClose={() => { setOpen(false); setEditMode(false); }} width={200} align="center">
        <div className="bg-white dark:bg-[#1a1830] rounded-xl shadow-dropdown border border-border dark:border-[#2d2b45] overflow-hidden">
          <div className="p-1.5 max-h-[280px] overflow-y-auto">
            {Object.entries(allStatuses).map(([key, cfg]) => (
              <button key={key} onClick={(e) => { e.stopPropagation(); if (onChange) onChange(key); setOpen(false); }}
                className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors mb-0.5 ${value === key ? 'bg-surface-100 dark:bg-[#2d2b45]' : 'hover:bg-surface-50 dark:hover:bg-[#211f3a]'}`}>
                <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: cfg.bgColor || cfg.color }} />
                <span className="text-text-primary dark:text-white font-medium flex-1 text-left">{cfg.label}</span>
                {value === key && <Check size={12} className="text-primary-500" />}
                {customStatuses?.find(cs => cs.key === key) && (
                  <button onClick={(e) => { e.stopPropagation(); handleRemoveCustom(key); }} className="text-text-muted hover:text-danger">
                    <X size={10} />
                  </button>
                )}
              </button>
            ))}
          </div>
          <div className="border-t border-border dark:border-[#2d2b45] p-2">
            {editMode ? (
              <div className="space-y-2">
                <input type="text" value={newLabel} onChange={e => setNewLabel(e.target.value)}
                  placeholder="Label name" className="input-field text-xs py-1.5"
                  onKeyDown={e => e.key === 'Enter' && handleAddCustom()} autoFocus />
                <div className="flex flex-wrap gap-1">
                  {STATUS_PRESET_COLORS.map(c => (
                    <button key={c} onClick={() => setNewColor(c)}
                      className={`w-4 h-4 rounded-full transition-transform ${newColor === c ? 'scale-125 ring-2 ring-offset-1 ring-slate-400' : 'hover:scale-110'}`}
                      style={{ backgroundColor: c }} />
                  ))}
                </div>
                <div className="flex gap-1.5">
                  <button onClick={handleAddCustom} className="flex-1 text-[10px] bg-primary-500 text-white rounded-md py-1.5 hover:bg-primary-600 font-medium">Add</button>
                  <button onClick={() => setEditMode(false)} className="text-[10px] text-text-tertiary px-2 hover:text-text-secondary">Cancel</button>
                </div>
              </div>
            ) : (
              <button onClick={() => setEditMode(true)}
                className="flex items-center gap-1.5 w-full text-xs text-text-tertiary hover:text-primary-500 px-1 py-1.5 rounded-md hover:bg-surface-50 dark:hover:bg-[#211f3a] transition-colors">
                <Edit2 size={11} /> Edit Labels
              </button>
            )}
          </div>
        </div>
      </PortalDropdown>
    </div>
  );
}
