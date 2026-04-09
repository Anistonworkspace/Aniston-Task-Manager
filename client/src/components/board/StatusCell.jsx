import React, { useState, useRef } from 'react';
import { Check, Lock, Edit2, Plus, X, Pencil } from 'lucide-react';
import { STATUS_CONFIG, DEFAULT_STATUSES, buildStatusLookup, STATUS_PRESET_COLORS } from '../../utils/constants';
import PortalDropdown from '../common/PortalDropdown';

/**
 * StatusCell — status pill + dropdown with inline task-level editing.
 *
 * Resolution: taskStatuses → boardStatuses → DEFAULT_STATUSES
 *
 * @param {string}   value                - Current status key
 * @param {Function} onChange             - Called when user picks a status
 * @param {Array}    taskStatuses         - Task-level status config [{key,label,color}]
 * @param {Array}    boardStatuses        - Board-level status config [{key,label,color}]
 * @param {Function} onSaveTaskStatuses   - Called with new [{key,label,color}] to persist task-level config
 * @param {boolean}  canConfigureStatuses - True if user can edit the status options (admin/manager)
 * @param {string}   approvalStatus
 * @param {boolean}  isBlocked
 */
export default function StatusCell({
  value, onChange, taskStatuses, boardStatuses,
  onSaveTaskStatuses, canConfigureStatuses,
  approvalStatus, isBlocked,
}) {
  const [open, setOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newColor, setNewColor] = useState('#3b82f6');
  const [editingKey, setEditingKey] = useState(null);
  const [editLabel, setEditLabel] = useState('');
  const btnRef = useRef(null);

  // Resolve: task-level → board-level → defaults
  const hasTaskConfig = taskStatuses && Array.isArray(taskStatuses) && taskStatuses.length > 0;
  const statuses = hasTaskConfig ? taskStatuses
    : (boardStatuses && Array.isArray(boardStatuses) && boardStatuses.length > 0) ? boardStatuses
    : DEFAULT_STATUSES;
  const lookup = buildStatusLookup(statuses);
  const config = lookup[value] || STATUS_CONFIG[value] || { label: value || 'Unknown', color: '#c4c4c4', bgColor: '#c4c4c4', textColor: '#fff' };

  // The full palette to pick from when adding statuses
  const palette = (boardStatuses && boardStatuses.length > 0) ? boardStatuses : DEFAULT_STATUSES;

  function saveConfig(updated) {
    if (onSaveTaskStatuses) onSaveTaskStatuses(updated.length > 0 ? updated : null);
  }

  // Get current task-level config, or initialize from effective statuses (board/defaults)
  function getCurrentConfig() {
    return hasTaskConfig ? [...taskStatuses] : statuses.map(s => ({ key: s.key, label: s.label, color: s.color }));
  }

  function handleAddFromPalette(s) {
    const current = getCurrentConfig();
    if (current.some(x => x.key === s.key)) return;
    const updated = [...current, { key: s.key, label: s.label, color: s.color }];
    saveConfig(updated);
  }

  function handleAddCustom() {
    if (!newLabel.trim()) return;
    const key = newLabel.trim().toLowerCase().replace(/\s+/g, '_');
    const current = getCurrentConfig();
    if (current.some(x => x.key === key)) return;
    const updated = [...current, { key, label: newLabel.trim(), color: newColor }];
    saveConfig(updated);
    setNewLabel('');
    setNewColor('#3b82f6');
  }

  function handleRemove(key) {
    const current = getCurrentConfig();
    const updated = current.filter(s => s.key !== key);
    saveConfig(updated);
  }

  function handleRename(key) {
    if (!editLabel.trim()) return;
    const current = getCurrentConfig();
    const updated = current.map(s => s.key === key ? { ...s, label: editLabel.trim() } : s);
    saveConfig(updated);
    setEditingKey(null);
  }

  function handleColorChange(key, color) {
    const current = getCurrentConfig();
    const updated = current.map(s => s.key === key ? { ...s, color } : s);
    saveConfig(updated);
  }

  return (
    <div className="relative w-full h-full flex items-center justify-center">
      {approvalStatus === 'approved' && (
        <span className="absolute -top-1 -right-1 z-10 w-4 h-4 rounded-full bg-green-500 text-white flex items-center justify-center text-[8px] font-bold shadow-sm" title="Approved">✓</span>
      )}
      <button ref={btnRef} onClick={(e) => { e.stopPropagation(); if (onChange && !isBlocked) setOpen(!open); }}
        className={`status-pill w-full ${(!onChange || isBlocked) ? 'cursor-default opacity-75' : ''}`}
        style={{ backgroundColor: config.bgColor || config.color }}
        title={isBlocked ? 'Blocked by dependency — complete the blocking task first' : ''}>
        <span className="flex items-center justify-center gap-1">
          {isBlocked && <Lock size={10} className="flex-shrink-0" />}
          {config.label}
        </span>
      </button>

      <PortalDropdown anchorRef={btnRef} open={open} onClose={() => { setOpen(false); setEditMode(false); setEditingKey(null); }} width={220} align="center">
        <div className="bg-white dark:bg-[#1a1830] rounded-xl shadow-dropdown border border-border dark:border-[#2d2b45] overflow-hidden">
          {/* Status list */}
          <div className="p-1.5 max-h-[280px] overflow-y-auto">
            {statuses.map(s => {
              const cfg = lookup[s.key] || { label: s.label, color: s.color, bgColor: s.color };

              if (editMode && editingKey === s.key) {
                return (
                  <div key={s.key} className="flex items-center gap-1 px-1.5 py-1 mb-0.5" onClick={e => e.stopPropagation()}>
                    <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
                    <input value={editLabel} onChange={e => setEditLabel(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleRename(s.key)}
                      className="flex-1 px-1.5 py-0.5 border border-blue-400 rounded text-xs focus:outline-none min-w-0"
                      autoFocus />
                    <button onClick={() => handleRename(s.key)} className="p-0.5 text-green-600"><Check size={10} /></button>
                    <button onClick={() => setEditingKey(null)} className="p-0.5 text-gray-400"><X size={10} /></button>
                  </div>
                );
              }

              return (
                <div key={s.key} className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-colors mb-0.5 group/item ${value === s.key ? 'bg-surface-100 dark:bg-[#2d2b45]' : 'hover:bg-surface-50 dark:hover:bg-[#211f3a]'}`}>
                  <button className="flex items-center gap-2 flex-1 min-w-0" onClick={(e) => { e.stopPropagation(); if (onChange) onChange(s.key); setOpen(false); setEditMode(false); }}>
                    <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: cfg.bgColor || cfg.color }} />
                    <span className="text-text-primary dark:text-white font-medium flex-1 text-left truncate">{cfg.label}</span>
                    {value === s.key && <Check size={12} className="text-primary-500" />}
                  </button>
                  {editMode && canConfigureStatuses && (
                    <div className="flex items-center gap-0.5 flex-shrink-0">
                      <button onClick={(e) => { e.stopPropagation(); setEditingKey(s.key); setEditLabel(s.label || cfg.label); }}
                        className="p-0.5 text-gray-400 hover:text-blue-500"><Pencil size={10} /></button>
                      <button onClick={(e) => { e.stopPropagation(); handleRemove(s.key); }}
                        className="p-0.5 text-gray-400 hover:text-red-500"><X size={10} /></button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Edit Labels footer — only for authorized users */}
          {canConfigureStatuses && onSaveTaskStatuses && (
            <div className="border-t border-border dark:border-[#2d2b45] p-2">
              {editMode ? (
                <div className="space-y-2" onClick={e => e.stopPropagation()}>
                  {/* Add from palette */}
                  {palette.filter(s => !statuses.some(x => x.key === s.key)).length > 0 && (
                    <div>
                      <p className="text-[9px] uppercase tracking-wider text-gray-400 mb-1 font-semibold">Add status</p>
                      <div className="flex flex-wrap gap-1">
                        {palette.filter(s => !statuses.some(x => x.key === s.key)).map(s => (
                          <button key={s.key} onClick={() => handleAddFromPalette(s)}
                            className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-gray-200 hover:border-blue-300 hover:bg-blue-50 transition-colors">
                            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: s.color }} />
                            {s.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Custom status input */}
                  <div>
                    <p className="text-[9px] uppercase tracking-wider text-gray-400 mb-1 font-semibold">Create custom</p>
                    <div className="flex items-center gap-1">
                      <input type="text" value={newLabel} onChange={e => setNewLabel(e.target.value)}
                        placeholder="Label name" className="flex-1 px-2 py-1 border border-gray-200 rounded text-xs focus:outline-none focus:border-blue-400 min-w-0"
                        onKeyDown={e => e.key === 'Enter' && handleAddCustom()} />
                      <button onClick={handleAddCustom} disabled={!newLabel.trim()}
                        className="text-[10px] bg-blue-500 text-white rounded px-2 py-1 hover:bg-blue-600 font-medium disabled:opacity-40">Add</button>
                    </div>
                    <div className="flex gap-1 mt-1">
                      {STATUS_PRESET_COLORS.slice(0, 8).map(c => (
                        <button key={c} onClick={() => setNewColor(c)}
                          className={`w-3.5 h-3.5 rounded-full transition-transform ${newColor === c ? 'scale-125 ring-2 ring-offset-1 ring-blue-400' : 'hover:scale-110'}`}
                          style={{ backgroundColor: c }} />
                      ))}
                    </div>
                  </div>

                  {/* Clear custom / Done */}
                  <div className="flex items-center justify-between pt-1">
                    {hasTaskConfig && (
                      <button onClick={() => { saveConfig([]); }}
                        className="text-[10px] text-gray-400 hover:text-red-500 transition-colors">Reset to defaults</button>
                    )}
                    <button onClick={() => { setEditMode(false); setEditingKey(null); }}
                      className="text-[10px] text-blue-500 hover:text-blue-700 font-medium ml-auto">Done</button>
                  </div>
                </div>
              ) : (
                <button onClick={(e) => { e.stopPropagation(); setEditMode(true); }}
                  className="flex items-center gap-1.5 w-full text-xs text-text-tertiary hover:text-primary-500 px-1 py-1.5 rounded-md hover:bg-surface-50 dark:hover:bg-[#211f3a] transition-colors">
                  <Edit2 size={11} /> Edit Labels
                </button>
              )}
            </div>
          )}
        </div>
      </PortalDropdown>
    </div>
  );
}
