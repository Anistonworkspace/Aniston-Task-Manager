import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import {
  Users, ChevronDown, ArrowUp, User, Edit2, X, History, Shield, Search,
  GitBranch, Crown, Settings2, Layers, Building2, GripVertical,
  ChevronUp, Plus, Palette, Trash2, ZoomIn, ZoomOut, Maximize2, RotateCcw, Save,
  UserCog, ExternalLink, ChevronRight, Move
} from 'lucide-react';

const ROLE_COLORS = {
  admin: { color: '#e2445c', bg: '#fef2f2' },
  manager: { color: '#0073ea', bg: '#eff6ff' },
  assistant_manager: { color: '#f59e0b', bg: '#fffbeb' },
  member: { color: '#00c875', bg: '#f0fdf4' },
};

const ROLE_LABELS = {
  admin: 'Admin',
  manager: 'Manager',
  assistant_manager: 'Asst. Manager',
  member: 'Member',
};

// ═══ SINGLE CARD (draggable independently) ═══
function PersonCard({ node, hlColor, hlLabel, canDrag, isSelected, onEdit, onPromote, onChangeManager, onViewHistory, onDragStartCard, onDropOnCard, onClick }) {
  const [hovered, setHovered] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const avatarUrl = node.avatar ? (node.avatar.startsWith?.('http') ? node.avatar : node.avatar.startsWith?.('/') ? node.avatar : `/${node.avatar}`) : null;

  return (
    <div
      className="relative"
      draggable={canDrag ? 'true' : 'false'}
      onDragStart={e => {
        e.stopPropagation();
        e.dataTransfer.setData('text/plain', node.id);
        e.dataTransfer.effectAllowed = 'move';
        e.currentTarget.style.opacity = '0.4';
        onDragStartCard(node);
      }}
      onDragEnd={e => { e.currentTarget.style.opacity = '1'; }}
      onDragOver={e => { e.preventDefault(); e.stopPropagation(); setIsDragOver(true); }}
      onDragLeave={e => {
        // Only clear if we actually left this element (not moving to a child)
        if (!e.currentTarget.contains(e.relatedTarget)) setIsDragOver(false);
      }}
      onDrop={e => { e.preventDefault(); e.stopPropagation(); setIsDragOver(false); onDropOnCard(node); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={canDrag ? { cursor: 'grab' } : undefined}
    >
      <div
        className={`card-inner bg-white rounded-lg border transition-all duration-150 select-none
          ${isSelected ? 'border-blue-400 ring-2 ring-blue-100 shadow-md' : isDragOver ? 'border-blue-400 ring-2 ring-blue-400 shadow-lg scale-105' : hovered ? 'shadow-md border-gray-200' : 'border-gray-100 shadow-sm'}
          ${canDrag ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}`}
        style={{ width: 150 }}
        onClick={(e) => { e.stopPropagation(); onClick(node); }}
      >
        <div className="h-[3px] rounded-t-lg" style={{ backgroundColor: hlColor }} />
        <div className="px-2.5 py-2.5 text-center">
          {canDrag && (
            <div className="absolute top-1 left-1 text-gray-300">
              <GripVertical size={12} />
            </div>
          )}
          <div className="w-10 h-10 rounded-full mx-auto mb-1.5 flex items-center justify-center text-xs font-bold text-white"
            style={{ backgroundColor: hlColor }}>
            {avatarUrl ? <img src={avatarUrl} className="w-10 h-10 rounded-full object-cover" alt="" /> : node.name?.charAt(0)?.toUpperCase()}
          </div>
          <p className="text-[11px] font-semibold text-gray-800 truncate leading-tight">{node.name}</p>
          <p className="text-[9px] text-gray-400 truncate mt-0.5">{node.designation || node.title || ''}</p>
          <span className="inline-block mt-1 text-[8px] font-medium px-1.5 py-0.5 rounded-full"
            style={{ backgroundColor: `${hlColor}15`, color: hlColor }}>{hlLabel}</span>
        </div>
      </div>

      {/* Hover actions — only in edit mode */}
      {hovered && canDrag && (
        <div className="absolute -top-1.5 -right-1.5 flex gap-px z-20">
          <button onClick={(e) => { e.stopPropagation(); onEdit(node); }} className="w-5 h-5 rounded-full bg-gray-500 text-white flex items-center justify-center shadow-sm hover:bg-gray-600" title="Edit Profile">
            <Edit2 size={9} />
          </button>
          <button onClick={(e) => { e.stopPropagation(); onPromote(node); }} className="w-5 h-5 rounded-full bg-green-500 text-white flex items-center justify-center shadow-sm hover:bg-green-600" title="Promote">
            <ArrowUp size={9} />
          </button>
          <button onClick={(e) => { e.stopPropagation(); onViewHistory(node); }} className="w-5 h-5 rounded-full bg-purple-500 text-white flex items-center justify-center shadow-sm hover:bg-purple-600" title="History">
            <History size={9} />
          </button>
        </div>
      )}
    </div>
  );
}

// ═══ TREE NODE (recursive with connectors) ═══
function TreeNode({ node, hierarchyLevels, canDrag, selectedId, depth, handlers }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = node.children?.length > 0;
  const hlInfo = hierarchyLevels.find(l => l.name === node.hierarchyLevel);
  const hlColor = hlInfo?.color || ROLE_COLORS[node.role]?.color || '#00c875';
  const hlLabel = ROLE_LABELS[node.role] || hlInfo?.label || node.role || 'Member';

  return (
    <div className="flex flex-col items-center">
      <div className="relative">
        <PersonCard node={node} hlColor={hlColor} hlLabel={hlLabel} canDrag={canDrag} isSelected={selectedId === node.id} {...handlers} />
        {hasChildren && (
          <button onClick={() => setExpanded(!expanded)}
            className="absolute -bottom-2.5 left-1/2 -translate-x-1/2 w-5 h-5 rounded-full bg-white border border-gray-200 shadow-sm flex items-center justify-center z-10 hover:bg-gray-50 transition-colors">
            <span className="text-[8px] text-gray-500 font-bold">{expanded ? '−' : node.children.length}</span>
          </button>
        )}
      </div>

      {expanded && hasChildren && (
        <div className="flex flex-col items-center mt-3">
          <div className="w-px h-3 bg-gray-200" />
          {node.children.length > 1 && (
            <div className="h-px bg-gray-200" style={{ width: `${(node.children.length - 1) * 166}px` }} />
          )}
          <div className="flex gap-4 items-start">
            {node.children.map(child => (
              <div key={child.id} className="flex flex-col items-center">
                <div className="w-px h-2 bg-gray-200" />
                <TreeNode node={child} hierarchyLevels={hierarchyLevels} canDrag={canDrag} selectedId={selectedId} depth={depth + 1} handlers={handlers} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══ EDIT EMPLOYEE MODAL ═══
function EditEmployeeModal({ user, hierarchyLevels, onClose, onSaved }) {
  const [form, setForm] = useState({ name: user.name || '', designation: user.designation || '', department: user.department || '', hierarchyLevel: user.hierarchyLevel || 'member', role: user.role || 'member' });
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await api.put(`/users/${user.id}`, form);
      console.log('[OrgChart] Edit saved:', res.data);
      await onSaved();
      onClose();
    } catch (err) {
      console.error('[OrgChart] Edit failed:', err.response?.data || err.message);
      alert(err.response?.data?.message || 'Failed to update');
    } finally { setSaving(false); }
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }}
        className="bg-white rounded-xl p-5 w-full max-w-sm shadow-2xl" onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-bold text-gray-800 mb-4 flex items-center gap-2">
          <Edit2 size={14} className="text-blue-500" /> Edit {user.name}
        </h3>
        <div className="space-y-3">
          <div>
            <label className="text-[10px] font-semibold text-gray-500 uppercase mb-1 block">Name</label>
            <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
              className="w-full px-2.5 py-2 border border-gray-200 rounded-lg text-[12px] outline-none focus:border-blue-400" />
          </div>
          <div>
            <label className="text-[10px] font-semibold text-gray-500 uppercase mb-1 block">Designation</label>
            <input value={form.designation} onChange={e => setForm({ ...form, designation: e.target.value })}
              placeholder="e.g., Sales Manager" className="w-full px-2.5 py-2 border border-gray-200 rounded-lg text-[12px] outline-none focus:border-blue-400" />
          </div>
          <div>
            <label className="text-[10px] font-semibold text-gray-500 uppercase mb-1 block">Department</label>
            <input value={form.department} onChange={e => setForm({ ...form, department: e.target.value })}
              className="w-full px-2.5 py-2 border border-gray-200 rounded-lg text-[12px] outline-none focus:border-blue-400" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] font-semibold text-gray-500 uppercase mb-1 block">Role</label>
              <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}
                className="w-full px-2.5 py-2 border border-gray-200 rounded-lg text-[12px] bg-white outline-none focus:border-blue-400">
                <option value="member">Member</option><option value="assistant_manager">Assistant Manager</option><option value="manager">Manager</option><option value="admin">Admin</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] font-semibold text-gray-500 uppercase mb-1 block">Hierarchy</label>
              <select value={form.hierarchyLevel} onChange={e => setForm({ ...form, hierarchyLevel: e.target.value })}
                className="w-full px-2.5 py-2 border border-gray-200 rounded-lg text-[12px] bg-white outline-none focus:border-blue-400">
                {hierarchyLevels.map(l => <option key={l.id} value={l.name}>{l.label}</option>)}
              </select>
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <button onClick={handleSave} disabled={saving}
              className="flex-1 py-2 bg-blue-500 text-white text-[12px] font-medium rounded-lg hover:bg-blue-600 disabled:opacity-50 flex items-center justify-center gap-1">
              <Save size={12} /> {saving ? 'Saving...' : 'Save Changes'}
            </button>
            <button onClick={onClose} className="px-4 py-2 text-[12px] text-gray-500 hover:bg-gray-50 rounded-lg">Cancel</button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ═══ HIERARCHY MANAGER ═══
function HierarchyManager({ levels, onClose, onRefresh }) {
  const [editLevels, setEditLevels] = useState([]);
  const [newName, setNewName] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newColor, setNewColor] = useState('#6366f1');
  useEffect(() => { setEditLevels([...levels]); }, [levels]);
  const COLORS = ['#e2445c', '#ff642e', '#f59e0b', '#00c875', '#0ea5e9', '#0073ea', '#8b5cf6', '#6366f1', '#94a3b8', '#1e293b'];

  async function handleAdd() {
    if (!newName.trim() || !newLabel.trim()) return;
    try { await api.post('/hierarchy-levels', { name: newName.trim().toLowerCase().replace(/\s+/g, '_'), label: newLabel.trim(), color: newColor }); setNewName(''); setNewLabel(''); onRefresh(); } catch {}
  }
  async function handleUpdate(id, field, value) { try { await api.put(`/hierarchy-levels/${id}`, { [field]: value }); onRefresh(); } catch {} }
  async function handleDelete(id) { try { await api.delete(`/hierarchy-levels/${id}`); onRefresh(); } catch {} }
  async function handleMove(idx, dir) {
    const arr = [...editLevels]; const s = idx + dir;
    if (s < 0 || s >= arr.length) return;
    [arr[idx], arr[s]] = [arr[s], arr[idx]]; setEditLevels(arr);
    try { await api.put('/hierarchy-levels/reorder', { orderedIds: arr.map(l => l.id) }); onRefresh(); } catch {}
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }}
        className="bg-white rounded-xl w-full max-w-md shadow-2xl max-h-[75vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
          <h3 className="text-sm font-bold text-gray-800 flex items-center gap-2"><Layers size={14} className="text-indigo-500" /> Manage Hierarchy</h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-md"><X size={14} className="text-gray-400" /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-1">
          {editLevels.map((l, i) => (
            <div key={l.id} className="flex items-center gap-2 px-2 py-2 bg-gray-50 rounded-lg group hover:bg-gray-100">
              <div className="flex flex-col">
                <button onClick={() => handleMove(i, -1)} disabled={i === 0} className="text-gray-300 hover:text-gray-500 disabled:opacity-20"><ChevronUp size={9} /></button>
                <button onClick={() => handleMove(i, 1)} disabled={i >= editLevels.length - 1} className="text-gray-300 hover:text-gray-500 disabled:opacity-20"><ChevronDown size={9} /></button>
              </div>
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: l.color }} />
              <input defaultValue={l.label} onBlur={e => e.target.value !== l.label && handleUpdate(l.id, 'label', e.target.value)}
                className="flex-1 text-[12px] text-gray-700 font-medium bg-transparent border-none outline-none" />
              <span className="text-[9px] text-gray-400 font-mono">{l.name}</span>
              <button onClick={() => handleDelete(l.id)} className="text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100"><Trash2 size={10} /></button>
            </div>
          ))}
        </div>
        <div className="px-5 py-3 border-t border-gray-100 flex items-center gap-2">
          <input placeholder="Label" value={newLabel} onChange={e => setNewLabel(e.target.value)} className="flex-1 px-2 py-1.5 text-[12px] border border-gray-200 rounded-md outline-none" />
          <input placeholder="key" value={newName} onChange={e => setNewName(e.target.value)} className="w-20 px-2 py-1.5 text-[12px] border border-gray-200 rounded-md outline-none font-mono" />
          <input type="color" value={newColor} onChange={e => setNewColor(e.target.value)} className="w-6 h-6 rounded border cursor-pointer" />
          <button onClick={handleAdd} className="px-2 py-1.5 bg-blue-500 text-white text-[11px] rounded-md hover:bg-blue-600"><Plus size={12} /></button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ═══ VIEW PROFILE MODAL (read-only full profile) ═══
function ViewProfileModal({ employee, allUsers, hierarchyLevels, onClose }) {
  if (!employee) return null;
  const hlInfo = hierarchyLevels.find(l => l.name === employee.hierarchyLevel);
  const hlColor = hlInfo?.color || ROLE_COLORS[employee.role]?.color || '#00c875';
  const avatarUrl = employee.avatar ? (employee.avatar.startsWith?.('http') ? employee.avatar : employee.avatar.startsWith?.('/') ? employee.avatar : `/${employee.avatar}`) : null;
  const manager = employee.managerId ? allUsers.find(u => String(u.id) === String(employee.managerId)) : null;
  const directReports = allUsers.filter(u => String(u.managerId) === String(employee.id));
  const roleLabel = { admin: 'Admin', manager: 'Manager', assistant_manager: 'Assistant Manager', member: 'Employee' }[employee.role] || employee.role;

  const fields = [
    { label: 'Email', value: employee.email },
    { label: 'Department', value: employee.department },
    { label: 'Role', value: roleLabel },
    { label: 'Designation', value: employee.designation || employee.title },
    { label: 'Hierarchy Level', value: hlInfo?.label || employee.hierarchyLevel, color: hlColor },
    { label: 'Reports to', value: manager ? manager.name : 'None (Root)' },
    { label: 'Direct Reports', value: directReports.length > 0 ? directReports.map(r => r.name).join(', ') : 'None' },
  ];

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }}
        className="bg-white rounded-xl p-6 w-full max-w-md shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold text-gray-800">Employee Profile</h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-md"><X size={14} className="text-gray-400" /></button>
        </div>
        <div className="flex flex-col items-center mb-5">
          <div className="w-16 h-16 rounded-full flex items-center justify-center text-lg font-bold text-white mb-2" style={{ backgroundColor: hlColor }}>
            {avatarUrl ? <img src={avatarUrl} className="w-16 h-16 rounded-full object-cover" alt="" /> : employee.name?.charAt(0)?.toUpperCase()}
          </div>
          <p className="text-[15px] font-bold text-gray-800">{employee.name}</p>
          <p className="text-[11px] text-gray-400">{employee.designation || employee.title || 'No designation'}</p>
        </div>
        <div className="space-y-2">
          {fields.map(f => f.value ? (
            <div key={f.label} className="flex items-center justify-between py-2 border-b border-gray-100">
              <span className="text-[11px] text-gray-500">{f.label}</span>
              <span className="text-[11px] font-medium text-right max-w-[55%] truncate" style={f.color ? { color: f.color } : { color: '#374151' }}>{f.value}</span>
            </div>
          ) : null)}
        </div>
        <button onClick={onClose} className="w-full mt-4 py-2 text-[12px] text-gray-500 hover:bg-gray-50 rounded-lg border border-gray-200">Close</button>
      </motion.div>
    </motion.div>
  );
}

// ═══ EMPLOYEE DETAILS PANEL (side panel like reference) ═══
function EmployeeDetailsPanel({ employee, allUsers, hierarchyLevels, canManage, onClose, onEdit, onChangeManager, onViewProfile, onRemoveManager }) {
  if (!employee) return null;

  const hlInfo = hierarchyLevels.find(l => l.name === employee.hierarchyLevel);
  const hlColor = hlInfo?.color || ROLE_COLORS[employee.role]?.color || '#00c875';
  const avatarUrl = employee.avatar ? (employee.avatar.startsWith?.('http') ? employee.avatar : employee.avatar.startsWith?.('/') ? employee.avatar : `/${employee.avatar}`) : null;
  const manager = employee.managerId ? allUsers.find(u => String(u.id) === String(employee.managerId)) : null;
  const directReports = allUsers.filter(u => String(u.managerId) === String(employee.id));
  const roleLabel = { admin: 'Admin', manager: 'Manager', assistant_manager: 'Assistant Manager', member: 'Employee' }[employee.role] || employee.role;

  return (
    <motion.div
      initial={{ x: 20, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 20, opacity: 0 }}
      className="w-[280px] flex-shrink-0 bg-white border-l border-gray-200 overflow-y-auto"
      style={{ height: 'calc(100vh - 80px)' }}
    >
      <div className="p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[13px] font-bold text-gray-700">Employee Details</h3>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-md transition-colors">
            <X size={14} className="text-gray-400" />
          </button>
        </div>

        {/* Avatar & Name */}
        <div className="flex flex-col items-center mb-5">
          <div className="w-16 h-16 rounded-full flex items-center justify-center text-lg font-bold text-white mb-2"
            style={{ backgroundColor: hlColor }}>
            {avatarUrl ? <img src={avatarUrl} className="w-16 h-16 rounded-full object-cover" alt="" /> : employee.name?.charAt(0)?.toUpperCase()}
          </div>
          <p className="text-[14px] font-bold text-gray-800">{employee.name}</p>
          <p className="text-[11px] text-gray-400">{employee.designation || employee.title || 'No designation'}</p>
        </div>

        {/* Info fields */}
        <div className="space-y-3 mb-5">
          <div className="flex items-center justify-between py-2 border-b border-gray-100">
            <span className="text-[11px] text-gray-500">Department</span>
            <span className="text-[11px] font-medium text-gray-700">{employee.department || '—'}</span>
          </div>
          <div className="flex items-center justify-between py-2 border-b border-gray-100">
            <span className="text-[11px] text-gray-500">Role</span>
            <span className="text-[11px] font-medium text-gray-700">{roleLabel}</span>
          </div>
          <div className="flex items-center justify-between py-2 border-b border-gray-100">
            <span className="text-[11px] text-gray-500">Hierarchy Level</span>
            <span className="text-[11px] font-medium" style={{ color: hlColor }}>{hlInfo?.label || employee.hierarchyLevel || '—'}</span>
          </div>
          <div className="flex items-center justify-between py-2 border-b border-gray-100">
            <span className="text-[11px] text-gray-500">Reports to</span>
            <span className="text-[11px] font-medium text-gray-700">{manager ? manager.name : 'None (Root)'}</span>
          </div>
          <div className="flex items-center justify-between py-2 border-b border-gray-100">
            <span className="text-[11px] text-gray-500">Direct reports</span>
            <span className="text-[11px] font-bold text-gray-700">{directReports.length}</span>
          </div>
        </div>

        {/* Direct Reports list */}
        {directReports.length > 0 && (
          <div className="mb-5">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Direct Reports</p>
            <div className="space-y-1.5 max-h-[140px] overflow-y-auto">
              {directReports.map(r => {
                const rRaw = r.toJSON ? r.toJSON() : r;
                const rHl = hierarchyLevels.find(l => l.name === rRaw.hierarchyLevel);
                const rColor = rHl?.color || ROLE_COLORS[rRaw.role]?.color || '#00c875';
                return (
                  <div key={rRaw.id} className="flex items-center gap-2 px-2 py-1.5 bg-gray-50 rounded-lg">
                    <div className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold text-white" style={{ backgroundColor: rColor }}>
                      {rRaw.name?.charAt(0)?.toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] font-medium text-gray-700 truncate">{rRaw.name}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Action Buttons */}
        {canManage && (
          <div className="space-y-2">
            <button onClick={() => onEdit(employee)}
              className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-blue-50 text-blue-600 text-[12px] font-medium rounded-lg hover:bg-blue-100 transition-colors border border-blue-100">
              <Edit2 size={13} /> Edit Details
            </button>
            <button onClick={() => onChangeManager(employee)}
              className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-emerald-50 text-emerald-600 text-[12px] font-medium rounded-lg hover:bg-emerald-100 transition-colors border border-emerald-100">
              <UserCog size={13} /> {employee.managerId ? 'Change Manager' : 'Assign Manager'}
            </button>
            {employee.managerId && (
              <button onClick={() => onRemoveManager(employee)}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-red-50 text-red-500 text-[12px] font-medium rounded-lg hover:bg-red-100 transition-colors border border-red-100">
                <X size={13} /> Remove Manager
              </button>
            )}
          </div>
        )}
        <button onClick={() => onViewProfile(employee)}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 mt-2 bg-gray-50 text-gray-600 text-[12px] font-medium rounded-lg hover:bg-gray-100 transition-colors border border-gray-100">
          <ExternalLink size={13} /> View Full Profile
        </button>
      </div>
    </motion.div>
  );
}

// ═══ MAIN PAGE ═══
export default function OrgChartPage() {
  const { canManage, isAdmin } = useAuth();
  const [orgChart, setOrgChart] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [hierarchyLevels, setHierarchyLevels] = useState([]);
  const [usersByLevel, setUsersByLevel] = useState({});
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showPromote, setShowPromote] = useState(null);
  const [showChangeManager, setShowChangeManager] = useState(null);
  const [showHistory, setShowHistory] = useState(null);
  const [showManageHierarchy, setShowManageHierarchy] = useState(false);
  const [showEditEmployee, setShowEditEmployee] = useState(null);
  const [showViewProfile, setShowViewProfile] = useState(null);
  const [promoteForm, setPromoteForm] = useState({ newRole: '', newTitle: '', newHierarchyLevel: '', notes: '' });
  const [selectedManager, setSelectedManager] = useState('');
  const [promoHistory, setPromoHistory] = useState([]);
  const [dragNode, setDragNode] = useState(null);
  const [viewMode, setViewMode] = useState('tree');
  const [zoom, setZoom] = useState(0.7);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, ox: 0, oy: 0 });
  const containerRef = useRef(null);

  // NEW: edit mode + selected employee for side panel
  const [editMode, setEditMode] = useState(false);
  const [dropRootHover, setDropRootHover] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState(null);

  useEffect(() => { fetchData(); }, []);

  // Wheel zoom
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const h = e => { e.preventDefault(); setZoom(z => Math.min(1.5, Math.max(0.3, z + (e.deltaY < 0 ? 0.05 : -0.05)))); };
    el.addEventListener('wheel', h, { passive: false });
    return () => el.removeEventListener('wheel', h);
  }, []);

  async function fetchData() {
    try {
      const [chartRes, hlRes] = await Promise.all([api.get('/promotions/org-chart'), api.get('/hierarchy-levels')]);
      const d = chartRes.data?.data || chartRes.data;

      // Normalize allUsers to plain objects so comparisons and re-renders work reliably
      const rawUsers = d.allUsers || [];
      const normalizedUsers = rawUsers.map(u => {
        const plain = typeof u.toJSON === 'function' ? u.toJSON() : u;
        return { ...plain };
      });

      const newOrgChart = d.orgChart || [];
      const newUsersByLevel = d.usersByLevel || {};
      const newHierarchyLevels = d.hierarchyLevels || (hlRes.data?.data || hlRes.data).levels || [];

      setOrgChart(newOrgChart);
      setAllUsers(normalizedUsers);
      setUsersByLevel(newUsersByLevel);
      setHierarchyLevels(newHierarchyLevels);

      // Refresh selectedEmployee from the fresh normalized user list
      setSelectedEmployee(prev => {
        if (!prev) return null;
        const fresh = normalizedUsers.find(u => String(u.id) === String(prev.id));
        return fresh ? { ...fresh } : null;
      });
    } catch (err) { console.error(err); } finally { setLoading(false); }
  }

  // Drag card handlers (HTML5 drag — only moves the card, NOT the canvas)
  function onDragStartCard(node) { setDragNode(node); }
  async function onDropOnCard(targetNode) {
    if (!dragNode || dragNode.id === targetNode.id) { setDragNode(null); return; }

    // Prevent circular
    function isDescendant(parent, childId) {
      if (!parent.children) return false;
      return parent.children.some(c => c.id === childId || isDescendant(c, childId));
    }
    if (isDescendant(dragNode, targetNode.id)) {
      alert('Cannot move a parent under their own subordinate.');
      setDragNode(null); return;
    }

    const confirmed = confirm(
      `Move "${dragNode.name}" under "${targetNode.name}"?\n\n` +
      `${dragNode.name} will now report to ${targetNode.name}.`
    );
    if (!confirmed) { setDragNode(null); return; }

    try {
      const res = await api.put('/promotions/update-manager', { userId: dragNode.id, managerId: targetNode.id });
      console.log('[OrgChart] Drag reassign success:', res.data);
      await fetchData();
    } catch (err) {
      console.error('[OrgChart] Drag reassign failed:', err.response?.data || err.message);
      alert(err.response?.data?.message || 'Failed to reassign');
    }
    setDragNode(null);
  }

  // Drag-to-change-level: drop a card on a level row
  async function onDropOnLevel(targetLevelName) {
    if (!dragNode || dragNode.hierarchyLevel === targetLevelName) { setDragNode(null); return; }
    const targetLevel = hierarchyLevels.find(l => l.name === targetLevelName);
    const confirmed = confirm(`Change "${dragNode.name}" hierarchy level to "${targetLevel?.label || targetLevelName}"?`);
    if (!confirmed) { setDragNode(null); return; }
    try {
      await api.put(`/users/${dragNode.id}`, { hierarchyLevel: targetLevelName });
      await fetchData();
    } catch (err) {
      console.error('[OrgChart] Level change failed:', err.response?.data || err.message);
      alert(err.response?.data?.message || 'Failed to change level');
    }
    setDragNode(null);
  }

  // Drag-to-root: drop a card on the root zone to remove manager
  async function onDropToRoot() {
    if (!dragNode || !dragNode.managerId) { setDragNode(null); return; }
    const confirmed = confirm(`Remove manager from "${dragNode.name}"?\n\n${dragNode.name} will become a root-level employee.`);
    if (!confirmed) { setDragNode(null); return; }
    try {
      await api.put('/promotions/update-manager', { userId: dragNode.id, managerId: null });
      await fetchData();
    } catch (err) {
      console.error('[OrgChart] Drop-to-root failed:', err.response?.data || err.message);
      alert(err.response?.data?.message || 'Failed to remove manager');
    }
    setDragNode(null);
  }

  // Canvas pan (middle mouse or background click)
  function onCanvasMouseDown(e) {
    if (e.target.closest('[draggable="true"]')) return;
    if (e.button === 0 || e.button === 1) {
      e.preventDefault();
      setIsPanning(true);
      panStart.current = { x: e.clientX, y: e.clientY, ox: panOffset.x, oy: panOffset.y };
    }
  }
  function onCanvasMouseMove(e) {
    if (!isPanning) return;
    setPanOffset({ x: panStart.current.ox + (e.clientX - panStart.current.x), y: panStart.current.oy + (e.clientY - panStart.current.y) });
  }

  async function handlePromote() {
    if (!promoteForm.newRole && !promoteForm.newHierarchyLevel) return;
    try {
      const res = await api.post('/promotions', { userId: showPromote.id, newRole: promoteForm.newRole, newTitle: promoteForm.newTitle, newHierarchyLevel: promoteForm.newHierarchyLevel, notes: promoteForm.notes });
      console.log('[OrgChart] Promote success:', res.data);
      setShowPromote(null); setPromoteForm({ newRole: '', newTitle: '', newHierarchyLevel: '', notes: '' });
      await fetchData();
    } catch (err) {
      console.error('[OrgChart] Promote failed:', err.response?.data || err.message);
      alert(err.response?.data?.message || 'Failed to promote');
    }
  }

  async function handleRemoveManager(employee) {
    if (!employee?.managerId) return;
    const confirmed = confirm(`Remove manager from "${employee.name}"?\n\n${employee.name} will become a root-level employee.`);
    if (!confirmed) return;
    try {
      await api.put('/promotions/update-manager', { userId: employee.id, managerId: null });
      await fetchData();
    } catch (err) {
      console.error('[OrgChart] Remove manager failed:', err.response?.data || err.message);
      alert(err.response?.data?.message || 'Failed to remove manager');
    }
  }

  async function handleChangeManager() {
    try {
      const res = await api.put('/promotions/update-manager', { userId: showChangeManager.id, managerId: selectedManager || null });
      console.log('[OrgChart] Manager changed:', res.data);
      setShowChangeManager(null); setSelectedManager('');
      await fetchData();
    } catch (err) {
      console.error('[OrgChart] Manager change failed:', err.response?.data || err.message);
      alert(err.response?.data?.message || 'Failed to update manager');
    }
  }

  async function viewHistory(node) {
    try { const res = await api.get(`/promotions/${node.id}`); setPromoHistory((res.data?.data || res.data).promotions || []); setShowHistory(node); } catch {}
  }

  function filterTree(nodes, q) {
    if (!q) return nodes;
    const query = q.toLowerCase();
    function matches(n) { return n.name?.toLowerCase().includes(query) || n.email?.toLowerCase().includes(query) || n.designation?.toLowerCase().includes(query) || n.department?.toLowerCase().includes(query) || n.children?.some(c => matches(c)); }
    function filterNode(n) { if (!matches(n)) return null; return { ...n, children: (n.children || []).map(filterNode).filter(Boolean) }; }
    return nodes.map(filterNode).filter(Boolean);
  }

  function getDepartmentView() {
    const m = {};
    allUsers.forEach(u => {
      const dept = u.department || 'Other';
      if (!m[dept]) m[dept] = [];
      m[dept].push(u);
    });
    return Object.entries(m).sort(([a], [b]) => a.localeCompare(b));
  }

  // Handle card click — select employee for side panel, always use fresh allUsers data
  function onCardClick(node) {
    const nodeId = node.id;
    setSelectedEmployee(prev => {
      if (prev && String(prev.id) === String(nodeId)) return null; // toggle off
      // Find fresh data from allUsers (already normalized plain objects)
      const fresh = allUsers.find(u => String(u.id) === String(nodeId));
      return fresh ? { ...fresh } : { ...node };
    });
  }

  const filteredChart = filterTree(orgChart, searchQuery);
  const stats = { total: allUsers.length, admins: allUsers.filter(u => u.role === 'admin').length, managers: allUsers.filter(u => u.role === 'manager').length, members: allUsers.filter(u => u.role === 'member').length };

  // Can drag only if canManage AND editMode is on
  const canDrag = canManage && editMode;

  const cardHandlers = {
    onEdit: n => setShowEditEmployee(n),
    onPromote: n => { setShowPromote(n); setPromoteForm({ newRole: n.role, newTitle: n.designation || '', newHierarchyLevel: n.hierarchyLevel || '', notes: '' }); },
    onChangeManager: n => { setShowChangeManager(n); setSelectedManager(n.managerId || ''); },
    onViewHistory: viewHistory,
    onDragStartCard,
    onDropOnCard,
    onClick: onCardClick,
  };

  if (loading) return <div className="p-8 bg-white min-h-full flex items-center justify-center"><div className="animate-pulse flex gap-6">{[1,2,3].map(i => <div key={i} className="w-32 h-24 bg-gray-100 rounded-lg" />)}</div></div>;

  return (
    <div className="bg-white min-h-full flex flex-col">
      <div className="flex-1 flex">
        {/* ═══ MAIN CONTENT ═══ */}
        <div className="flex-1 p-5 min-w-0">
          <div className="max-w-full mx-auto">
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
              <div>
                <h1 className="text-lg font-bold text-gray-800 flex items-center gap-2"><GitBranch size={16} className="text-indigo-500" /> Organization Chart</h1>
                <p className="text-[11px] text-gray-400 mt-0.5 ml-6">Hierarchical view of your team structure</p>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex bg-gray-100 rounded-lg p-0.5">
                  <button onClick={() => setViewMode('tree')} className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${viewMode === 'tree' ? 'bg-white shadow-sm text-gray-800' : 'text-gray-500'}`}>Tree View</button>
                  <button onClick={() => setViewMode('levels')} className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${viewMode === 'levels' ? 'bg-white shadow-sm text-gray-800' : 'text-gray-500'}`}>List View</button>
                  <button onClick={() => setViewMode('department')} className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${viewMode === 'department' ? 'bg-white shadow-sm text-gray-800' : 'text-gray-500'}`}>Department</button>
                </div>
                {canManage && <button onClick={() => setShowManageHierarchy(true)} className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium text-indigo-600 bg-indigo-50 rounded-lg hover:bg-indigo-100 transition-colors"><Settings2 size={12} /> Manage Levels</button>}

                {/* Edit Structure toggle — only for privileged roles */}
                {canManage && (
                  editMode ? (
                    <button onClick={() => setEditMode(false)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold text-red-600 bg-red-50 rounded-lg hover:bg-red-100 transition-colors border border-red-200">
                      <X size={12} /> Exit Edit
                    </button>
                  ) : (
                    <button onClick={() => setEditMode(true)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors border border-blue-200">
                      <Edit2 size={12} /> Edit Structure
                    </button>
                  )
                )}
              </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-4 gap-2.5 mb-4">
              {[{ label: 'Total', count: stats.total, color: '#6366f1', icon: Users }, { label: 'Admin', count: stats.admins, color: '#e2445c', icon: Crown }, { label: 'Manager', count: stats.managers, color: '#0073ea', icon: Shield }, { label: 'Member', count: stats.members, color: '#00c875', icon: User }].map((s, i) => (
                <div key={i} className="bg-white rounded-lg border border-gray-100 shadow-sm px-3 py-2.5 flex items-center gap-3">
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${s.color}12` }}><s.icon size={13} style={{ color: s.color }} /></div>
                  <div><p className="text-lg font-bold text-gray-800 leading-none">{s.count}</p><p className="text-[9px] text-gray-400 uppercase tracking-wide mt-0.5">{s.label}</p></div>
                </div>
              ))}
            </div>

            {/* Search */}
            <div className="flex items-center gap-2 mb-3">
              <div className="flex-1 flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-2.5 py-1.5 focus-within:border-blue-300 shadow-sm">
                <Search size={13} className="text-gray-400" />
                <input type="text" placeholder="Search name, department..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} className="bg-transparent border-none outline-none text-[12px] text-gray-700 w-full placeholder:text-gray-300" />
                {searchQuery && <button onClick={() => setSearchQuery('')}><X size={12} className="text-gray-300" /></button>}
              </div>
            </div>

            {/* Edit mode instruction banner */}
            {editMode && (
              <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-lg">
                <GripVertical size={14} className="text-emerald-500" />
                <p className="text-[11px] text-emerald-700 font-medium">
                  Drag a node near another to reassign · Click a node to select
                </p>
              </div>
            )}

            {/* View-only hint for non-edit */}
            {!editMode && !canManage && (
              <p className="text-[10px] text-gray-400 mb-2">Click a card to view employee details · Scroll to zoom</p>
            )}
            {!editMode && canManage && (
              <p className="text-[10px] text-gray-400 mb-2">Click a card to view details · Click "Edit Structure" to drag & reassign</p>
            )}

            {/* ═══ TREE VIEW ═══ */}
            {viewMode === 'tree' && (
              <div className="relative bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden" style={{ height: 'calc(100vh - 340px)', minHeight: 400 }}>
                {/* Zoom controls */}
                <div className="absolute top-3 right-3 z-20 flex items-center gap-1 bg-white/90 backdrop-blur-sm rounded-lg border border-gray-200 shadow-sm px-1 py-1">
                  <button onClick={() => setZoom(z => Math.min(z + 0.1, 1.5))} className="p-1.5 hover:bg-gray-100 rounded-md text-gray-500"><ZoomIn size={14} /></button>
                  <span className="text-[10px] font-mono text-gray-400 w-10 text-center">{Math.round(zoom * 100)}%</span>
                  <button onClick={() => setZoom(z => Math.max(z - 0.1, 0.3))} className="p-1.5 hover:bg-gray-100 rounded-md text-gray-500"><ZoomOut size={14} /></button>
                  <div className="w-px h-4 bg-gray-200 mx-0.5" />
                  <button onClick={() => { setZoom(0.7); setPanOffset({ x: 0, y: 0 }); }} className="p-1.5 hover:bg-gray-100 rounded-md text-gray-500" title="Reset"><RotateCcw size={13} /></button>
                  <button onClick={() => { setZoom(0.45); setPanOffset({ x: 0, y: 0 }); }} className="p-1.5 hover:bg-gray-100 rounded-md text-gray-500" title="Fit All"><Maximize2 size={13} /></button>
                </div>

                {/* Drop-to-root zone — visible in edit mode when dragging */}
                {canDrag && (
                  <div
                    className={`absolute top-0 left-0 right-0 z-10 flex items-center justify-center gap-2 py-2 text-[11px] font-medium transition-all border-b-2 border-dashed
                      ${dropRootHover ? 'bg-orange-100 border-orange-400 text-orange-700' : 'bg-orange-50/60 border-orange-200 text-orange-400'}`}
                    onDragOver={e => { e.preventDefault(); setDropRootHover(true); }}
                    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDropRootHover(false); }}
                    onDrop={e => { e.preventDefault(); setDropRootHover(false); onDropToRoot(); }}
                  >
                    <ArrowUp size={14} /> Drop here to remove manager (make root)
                  </div>
                )}

                {/* Canvas */}
                <div ref={containerRef} className="w-full h-full overflow-hidden"
                  style={{ cursor: isPanning ? 'grabbing' : 'default' }}
                  onMouseDown={onCanvasMouseDown}
                  onMouseMove={onCanvasMouseMove}
                  onMouseUp={() => setIsPanning(false)}
                  onMouseLeave={() => setIsPanning(false)}
                >
                  <div style={{ transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`, transformOrigin: 'top center', padding: '30px', display: 'flex', justifyContent: 'center', width: 'max-content', minWidth: '100%' }}>
                    {filteredChart.length === 0 ? (
                      <div className="text-center py-16"><Users size={24} className="text-gray-200 mx-auto mb-2" /><p className="text-sm text-gray-400">{searchQuery ? `No results for "${searchQuery}"` : 'No hierarchy configured'}</p></div>
                    ) : (
                      <div className="flex justify-center gap-6 items-start">
                        {filteredChart.map(node => <TreeNode key={node.id} node={node} hierarchyLevels={hierarchyLevels} canDrag={canDrag} selectedId={selectedEmployee?.id} depth={0} handlers={cardHandlers} />)}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ═══ LEVELS VIEW ═══ */}
            {viewMode === 'levels' && (
              <div className="space-y-0">
                {hierarchyLevels
                  .filter(level => usersByLevel[level.name]?.users?.length > 0)
                  .map((level, idx, arr) => {
                    const levelData = usersByLevel[level.name];
                    const levelUsers = levelData?.users || [];
                    return (
                      <React.Fragment key={level.name}>
                        <div
                          className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden transition-all"
                          onDragOver={e => { if (!canDrag) return; e.preventDefault(); e.currentTarget.classList.add('ring-2', 'ring-blue-400', 'bg-blue-50/30'); }}
                          onDragLeave={e => { e.currentTarget.classList.remove('ring-2', 'ring-blue-400', 'bg-blue-50/30'); }}
                          onDrop={e => { e.preventDefault(); e.currentTarget.classList.remove('ring-2', 'ring-blue-400', 'bg-blue-50/30'); if (canDrag) onDropOnLevel(level.name); }}
                        >
                          <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-gray-100" style={{ backgroundColor: `${level.color}08` }}>
                            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: level.color }} />
                            <span className="text-[12px] font-bold" style={{ color: level.color }}>{level.label}</span>
                            <span className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full">{levelUsers.length}</span>
                            <span className="text-[9px] text-gray-300 ml-auto uppercase tracking-wider">Level {level.order}</span>
                          </div>
                          <div className="p-3 flex flex-wrap gap-2.5 min-h-[50px]">
                            {levelUsers.map(u => {
                              const hlColor = ROLE_COLORS[u.role]?.color || level.color || '#00c875';
                              return (
                                <PersonCard
                                  key={u.id}
                                  node={u}
                                  hlColor={hlColor}
                                  hlLabel={ROLE_LABELS[u.role] || level.label}
                                  canDrag={canDrag}
                                  isSelected={selectedEmployee?.id === u.id}
                                  onEdit={n => setShowEditEmployee(n)}
                                  onPromote={n => { setShowPromote(n); setPromoteForm({ newRole: n.role, newTitle: n.designation || '', newHierarchyLevel: n.hierarchyLevel || '', notes: '' }); }}
                                  onChangeManager={n => { setShowChangeManager(n); setSelectedManager(n.managerId || ''); }}
                                  onViewHistory={viewHistory}
                                  onDragStartCard={onDragStartCard}
                                  onDropOnCard={() => {}}
                                  onClick={onCardClick}
                                />
                              );
                            })}
                          </div>
                        </div>
                        {idx < arr.length - 1 && (
                          <div className="flex justify-center py-1">
                            <div className="w-px h-4 bg-gray-200" />
                          </div>
                        )}
                      </React.Fragment>
                    );
                  })}
                {hierarchyLevels.filter(l => usersByLevel[l.name]?.users?.length > 0).length === 0 && (
                  <div className="text-center py-16 bg-white rounded-xl border border-gray-100">
                    <Layers size={24} className="text-gray-200 mx-auto mb-2" />
                    <p className="text-sm text-gray-400">No hierarchy levels with users</p>
                  </div>
                )}
              </div>
            )}

            {/* ═══ DEPARTMENT VIEW ═══ */}
            {viewMode === 'department' && (
              <div className="space-y-3">
                {getDepartmentView().map(([dept, users]) => (
                  <div key={dept} className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
                    <div className="flex items-center gap-2.5 px-4 py-2.5 bg-gray-50 border-b border-gray-100">
                      <Building2 size={13} className="text-gray-400" />
                      <span className="text-[12px] font-semibold text-gray-700">{dept}</span>
                      <span className="text-[10px] text-gray-400 bg-gray-200 px-1.5 py-0.5 rounded-full">{users.length}</span>
                    </div>
                    <div className="p-3 flex flex-wrap gap-2">
                      {users.map(u => {
                        const hl = hierarchyLevels.find(l => l.name === u.hierarchyLevel);
                        const c = hl?.color || ROLE_COLORS[u.role]?.color || '#00c875';
                        return (
                          <div key={u.id}
                            className={`flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer group transition-colors ${selectedEmployee?.id === u.id ? 'bg-blue-50 border border-blue-200' : 'bg-gray-50 hover:bg-gray-100 border border-transparent'}`}
                            style={{ minWidth: 160 }}
                            onClick={() => onCardClick(u)}>
                            <div className="w-7 h-7 rounded-full flex items-center justify-center text-[9px] font-bold text-white" style={{ backgroundColor: c }}>{u.name?.charAt(0)?.toUpperCase()}</div>
                            <div className="flex-1 min-w-0">
                              <p className="text-[11px] font-semibold text-gray-700 truncate">{u.name}</p>
                              <p className="text-[9px] text-gray-400 truncate">{u.designation || hl?.label || u.role}</p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ═══ EMPLOYEE DETAILS SIDE PANEL ═══ */}
        <AnimatePresence>
          {selectedEmployee && (
            <EmployeeDetailsPanel
              key={selectedEmployee.id + '-' + (selectedEmployee.name || '') + '-' + (selectedEmployee.role || '')}
              employee={selectedEmployee}
              allUsers={allUsers}
              hierarchyLevels={hierarchyLevels}
              canManage={canManage}
              onClose={() => setSelectedEmployee(null)}
              onEdit={n => setShowEditEmployee(n)}
              onChangeManager={n => { setShowChangeManager(n); setSelectedManager(n.managerId || ''); }}
              onRemoveManager={handleRemoveManager}
              onViewProfile={n => setShowViewProfile(n)}
            />
          )}
        </AnimatePresence>
      </div>

      {/* ═══ MODALS ═══ */}
      <AnimatePresence>
        {showEditEmployee && <EditEmployeeModal user={showEditEmployee} hierarchyLevels={hierarchyLevels} onClose={() => setShowEditEmployee(null)} onSaved={fetchData} />}
      </AnimatePresence>

      <AnimatePresence>
        {showPromote && canManage && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => setShowPromote(null)}>
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} className="bg-white rounded-xl p-5 w-full max-w-sm shadow-2xl" onClick={e => e.stopPropagation()}>
              <h3 className="text-sm font-bold text-gray-800 mb-4 flex items-center gap-2"><ArrowUp size={14} className="text-green-500" /> Promote {showPromote.name}</h3>
              <div className="space-y-3">
                <div><label className="text-[10px] font-semibold text-gray-500 uppercase mb-1 block">System Role</label><select value={promoteForm.newRole} onChange={e => setPromoteForm({ ...promoteForm, newRole: e.target.value })} className="w-full px-2.5 py-2 border border-gray-200 rounded-lg text-[12px] bg-white outline-none"><option value="member">Member</option><option value="assistant_manager">Assistant Manager</option><option value="manager">Manager</option><option value="admin">Admin</option></select></div>
                <div><label className="text-[10px] font-semibold text-gray-500 uppercase mb-1 block">Hierarchy Level</label><select value={promoteForm.newHierarchyLevel} onChange={e => setPromoteForm({ ...promoteForm, newHierarchyLevel: e.target.value })} className="w-full px-2.5 py-2 border border-gray-200 rounded-lg text-[12px] bg-white outline-none"><option value="">Select...</option>{hierarchyLevels.map(l => <option key={l.id} value={l.name}>{l.label}</option>)}</select></div>
                <div><label className="text-[10px] font-semibold text-gray-500 uppercase mb-1 block">Title</label><input value={promoteForm.newTitle} onChange={e => setPromoteForm({ ...promoteForm, newTitle: e.target.value })} placeholder="e.g., Senior Developer" className="w-full px-2.5 py-2 border border-gray-200 rounded-lg text-[12px] outline-none" /></div>
                <div><label className="text-[10px] font-semibold text-gray-500 uppercase mb-1 block">Notes</label><textarea value={promoteForm.notes} onChange={e => setPromoteForm({ ...promoteForm, notes: e.target.value })} rows={2} className="w-full px-2.5 py-2 border border-gray-200 rounded-lg text-[12px] outline-none resize-none" /></div>
                <div className="flex gap-2 pt-1"><button onClick={handlePromote} className="flex-1 py-2 bg-blue-500 text-white text-[12px] font-medium rounded-lg hover:bg-blue-600">Promote</button><button onClick={() => setShowPromote(null)} className="px-4 py-2 text-[12px] text-gray-500">Cancel</button></div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showChangeManager && canManage && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => setShowChangeManager(null)}>
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} className="bg-white rounded-xl p-5 w-full max-w-sm shadow-2xl" onClick={e => e.stopPropagation()}>
              <h3 className="text-sm font-bold text-gray-800 mb-3">{showChangeManager.managerId ? 'Change / Remove Manager' : 'Assign Manager'} — {showChangeManager.name}</h3>
              {showChangeManager.managerId && (
                <p className="text-[10px] text-gray-400 mb-2">Current manager: {allUsers.find(u => String(u.id) === String(showChangeManager.managerId))?.name || 'Unknown'}</p>
              )}
              <select value={selectedManager} onChange={e => setSelectedManager(e.target.value)} className="w-full px-2.5 py-2 border border-gray-200 rounded-lg text-[12px] bg-white outline-none mb-3">
                <option value="">✕ No Manager (Root Level)</option>
                {allUsers.filter(u => u.id !== showChangeManager.id).map(u => <option key={u.id} value={u.id}>{u.name} · {u.designation || u.role}</option>)}
              </select>
              <div className="flex gap-2"><button onClick={handleChangeManager} className="flex-1 py-2 bg-blue-500 text-white text-[12px] font-medium rounded-lg hover:bg-blue-600">Update</button><button onClick={() => setShowChangeManager(null)} className="px-4 py-2 text-[12px] text-gray-500">Cancel</button></div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showHistory && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => setShowHistory(null)}>
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} className="bg-white rounded-xl p-5 w-full max-w-sm shadow-2xl max-h-[60vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4"><h3 className="text-sm font-bold text-gray-800">History — {showHistory.name}</h3><button onClick={() => setShowHistory(null)}><X size={14} className="text-gray-400" /></button></div>
              {promoHistory.length === 0 ? <p className="text-[12px] text-gray-400 text-center py-6">No promotion history</p> : (
                <div className="space-y-2">{promoHistory.map((p, i) => (
                  <div key={p.id || i} className="flex gap-2"><div className="flex flex-col items-center"><div className="w-2 h-2 rounded-full bg-blue-500 mt-1.5" />{i < promoHistory.length - 1 && <div className="w-px flex-1 bg-gray-200 mt-0.5" />}</div>
                  <div className="pb-2"><div className="flex items-center gap-1.5 text-[10px]"><span className="px-1.5 py-0.5 rounded-full bg-red-50 text-red-500 font-medium">{p.previousRole}</span><span className="text-gray-300">→</span><span className="px-1.5 py-0.5 rounded-full bg-green-50 text-green-600 font-medium">{p.newRole}</span></div>{p.notes && <p className="text-[10px] text-gray-500 mt-0.5">{p.notes}</p>}<p className="text-[9px] text-gray-400">{p.promoter?.name && `by ${p.promoter.name} · `}{p.effectiveDate && new Date(p.effectiveDate).toLocaleDateString()}</p></div></div>
                ))}</div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>{showManageHierarchy && <HierarchyManager levels={hierarchyLevels} onClose={() => setShowManageHierarchy(false)} onRefresh={fetchData} />}</AnimatePresence>

      <AnimatePresence>{showViewProfile && <ViewProfileModal employee={showViewProfile} allUsers={allUsers} hierarchyLevels={hierarchyLevels} onClose={() => setShowViewProfile(null)} />}</AnimatePresence>
    </div>
  );
}
