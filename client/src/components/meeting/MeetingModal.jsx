import React, { useState, useEffect } from 'react';
import { X, Check, AlertCircle, Search } from 'lucide-react';
import api from '../../services/api';
import Avatar from '../common/Avatar';

const TYPES = [
  { value: 'meeting', label: 'Meeting', color: '#0073ea' },
  { value: 'reminder', label: 'Reminder', color: '#fdab3d' },
  { value: 'follow_up', label: 'Follow-up', color: '#a25ddc' },
];

export default function MeetingModal({ meeting, onClose, onSave }) {
  const [form, setForm] = useState({
    title: meeting?.title || '',
    description: meeting?.description || '',
    date: meeting?.date || new Date().toISOString().slice(0, 10),
    startTime: meeting?.startTime || '09:00',
    endTime: meeting?.endTime || '10:00',
    location: meeting?.location || '',
    type: meeting?.type || 'meeting',
    boardId: meeting?.boardId || '',
    taskId: meeting?.taskId || '',
  });
  const [selectedParticipants, setSelectedParticipants] = useState(
    meeting?.participants?.filter(Boolean)?.map(p => p.userId) || []
  );
  const [users, setUsers] = useState([]);
  const [boards, setBoards] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [userSearch, setUserSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get('/auth/users').then(r => setUsers(r.data.users || r.data || [])),
      api.get('/boards').then(r => setBoards(r.data.boards || r.data || [])),
    ]).catch(() => {});
  }, []);

  useEffect(() => {
    if (form.boardId) {
      api.get(`/tasks?boardId=${form.boardId}&limit=50`).then(r => {
        setTasks(r.data.tasks || r.data || []);
      }).catch(() => setTasks([]));
    } else {
      setTasks([]);
    }
  }, [form.boardId]);

  function toggleParticipant(userId) {
    setSelectedParticipants(prev =>
      prev.includes(userId) ? prev.filter(id => id !== userId) : [...prev, userId]
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.title.trim()) { setError('Title is required.'); return; }
    if (!form.date) { setError('Date is required.'); return; }
    if (form.startTime >= form.endTime) { setError('End time must be after start time.'); return; }

    setSaving(true);
    setError('');
    try {
      const payload = {
        ...form,
        title: form.title.trim(),
        participants: selectedParticipants,
        boardId: form.boardId || null,
        taskId: form.taskId || null,
      };

      let res;
      if (meeting?.id) {
        res = await api.put(`/meetings/${meeting.id}`, payload);
      } else {
        res = await api.post('/meetings', payload);
      }
      if (onSave) onSave(res.data?.meeting || res.data?.data?.meeting);
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to save meeting.');
    } finally {
      setSaving(false);
    }
  }

  const filteredUsers = userSearch
    ? users.filter(u => u.name.toLowerCase().includes(userSearch.toLowerCase()))
    : users;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-modal w-full max-w-lg max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <h2 className="text-base font-semibold text-text-primary">
            {meeting?.id ? 'Edit Meeting' : 'Schedule Meeting'}
          </h2>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-surface text-text-secondary"><X size={18} /></button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-5 space-y-4">
          {error && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-danger/10 text-danger text-sm">
              <AlertCircle size={14} /> {error}
            </div>
          )}

          {/* Title */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Title *</label>
            <input type="text" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              className="w-full px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
              placeholder="e.g., Sprint Planning" autoFocus />
          </div>

          {/* Type */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Type</label>
            <div className="flex gap-2">
              {TYPES.map(t => (
                <button key={t.value} type="button" onClick={() => setForm(f => ({ ...f, type: t.value }))}
                  className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium border transition-all ${form.type === t.value ? 'border-primary/50 bg-primary/5 text-primary shadow-sm' : 'border-border text-text-secondary hover:bg-surface'}`}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Date & Time */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">Date *</label>
              <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary" />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">Start *</label>
              <input type="time" value={form.startTime} onChange={e => setForm(f => ({ ...f, startTime: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary" />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">End *</label>
              <input type="time" value={form.endTime} onChange={e => setForm(f => ({ ...f, endTime: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary" />
            </div>
          </div>

          {/* Location */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Location</label>
            <input type="text" value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))}
              className="w-full px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
              placeholder="e.g., Conference Room A, Zoom link..." />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">Description</label>
            <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={2}
              className="w-full px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary resize-none"
              placeholder="Meeting agenda or notes..." />
          </div>

          {/* Participants */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              Participants ({selectedParticipants.length} selected)
            </label>
            {/* Selected chips */}
            {selectedParticipants.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {selectedParticipants.map(uid => {
                  const u = users.find(x => x.id === uid);
                  return u ? (
                    <span key={uid} className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-primary/10 text-primary text-xs font-medium">
                      <Avatar name={u.name} size="xs" />
                      {u.name.split(' ')[0]}
                      <button type="button" onClick={() => toggleParticipant(uid)} className="hover:text-danger ml-0.5"><X size={10} /></button>
                    </span>
                  ) : null;
                })}
              </div>
            )}
            {/* Search */}
            <div className="border border-border rounded-lg overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface/30">
                <Search size={13} className="text-text-tertiary" />
                <input type="text" value={userSearch} onChange={e => setUserSearch(e.target.value)}
                  className="bg-transparent border-none outline-none text-xs w-full placeholder:text-text-tertiary" placeholder="Search people..." />
              </div>
              <div className="max-h-[120px] overflow-y-auto">
                {filteredUsers.map(u => (
                  <label key={u.id} className="flex items-center gap-2.5 px-3 py-2 hover:bg-surface cursor-pointer transition-colors">
                    <input type="checkbox" checked={selectedParticipants.includes(u.id)} onChange={() => toggleParticipant(u.id)}
                      className="w-3.5 h-3.5 rounded border-border text-primary focus:ring-primary/20" />
                    <Avatar name={u.name} size="xs" />
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-medium text-text-primary truncate block">{u.name}</span>
                      <span className="text-[10px] text-text-tertiary capitalize">{u.role}</span>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          </div>

          {/* Link to Board/Task */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">Link to Board</label>
              <select value={form.boardId} onChange={e => setForm(f => ({ ...f, boardId: e.target.value, taskId: '' }))}
                className="w-full px-3 py-2 rounded-lg border border-border text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/20">
                <option value="">None</option>
                {boards.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">Link to Task</label>
              <select value={form.taskId} onChange={e => setForm(f => ({ ...f, taskId: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-border text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/20"
                disabled={!form.boardId}>
                <option value="">None</option>
                {tasks.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
              </select>
            </div>
          </div>
        </form>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-border flex-shrink-0">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-text-secondary hover:bg-surface rounded-lg transition-colors">Cancel</button>
          <button onClick={handleSubmit} disabled={saving}
            className="flex items-center gap-2 px-5 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-hover disabled:opacity-50 transition-colors shadow-sm">
            {saving ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Check size={15} />}
            {meeting?.id ? 'Save Changes' : 'Schedule Meeting'}
          </button>
        </div>
      </div>
    </div>
  );
}
