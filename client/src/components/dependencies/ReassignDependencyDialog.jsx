import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X, Search, UserCheck } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../common/Toast';
import Avatar from '../common/Avatar';

/**
 * Reassign dialog for a DependencyRequest.
 *
 * Props:
 *   - dep
 *   - onClose
 *   - onSubmitted — called with no args after a successful reassignment
 */
export default function ReassignDependencyDialog({ dep, onClose, onSubmitted }) {
  const toast = useToast();
  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState('');
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/auth/users').then(res => {
      const all = res.data.users || res.data || [];
      // Hide the current assignee — picking them is a no-op.
      setUsers(all.filter(u => u.id !== dep.assignedToUserId));
    }).catch(() => {});
  }, [dep.assignedToUserId]);

  const filtered = useMemo(() => {
    if (!search) return users;
    const q = search.toLowerCase();
    return users.filter(u =>
      u.name?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q)
    );
  }, [users, search]);

  async function submit() {
    if (!selectedUserId) return;
    setSaving(true);
    try {
      await api.patch(`/dependencies/${dep.id}`, { assignedToUserId: selectedUserId });
      const newUser = users.find(u => u.id === selectedUserId);
      toast.success(`Reassigned to ${newUser?.name || 'teammate'}.`);
      onSubmitted?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to reassign.');
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-5"
        onClick={e => e.stopPropagation()}
        onMouseDown={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-base font-semibold text-gray-800 flex items-center gap-2">
            <UserCheck size={16} className="text-blue-500" /> Reassign dependency
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-3">
          Pick a different teammate to take this work. The new assignee will get a notification; the previous assignee will see the row disappear from their queue.
        </p>
        <p className="text-sm font-medium text-gray-700 mb-3">"{dep.title}"</p>

        <div className="border border-gray-200 rounded-lg overflow-hidden mb-2">
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-100 bg-gray-50">
            <Search size={13} className="text-gray-400" />
            <input type="text" value={search} onChange={e => setSearch(e.target.value)}
              className="bg-transparent border-none outline-none text-xs w-full"
              placeholder="Search teammates..." autoFocus />
          </div>
          <div className="max-h-[220px] overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-6">No teammates found.</p>
            ) : filtered.map(u => (
              <button key={u.id}
                onClick={() => setSelectedUserId(u.id)}
                className={`flex items-center gap-2.5 w-full px-3 py-2 text-left hover:bg-gray-50 transition-colors ${
                  selectedUserId === u.id ? 'bg-blue-50' : ''
                }`}>
                <Avatar name={u.name} size="xs" />
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium text-gray-700">{u.name}</span>
                  <span className="text-[10px] text-gray-400 ml-1.5 capitalize">({u.role})</span>
                </div>
                {selectedUserId === u.id && (
                  <span className="text-[10px] font-medium text-blue-600">Selected</span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose}
            className="px-4 py-2 text-sm text-gray-500 hover:bg-gray-50 rounded-lg">
            Cancel
          </button>
          <button onClick={submit} disabled={!selectedUserId || saving}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50">
            {saving
              ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              : <UserCheck size={14} />
            }
            Reassign
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
