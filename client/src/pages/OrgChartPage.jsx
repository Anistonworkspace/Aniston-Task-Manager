import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import {
  Users, ChevronDown, ArrowUp, User, Edit2, X, History, Shield, Search,
  GitBranch, Crown, Settings2, Layers, Building2, GripVertical,
  ChevronUp, Plus, Palette, Trash2, ZoomIn, ZoomOut, Maximize2, RotateCcw, Save
} from 'lucide-react';

const ROLE_COLORS = {
  admin: { color: '#e2445c', bg: '#fef2f2' },
  manager: { color: '#0073ea', bg: '#eff6ff' },
  member: { color: '#00c875', bg: '#f0fdf4' },
};

// ═══ SINGLE CARD (draggable independently) ═══
function PersonCard({ node, hlColor, hlLabel, canManage, onEdit, onPromote, onChangeManager, onViewHistory, onDragStartCard, onDropOnCard }) {
  const [hovered, setHovered] = useState(false);
  const avatarUrl = node.avatar ? (node.avatar.startsWith?.('http') ? node.avatar : node.avatar.startsWith?.('/') ? node.avatar : `/${node.avatar}`) : null;

  return (
    <div
      className="relative"
      draggable={canManage ? 'true' : 'false'}
      onDragStart={e => {
        e.stopPropagation();
        e.dataTransfer.setData('text/plain', node.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStartCard(node);
      }}
      onDragOver={e => { e.preventDefault(); e.stopPropagation(); e.currentTarget.querySelector('.card-inner')?.classList.add('ring-2', 'ring-blue-400', 'shadow-lg'); }}
      onDragLeave={e => { e.currentTarget.querySelector('.card-inner')?.classList.remove('ring-2', 'ring-blue-400', 'shadow-lg'); }}
      onDrop={e => { e.preventDefault(); e.stopPropagation(); e.currentTarget.querySelector('.card-inner')?.classList.remove('ring-2', 'ring-blue-400', 'shadow-lg'); onDropOnCard(node); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className={`card-inner bg-white rounded-lg border border-gray-100 shadow-sm transition-all duration-150 select-none
        ${hovered ? 'shadow-md border-gray-200' : ''}`}
        style={{ width: 130 }}>
        <div className="h-[3px] rounded-t-lg" style={{ backgroundColor: hlColor }} />
        <div className="px-2 py-2 text-center">
          <div className="w-8 h-8 rounded-full mx-auto mb-1 flex items-center justify-center text-[10px] font-bold text-white"
            style={{ backgroundColor: hlColor }}>
            {avatarUrl ? <img src={avatarUrl} className="w-8 h-8 rounded-full object-cover" alt="" /> : node.name?.charAt(0)?.toUpperCase()}
          </div>
          <p className="text-[10px] font-semibold text-gray-800 truncate leading-tight">{node.name}</p>
          <p className="text-[8px] text-gray-400 truncate">{node.designation || ''}</p>
          <span className="inline-block mt-1 text-[7px] font-medium px-1.5 py-0.5 rounded-full"
            style={{ backgroundColor: `${hlColor}15`, color: hlColor }}>{hlLabel}</span>
        </div>
      </div>

      {/* Hover actions */}
      {hovered && canManage && (
        <div className="absolute -top-1.5 -right-1.5 flex gap-px z-20">
          <button onClick={() => onEdit(node)} className="w-4 h-4 rounded-full bg-gray-500 text-white flex items-center justify-center shadow-sm hover:bg-gray-600 text-[8px]" title="Edit Profile">
            <Edit2 size={8} />
          </button>
          <button onClick={() => onPromote(node)} className="w-4 h-4 rounded-full bg-green-500 text-white flex items-center justify-center shadow-sm hover:bg-green-600" title="Promote">
            <ArrowUp size={8} />
          </button>
          <button onClick={() => onViewHistory(node)} className="w-4 h-4 rounded-full bg-purple-500 text-white flex items-center justify-center shadow-sm hover:bg-purple-600" title="History">
            <History size={8} />
          </button>
        </div>
      )}
    </div>
  );
}

// ═══ TREE NODE (recursive with connectors) ═══
function TreeNode({ node, hierarchyLevels, canManage, depth, handlers }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = node.children?.length > 0;
  const hlInfo = hierarchyLevels.find(l => l.name === node.hierarchyLevel);
  const hlColor = hlInfo?.color || ROLE_COLORS[node.role]?.color || '#00c875';
  const hlLabel = hlInfo?.label || node.hierarchyLevel || 'Member';

  return (
    <div className="flex flex-col items-center">
      <div className="relative">
        <PersonCard node={node} hlColor={hlColor} hlLabel={hlLabel} canManage={canManage} {...handlers} />
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
            <div className="h-px bg-gray-200" style={{ width: `${(node.children.length - 1) * 146}px` }} />
          )}
          <div className="flex gap-3 items-start">
            {node.children.map(child => (
              <div key={child.id} className="flex flex-col items-center">
                <div className="w-px h-2 bg-gray-200" />
                <TreeNode node={child} hierarchyLevels={hierarchyLevels} canManage={canManage} depth={depth + 1} handlers={handlers} />
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
      await api.put(`/users/${user.id}`, form);
      onSaved();
      onClose();
    } catch (err) { console.error(err); alert('Failed to update'); } finally { setSaving(false); }
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
  const [promoteForm, setPromoteForm] = useState({ newRole: '', newTitle: '', newHierarchyLevel: '', notes: '' });
  const [selectedManager, setSelectedManager] = useState('');
  const [promoHistory, setPromoHistory] = useState([]);
  const [dragNode, setDragNode] = useState(null);
  const [viewMode, setViewMode] = useState('levels');
  const [zoom, setZoom] = useState(0.7);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, ox: 0, oy: 0 });
  const containerRef = useRef(null);

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
      setOrgChart(d.orgChart || []);
      setAllUsers(d.allUsers || []);
      setUsersByLevel(d.usersByLevel || {});
      setHierarchyLevels(d.hierarchyLevels || (hlRes.data?.data || hlRes.data).levels || []);
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
      await api.put('/promotions/update-manager', { userId: dragNode.id, managerId: targetNode.id });
      fetchData();
    } catch (err) { console.error(err); }
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
      fetchData();
    } catch (err) { console.error(err); }
    setDragNode(null);
  }

  // Canvas pan (middle mouse or background click)
  function onCanvasMouseDown(e) {
    if (e.target.closest('[draggable="true"]')) return; // Don't pan when dragging cards
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
      await api.post('/promotions', { userId: showPromote.id, newRole: promoteForm.newRole, newTitle: promoteForm.newTitle, newHierarchyLevel: promoteForm.newHierarchyLevel, notes: promoteForm.notes });
      setShowPromote(null); setPromoteForm({ newRole: '', newTitle: '', newHierarchyLevel: '', notes: '' }); fetchData();
    } catch {}
  }

  async function handleChangeManager() {
    try {
      await api.put('/promotions/update-manager', { userId: showChangeManager.id, managerId: selectedManager || null });
      setShowChangeManager(null); setSelectedManager(''); fetchData();
    } catch {}
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
    (allUsers.map ? allUsers : []).forEach(u => { const d = (u.toJSON ? u.toJSON() : u).department || 'Other'; if (!m[d]) m[d] = []; m[d].push(u.toJSON ? u.toJSON() : u); });
    return Object.entries(m).sort(([a], [b]) => a.localeCompare(b));
  }

  const filteredChart = filterTree(orgChart, searchQuery);
  const stats = { total: allUsers.length, admins: allUsers.filter(u => u.role === 'admin').length, managers: allUsers.filter(u => u.role === 'manager').length, members: allUsers.filter(u => u.role === 'member').length };

  const cardHandlers = {
    onEdit: n => setShowEditEmployee(n),
    onPromote: n => { setShowPromote(n); setPromoteForm({ newRole: n.role, newTitle: n.designation || '', newHierarchyLevel: n.hierarchyLevel || '', notes: '' }); },
    onChangeManager: n => { setShowChangeManager(n); setSelectedManager(n.managerId || ''); },
    onViewHistory: viewHistory,
    onDragStartCard,
    onDropOnCard,
  };

  if (loading) return <div className="p-8 bg-white min-h-full flex items-center justify-center"><div className="animate-pulse flex gap-6">{[1,2,3].map(i => <div key={i} className="w-32 h-24 bg-gray-100 rounded-lg" />)}</div></div>;

  return (
    <div className="p-5 bg-white min-h-full">
      <div className="max-w-full mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-lg font-bold text-gray-800 flex items-center gap-2"><GitBranch size={16} className="text-indigo-500" /> Organization Chart</h1>
            <p className="text-[11px] text-gray-400 mt-0.5 ml-6">{stats.total} members · {hierarchyLevels.length} levels</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex bg-gray-100 rounded-lg p-0.5">
              <button onClick={() => setViewMode('levels')} className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${viewMode === 'levels' ? 'bg-white shadow-sm text-gray-800' : 'text-gray-500'}`}>Levels</button>
              <button onClick={() => setViewMode('tree')} className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${viewMode === 'tree' ? 'bg-white shadow-sm text-gray-800' : 'text-gray-500'}`}>Tree</button>
              <button onClick={() => setViewMode('department')} className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${viewMode === 'department' ? 'bg-white shadow-sm text-gray-800' : 'text-gray-500'}`}>Department</button>
            </div>
            {isAdmin && <button onClick={() => setShowManageHierarchy(true)} className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium text-indigo-600 bg-indigo-50 rounded-lg hover:bg-indigo-100"><Settings2 size={12} /> Manage Levels</button>}
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

        {canManage && <p className="text-[10px] text-gray-400 mb-2 flex items-center gap-1"><GripVertical size={10} /> {viewMode === 'levels' ? 'Drag a card to a different level to change hierarchy' : 'Drag a card onto another to reassign manager'} · Click background to pan · Scroll to zoom</p>}

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
                      onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('ring-2', 'ring-blue-400', 'bg-blue-50/30'); }}
                      onDragLeave={e => { e.currentTarget.classList.remove('ring-2', 'ring-blue-400', 'bg-blue-50/30'); }}
                      onDrop={e => { e.preventDefault(); e.currentTarget.classList.remove('ring-2', 'ring-blue-400', 'bg-blue-50/30'); onDropOnLevel(level.name); }}
                    >
                      <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-gray-100" style={{ backgroundColor: `${level.color}08` }}>
                        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: level.color }} />
                        <span className="text-[12px] font-bold" style={{ color: level.color }}>{level.label}</span>
                        <span className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full">{levelUsers.length}</span>
                        <span className="text-[9px] text-gray-300 ml-auto uppercase tracking-wider">Level {level.order}</span>
                      </div>
                      <div className="p-3 flex flex-wrap gap-2.5 min-h-[50px]">
                        {levelUsers.map(u => {
                          const hlColor = level.color || '#00c875';
                          return (
                            <PersonCard
                              key={u.id}
                              node={u}
                              hlColor={hlColor}
                              hlLabel={level.label}
                              canManage={canManage}
                              onEdit={n => setShowEditEmployee(n)}
                              onPromote={n => { setShowPromote(n); setPromoteForm({ newRole: n.role, newTitle: n.designation || '', newHierarchyLevel: n.hierarchyLevel || '', notes: '' }); }}
                              onChangeManager={n => { setShowChangeManager(n); setSelectedManager(n.managerId || ''); }}
                              onViewHistory={viewHistory}
                              onDragStartCard={onDragStartCard}
                              onDropOnCard={() => {}}
                            />
                          );
                        })}
                      </div>
                    </div>
                    {/* Connector between levels */}
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
                    {filteredChart.map(node => <TreeNode key={node.id} node={node} hierarchyLevels={hierarchyLevels} canManage={canManage} depth={0} handlers={cardHandlers} />)}
                  </div>
                )}
              </div>
            </div>
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
                      <div key={u.id} className="flex items-center gap-2 px-2.5 py-2 bg-gray-50 rounded-lg hover:bg-gray-100 cursor-pointer group" style={{ minWidth: 160 }}
                        onClick={() => canManage && setShowEditEmployee(u)}>
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
              <h3 className="text-sm font-bold text-gray-800 mb-3">Change Manager — {showChangeManager.name}</h3>
              <select value={selectedManager} onChange={e => setSelectedManager(e.target.value)} className="w-full px-2.5 py-2 border border-gray-200 rounded-lg text-[12px] bg-white outline-none mb-3">
                <option value="">No manager (top level)</option>
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
    </div>
  );
}
