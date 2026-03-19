import React, { useRef, useState } from 'react';
import {
  Settings, Filter, ArrowUpDown, X as XIcon, Group, Copy, Sparkles,
  Plus, ArrowLeftRight, Edit3, Trash2, ChevronRight, MoreHorizontal,
  EyeOff, Lock, FileText, Columns3, Bell, CheckSquare, ListFilter,
  Type, Hash, AlignLeft, List, Eye, Calendar, User, Flag, Tag, BarChart, Link
} from 'lucide-react';
import PortalDropdown from '../common/PortalDropdown';

export default function ColumnHeaderMenu({
  column, onRename, onRemove, onDuplicate, onHide, onAddColumnRight,
  onChangeType, onSort, onFilter, onCollapse, onGroupBy,
  onSetRequired, onSetDescription,
}) {
  const [open, setOpen] = useState(false);
  const [activeSubmenu, setActiveSubmenu] = useState(null);
  const [description, setDescription] = useState('');
  const [showDescInput, setShowDescInput] = useState(false);
  const btnRef = useRef(null);

  const close = () => { setOpen(false); setActiveSubmenu(null); setShowDescInput(false); };

  const typeOptions = [
    { type: 'text', label: 'Text', icon: Type, color: '#ff642e' },
    { type: 'number', label: 'Number', icon: Hash, color: '#fdab3d' },
    { type: 'date', label: 'Date', icon: Calendar, color: '#579bfc' },
    { type: 'status', label: 'Status', icon: Columns3, color: '#00c875' },
    { type: 'person', label: 'Person', icon: User, color: '#0073ea' },
    { type: 'priority', label: 'Priority', icon: Flag, color: '#e2445c' },
    { type: 'label', label: 'Label', icon: Tag, color: '#a25ddc' },
    { type: 'progress', label: 'Progress', icon: BarChart, color: '#cab641' },
    { type: 'checkbox', label: 'Checkbox', icon: CheckSquare, color: '#00c875' },
    { type: 'link', label: 'Link/URL', icon: Link, color: '#579bfc' },
  ];

  const MenuItem = ({ icon: Icon, label, arrow, danger, disabled, badge, onClick: itemClick }) => (
    <button onClick={itemClick} disabled={disabled}
      className={`w-full flex items-center gap-2.5 px-4 py-[7px] text-[13px] transition-colors ${
        disabled ? 'text-[#c5c7d0] cursor-default' : danger ? 'text-[#e2445c] hover:bg-[#f5f6f8]' : 'text-[#323338] hover:bg-[#f5f6f8]'
      }`}>
      <Icon size={15} className={disabled ? 'text-[#c5c7d0]' : danger ? 'text-[#e2445c]' : 'text-[#676879]'} />
      <span className="flex-1 text-left">{label}</span>
      {arrow && <ChevronRight size={12} className="text-[#c5c7d0]" />}
      {badge && <span className="text-[10px] font-medium text-[#0073ea] border border-[#0073ea]/30 px-1.5 py-0.5 rounded">{badge}</span>}
    </button>
  );

  return (
    <>
      <button ref={btnRef} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className="opacity-0 group-hover/col:opacity-100 p-0.5 rounded hover:bg-[#dcdfec] text-[#c5c7d0] hover:text-[#676879] transition-all"
        title="Column options">
        <MoreHorizontal size={12} />
      </button>

      <PortalDropdown anchorRef={btnRef} open={open} onClose={close} width={activeSubmenu ? 520 : 260} align="left">
        <div className="flex bg-white rounded-lg shadow-dropdown border border-[#e6e9ef] overflow-hidden max-h-[70vh]">
          {/* Main Menu */}
          <div className="w-[260px] flex-shrink-0 overflow-y-auto">
            {/* Settings */}
            <div className="py-1 border-b border-[#e6e9ef]">
              <MenuItem icon={Settings} label="Settings" arrow
                onClick={() => setActiveSubmenu(activeSubmenu === 'settings' ? null : 'settings')} />
            </div>

            {/* AI section */}
            <div className="py-1 border-b border-[#e6e9ef]">
              <div className="px-4 py-[5px] text-[12px] text-[#676879] font-medium flex items-center gap-1.5">
                AI-powered actions <Sparkles size={12} className="text-[#a25ddc]" />
              </div>
              <MenuItem icon={ListFilter} label="Auto-assign labels" onClick={close} />
            </div>

            {/* Actions */}
            <div className="py-1 border-b border-[#e6e9ef]">
              <MenuItem icon={Filter} label="Filter" onClick={() => { if (onFilter) onFilter(column); close(); }} />
              <MenuItem icon={ArrowUpDown} label="Sort" arrow onClick={() => setActiveSubmenu(activeSubmenu === 'sort' ? null : 'sort')} />
              <MenuItem icon={XIcon} label="Collapse" onClick={() => { if (onCollapse) onCollapse(column); close(); }} />
              <MenuItem icon={Group} label="Group by" onClick={() => { if (onGroupBy) onGroupBy(column); close(); }} />
            </div>

            {/* Column operations */}
            <div className="py-1 border-b border-[#e6e9ef]">
              <MenuItem icon={Copy} label="Duplicate column" arrow onClick={() => { if (onDuplicate) onDuplicate(column); close(); }} />
              <MenuItem icon={Plus} label="Add column to the right" arrow onClick={() => { if (onAddColumnRight) onAddColumnRight(); close(); }} />
              <MenuItem icon={ArrowLeftRight} label="Change column type" arrow
                onClick={() => setActiveSubmenu(activeSubmenu === 'type' ? null : 'type')} />
            </div>

            {/* Hide */}
            <div className="py-1 border-b border-[#e6e9ef]">
              <MenuItem icon={EyeOff} label="Hide column" onClick={() => { if (onHide) onHide(column.id); close(); }} />
            </div>

            {/* Rename & Delete */}
            <div className="py-1">
              <MenuItem icon={Edit3} label="Rename" onClick={() => { if (onRename) onRename(column); close(); }} />
              <MenuItem icon={Trash2} label="Delete" danger onClick={() => { if (onRemove) onRemove(column.id); close(); }} />
            </div>
          </div>

          {/* Submenu Panel */}
          {activeSubmenu && (
            <div className="w-[260px] border-l border-[#e6e9ef] bg-white overflow-y-auto">
              {activeSubmenu === 'settings' && (
                <div className="py-1">
                  <MenuItem icon={Columns3} label={`Customize ${column.title} column`} onClick={close} />
                  <MenuItem icon={AlignLeft} label="Add description" onClick={() => setShowDescInput(true)} />
                  {showDescInput && (
                    <div className="px-4 pb-2">
                      <textarea value={description} onChange={e => setDescription(e.target.value)}
                        placeholder="Enter column description..."
                        className="w-full text-[12px] border border-[#e6e9ef] rounded px-2 py-1.5 outline-none focus:border-[#0073ea] resize-none h-16" autoFocus />
                      <button onClick={() => { if (onSetDescription) onSetDescription(column.id, description); setShowDescInput(false); }}
                        className="mt-1 px-3 py-1 text-[11px] bg-[#0073ea] text-white rounded hover:bg-[#0060c2]">Save</button>
                    </div>
                  )}
                  <MenuItem icon={Bell} label="Set status notifications" arrow onClick={close} />
                  <div className="border-t border-[#e6e9ef] my-1" />
                  <MenuItem icon={CheckSquare} label="Set column as required"
                    onClick={() => { if (onSetRequired) onSetRequired(column.id); close(); }} />
                  <MenuItem icon={ListFilter} label="Set column validation" badge="New" onClick={close} />
                  <div className="border-t border-[#e6e9ef] my-1" />
                  <MenuItem icon={Lock} label="Restrict column editing" onClick={close} />
                  <MenuItem icon={Eye} label="Restrict column view" disabled onClick={close} />
                  <div className="border-t border-[#e6e9ef] my-1" />
                  <MenuItem icon={EyeOff} label="Hide column summary" onClick={() => { if (onHide) onHide(column.id); close(); }} />
                  <MenuItem icon={FileText} label="Save column as a template" disabled onClick={close} />
                </div>
              )}

              {activeSubmenu === 'sort' && (
                <div className="py-2 px-3">
                  <p className="text-[12px] text-[#676879] mb-2 px-1">Sort by <strong>{column.title}</strong></p>
                  <button onClick={() => { if (onSort) onSort({ key: column.id === 'status' ? 'status' : column.id === 'date' ? 'dueDate' : column.id === 'priority' ? 'priority' : column.id, direction: 'asc' }); close(); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md hover:bg-[#f5f6f8] text-[13px] text-[#323338]">
                    <ArrowUpDown size={14} className="text-[#676879]" /> Ascending (A → Z)
                  </button>
                  <button onClick={() => { if (onSort) onSort({ key: column.id === 'status' ? 'status' : column.id === 'date' ? 'dueDate' : column.id === 'priority' ? 'priority' : column.id, direction: 'desc' }); close(); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md hover:bg-[#f5f6f8] text-[13px] text-[#323338]">
                    <ArrowUpDown size={14} className="text-[#676879] rotate-180" /> Descending (Z → A)
                  </button>
                </div>
              )}

              {activeSubmenu === 'type' && (
                <div className="py-2 px-3">
                  <p className="text-[12px] text-[#676879] mb-2 px-1">
                    Change <strong className="text-[#323338]">{column.title}</strong> column to:
                  </p>
                  <div className="space-y-0.5">
                    {typeOptions.map((opt) => (
                      <button key={opt.type} onClick={() => { if (onChangeType) onChangeType(column.id, opt.type); close(); }}
                        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md hover:bg-[#f5f6f8] transition-colors text-[13px] ${column.type === opt.type ? 'bg-[#e6f0ff] text-[#0073ea]' : 'text-[#323338]'}`}>
                        <div className="w-6 h-6 rounded flex items-center justify-center" style={{ backgroundColor: `${opt.color}18` }}>
                          <opt.icon size={13} style={{ color: opt.color }} />
                        </div>
                        {opt.label}
                        {column.type === opt.type && <span className="ml-auto text-[10px] text-[#0073ea]">Current</span>}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </PortalDropdown>
    </>
  );
}
