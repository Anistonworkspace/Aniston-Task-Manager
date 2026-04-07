import React, { useState, useEffect } from 'react';
import { X, Send, Search, AlertCircle, Check } from 'lucide-react';
import api from '../../services/api';
import Avatar from '../common/Avatar';

export default function DelegateTaskModal({ task, onClose, onDelegated }) {
  const [users, setUsers] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);
  const [notes, setNotes] = useState('');
  const [search, setSearch] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    api.get('/auth/users').then(res => {
      const all = res.data.users || res.data || [];
      // Exclude current assignee
      setUsers(all.filter(u => u.id !== task.assignedTo));
    }).catch(() => {});
  }, []);

  async function handleDelegate() {
    if (!selectedUser) { setError('Please select a team member.'); return; }
    setSending(true);
    setError('');
    try {
      await api.post(`/tasks/${task.id}/delegate`, {
        toUserId: selectedUser.id,
        notes: notes.trim() || undefined,
      });
      setSuccess(`Task delegated to ${selectedUser.name} successfully!`);
      setTimeout(() => {
        if (onDelegated) onDelegated(selectedUser.id);
        onClose();
      }, 1200);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to delegate task.');
    } finally {
      setSending(false);
    }
  }

  const filtered = search
    ? users.filter(u => u.name.toLowerCase().includes(search.toLowerCase()))
    : users;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60] p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-modal w-full max-w-md" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold text-text-primary">Delegate Task</h2>
            <p className="text-xs text-text-tertiary mt-0.5">Hand off "{task.title}" to a teammate</p>
          </div>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-surface text-text-secondary"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4">
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

          {/* Select teammate */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Delegate to *</label>
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface/30">
                <Search size={13} className="text-text-tertiary" />
                <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                  className="bg-transparent border-none outline-none text-xs w-full placeholder:text-text-tertiary" placeholder="Search team members..." />
              </div>
              <div className="max-h-[180px] overflow-y-auto">
                {filtered.map(u => (
                  <button key={u.id} onClick={() => setSelectedUser(u)}
                    className={`flex items-center gap-2.5 w-full px-3 py-2.5 text-sm hover:bg-surface transition-colors ${selectedUser?.id === u.id ? 'bg-primary/5 border-l-2 border-primary' : ''}`}>
                    <Avatar name={u.name} size="sm" />
                    <div className="flex-1 text-left min-w-0">
                      <p className="text-sm font-medium text-text-primary truncate">{u.name}</p>
                      <p className="text-[10px] text-text-tertiary capitalize">{u.role}{u.department ? ` · ${u.department}` : ''}</p>
                    </div>
                    {selectedUser?.id === u.id && (
                      <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                        <Check size={12} className="text-white" />
                      </div>
                    )}
                  </button>
                ))}
                {filtered.length === 0 && <p className="text-xs text-text-tertiary text-center py-4">No team members found</p>}
              </div>
            </div>
          </div>

          {/* Handoff notes */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Handoff Notes (optional)</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
              className="w-full px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none"
              placeholder="Any context or instructions for the next person..." />
          </div>

          {/* Selected summary */}
          {selectedUser && (
            <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-primary/5 border border-primary/20">
              <Avatar name={selectedUser.name} size="sm" />
              <div className="flex-1">
                <p className="text-sm font-medium text-text-primary">{selectedUser.name}</p>
                <p className="text-[10px] text-text-tertiary">Will receive a notification with your handoff notes</p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-border">
          <button onClick={onClose} className="px-4 py-2 text-sm text-text-secondary hover:bg-surface rounded-lg transition-colors">Cancel</button>
          <button onClick={handleDelegate} disabled={sending || !selectedUser || !!success}
            className="flex items-center gap-2 px-5 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-hover disabled:opacity-50 transition-colors shadow-sm">
            {sending ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Send size={15} />}
            Delegate
          </button>
        </div>
      </div>
    </div>
  );
}
