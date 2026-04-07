import React, { useRef, useState } from 'react';
import {
  Settings, Filter, ArrowUpDown, X as XIcon, Group, Copy,
  Plus, ArrowLeftRight, Edit3, Trash2, ChevronRight, MoreHorizontal,
  EyeOff, Columns3, CheckSquare, AlignLeft,
  Type, Hash, Calendar, User, Flag, Tag, BarChart, Link
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
            {/* Actions */}
            <div className="py-1 border-b border-[#e6e9ef]">
              <MenuItem icon={Filter} label="Filter" onClick={() => { if (onFilter) onFilter(column); close(); }} />
              <MenuItem icon={ArrowUpDown} label="Sort" arrow onClick={() => setActiveSubmenu(activeSubmenu === 'sort' ? null : 'sort')} />
            </div>

            {/* Column operations */}
            <div className="py-1 border-b border-[#e6e9ef]">
              <MenuItem icon={Copy} label="Duplicate column" onClick={() => { if (onDuplicate) onDuplicate(column); close(); }} />
              <MenuItem icon={Plus} label="Add column to the right" onClick={() => { if (onAddColumnRight) onAddColumnRight(); close(); }} />
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

            </div>
          )}
        </div>
      </PortalDropdown>
    </>
  );
}
