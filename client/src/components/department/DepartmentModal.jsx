import React, { useState, useEffect } from 'react';
import { X, Check, AlertCircle } from 'lucide-react';
import api from '../../services/api';
import Avatar from '../common/Avatar';

const DEPT_COLORS = ['#0073ea', '#00c875', '#fdab3d', '#e2445c', '#a25ddc', '#579bfc', '#ff642e', '#037f4c', '#9cd326', '#cab641', '#ff158a', '#66ccff'];

export default function DepartmentModal({ department, onClose, onSave }) {
  const [name, setName] = useState(department?.name || '');
  const [description, setDescription] = useState(department?.description || '');
  const [color, setColor] = useState(department?.color || '#0073ea');
  const [head, setHead] = useState(department?.head || null);
  const [users, setUsers] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    loadUsers();
  }, []);

  async function loadUsers() {
    try {
      const res = await api.get('/auth/users');
      setUsers(res.data.users || res.data || []);
    } catch {}
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim()) { setError('Department name is required.'); return; }
    setSaving(true);
    setError('');
    try {
      let res;
      if (department?.id) {
        res = await api.put(`/departments/${department.id}`, { name: name.trim(), description, color, head });
      } else {
        res = await api.post('/departments', { name: name.trim(), description, color, head });
      }
      const saved = res.data?.department || res.data?.data?.department || res.data;
      if (onSave) onSave(saved);
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to save department.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-modal w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-text-primary">{department?.id ? 'Edit Department' : 'Create Department'}</h2>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-surface text-text-secondary"><X size={18} /></button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {error && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-danger/10 text-danger text-sm">
              <AlertCircle size={14} /> {error}
            </div>
          )}

          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Name *</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
              placeholder="e.g., Engineering" autoFocus />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Description</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2}
              className="w-full px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none"
              placeholder="What does this department do?" />
          </div>

          {/* Color */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Color</label>
            <div className="flex flex-wrap gap-2">
              {DEPT_COLORS.map(c => (
                <button key={c} type="button" onClick={() => setColor(c)}
                  className={`w-7 h-7 rounded-full transition-all ${color === c ? 'ring-2 ring-offset-2 ring-primary scale-110' : 'hover:scale-110'}`}
                  style={{ backgroundColor: c }} />
              ))}
            </div>
          </div>

          {/* Department Head */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Department Head</label>
            <select value={head || ''} onChange={e => setHead(e.target.value || null)}
              className="w-full px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary bg-white">
              <option value="">No head assigned</option>
              {users.filter(u => u.role !== 'member').map(u => (
                <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
              ))}
            </select>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-text-secondary hover:bg-surface rounded-lg transition-colors">Cancel</button>
            <button type="submit" disabled={saving}
              className="flex items-center gap-2 px-5 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-hover disabled:opacity-50 transition-colors">
              {saving ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Check size={15} />}
              {department?.id ? 'Save Changes' : 'Create Department'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
