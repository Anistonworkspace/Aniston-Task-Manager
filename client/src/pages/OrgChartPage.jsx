import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/common/Toast';
import { useConfirm } from '../components/common/ConfirmDialog';
import useRealtimeEvent from '../realtime/useRealtimeEvent';
import AccessDenied from '../components/common/AccessDenied';
import { isExplicitlyDenied } from '../utils/permissions';
import { TIER_1, TIER_2, TIER_3, TIER_4, resolveTier, tierLabel, tiersGrantableBy } from '../utils/tiers';
import { useT } from '../context/LanguageContext';

// TODO i18n: further strings (form labels, error messages, dialogs) still hardcoded — extend in a future pass
import {
  Users, ChevronDown, ArrowUp, User, Edit2, X, History, Shield, Search,
  GitBranch, Crown, Settings2, Layers, Building2, GripVertical,
  ChevronUp, Plus, Palette, Trash2, ZoomIn, ZoomOut, Maximize2, RotateCcw, Save,
  UserCog, ExternalLink, ChevronRight, Move
} from 'lucide-react';

/**
 * Returns true if the employee has a primary manager from EITHER source:
 *   - User.managerId (legacy/cache)
 *   - manager_relations row with isPrimary=true (canonical multi-manager)
 *
 * Treating either source as authoritative for the "Remove Primary Manager"
 * affordance prevents a long-standing bug where the side-panel button (and
 * drop-to-root zone) silently disabled themselves when User.managerId had
 * drifted to null but the junction table still held a primary row.
 */
function hasPrimaryManager(employee) {
  if (!employee) return false;
  if (employee.managerId) return true;
  const rels = employee.managerRelations || [];
  return rels.some((r) => r && r.isPrimary === true);
}

// Tier-based color palette for the org-chart fallback (used when a user has
// no hierarchyLevel set). hierarchyLevel remains the primary classification —
// tier is shown only as a fallback so cards never render an old role name.
const TIER_COLORS = {
  [TIER_1]: { color: '#e2445c', bg: '#fef2f2' },
  [TIER_2]: { color: '#0073ea', bg: '#eff6ff' },
  [TIER_3]: { color: '#f59e0b', bg: '#fffbeb' },
  [TIER_4]: { color: '#00c875', bg: '#f0fdf4' },
};

// Resolve the org-chart fallback color for a user. Uses tier — never role.
function tierColorOf(user) {
  return TIER_COLORS[resolveTier(user)] || TIER_COLORS[TIER_4];
}

// ═══ SINGLE CARD (ChartHop-style: avatar + name/title + bottom colored band) ═══
//
// Card layout (top-to-bottom):
//   ┌────────────────────────────────────┐
//   │ [avatar]   Name                    │   ← top-band (white)
//   │            Title / designation     │
//   ├────────────────────────────────────┤
//   │  Department · Tier label · N reports│   ← bottom band (dept colour)
//   └────────────────────────────────────┘
//
// Tier 1 cards are slightly larger (w=180 vs 156) per the redesign brief —
// leadership reads as visually heavier. Tier 4 is unchanged. The bottom band
// uses the hierarchyLevel/tier colour at full saturation; band text is white
// and high-contrast, mirroring ChartHop reference.
function PersonCard({ node, hlColor, hlLabel, canDrag, isSelected, reportCount = 0, onEdit, onPromote, onChangeManager, onViewHistory, onDragStartCard, onDropOnCard, onClick }) {
  const [hovered, setHovered] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const avatarUrl = node.avatar ? (node.avatar.startsWith?.('http') ? node.avatar : node.avatar.startsWith?.('/') ? node.avatar : `/${node.avatar}`) : null;
  const tier = resolveTier(node);
  const isTier1Card = tier === TIER_1 || node.isSuperAdmin;
  const cardWidth = isTier1Card ? 184 : 156;
  // Show BOTH department and tier on the bottom band. Department is the
  // primary label (left); tier is always shown on the right as a small pill
  // so the user can read it at a glance regardless of how the colour palette
  // happens to overlap with the department colour.
  //
  // "Unassigned" displayed when a user has no department on file (per the
  // brief — never invent a department; never fall back to the tier label).
  const deptLabel = node.department || 'Unassigned';
  const tierBadgeLabel = tierLabel(tier);

  return (
    <div
      className="relative"
      draggable={canDrag && !isTier1Card ? 'true' : 'false'}
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
      style={canDrag && !isTier1Card ? { cursor: 'grab' } : undefined}
    >
      <div
        className={`card-inner bg-white rounded-xl border overflow-hidden transition-all duration-150 select-none
          ${isSelected
            ? 'border-blue-400 ring-2 ring-blue-100 shadow-lg'
            : isDragOver
              ? 'border-blue-400 ring-2 ring-blue-400 shadow-xl -translate-y-0.5'
              : hovered
                ? 'shadow-md border-gray-200 -translate-y-0.5'
                : 'border-gray-200 shadow-sm'}
          ${canDrag && !isTier1Card ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}`}
        style={{ width: cardWidth }}
        onClick={(e) => { e.stopPropagation(); onClick(node); }}
      >
        {/* Top section — white background, avatar + name/title */}
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          {canDrag && !isTier1Card && (
            <div className="absolute top-1.5 left-1.5 text-gray-300 opacity-0 group-hover:opacity-100">
              <GripVertical size={11} />
            </div>
          )}
          <div className={`flex-shrink-0 ${isTier1Card ? 'w-10 h-10' : 'w-9 h-9'} rounded-full flex items-center justify-center text-[11px] font-bold text-white`}
            style={{ backgroundColor: hlColor }}>
            {avatarUrl ? <img src={avatarUrl} className={`${isTier1Card ? 'w-10 h-10' : 'w-9 h-9'} rounded-full object-cover`} alt="" /> : node.name?.charAt(0)?.toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className={`${isTier1Card ? 'text-[12px]' : 'text-[11px]'} font-semibold text-gray-800 truncate leading-tight`}>{node.name}</p>
            <p className="text-[9.5px] text-gray-400 truncate leading-tight mt-0.5">{node.designation || node.title || ''}</p>
          </div>
        </div>

        {/* Bottom band — department LEFT, tier badge RIGHT, both always shown.
            Tier badge is a translucent white pill so it stays legible on every
            band colour (the band itself is the hierarchyLevel/tier colour). */}
        <div
          className="w-full px-2.5 py-1 flex items-center justify-between gap-1.5 text-[9px] font-medium"
          style={{ backgroundColor: hlColor, color: '#fff' }}
        >
          <span className="truncate flex-1 min-w-0" title={deptLabel}>{deptLabel}</span>
          <span
            className="flex-shrink-0 px-1.5 py-px rounded-full text-[8.5px] font-semibold tracking-tight"
            style={{ backgroundColor: 'rgba(255,255,255,0.22)', color: '#fff' }}
            title={tierBadgeLabel}
          >
            {tierBadgeLabel}
          </span>
          {reportCount > 0 && (
            <span className="flex-shrink-0 opacity-85" title={`${reportCount} direct ${reportCount === 1 ? 'report' : 'reports'}`}>+{reportCount}</span>
          )}
        </div>

        {/* Secondary-relation / multi-manager hints — kept compact on top of card */}
        {node._isSecondaryRef && (
          <span className="absolute top-1 right-1 text-[7.5px] font-medium px-1.5 py-px rounded-full bg-purple-50 text-purple-500 border border-dashed border-purple-200">
            {node._secondaryRelationType === 'dotted_line' ? '┈' : node._secondaryRelationType === 'project' ? '◈' : '◇'}
          </span>
        )}
        {(node.managerRelations || []).length > 1 && !node._isSecondaryRef && (
          <span className="absolute top-1 right-1 text-[7.5px] text-gray-400 bg-white/70 px-1 rounded">
            +{node.managerRelations.length - 1}
          </span>
        )}
      </div>

      {/* Hover actions — only in edit mode AND not Tier 1 */}
      {hovered && canDrag && !isTier1Card && (
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

// ═══ TREE NODE (recursive with thin orthogonal connectors) ═══
//
// Connector design (ChartHop-style):
//   - 1px neutral grey (#E1E5EB) lines, no shadow
//   - vertical drop from parent → horizontal joiner across siblings →
//     vertical drop into each child, forming clean right angles
//   - sibling-bar width derived from CARD_WIDTH + COL_GAP so spacing is
//     constant regardless of card content (avoids the off-centre layout
//     the screenshot showed when children had different widths)
const COL_GAP = 28;       // px between sibling cards
const CARD_W = 156;       // matches PersonCard non-Tier-1 width
const ROW_DROP = 14;      // vertical line length above each child
const ROW_DROP_TOP = 12;  // vertical line dropping from parent
const CONNECTOR_COLOR = '#E1E5EB';
function TreeNode({ node, hierarchyLevels, canDrag, selectedId, depth, handlers }) {
  // All nodes default to expanded so the hierarchy renders fully open on load.
  // Manual collapse via the toggle button still persists for the session because
  // each TreeNode keeps its own state for as long as it stays mounted.
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children?.length > 0;
  const hlInfo = hierarchyLevels.find(l => l.name === node.hierarchyLevel);
  const hlColor = hlInfo?.color || tierColorOf(node).color;
  // Display priority: explicit hierarchyLevel label → fallback to tier label.
  // Old role names (Admin/Manager/Asst. Manager/Member) are never shown.
  const hlLabel = hlInfo?.label || tierLabel(resolveTier(node));
  const reportCount = hasChildren ? node.children.filter(c => !c._isSecondaryRef).length : 0;

  return (
    <div className="flex flex-col items-center">
      <div className="relative">
        <PersonCard node={node} hlColor={hlColor} hlLabel={hlLabel} canDrag={canDrag} isSelected={selectedId === node.id} reportCount={reportCount} {...handlers} />
        {hasChildren && (
          <button onClick={() => setExpanded(!expanded)}
            aria-label={expanded ? 'Collapse subordinates' : `Expand ${node.children.length} subordinates`}
            className="absolute -bottom-2.5 left-1/2 -translate-x-1/2 w-5 h-5 rounded-full bg-white border border-gray-200 shadow-sm flex items-center justify-center z-10 hover:bg-gray-50 hover:border-gray-300 transition-colors">
            <span className="text-[9px] text-gray-500 font-semibold">{expanded ? '−' : node.children.length}</span>
          </button>
        )}
      </div>

      {expanded && hasChildren && (
        <div className="flex flex-col items-center" style={{ marginTop: 6 }}>
          {/* Vertical drop from parent */}
          <div style={{ width: 1, height: ROW_DROP_TOP, backgroundColor: CONNECTOR_COLOR }} />
          {/* Horizontal sibling bar — constant-width per-child slot keeps the
              layout symmetrical even when children have varying widths. */}
          {node.children.length > 1 && (
            <div
              style={{
                height: 1,
                backgroundColor: CONNECTOR_COLOR,
                width: `${(node.children.length - 1) * (CARD_W + COL_GAP)}px`,
              }}
            />
          )}
          <div className="flex items-start" style={{ gap: COL_GAP }}>
            {node.children.map((child, ci) => (
              <div key={child._isSecondaryRef ? `${child.id}-sec-${ci}` : child.id} className="flex flex-col items-center">
                <div
                  style={{
                    width: 1,
                    height: ROW_DROP,
                    backgroundColor: child._isSecondaryRef ? 'transparent' : CONNECTOR_COLOR,
                    borderLeft: child._isSecondaryRef ? '1px dashed #C9B8E0' : 'none',
                  }}
                />
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
function EditEmployeeModal({ user, hierarchyLevels, onClose, onSaved, toastError }) {
  const { user: actor } = useAuth();
  const initialTier = resolveTier(user);
  const [form, setForm] = useState({
    name: user.name || '',
    designation: user.designation || '',
    department: user.department || '',
    hierarchyLevel: user.hierarchyLevel || 'member',
    tier: initialTier,
  });
  const [saving, setSaving] = useState(false);

  // Always include the user's CURRENT tier (so the dropdown can render their
  // existing state) plus every tier the actor is permitted to grant. Tier 3/4
  // actors get a single read-only entry.
  const grantable = tiersGrantableBy(actor);
  const tierOptions = Array.from(new Set([initialTier, ...grantable.map(g => g.value)]))
    .sort((a, b) => a - b)
    .map(t => ({ value: t, label: tierLabel(t) }));

  // Map a tier to the legacy (role, isSuperAdmin) pair the API still accepts
  // during the compatibility window. The User-model `beforeSave` hook keeps
  // tier and legacy fields in lockstep on the server side.
  function legacyFromTier(tier) {
    switch (tier) {
      case TIER_1: return { role: 'admin', isSuperAdmin: true };
      case TIER_2: return { role: 'admin', isSuperAdmin: false };
      case TIER_3: return { role: 'assistant_manager', isSuperAdmin: false };
      case TIER_4: return { role: 'member', isSuperAdmin: false };
      default:     return { role: 'member', isSuperAdmin: false };
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const payload = {
        name: form.name,
        designation: form.designation,
        department: form.department,
        hierarchyLevel: form.hierarchyLevel,
      };
      if (form.tier !== initialTier) Object.assign(payload, legacyFromTier(form.tier));
      const res = await api.put(`/users/${user.id}`, payload);
      console.log('[OrgChart] Edit saved:', res.data);
      await onSaved();
      onClose();
    } catch (err) {
      console.error('[OrgChart] Edit failed:', err.response?.data || err.message);
      toastError?.(err.response?.data?.message || 'Failed to update');
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
              <label className="text-[10px] font-semibold text-gray-500 uppercase mb-1 block">Tier</label>
              <select value={form.tier} onChange={e => setForm({ ...form, tier: Number(e.target.value) })}
                disabled={tierOptions.length <= 1}
                className="w-full px-2.5 py-2 border border-gray-200 rounded-lg text-[12px] bg-white outline-none focus:border-blue-400 disabled:opacity-60 disabled:cursor-not-allowed">
                {tierOptions.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
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
  const hlColor = hlInfo?.color || tierColorOf(employee).color;
  const avatarUrl = employee.avatar ? (employee.avatar.startsWith?.('http') ? employee.avatar : employee.avatar.startsWith?.('/') ? employee.avatar : `/${employee.avatar}`) : null;
  const manager = employee.managerId ? allUsers.find(u => String(u.id) === String(employee.managerId)) : null;
  const directReports = allUsers.filter(u => String(u.managerId) === String(employee.id));

  const fields = [
    { label: 'Email', value: employee.email },
    { label: 'Department', value: employee.department },
    { label: 'Tier', value: tierLabel(resolveTier(employee)) },
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
function EmployeeDetailsPanel({ employee, allUsers, hierarchyLevels, canManage, onClose, onEdit, onChangeManager, onViewProfile, onRemoveManager, onAddSecondaryManager, onRemoveRelation }) {
  if (!employee) return null;

  const hlInfo = hierarchyLevels.find(l => l.name === employee.hierarchyLevel);
  const hlColor = hlInfo?.color || tierColorOf(employee).color;
  const avatarUrl = employee.avatar ? (employee.avatar.startsWith?.('http') ? employee.avatar : employee.avatar.startsWith?.('/') ? employee.avatar : `/${employee.avatar}`) : null;
  const manager = employee.managerId ? allUsers.find(u => String(u.id) === String(employee.managerId)) : null;
  const directReports = allUsers.filter(u => String(u.managerId) === String(employee.id));
  const tierBadgeText = tierLabel(resolveTier(employee));

  // Multi-manager: get all manager relations for this employee
  const relations = employee.managerRelations || [];
  const RELATION_LABELS = { primary: 'Primary', functional: 'Functional', project: 'Project', dotted_line: 'Dotted Line' };
  const RELATION_COLORS = { primary: '#0073ea', functional: '#00c875', project: '#f59e0b', dotted_line: '#8b5cf6' };

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
            <span className="text-[11px] text-gray-500">Tier</span>
            <span className="text-[11px] font-medium text-gray-700">{tierBadgeText}</span>
          </div>
          <div className="flex items-center justify-between py-2 border-b border-gray-100">
            <span className="text-[11px] text-gray-500">Hierarchy Level</span>
            <span className="text-[11px] font-medium" style={{ color: hlColor }}>{hlInfo?.label || employee.hierarchyLevel || '—'}</span>
          </div>
          <div className="flex items-center justify-between py-2 border-b border-gray-100">
            <span className="text-[11px] text-gray-500">Direct reports</span>
            <span className="text-[11px] font-bold text-gray-700">{directReports.length}</span>
          </div>
        </div>

        {/* Managers section (multi-manager) */}
        <div className="mb-5">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Reports to</p>
            {canManage && (
              <button onClick={() => onAddSecondaryManager(employee)} className="text-[9px] text-blue-500 hover:text-blue-700 font-medium">+ Add Manager</button>
            )}
          </div>
          {relations.length > 0 ? (
            <div className="space-y-1.5">
              {relations.map(rel => {
                const mgr = rel.manager || allUsers.find(u => String(u.id) === String(rel.managerId));
                const relColor = RELATION_COLORS[rel.relationType] || '#6b7280';
                return (
                  <div key={rel.id} className="flex items-center gap-2 px-2 py-1.5 bg-gray-50 rounded-lg group">
                    <div className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold text-white" style={{ backgroundColor: relColor }}>
                      {mgr?.name?.charAt(0)?.toUpperCase() || '?'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] font-medium text-gray-700 truncate">{mgr?.name || 'Unknown'}</p>
                      <span className="text-[8px] font-medium px-1.5 py-0.5 rounded-full" style={{ backgroundColor: `${relColor}15`, color: relColor }}>
                        {RELATION_LABELS[rel.relationType] || rel.relationType}{rel.isPrimary ? ' ★' : ''}
                      </span>
                    </div>
                    {canManage && !rel.isPrimary && (
                      <button onClick={() => onRemoveRelation(rel.id)} className="text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity" title="Remove">
                        <X size={12} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-[11px] text-gray-400 px-2">{manager ? manager.name : 'None (Root)'}</p>
          )}
        </div>

        {/* Direct Reports list */}
        {directReports.length > 0 && (
          <div className="mb-5">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Direct Reports</p>
            <div className="space-y-1.5 max-h-[140px] overflow-y-auto">
              {directReports.map(r => {
                const rRaw = r.toJSON ? r.toJSON() : r;
                const rHl = hierarchyLevels.find(l => l.name === rRaw.hierarchyLevel);
                const rColor = rHl?.color || tierColorOf(rRaw).color;
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
              <UserCog size={13} /> {hasPrimaryManager(employee) ? 'Change Primary Manager' : 'Assign Manager'}
            </button>
            {hasPrimaryManager(employee) && (
              <button onClick={() => onRemoveManager(employee)}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-red-50 text-red-500 text-[12px] font-medium rounded-lg hover:bg-red-100 transition-colors border border-red-100"
                title="Remove this user's primary manager (make them a root node). Their own subtree stays attached.">
                <X size={13} /> Remove Primary Manager (Make Root)
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
  const { canManage, isAdmin, isSuperAdmin, granularPermissions } = useAuth();
  const t = useT();
  const { success: toastSuccess, error: toastError, info: toastInfo } = useToast();
  const confirm = useConfirm();

  // Defense-in-depth guard. The /org-chart route is also wrapped in
  // <PermissionRoute>, but a page-level check ensures that if permissions
  // change live (admin issues a DENY while the user is on this page) the
  // permissions:updated socket refresh swaps the page out cleanly even
  // without a remount. Server APIs are also locked down via requirePermission,
  // so a denied user that races past this check still gets 403s.
  const orgChartViewDenied = isExplicitlyDenied('org_chart', 'view', isSuperAdmin, granularPermissions);
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
  const [showAddManager, setShowAddManager] = useState(null); // employee to add secondary manager to
  const [addManagerId, setAddManagerId] = useState('');
  const [addManagerType, setAddManagerType] = useState('functional');
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
  // Department filter chip state. Empty string = "All depts". Filters the
  // tree at render time (filterTree() now also matches department).
  const [deptFilter, setDeptFilter] = useState('');

  // Skip the fetch entirely when an explicit DENY is in place so we don't
  // trigger 403 toasts for a user that is correctly blocked. Re-runs on
  // permissions:updated (granularPermissions changes) so revoking a deny
  // restores the chart without a manual reload.
  useEffect(() => { if (!orgChartViewDenied) fetchData(); }, [orgChartViewDenied]);

  // Realtime — refetch when ANY user mutates the hierarchy. Server emits
  // 'org:hierarchy:changed' from promotionController + managerRelationController
  // after every successful write. Debounce burst-refetches (e.g. a manager
  // dragging multiple users in quick succession would otherwise hammer the
  // GET endpoint) — 400ms window collapses bursts into one refetch.
  const hierarchyRefetchTimerRef = useRef(null);
  useRealtimeEvent('org:hierarchy:changed', () => {
    if (orgChartViewDenied) return;
    if (hierarchyRefetchTimerRef.current) clearTimeout(hierarchyRefetchTimerRef.current);
    hierarchyRefetchTimerRef.current = setTimeout(() => { fetchData(); }, 400);
  });

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
  function onDragStartCard(node) {
    // Tier 1 frontend block — these users are top-of-org and must remain root.
    // Backend (hierarchyService.canEditHierarchy) is still authoritative; this
    // is a UX shortcut that surfaces the rule before the user drops.
    if (resolveTier(node) === TIER_1 || node.isSuperAdmin) {
      toastInfo('Tier 1 users cannot be reassigned because they are top-level organization users.');
      setDragNode(null);
      return;
    }
    setDragNode(node);
  }
  async function onDropOnCard(targetNode) {
    if (!dragNode || dragNode.id === targetNode.id) { setDragNode(null); return; }

    // Defensive: even if onDragStartCard let it through (race / future change),
    // re-check Tier 1 on drop. Backend would reject anyway, but the friendly
    // toast is much nicer than a 403 error toast.
    //
    // ASYMMETRIC RULE:
    //   - dragNode = Tier 1   → BLOCK (Tier 1 cannot be reassigned)
    //   - targetNode = Tier 1 → ALLOW (Tier 1 IS valid as someone's manager)
    // The earlier version of this block also rejected Tier 1 as the target,
    // which prevented legitimate "Mayank reports to the CEO" assignments.
    if (resolveTier(dragNode) === TIER_1 || dragNode.isSuperAdmin) {
      toastInfo('Tier 1 users cannot be reassigned because they are top-level organization users.');
      setDragNode(null); return;
    }

    // Prevent circular (only relevant for primary manager)
    function isDescendant(parent, childId) {
      if (!parent.children) return false;
      return parent.children.some(c => c.id === childId || isDescendant(c, childId));
    }

    const existingRelations = dragNode.managerRelations || [];
    const alreadyLinked = existingRelations.some(r => String(r.managerId) === String(targetNode.id));

    if (alreadyLinked) {
      toastInfo(`${dragNode.name} is already assigned to ${targetNode.name}.`);
      setDragNode(null); return;
    }

    const hasAnyManager = existingRelations.length > 0 || dragNode.managerId;

    // If employee has no manager yet, set as primary. Otherwise, add as additional.
    if (!hasAnyManager) {
      // First manager — set as primary
      if (isDescendant(dragNode, targetNode.id)) {
        toastError('Cannot move a parent under their own subordinate.');
        setDragNode(null); return;
      }
      const ok = await confirm({
        title: 'Assign primary manager?',
        body: `Assign "${targetNode.name}" as primary manager for "${dragNode.name}"?`,
        confirmLabel: 'Assign manager',
      });
      if (!ok) { setDragNode(null); return; }
      try {
        await api.put('/promotions/update-manager', { userId: dragNode.id, managerId: targetNode.id });
        await fetchData();
        toastSuccess(`"${targetNode.name}" is now the primary manager of "${dragNode.name}".`);
      } catch (err) {
        toastError(err.response?.data?.message || 'Failed to assign manager');
      }
    } else {
      // Already has manager(s) — add as additional manager via junction table
      const ok = await confirm({
        title: 'Add additional manager?',
        body: `Add "${targetNode.name}" as an additional manager for "${dragNode.name}". They will report to both existing manager(s) and "${targetNode.name}".`,
        confirmLabel: 'Add manager',
      });
      if (!ok) { setDragNode(null); return; }
      try {
        await api.post('/multi-manager', {
          employeeId: dragNode.id,
          managerId: targetNode.id,
          relationType: 'functional',
          isPrimary: false,
        });
        await fetchData();
        toastSuccess(`Added "${targetNode.name}" as an additional manager.`);
      } catch (err) {
        toastError(err.response?.data?.message || 'Failed to add manager relation');
      }
    }
    setDragNode(null);
  }

  // Drag-to-change-level: drop a card on a level row
  async function onDropOnLevel(targetLevelName) {
    if (!dragNode || dragNode.hierarchyLevel === targetLevelName) { setDragNode(null); return; }
    if (resolveTier(dragNode) === TIER_1 || dragNode.isSuperAdmin) {
      toastInfo('Tier 1 users cannot be reassigned because they are top-level organization users.');
      setDragNode(null); return;
    }
    const targetLevel = hierarchyLevels.find(l => l.name === targetLevelName);
    const ok = await confirm({
      title: 'Change hierarchy level?',
      body: `Change "${dragNode.name}" hierarchy level to "${targetLevel?.label || targetLevelName}"?`,
      confirmLabel: 'Change level',
    });
    if (!ok) { setDragNode(null); return; }
    try {
      await api.put(`/users/${dragNode.id}`, { hierarchyLevel: targetLevelName });
      await fetchData();
      toastSuccess(`Hierarchy level updated for "${dragNode.name}".`);
    } catch (err) {
      console.error('[OrgChart] Level change failed:', err.response?.data || err.message);
      toastError(err.response?.data?.message || 'Failed to change level');
    }
    setDragNode(null);
  }

  // Drag-to-root: drop a card on the root zone to remove manager.
  // Accepts the drop if the dragged employee has a primary manager from
  // either source (User.managerId OR manager_relations.isPrimary). The
  // backend wipes BOTH atomically and preserves the employee's own subtree.
  async function onDropToRoot() {
    const draggedName = dragNode?.name;
    const draggedId = dragNode?.id;
    if (!dragNode || !hasPrimaryManager(dragNode)) { setDragNode(null); return; }
    if (resolveTier(dragNode) === TIER_1 || dragNode.isSuperAdmin) {
      toastInfo('Tier 1 users are already top-level and cannot be reassigned.');
      setDragNode(null); return;
    }
    const ok = await confirm({
      title: 'Remove primary manager?',
      body: `"${draggedName}" will become a root-level employee. Their own direct reports remain attached to them.`,
      confirmLabel: 'Make root',
      danger: true,
    });
    if (!ok) { setDragNode(null); return; }
    try {
      await api.put('/promotions/update-manager', { userId: draggedId, managerId: null });
      await fetchData();
      toastSuccess(`"${draggedName}" is now a root-level employee.`);
    } catch (err) {
      console.error('[OrgChart] Drop-to-root failed:', err.response?.data || err.message);
      toastError(err.response?.data?.message || 'Failed to remove manager');
    }
    setDragNode(null);
  }

  // Add secondary manager relation
  async function handleAddSecondaryManager() {
    if (!showAddManager || !addManagerId) return;
    try {
      await api.post('/multi-manager', {
        employeeId: showAddManager.id,
        managerId: addManagerId,
        relationType: addManagerType,
        isPrimary: false,
      });
      setShowAddManager(null); setAddManagerId(''); setAddManagerType('functional');
      await fetchData();
      toastSuccess('Manager relation added.');
    } catch (err) {
      console.error('[OrgChart] Add secondary manager failed:', err.response?.data || err.message);
      toastError(err.response?.data?.message || 'Failed to add manager relation');
    }
  }

  // Remove a specific manager relation by relation ID
  async function handleRemoveRelation(relationId) {
    const ok = await confirm({
      title: 'Remove manager relation?',
      body: 'This removes the link between the employee and that manager. Other relations remain in place.',
      confirmLabel: 'Remove relation',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/multi-manager/${relationId}`);
      await fetchData();
      toastSuccess('Manager relation removed.');
    } catch (err) {
      console.error('[OrgChart] Remove relation failed:', err.response?.data || err.message);
      toastError(err.response?.data?.message || 'Failed to remove relation');
    }
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
      toastSuccess(`Promoted ${res.data?.data?.user?.name || 'user'}.`);
    } catch (err) {
      console.error('[OrgChart] Promote failed:', err.response?.data || err.message);
      toastError(err.response?.data?.message || 'Failed to promote');
    }
  }

  async function handleRemoveManager(employee) {
    if (!employee || !hasPrimaryManager(employee)) {
      toastError(`"${employee?.name || 'This user'}" does not have a primary manager to remove.`);
      return;
    }
    if (resolveTier(employee) === TIER_1 || employee.isSuperAdmin) {
      toastInfo('Tier 1 users are already top-level and cannot be reassigned.');
      return;
    }
    const ok = await confirm({
      title: 'Remove primary manager?',
      body: `"${employee.name}" will become a root-level employee. Their own direct reports remain attached to them.`,
      confirmLabel: 'Make root',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.put('/promotions/update-manager', { userId: employee.id, managerId: null });
      await fetchData();
      toastSuccess(`Removed primary manager. "${employee.name}" is now a root-level employee.`);
    } catch (err) {
      console.error('[OrgChart] Remove manager failed:', err.response?.data || err.message);
      toastError(err.response?.data?.message || 'Failed to remove manager');
    }
  }

  async function handleChangeManager() {
    try {
      const newManagerId = selectedManager || null;
      await api.put('/promotions/update-manager', { userId: showChangeManager.id, managerId: newManagerId });
      setShowChangeManager(null); setSelectedManager('');
      await fetchData();
      toastSuccess(newManagerId
        ? `Updated primary manager for "${showChangeManager.name}".`
        : `"${showChangeManager.name}" is now a root-level employee.`);
    } catch (err) {
      console.error('[OrgChart] Manager change failed:', err.response?.data || err.message);
      toastError(err.response?.data?.message || 'Failed to update manager');
    }
  }

  async function viewHistory(node) {
    try { const res = await api.get(`/promotions/${node.id}`); setPromoHistory((res.data?.data || res.data).promotions || []); setShowHistory(node); } catch {}
  }

  // ─── Filtering ───────────────────────────────────────────────────────────
  //
  // A single matcher is applied to each user record across all three view
  // modes (tree / list / department). Match fields:
  //   - name, email, designation, title, department
  //   - tier label ("tier 1", "tier 2"…) so users can search by tier
  //
  // Tree View additionally retains a node whose own fields don't match if any
  // descendant's do — that preserves manager-chain context the user expects.
  function userMatchesFilters(u, q, dept) {
    const tierStr = tierLabel(resolveTier(u))?.toLowerCase() || '';
    const queryHit =
      !q ||
      u.name?.toLowerCase().includes(q) ||
      u.email?.toLowerCase().includes(q) ||
      u.designation?.toLowerCase().includes(q) ||
      u.title?.toLowerCase().includes(q) ||
      u.department?.toLowerCase().includes(q) ||
      tierStr.includes(q);
    const deptHit = !dept || u.department === dept;
    return queryHit && deptHit;
  }

  function filterTree(nodes, q, dept) {
    if (!q && !dept) return nodes;
    const query = (q || '').toLowerCase();
    function matches(n) {
      // A node matches if it satisfies the filters OR any descendant does
      // (keeps manager chain visible).
      return userMatchesFilters(n, query, dept) || (n.children || []).some(c => matches(c));
    }
    function filterNode(n) { if (!matches(n)) return null; return { ...n, children: (n.children || []).map(filterNode).filter(Boolean) }; }
    return nodes.map(filterNode).filter(Boolean);
  }

  function getDepartmentView() {
    const q = (searchQuery || '').toLowerCase();
    const m = {};
    allUsers.forEach(u => {
      // Apply both search and dept-chip filters to the department view too.
      if (!userMatchesFilters(u, q, deptFilter)) return;
      const dept = u.department || 'Unassigned';
      if (!m[dept]) m[dept] = [];
      m[dept].push(u);
    });
    return Object.entries(m).sort(([a], [b]) => a.localeCompare(b));
  }

  // Handle card click — select employee for side panel, merge allUsers + tree node data
  function onCardClick(node) {
    const nodeId = node.id;
    setSelectedEmployee(prev => {
      if (prev && String(prev.id) === String(nodeId)) return null; // toggle off
      const fresh = allUsers.find(u => String(u.id) === String(nodeId));
      // Merge: prefer fresh allUsers data but fall back to tree node for managerRelations
      const base = fresh ? { ...fresh } : { ...node };
      if ((!base.managerRelations || base.managerRelations.length === 0) && node.managerRelations?.length > 0) {
        base.managerRelations = node.managerRelations;
      }
      return base;
    });
  }

  const filteredChart = filterTree(orgChart, searchQuery, deptFilter);
  // Apply the same searchQuery + deptFilter to the List View source so it
  // tracks the Tree View. Without this, switching to List View while a
  // search/chip is active showed the unfiltered list — that was the
  // "search not working" symptom in screenshot 1.
  const filteredUsersByLevel = (() => {
    const q = (searchQuery || '').toLowerCase();
    const out = {};
    Object.entries(usersByLevel).forEach(([levelName, levelData]) => {
      const filteredUsers = (levelData?.users || []).filter(u => userMatchesFilters(u, q, deptFilter));
      out[levelName] = { ...levelData, users: filteredUsers };
    });
    return out;
  })();
  const departmentView = getDepartmentView();
  const stats = {
    total: allUsers.length,
    tier1: allUsers.filter(u => resolveTier(u) === TIER_1).length,
    tier2: allUsers.filter(u => resolveTier(u) === TIER_2).length,
    tier3: allUsers.filter(u => resolveTier(u) === TIER_3).length,
    tier4: allUsers.filter(u => resolveTier(u) === TIER_4).length,
  };
  // Distinct active tiers + departments for the meta strip
  const activeTierCount = [stats.tier1, stats.tier2, stats.tier3, stats.tier4].filter(n => n > 0).length;
  const distinctDepartments = new Set(allUsers.map(u => u.department).filter(Boolean));
  // Department-band palette per the redesign brief — used by the tier
  // distribution bar AND any future visualize-by=Department recolouring.
  const TIER_BAND_COLORS = {
    [TIER_1]: '#D4537E',
    [TIER_2]: '#378ADD',
    [TIER_3]: '#BA7517',
    [TIER_4]: '#639922',
  };

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

  // If an admin DENY override removed Org Chart access (either before mount
  // or live via permissions:updated socket), render the AccessDenied screen
  // instead of the chart. The server already 403s the underlying APIs, so
  // this is purely UX.
  if (orgChartViewDenied) {
    return <AccessDenied resourceLabel="the Org Chart" action="view" />;
  }

  if (loading) return <div className="p-8 bg-white min-h-full flex items-center justify-center"><div className="animate-pulse flex gap-6">{[1,2,3].map(i => <div key={i} className="w-32 h-24 bg-gray-100 rounded-lg" />)}</div></div>;

  return (
    <div className="bg-white min-h-full flex flex-col">
      <div className="flex-1 flex">
        {/* ═══ MAIN CONTENT ═══ */}
        <div className="flex-1 p-5 min-w-0">
          <div className="max-w-full mx-auto">
            {/* ─── Header (h1 + subtitle + view toggle + actions) ─── */}
            <div className="flex items-start justify-between mb-3 gap-3">
              <div className="min-w-0">
                <h1 className="text-lg font-bold text-gray-800 flex items-center gap-2"><GitBranch size={16} className="text-indigo-500" /> {t('orgChart.title')}</h1>
                <p className="text-[11px] text-gray-400 mt-0.5 ml-6">{t('orgChart.subtitle')}</p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <div className="flex bg-gray-100 rounded-lg p-0.5" role="tablist" aria-label="Org chart view">
                  <button onClick={() => setViewMode('tree')} className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${viewMode === 'tree' ? 'bg-white shadow-sm text-gray-800' : 'text-gray-500 hover:text-gray-700'}`}>{t('orgChart.views.tree')}</button>
                  <button onClick={() => setViewMode('levels')} className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${viewMode === 'levels' ? 'bg-white shadow-sm text-gray-800' : 'text-gray-500 hover:text-gray-700'}`}>{t('orgChart.views.list')}</button>
                  <button onClick={() => setViewMode('department')} className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${viewMode === 'department' ? 'bg-white shadow-sm text-gray-800' : 'text-gray-500 hover:text-gray-700'}`}>{t('orgChart.views.department')}</button>
                </div>
                {canManage && <button onClick={() => setShowManageHierarchy(true)} className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium text-indigo-600 bg-indigo-50 rounded-lg hover:bg-indigo-100 transition-colors"><Settings2 size={12} /> {t('orgChart.actions.manageLevels')}</button>}
                {canManage && (
                  editMode ? (
                    <button onClick={() => setEditMode(false)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold text-red-600 bg-red-50 rounded-lg hover:bg-red-100 transition-colors border border-red-200">
                      <X size={12} /> {t('orgChart.actions.exitEdit')}
                    </button>
                  ) : (
                    <button onClick={() => setEditMode(true)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold text-blue-600 bg-blue-50 rounded-lg hover:bg-blue-100 transition-colors border border-blue-200">
                      <Edit2 size={12} /> {t('orgChart.actions.editStructure')}
                    </button>
                  )
                )}
              </div>
            </div>

            {/* ─── ChartHop-style META STRIP + TIER DISTRIBUTION BAR ─── */}
            {/* Replaces the 5 oversized stat cards with one compact line-of-text
                + a slim 4-segment distribution bar. Far less vertical real
                estate so the chart canvas dominates the viewport. */}
            <div className="bg-white border border-gray-200 rounded-xl shadow-sm px-4 py-3 mb-3">
              <div className="flex items-center gap-1.5 text-[11.5px] text-gray-600 flex-wrap">
                <span className="font-semibold text-gray-800">{stats.total}</span> people
                <span className="text-gray-300 mx-1">·</span>
                <span className="font-semibold text-gray-800">0</span> open
                <span className="text-gray-300 mx-1">·</span>
                <span className="font-semibold text-gray-800">{activeTierCount}</span> tiers
                <span className="text-gray-300 mx-1">·</span>
                <span className="font-semibold text-gray-800">{distinctDepartments.size || 0}</span> {distinctDepartments.size === 1 ? 'department' : 'departments'}
                <span className="text-gray-300 mx-1">·</span>
                <span className="text-gray-400">updated just now</span>
              </div>
              {/* Tier distribution bar — proportional widths, brand colours */}
              {stats.total > 0 && (
                <div className="mt-2.5 flex h-1.5 rounded-full overflow-hidden bg-gray-100" role="img" aria-label={`Tier distribution: ${stats.tier1} Tier 1, ${stats.tier2} Tier 2, ${stats.tier3} Tier 3, ${stats.tier4} Tier 4`}>
                  {[
                    { tier: TIER_1, count: stats.tier1, color: TIER_BAND_COLORS[TIER_1], label: 'Tier 1' },
                    { tier: TIER_2, count: stats.tier2, color: TIER_BAND_COLORS[TIER_2], label: 'Tier 2' },
                    { tier: TIER_3, count: stats.tier3, color: TIER_BAND_COLORS[TIER_3], label: 'Tier 3' },
                    { tier: TIER_4, count: stats.tier4, color: TIER_BAND_COLORS[TIER_4], label: 'Tier 4' },
                  ].filter(s => s.count > 0).map(s => (
                    <div
                      key={s.tier}
                      title={`${s.label}: ${s.count} ${s.count === 1 ? 'person' : 'people'}`}
                      className="transition-all hover:brightness-110"
                      style={{ backgroundColor: s.color, flex: s.count }}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* ─── Controls row: visualize-by + filter chips + search ─── */}
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <div className="flex-1 flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-2.5 py-1.5 focus-within:border-blue-300 shadow-sm min-w-[200px]">
                <Search size={13} className="text-gray-400" />
                <input type="text" placeholder="Search name, department..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} className="bg-transparent border-none outline-none text-[12px] text-gray-700 w-full placeholder:text-gray-300" />
                {searchQuery && <button onClick={() => setSearchQuery('')} aria-label="Clear search"><X size={12} className="text-gray-300" /></button>}
              </div>
              {/* Department filter chips. "All" resets — others narrow allUsers
                  to a single department. Wired into `deptFilter` state below. */}
              <div className="flex items-center gap-1 flex-wrap">
                <button
                  onClick={() => setDeptFilter('')}
                  className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${deptFilter === '' ? 'bg-gray-800 text-white border-gray-800' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'}`}
                >All depts</button>
                {[...distinctDepartments].slice(0, 4).map(d => (
                  <button
                    key={d}
                    onClick={() => setDeptFilter(d === deptFilter ? '' : d)}
                    className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${deptFilter === d ? 'bg-gray-800 text-white border-gray-800' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'}`}
                  >{d}</button>
                ))}
              </div>
            </div>

            {/* Compact edit-mode hint inline with the search row, not a full
                banner — keeps the canvas tall enough to render the tree
                without clipping. */}
            {editMode && (
              <div className="inline-flex items-center gap-1.5 mb-2 px-2.5 py-1 bg-emerald-50 border border-emerald-200 rounded-full text-[11px] text-emerald-700 font-medium">
                <GripVertical size={11} className="text-emerald-500" />
                Drag near another node to reassign
              </div>
            )}
            {!editMode && (
              <p className="text-[10px] text-gray-400 mb-2">Click a card for details{canManage ? ' · Click "Edit Structure" to drag & reassign' : ''}</p>
            )}

            {/* ═══ TREE VIEW ═══ */}
            {viewMode === 'tree' && (
              <div className="relative bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden" style={{ height: 'calc(100vh - 290px)', minHeight: 460 }}>
                {/* Bottom-right pill — zoom controls + reset/fit */}
                <div className="absolute bottom-3 right-3 z-20 flex items-center gap-0.5 bg-white rounded-full border border-gray-200 shadow-sm px-1 py-0.5">
                  <button onClick={() => setZoom(z => Math.min(z + 0.1, 1.5))} className="p-1.5 hover:bg-gray-100 rounded-full text-gray-500" title="Zoom in"><ZoomIn size={13} /></button>
                  <span className="text-[10px] font-medium text-gray-500 w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
                  <button onClick={() => setZoom(z => Math.max(z - 0.1, 0.3))} className="p-1.5 hover:bg-gray-100 rounded-full text-gray-500" title="Zoom out"><ZoomOut size={13} /></button>
                  <div className="w-px h-4 bg-gray-200 mx-0.5" />
                  <button onClick={() => { setZoom(0.7); setPanOffset({ x: 0, y: 0 }); }} className="p-1.5 hover:bg-gray-100 rounded-full text-gray-500" title="Reset view"><RotateCcw size={12} /></button>
                  <button onClick={() => { setZoom(0.45); setPanOffset({ x: 0, y: 0 }); }} className="p-1.5 hover:bg-gray-100 rounded-full text-gray-500" title="Fit all"><Maximize2 size={12} /></button>
                </div>

                {/* Drop-to-root zone — compact pill at the top-centre of the
                    canvas when dragging. The previous full-width band ate too
                    much vertical space and pushed the tree below the fold. */}
                {canDrag && dragNode && (
                  <div
                    className={`absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium transition-all border border-dashed shadow-sm
                      ${dropRootHover ? 'bg-orange-100 border-orange-400 text-orange-700' : 'bg-white border-orange-300 text-orange-500'}`}
                    onDragOver={e => { e.preventDefault(); setDropRootHover(true); }}
                    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDropRootHover(false); }}
                    onDrop={e => { e.preventDefault(); setDropRootHover(false); onDropToRoot(); }}
                  >
                    <ArrowUp size={12} /> Drop to remove manager (make root)
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
                  <div style={{ transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`, transformOrigin: 'top center', padding: '48px 56px', display: 'flex', justifyContent: 'center', width: 'max-content', minWidth: '100%' }}>
                    {filteredChart.length === 0 ? (
                      <div className="text-center py-16">
                        <Users size={24} className="text-gray-200 mx-auto mb-2" />
                        <p className="text-sm text-gray-400 mb-2">{(searchQuery || deptFilter) ? 'No one matches that search.' : 'No hierarchy configured'}</p>
                        {(searchQuery || deptFilter) && (
                          <button onClick={() => { setSearchQuery(''); setDeptFilter(''); }} className="text-[11px] text-blue-500 hover:text-blue-600 font-medium">Clear search</button>
                        )}
                      </div>
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
                  .filter(level => filteredUsersByLevel[level.name]?.users?.length > 0)
                  .map((level, idx, arr) => {
                    const levelData = filteredUsersByLevel[level.name];
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
                              const hlColor = level.color || tierColorOf(u).color;
                              return (
                                <PersonCard
                                  key={u.id}
                                  node={u}
                                  hlColor={hlColor}
                                  hlLabel={level.label || tierLabel(resolveTier(u))}
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
                {hierarchyLevels.filter(l => filteredUsersByLevel[l.name]?.users?.length > 0).length === 0 && (
                  <div className="text-center py-16 bg-white rounded-xl border border-gray-100">
                    <Layers size={24} className="text-gray-200 mx-auto mb-2" />
                    <p className="text-sm text-gray-400 mb-2">{searchQuery || deptFilter ? 'No one matches that search.' : 'No hierarchy levels with users'}</p>
                    {(searchQuery || deptFilter) && (
                      <button onClick={() => { setSearchQuery(''); setDeptFilter(''); }} className="text-[11px] text-blue-500 hover:text-blue-600 font-medium">Clear search</button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ═══ DEPARTMENT VIEW ═══ */}
            {viewMode === 'department' && (
              <div className="space-y-3">
                {departmentView.length === 0 && (
                  <div className="text-center py-16 bg-white rounded-xl border border-gray-100">
                    <Building2 size={24} className="text-gray-200 mx-auto mb-2" />
                    <p className="text-sm text-gray-400 mb-2">No one matches that search.</p>
                    {(searchQuery || deptFilter) && (
                      <button onClick={() => { setSearchQuery(''); setDeptFilter(''); }} className="text-[11px] text-blue-500 hover:text-blue-600 font-medium">Clear search</button>
                    )}
                  </div>
                )}
                {departmentView.map(([dept, users]) => (
                  <div key={dept} className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
                    <div className="flex items-center gap-2.5 px-4 py-2.5 bg-gray-50 border-b border-gray-100">
                      <Building2 size={13} className="text-gray-400" />
                      <span className="text-[12px] font-semibold text-gray-700">{dept}</span>
                      <span className="text-[10px] text-gray-400 bg-gray-200 px-1.5 py-0.5 rounded-full">{users.length}</span>
                    </div>
                    <div className="p-3 flex flex-wrap gap-2">
                      {users.map(u => {
                        const hl = hierarchyLevels.find(l => l.name === u.hierarchyLevel);
                        const c = hl?.color || tierColorOf(u).color;
                        return (
                          <div key={u.id}
                            className={`flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer group transition-colors ${selectedEmployee?.id === u.id ? 'bg-blue-50 border border-blue-200' : 'bg-gray-50 hover:bg-gray-100 border border-transparent'}`}
                            style={{ minWidth: 160 }}
                            onClick={() => onCardClick(u)}>
                            <div className="w-7 h-7 rounded-full flex items-center justify-center text-[9px] font-bold text-white" style={{ backgroundColor: c }}>{u.name?.charAt(0)?.toUpperCase()}</div>
                            <div className="flex-1 min-w-0">
                              <p className="text-[11px] font-semibold text-gray-700 truncate">{u.name}</p>
                              <p className="text-[9px] text-gray-400 truncate">{u.designation || hl?.label || tierLabel(resolveTier(u))}</p>
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
              onAddSecondaryManager={n => { setShowAddManager(n); setAddManagerId(''); setAddManagerType('functional'); }}
              onRemoveRelation={handleRemoveRelation}
              onViewProfile={n => setShowViewProfile(n)}
            />
          )}
        </AnimatePresence>
      </div>

      {/* ═══ MODALS ═══ */}
      <AnimatePresence>
        {showEditEmployee && <EditEmployeeModal user={showEditEmployee} hierarchyLevels={hierarchyLevels} onClose={() => setShowEditEmployee(null)} onSaved={fetchData} toastError={toastError} />}
      </AnimatePresence>

      <AnimatePresence>
        {showPromote && canManage && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => setShowPromote(null)}>
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} className="bg-white rounded-xl p-5 w-full max-w-sm shadow-2xl" onClick={e => e.stopPropagation()}>
              <h3 className="text-sm font-bold text-gray-800 mb-4 flex items-center gap-2"><ArrowUp size={14} className="text-green-500" /> Promote {showPromote.name}</h3>
              <div className="space-y-3">
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase mb-1 block">Tier</label>
                  <select
                    value={(() => {
                      // Translate the staged legacy role string back to a tier
                      // value so the select renders the right option even if
                      // the parent set newRole as a legacy string.
                      const r = promoteForm.newRole;
                      if (r === 'admin') return TIER_2;
                      if (r === 'assistant_manager') return TIER_3;
                      if (r === 'member') return TIER_4;
                      // No newRole staged yet → fall back to the user's current tier.
                      return resolveTier(showPromote);
                    })()}
                    onChange={e => {
                      const t = Number(e.target.value);
                      // Translate tier → legacy role for the existing API.
                      // Tier 1 promotion via this dialog is intentionally
                      // disabled (use the Admin Settings tier dropdown).
                      const role =
                        t === TIER_2 ? 'admin' :
                        t === TIER_3 ? 'assistant_manager' :
                                       'member';
                      setPromoteForm({ ...promoteForm, newRole: role });
                    }}
                    className="w-full px-2.5 py-2 border border-gray-200 rounded-lg text-[12px] bg-white outline-none">
                    <option value={TIER_4}>{tierLabel(TIER_4)}</option>
                    <option value={TIER_3}>{tierLabel(TIER_3)}</option>
                    <option value={TIER_2}>{tierLabel(TIER_2)}</option>
                  </select>
                </div>
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
                {allUsers.filter(u => u.id !== showChangeManager.id).map(u => <option key={u.id} value={u.id}>{u.name} · {u.designation || tierLabel(resolveTier(u))}</option>)}
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

      {/* Add Secondary Manager Modal */}
      <AnimatePresence>
        {showAddManager && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => setShowAddManager(null)}>
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} className="bg-white rounded-xl p-5 w-full max-w-sm shadow-2xl" onClick={e => e.stopPropagation()}>
              <h3 className="text-sm font-bold text-gray-800 mb-3">Add Manager — {showAddManager.name}</h3>
              <p className="text-[10px] text-gray-400 mb-3">Add a secondary/dotted-line manager relationship. The primary manager (tree parent) is managed separately.</p>
              <div className="space-y-3">
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase mb-1 block">Manager</label>
                  <select value={addManagerId} onChange={e => setAddManagerId(e.target.value)} className="w-full px-2.5 py-2 border border-gray-200 rounded-lg text-[12px] bg-white outline-none">
                    <option value="">Select manager...</option>
                    {allUsers
                      .filter(u => u.id !== showAddManager.id && !(showAddManager.managerRelations || []).some(r => String(r.managerId) === String(u.id)))
                      .map(u => <option key={u.id} value={u.id}>{u.name} · {u.designation || tierLabel(resolveTier(u))}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-semibold text-gray-500 uppercase mb-1 block">Relation Type</label>
                  <select value={addManagerType} onChange={e => setAddManagerType(e.target.value)} className="w-full px-2.5 py-2 border border-gray-200 rounded-lg text-[12px] bg-white outline-none">
                    <option value="functional">Functional</option>
                    <option value="project">Project-based</option>
                    <option value="dotted_line">Dotted Line</option>
                  </select>
                </div>
                <div className="flex gap-2 pt-1">
                  <button onClick={handleAddSecondaryManager} disabled={!addManagerId} className="flex-1 py-2 bg-blue-500 text-white text-[12px] font-medium rounded-lg hover:bg-blue-600 disabled:opacity-50">Add Manager</button>
                  <button onClick={() => setShowAddManager(null)} className="px-4 py-2 text-[12px] text-gray-500">Cancel</button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
