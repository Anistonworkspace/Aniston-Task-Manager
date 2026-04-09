import React, { useState, useEffect } from 'react';
import {
  X, Settings, Palette, Columns3, Layers, Users, Trash2,
  Plus, GripVertical, Pencil, Check, AlertTriangle, Archive,
  ChevronRight, UserPlus, UserMinus, Circle
} from 'lucide-react';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { BOARD_COLORS, DEFAULT_STATUSES, STATUS_PRESET_COLORS, getBoardStatuses } from '../../utils/constants';
import Avatar from '../common/Avatar';

const TABS = [
  { id: 'general', label: 'General', icon: Settings },
  { id: 'statuses', label: 'Statuses', icon: Circle },
  { id: 'columns', label: 'Columns', icon: Columns3 },
  { id: 'groups', label: 'Groups', icon: Layers },
  { id: 'members', label: 'Members', icon: Users },
  { id: 'danger', label: 'Danger Zone', icon: AlertTriangle },
];

const COLUMN_TYPE_OPTIONS = [
  { value: 'status', label: 'Status' },
  { value: 'person', label: 'Person' },
  { value: 'date', label: 'Date' },
  { value: 'priority', label: 'Priority' },
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
];

const GROUP_COLORS = [
  '#579bfc', '#fdab3d', '#00c875', '#e2445c', '#a25ddc',
  '#ff642e', '#037f4c', '#cab641', '#66ccff', '#333333',
];

export default function BoardSettingsModal({ board, onClose, onUpdate, onDelete }) {
  const { isAdmin, user } = useAuth();
  const [activeTab, setActiveTab] = useState('general');
  const [saving, setSaving] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');

  // General
  const [name, setName] = useState(board.name || '');
  const [description, setDescription] = useState(board.description || '');
  const [color, setColor] = useState(board.color || '#0073ea');

  // Columns
  const [columns, setColumns] = useState(board.columns || []);
  const [editingColId, setEditingColId] = useState(null);
  const [editColTitle, setEditColTitle] = useState('');

  // Groups
  const [groups, setGroups] = useState(board.groups || []);
  const [editingGroupId, setEditingGroupId] = useState(null);
  const [editGroupTitle, setEditGroupTitle] = useState('');

  // Statuses
  const [statuses, setStatuses] = useState(() => getBoardStatuses(board));
  const [editingStatusKey, setEditingStatusKey] = useState(null);
  const [editStatusLabel, setEditStatusLabel] = useState('');
  const [newStatusLabel, setNewStatusLabel] = useState('');
  const [newStatusColor, setNewStatusColor] = useState('#3b82f6');
  const [showAddStatus, setShowAddStatus] = useState(false);

  // Members
  const [allUsers, setAllUsers] = useState([]);
  const [memberSearch, setMemberSearch] = useState('');
  const boardMembers = board.members || board.Users || [];

  // Danger
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [archivePassword, setArchivePassword] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [passwordError, setPasswordError] = useState('');

  useEffect(() => {
    loadUsers();
  }, []);

  async function loadUsers() {
    try {
      const res = await api.get('/users');
      const d = res.data?.data || res.data;
      setAllUsers(Array.isArray(d) ? d : d?.users || []);
    } catch {}
  }

  function showSuccess(msg) {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(''), 2000);
  }

  async function saveBoard(updates) {
    setSaving(true);
    try {
      const res = await api.put(`/boards/${board.id}`, updates);
      const updated = res.data.board || res.data.data?.board || res.data;
      onUpdate(updated);
      showSuccess('Saved');
    } catch (err) {
      console.error('Failed to save board:', err);
    } finally {
      setSaving(false);
    }
  }

  // ── General ──
  function handleSaveGeneral() {
    saveBoard({ name, description, color });
  }

  // ── Columns ──
  function handleAddColumn() {
    const id = `col_${Date.now()}`;
    const updated = [...columns, { id, title: 'New Column', type: 'text', width: 140 }];
    setColumns(updated);
    saveBoard({ columns: updated });
  }

  function handleRemoveColumn(colId) {
    const updated = columns.filter(c => c.id !== colId);
    setColumns(updated);
    saveBoard({ columns: updated });
  }

  function handleRenameColumn(colId) {
    if (!editColTitle.trim()) return;
    const updated = columns.map(c => c.id === colId ? { ...c, title: editColTitle.trim() } : c);
    setColumns(updated);
    setEditingColId(null);
    saveBoard({ columns: updated });
  }

  function handleColumnTypeChange(colId, type) {
    const updated = columns.map(c => c.id === colId ? { ...c, type } : c);
    setColumns(updated);
    saveBoard({ columns: updated });
  }

  // ── Groups ──
  function handleAddGroup() {
    const id = `grp_${Date.now()}`;
    const updated = [...groups, { id, title: 'New Group', color: GROUP_COLORS[groups.length % GROUP_COLORS.length], position: groups.length }];
    setGroups(updated);
    saveBoard({ groups: updated });
  }

  function handleRemoveGroup(groupId) {
    if (groups.length <= 1) return;
    const updated = groups.filter(g => g.id !== groupId).map((g, i) => ({ ...g, position: i }));
    setGroups(updated);
    saveBoard({ groups: updated });
  }

  function handleRenameGroup(groupId) {
    if (!editGroupTitle.trim()) return;
    const updated = groups.map(g => g.id === groupId ? { ...g, title: editGroupTitle.trim() } : g);
    setGroups(updated);
    setEditingGroupId(null);
    saveBoard({ groups: updated });
  }

  function handleGroupColorChange(groupId, newColor) {
    const updated = groups.map(g => g.id === groupId ? { ...g, color: newColor } : g);
    setGroups(updated);
    saveBoard({ groups: updated });
  }

  function handleMoveGroup(index, direction) {
    const newGroups = [...groups];
    const swapIdx = index + direction;
    if (swapIdx < 0 || swapIdx >= newGroups.length) return;
    [newGroups[index], newGroups[swapIdx]] = [newGroups[swapIdx], newGroups[index]];
    const updated = newGroups.map((g, i) => ({ ...g, position: i }));
    setGroups(updated);
    saveBoard({ groups: updated });
  }

  // ── Statuses ──
  function saveStatusesToBoard(updatedStatuses) {
    setStatuses(updatedStatuses);
    // Persist into the status column entry within the columns JSONB
    const updatedColumns = (columns || []).map(col =>
      col.type === 'status' ? { ...col, statuses: updatedStatuses } : col
    );
    setColumns(updatedColumns);
    saveBoard({ columns: updatedColumns });
  }

  function handleAddStatus() {
    if (!newStatusLabel.trim()) return;
    const key = newStatusLabel.trim().toLowerCase().replace(/\s+/g, '_');
    if (statuses.some(s => s.key === key)) return; // prevent duplicates
    const updated = [...statuses, { key, label: newStatusLabel.trim(), color: newStatusColor }];
    saveStatusesToBoard(updated);
    setNewStatusLabel('');
    setNewStatusColor('#3b82f6');
    setShowAddStatus(false);
  }

  function handleRemoveStatus(key) {
    if (statuses.length <= 1) return; // must keep at least one
    const updated = statuses.filter(s => s.key !== key);
    saveStatusesToBoard(updated);
  }

  function handleRenameStatus(key) {
    if (!editStatusLabel.trim()) return;
    // Only update the display label — keep the key stable to preserve existing task data
    const updated = statuses.map(s =>
      s.key === key ? { ...s, label: editStatusLabel.trim() } : s
    );
    saveStatusesToBoard(updated);
    setEditingStatusKey(null);
  }

  function handleStatusColorChange(key, color) {
    const updated = statuses.map(s => s.key === key ? { ...s, color } : s);
    saveStatusesToBoard(updated);
  }

  function handleMoveStatus(index, direction) {
    const newStatuses = [...statuses];
    const swapIdx = index + direction;
    if (swapIdx < 0 || swapIdx >= newStatuses.length) return;
    [newStatuses[index], newStatuses[swapIdx]] = [newStatuses[swapIdx], newStatuses[index]];
    saveStatusesToBoard(newStatuses);
  }

  function handleResetStatuses() {
    saveStatusesToBoard([...DEFAULT_STATUSES]);
  }

  // ── Members ──
  async function handleAddMember(userId) {
    try {
      const res = await api.post(`/boards/${board.id}/members`, { userId });
      const updated = res.data.board || res.data.data?.board;
      if (updated) onUpdate(updated);
      showSuccess('Member added');
    } catch (err) {
      console.error('Failed to add member:', err);
    }
  }

  async function handleRemoveMember(userId) {
    try {
      const res = await api.delete(`/boards/${board.id}/members/${userId}`);
      const updated = res.data.board || res.data.data?.board;
      if (updated) onUpdate(updated);
      showSuccess('Member removed');
    } catch (err) {
      console.error('Failed to remove member:', err);
    }
  }

  // ── Danger ──
  async function handleArchive() {
    if (!archivePassword) { setPasswordError('Password required'); return; }
    setPasswordError('');
    try {
      // Verify password first
      await api.post('/auth/login', { email: user.email, password: archivePassword });
      await saveBoard({ isArchived: !board.isArchived });
      showSuccess(board.isArchived ? 'Board restored' : 'Board archived');
      setArchivePassword('');
    } catch (err) {
      setPasswordError('Incorrect password');
      return;
    }
  }

  async function handleDelete() {
    if (deleteConfirm !== board.name) return;
    if (!deletePassword) { setPasswordError('Password required to delete'); return; }
    setPasswordError('');
    try {
      // Verify password first
      await api.post('/auth/login', { email: user.email, password: deletePassword });
      await api.delete(`/boards/${board.id}`);
      onDelete(board.id);
      onClose();
    } catch (err) {
      if (err.response?.status === 401) { setPasswordError('Incorrect password'); return; }
      console.error('Failed to delete board:', err);
    }
  }

  const memberIds = boardMembers.map(m => m.id);
  const nonMembers = allUsers
    .filter(u => !memberIds.includes(u.id) && u.isActive !== false)
    .filter(u => !memberSearch || u.name.toLowerCase().includes(memberSearch.toLowerCase()));

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 animate-fade-in" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-[720px] max-h-[85vh] flex overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Sidebar */}
        <div className="w-[180px] bg-surface/60 border-r border-border flex flex-col py-4 flex-shrink-0">
          <h2 className="text-sm font-bold text-text-primary px-4 mb-3 flex items-center gap-2">
            <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: board.color || '#0073ea' }} />
            Settings
          </h2>
          {TABS.map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2.5 px-4 py-2 text-sm transition-colors ${
                  activeTab === tab.id
                    ? 'bg-primary/10 text-primary font-medium border-r-2 border-primary'
                    : tab.id === 'danger'
                    ? 'text-danger/70 hover:bg-danger/5 hover:text-danger'
                    : 'text-text-secondary hover:bg-surface hover:text-text-primary'
                }`}
              >
                <Icon size={15} /> {tab.label}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
            <h3 className="text-base font-bold text-text-primary">
              {TABS.find(t => t.id === activeTab)?.label}
            </h3>
            <div className="flex items-center gap-2">
              {successMsg && (
                <span className="text-xs text-success font-medium flex items-center gap-1 animate-fade-in">
                  <Check size={13} /> {successMsg}
                </span>
              )}
              <button onClick={onClose} className="p-1.5 rounded-md hover:bg-surface text-text-secondary">
                <X size={18} />
              </button>
            </div>
          </div>

          {/* Tab Content */}
          <div className="flex-1 overflow-y-auto p-5">
            {/* ── GENERAL ── */}
            {activeTab === 'general' && (
              <div className="space-y-5">
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1.5">Board Name</label>
                  <input
                    value={name}
                    onChange={e => setName(e.target.value)}
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:border-primary"
                    placeholder="Enter board name"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1.5">Description</label>
                  <textarea
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    rows={3}
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:border-primary resize-none"
                    placeholder="Add a description..."
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-2">Board Color</label>
                  <div className="flex flex-wrap gap-2">
                    {BOARD_COLORS.map(c => (
                      <button
                        key={c}
                        onClick={() => setColor(c)}
                        className={`w-8 h-8 rounded-lg transition-all ${color === c ? 'ring-2 ring-offset-2 ring-primary scale-110' : 'hover:scale-105'}`}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                </div>
                <div className="pt-2">
                  <button
                    onClick={handleSaveGeneral}
                    disabled={saving || !name.trim()}
                    className="px-5 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-dark transition-colors disabled:opacity-40"
                  >
                    {saving ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </div>
            )}

            {/* ── STATUSES ── */}
            {activeTab === 'statuses' && (
              <div className="space-y-3">
                <p className="text-xs text-text-tertiary mb-3">
                  Configure which status options are available for tasks on this board. Members will only see these options.
                </p>
                {statuses.map((s, i) => (
                  <div key={s.key} className="flex items-center gap-2 p-2.5 rounded-lg border border-border/60 bg-surface/20 group">
                    <div className="flex flex-col gap-0.5">
                      <button onClick={() => handleMoveStatus(i, -1)} disabled={i === 0}
                        className="text-text-tertiary hover:text-text-primary disabled:opacity-20 p-0.5">
                        <ChevronRight size={12} className="-rotate-90" />
                      </button>
                      <button onClick={() => handleMoveStatus(i, 1)} disabled={i === statuses.length - 1}
                        className="text-text-tertiary hover:text-text-primary disabled:opacity-20 p-0.5">
                        <ChevronRight size={12} className="rotate-90" />
                      </button>
                    </div>
                    <div className="w-5 h-5 rounded-full flex-shrink-0 relative" style={{ backgroundColor: s.color }}>
                    </div>
                    {editingStatusKey === s.key ? (
                      <div className="flex items-center gap-2 flex-1">
                        <input
                          value={editStatusLabel}
                          onChange={e => setEditStatusLabel(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && handleRenameStatus(s.key)}
                          className="flex-1 px-2 py-1 border border-primary rounded text-sm focus:outline-none"
                          autoFocus
                        />
                        <button onClick={() => handleRenameStatus(s.key)} className="p-1 text-success hover:bg-success/10 rounded">
                          <Check size={14} />
                        </button>
                        <button onClick={() => setEditingStatusKey(null)} className="p-1 text-text-tertiary hover:bg-surface rounded">
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <>
                        <span className="text-sm font-medium text-text-primary flex-1">{s.label}</span>
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          {STATUS_PRESET_COLORS.slice(0, 8).map(c => (
                            <button
                              key={c}
                              onClick={() => handleStatusColorChange(s.key, c)}
                              className={`w-3.5 h-3.5 rounded-full transition-all ${s.color === c ? 'ring-1 ring-offset-1 ring-primary' : 'hover:scale-110'}`}
                              style={{ backgroundColor: c }}
                            />
                          ))}
                        </div>
                        <button
                          onClick={() => { setEditingStatusKey(s.key); setEditStatusLabel(s.label); }}
                          className="p-1 text-text-tertiary hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity rounded"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={() => handleRemoveStatus(s.key)}
                          disabled={statuses.length <= 1}
                          className="p-1 text-text-tertiary hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity rounded disabled:opacity-20"
                        >
                          <Trash2 size={13} />
                        </button>
                      </>
                    )}
                  </div>
                ))}

                {/* Add New Status */}
                {showAddStatus ? (
                  <div className="p-3 rounded-lg border border-primary/30 bg-primary/5 space-y-2">
                    <input
                      type="text"
                      value={newStatusLabel}
                      onChange={e => setNewStatusLabel(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleAddStatus()}
                      placeholder="Status label (e.g. QA Testing)"
                      className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:border-primary"
                      autoFocus
                    />
                    <div className="flex flex-wrap gap-1.5">
                      {STATUS_PRESET_COLORS.map(c => (
                        <button
                          key={c}
                          onClick={() => setNewStatusColor(c)}
                          className={`w-5 h-5 rounded-full transition-all ${newStatusColor === c ? 'ring-2 ring-offset-1 ring-primary scale-110' : 'hover:scale-105'}`}
                          style={{ backgroundColor: c }}
                        />
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <button onClick={handleAddStatus} disabled={!newStatusLabel.trim()}
                        className="px-4 py-1.5 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary-dark transition-colors disabled:opacity-40">
                        Add Status
                      </button>
                      <button onClick={() => { setShowAddStatus(false); setNewStatusLabel(''); }}
                        className="px-3 py-1.5 text-sm text-text-tertiary hover:text-text-secondary">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowAddStatus(true)}
                    className="flex items-center gap-2 text-sm text-primary hover:bg-primary/5 px-3 py-2 rounded-lg transition-colors w-full"
                  >
                    <Plus size={15} /> Add Status
                  </button>
                )}

                {/* Reset to Defaults */}
                <div className="pt-2 border-t border-border">
                  <button
                    onClick={handleResetStatuses}
                    className="text-xs text-text-tertiary hover:text-text-secondary transition-colors"
                  >
                    Reset to default statuses
                  </button>
                </div>
              </div>
            )}

            {/* ── COLUMNS ── */}
            {activeTab === 'columns' && (
              <div className="space-y-3">
                <p className="text-xs text-text-tertiary mb-3">Configure which columns appear on your board.</p>
                {columns.map((col, i) => (
                  <div key={col.id} className="flex items-center gap-2 p-2.5 rounded-lg border border-border/60 bg-surface/20 group">
                    <GripVertical size={14} className="text-text-tertiary flex-shrink-0" />
                    {editingColId === col.id ? (
                      <div className="flex items-center gap-2 flex-1">
                        <input
                          value={editColTitle}
                          onChange={e => setEditColTitle(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && handleRenameColumn(col.id)}
                          className="flex-1 px-2 py-1 border border-primary rounded text-sm focus:outline-none"
                          autoFocus
                        />
                        <button onClick={() => handleRenameColumn(col.id)} className="p-1 text-success hover:bg-success/10 rounded">
                          <Check size={14} />
                        </button>
                        <button onClick={() => setEditingColId(null)} className="p-1 text-text-tertiary hover:bg-surface rounded">
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <>
                        <span className="text-sm font-medium text-text-primary flex-1">{col.title}</span>
                        <select
                          value={col.type}
                          onChange={e => handleColumnTypeChange(col.id, e.target.value)}
                          className="text-xs border border-border rounded px-2 py-1 bg-white text-text-secondary focus:outline-none"
                        >
                          {COLUMN_TYPE_OPTIONS.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                        <button
                          onClick={() => { setEditingColId(col.id); setEditColTitle(col.title); }}
                          className="p-1 text-text-tertiary hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity rounded"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={() => handleRemoveColumn(col.id)}
                          className="p-1 text-text-tertiary hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity rounded"
                        >
                          <Trash2 size={13} />
                        </button>
                      </>
                    )}
                  </div>
                ))}
                <button
                  onClick={handleAddColumn}
                  className="flex items-center gap-2 text-sm text-primary hover:bg-primary/5 px-3 py-2 rounded-lg transition-colors w-full"
                >
                  <Plus size={15} /> Add Column
                </button>
              </div>
            )}

            {/* ── GROUPS ── */}
            {activeTab === 'groups' && (
              <div className="space-y-3">
                <p className="text-xs text-text-tertiary mb-3">Manage task groups (swim lanes) for this board.</p>
                {groups.map((group, i) => (
                  <div key={group.id} className="flex items-center gap-2 p-2.5 rounded-lg border border-border/60 bg-surface/20 group">
                    <div className="flex flex-col gap-0.5">
                      <button onClick={() => handleMoveGroup(i, -1)} disabled={i === 0}
                        className="text-text-tertiary hover:text-text-primary disabled:opacity-20 p-0.5">
                        <ChevronRight size={12} className="-rotate-90" />
                      </button>
                      <button onClick={() => handleMoveGroup(i, 1)} disabled={i === groups.length - 1}
                        className="text-text-tertiary hover:text-text-primary disabled:opacity-20 p-0.5">
                        <ChevronRight size={12} className="rotate-90" />
                      </button>
                    </div>
                    <div className="w-4 h-4 rounded-sm flex-shrink-0 cursor-pointer relative" style={{ backgroundColor: group.color }}>
                    </div>
                    {editingGroupId === group.id ? (
                      <div className="flex items-center gap-2 flex-1">
                        <input
                          value={editGroupTitle}
                          onChange={e => setEditGroupTitle(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && handleRenameGroup(group.id)}
                          className="flex-1 px-2 py-1 border border-primary rounded text-sm focus:outline-none"
                          autoFocus
                        />
                        <button onClick={() => handleRenameGroup(group.id)} className="p-1 text-success hover:bg-success/10 rounded">
                          <Check size={14} />
                        </button>
                        <button onClick={() => setEditingGroupId(null)} className="p-1 text-text-tertiary hover:bg-surface rounded">
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <>
                        <span className="text-sm font-medium text-text-primary flex-1">{group.title}</span>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          {GROUP_COLORS.map(c => (
                            <button
                              key={c}
                              onClick={() => handleGroupColorChange(group.id, c)}
                              className={`w-4 h-4 rounded-sm transition-all ${group.color === c ? 'ring-1 ring-offset-1 ring-primary' : 'hover:scale-110'}`}
                              style={{ backgroundColor: c }}
                            />
                          ))}
                        </div>
                        <button
                          onClick={() => { setEditingGroupId(group.id); setEditGroupTitle(group.title); }}
                          className="p-1 text-text-tertiary hover:text-primary rounded"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={() => handleRemoveGroup(group.id)}
                          disabled={groups.length <= 1}
                          className="p-1 text-text-tertiary hover:text-danger rounded disabled:opacity-20"
                        >
                          <Trash2 size={13} />
                        </button>
                      </>
                    )}
                  </div>
                ))}
                <button
                  onClick={handleAddGroup}
                  className="flex items-center gap-2 text-sm text-primary hover:bg-primary/5 px-3 py-2 rounded-lg transition-colors w-full"
                >
                  <Plus size={15} /> Add Group
                </button>
              </div>
            )}

            {/* ── MEMBERS ── */}
            {activeTab === 'members' && (
              <div className="space-y-4">
                {/* Current Members */}
                <div>
                  <h4 className="text-sm font-medium text-text-primary mb-2">
                    Board Members ({boardMembers.length})
                  </h4>
                  <div className="space-y-1.5">
                    {boardMembers.map(member => (
                      <div key={member.id} className="flex items-center gap-3 p-2.5 rounded-lg border border-border/40 hover:bg-surface/30 group">
                        <Avatar name={member.name} size="sm" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-text-primary truncate">{member.name}</p>
                          <p className="text-xs text-text-tertiary truncate">{member.email}</p>
                        </div>
                        {member.id === board.createdBy ? (
                          <span className="text-[10px] font-semibold text-primary bg-primary/10 px-2 py-0.5 rounded-full">Owner</span>
                        ) : (
                          <button
                            onClick={() => handleRemoveMember(member.id)}
                            className="flex items-center gap-1 text-xs text-danger/60 hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity px-2 py-1 rounded hover:bg-danger/5"
                          >
                            <UserMinus size={13} /> Remove
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Add Members */}
                <div className="border-t border-border pt-4">
                  <h4 className="text-sm font-medium text-text-primary mb-2 flex items-center gap-2">
                    <UserPlus size={15} /> Add Members
                  </h4>
                  <input
                    value={memberSearch}
                    onChange={e => setMemberSearch(e.target.value)}
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:border-primary mb-2"
                    placeholder="Search users..."
                  />
                  <div className="max-h-[200px] overflow-y-auto space-y-1">
                    {nonMembers.length === 0 ? (
                      <p className="text-xs text-text-tertiary text-center py-3">
                        {memberSearch ? 'No matching users found' : 'All users are already members'}
                      </p>
                    ) : (
                      nonMembers.map(u => (
                        <div key={u.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-surface/50 cursor-pointer group" onClick={() => handleAddMember(u.id)}>
                          <Avatar name={u.name} size="sm" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-text-primary truncate">{u.name}</p>
                            <p className="text-xs text-text-tertiary truncate">{u.email}</p>
                          </div>
                          <span className="text-xs text-primary opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
                            <Plus size={13} /> Add
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ── DANGER ZONE ── */}
            {activeTab === 'danger' && (
              <div className="space-y-5">
                {/* Archive */}
                <div className="p-4 rounded-lg border border-warning/30 bg-warning/5">
                  <div className="flex items-start gap-3">
                    <Archive size={18} className="text-warning flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <h4 className="text-sm font-semibold text-text-primary">
                        {board.isArchived ? 'Restore Board' : 'Archive Board'}
                      </h4>
                      <p className="text-xs text-text-secondary mt-1">
                        {board.isArchived
                          ? 'This board is currently archived. Restoring it will make it visible again.'
                          : 'Archiving hides the board from the sidebar. You can restore it later.'}
                      </p>
                      <div className="mt-3 space-y-2">
                        <input
                          type="password"
                          value={archivePassword}
                          onChange={e => { setArchivePassword(e.target.value); setPasswordError(''); }}
                          placeholder="Enter your password to confirm"
                          className="w-full px-3 py-1.5 border border-warning/30 rounded-lg text-sm focus:outline-none focus:border-warning"
                        />
                        {passwordError && <p className="text-xs text-danger">{passwordError}</p>}
                        <button
                          onClick={handleArchive}
                          disabled={!archivePassword}
                          className="px-4 py-1.5 text-sm font-medium rounded-lg border border-warning text-warning hover:bg-warning hover:text-white transition-colors disabled:opacity-30"
                        >
                          {board.isArchived ? 'Restore Board' : 'Archive Board'}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Archive Workspace */}
                {board.workspaceId && (
                  <div className="p-4 rounded-lg border border-purple-200 bg-purple-50/50">
                    <div className="flex items-start gap-3">
                      <Archive size={18} className="text-purple-500 flex-shrink-0 mt-0.5" />
                      <div className="flex-1">
                        <h4 className="text-sm font-semibold text-text-primary">Archive Workspace</h4>
                        <p className="text-xs text-text-secondary mt-1">
                          Archive the entire workspace including all boards and tasks. You can restore it from the Archive page.
                        </p>
                        <div className="mt-3 space-y-2">
                          <input
                            type="password"
                            value={archivePassword}
                            onChange={e => { setArchivePassword(e.target.value); setPasswordError(''); }}
                            placeholder="Enter your password to confirm"
                            className="w-full px-3 py-1.5 border border-purple-200 rounded-lg text-sm focus:outline-none focus:border-purple-400"
                          />
                          {passwordError && <p className="text-xs text-danger">{passwordError}</p>}
                          <button
                            onClick={async () => {
                              if (!archivePassword) { setPasswordError('Password required'); return; }
                              try {
                                await api.post('/auth/login', { email: user.email, password: archivePassword });
                                await api.put(`/workspaces/${board.workspaceId}`, { isActive: false });
                                showSuccess('Workspace archived');
                                setArchivePassword('');
                                onClose();
                              } catch (err) {
                                setPasswordError(err.response?.status === 401 ? 'Incorrect password' : 'Failed to archive');
                              }
                            }}
                            disabled={!archivePassword}
                            className="px-4 py-1.5 text-sm font-medium rounded-lg border border-purple-400 text-purple-600 hover:bg-purple-500 hover:text-white transition-colors disabled:opacity-30"
                          >
                            Archive Entire Workspace
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Delete */}
                <div className="p-4 rounded-lg border border-danger/30 bg-danger/5">
                  <div className="flex items-start gap-3">
                    <Trash2 size={18} className="text-danger flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <h4 className="text-sm font-semibold text-text-primary">Delete Board</h4>
                      <p className="text-xs text-text-secondary mt-1">
                        This will permanently delete the board and all its tasks. This action cannot be undone.
                      </p>
                      <div className="mt-3">
                        <p className="text-xs text-text-secondary mb-1.5">
                          Type <strong className="text-text-primary">{board.name}</strong> to confirm:
                        </p>
                        <input
                          value={deleteConfirm}
                          onChange={e => setDeleteConfirm(e.target.value)}
                          className="w-full px-3 py-1.5 border border-danger/30 rounded-lg text-sm focus:outline-none focus:border-danger"
                          placeholder={board.name}
                        />
                        <input
                          type="password"
                          value={deletePassword}
                          onChange={e => { setDeletePassword(e.target.value); setPasswordError(''); }}
                          placeholder="Enter your password"
                          className="w-full px-3 py-1.5 border border-danger/30 rounded-lg text-sm focus:outline-none focus:border-danger mt-2"
                        />
                        {passwordError && <p className="text-xs text-danger mt-1">{passwordError}</p>}
                        <button
                          onClick={handleDelete}
                          disabled={deleteConfirm !== board.name || !deletePassword}
                          className="mt-2 px-4 py-1.5 text-sm font-medium rounded-lg bg-danger text-white hover:bg-red-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          Delete Board Permanently
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
