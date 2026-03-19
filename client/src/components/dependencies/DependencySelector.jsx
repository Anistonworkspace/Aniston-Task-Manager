import React, { useState, useEffect } from 'react';
import { X, Search, Plus, Link2, AlertCircle, Check, Users } from 'lucide-react';
import api from '../../services/api';
import Avatar from '../common/Avatar';

const DEP_TYPES = [
  { value: 'blocks', label: 'Blocks (hard)', desc: 'Task cannot start until this person completes their work' },
  { value: 'required_for', label: 'Required for (soft)', desc: 'Recommended but not enforced' },
  { value: 'related', label: 'Related (info)', desc: 'Informational link only' },
];

export default function DependencySelector({ taskId, taskTitle, boardId, onClose, onCreated }) {
  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState('');
  const [depType, setDepType] = useState('blocks');
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    api.get('/auth/users').then(res => {
      const all = res.data.users || res.data || [];
      setUsers(all);
    }).catch(() => {});
  }, []);

  async function handleAdd() {
    if (!selectedUserId) { setError('Select an employee to assign.'); return; }
    if (!title.trim()) { setError('Enter a task title for the dependency.'); return; }
    setSaving(true);
    setError('');
    try {
      await api.post(`/tasks/${taskId}/dependencies/assign`, {
        assignToUserId: selectedUserId,
        title: title.trim(),
        description: description || null,
        dependencyType: depType,
      });
      setSuccess('Dependency assigned!');
      setTimeout(() => { if (onCreated) onCreated(); onClose(); }, 800);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to assign dependency.');
    } finally { setSaving(false); }
  }

  const filtered = search
    ? users.filter(u => u.name?.toLowerCase().includes(search.toLowerCase()) || u.email?.toLowerCase().includes(search.toLowerCase()))
    : users;

  const selectedUser = users.find(u => u.id === selectedUserId);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60] p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-modal w-full max-w-md max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <div>
            <h2 className="text-base font-semibold text-text-primary flex items-center gap-2">
              <Link2 size={16} className="text-primary" /> Add Dependency
            </h2>
            <p className="text-xs text-text-tertiary mt-0.5">Assign a dependency task to a team member</p>
          </div>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-surface text-text-secondary"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {error && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-danger/10 text-danger text-sm">
              <AlertCircle size={14} /> {error}
            </div>
          )}
          {success && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-success/10 text-success text-sm">
              <Check size={14} /> {success}
            </div>
          )}

          {/* Your Task (read-only) */}
          {taskTitle && (
            <div className="px-3 py-2.5 rounded-lg bg-surface/50 border border-border">
              <p className="text-[10px] font-medium text-text-tertiary uppercase tracking-wide mb-1">Your Task</p>
              <p className="text-sm font-semibold text-text-primary">{taskTitle}</p>
            </div>
          )}

          {/* Dependency Type */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Dependency Type</label>
            <div className="space-y-1.5">
              {DEP_TYPES.map(dt => (
                <label key={dt.value} className={`flex items-start gap-2.5 px-3 py-2 rounded-lg border cursor-pointer transition-all ${depType === dt.value ? 'border-primary/50 bg-primary/5' : 'border-border hover:bg-surface/50'}`}>
                  <input type="radio" name="depType" value={dt.value} checked={depType === dt.value}
                    onChange={() => setDepType(dt.value)} className="mt-0.5 text-primary focus:ring-primary/20" />
                  <div>
                    <p className="text-sm font-medium text-text-primary">{dt.label}</p>
                    <p className="text-[10px] text-text-tertiary">{dt.desc}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Employee Selector */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              <Users size={11} className="inline mr-1" />
              Assign To Employee *
            </label>
            {selectedUser ? (
              <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-primary/50 bg-primary/5">
                <Avatar name={selectedUser.name} size="xs" />
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-text-primary">{selectedUser.name}</span>
                  <span className="text-[10px] text-text-tertiary ml-2">{selectedUser.role}</span>
                </div>
                <button onClick={() => { setSelectedUserId(null); setSearch(''); }}
                  className="p-0.5 rounded hover:bg-surface text-text-tertiary"><X size={14} /></button>
              </div>
            ) : (
              <div className="border border-border rounded-lg overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface/30">
                  <Search size={13} className="text-text-tertiary" />
                  <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                    className="bg-transparent border-none outline-none text-xs w-full placeholder:text-text-tertiary" placeholder="Search employees..." />
                </div>
                <div className="max-h-[180px] overflow-y-auto">
                  {filtered.length === 0 ? (
                    <p className="text-xs text-text-tertiary text-center py-4">No employees found</p>
                  ) : filtered.map(u => (
                    <button key={u.id} onClick={() => { setSelectedUserId(u.id); setSearch(''); }}
                      className="flex items-center gap-2.5 w-full px-3 py-2 text-left hover:bg-surface transition-colors">
                      <Avatar name={u.name} size="xs" />
                      <div className="flex-1 min-w-0">
                        <span className="text-xs font-medium text-text-primary">{u.name}</span>
                        <span className="text-[10px] text-text-tertiary ml-1.5 capitalize">({u.role})</span>
                      </div>
                      {u.department && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-surface text-text-tertiary">{u.department}</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Task Title */}
          {selectedUserId && (
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">What do you need from them? *</label>
              <input type="text" value={title} onChange={e => setTitle(e.target.value)}
                placeholder="e.g., Complete design mockups, Review API specs..."
                className="w-full px-3 py-2 rounded-lg border border-border text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary" />
            </div>
          )}

          {/* Description */}
          {selectedUserId && (
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">Description (optional)</label>
              <textarea value={description} onChange={e => setDescription(e.target.value)}
                placeholder="Add more details about what you need..."
                rows={2} className="w-full px-3 py-2 rounded-lg border border-border text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none" />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-border flex-shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-text-secondary hover:bg-surface rounded-lg transition-colors">Cancel</button>
          <button onClick={handleAdd} disabled={saving || !selectedUserId || !title.trim() || !!success}
            className="flex items-center gap-2 px-5 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-hover disabled:opacity-50 transition-colors shadow-sm">
            {saving ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Plus size={15} />}
            Add Dependency
          </button>
        </div>
      </div>
    </div>
  );
}
