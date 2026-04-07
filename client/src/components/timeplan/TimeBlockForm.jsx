import React, { useState, useEffect } from 'react';
import { X, Clock, FileText, CheckSquare } from 'lucide-react';
import api from '../../services/api';

export default function TimeBlockForm({ block, date, onSave, onClose, forUserId }) {
  const [startTime, setStartTime] = useState(block?.startTime || '09:00');
  const [endTime, setEndTime] = useState(block?.endTime || '10:00');
  const [description, setDescription] = useState(block?.description || '');
  const [taskId, setTaskId] = useState(block?.taskId || '');
  const [boardId, setBoardId] = useState(block?.boardId || '');
  const [tasks, setTasks] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    loadTasks();
  }, []);

  async function loadTasks() {
    try {
      const res = await api.get('/tasks?limit=200');
      const list = res.data.tasks || res.data.data?.tasks || res.data || [];
      setTasks(Array.isArray(list) ? list : []);
    } catch {}
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (startTime >= endTime) {
      setError('Start time must be before end time');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const payload = {
        date,
        startTime,
        endTime,
        description: description.trim(),
        taskId: taskId || null,
        boardId: boardId || null,
        ...(forUserId ? { forUserId } : {}),
      };
      if (block?.id) {
        await api.put(`/timeplans/${block.id}`, payload);
      } else {
        await api.post('/timeplans', payload);
      }
      onSave();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to save time block');
    } finally {
      setSaving(false);
    }
  }

  function handleTaskSelect(id) {
    setTaskId(id);
    if (id) {
      const task = tasks.find(t => t.id === id);
      if (task?.boardId) setBoardId(task.boardId);
      if (!description && task?.title) setDescription(task.title);
    }
  }

  // Quick time presets
  const presets = [
    { label: '30m', mins: 30 },
    { label: '1h', mins: 60 },
    { label: '1.5h', mins: 90 },
    { label: '2h', mins: 120 },
    { label: '3h', mins: 180 },
  ];

  function applyPreset(mins) {
    const [h, m] = startTime.split(':').map(Number);
    const totalMins = h * 60 + m + mins;
    const endH = Math.floor(totalMins / 60);
    const endM = totalMins % 60;
    if (endH < 24) {
      setEndTime(`${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 animate-scale-in" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <h3 className="text-sm font-bold text-text-primary flex items-center gap-2">
            <Clock size={15} className="text-primary" />
            {block?.id ? 'Edit Time Block' : 'New Time Block'}
          </h3>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-surface text-text-secondary"><X size={16} /></button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Time selection */}
          <div>
            <label className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5 block">Time</label>
            <div className="flex items-center gap-2">
              <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)}
                className="flex-1 text-sm border border-border rounded-lg px-3 py-2 focus:outline-none focus:border-primary" />
              <span className="text-text-tertiary text-sm">to</span>
              <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)}
                className="flex-1 text-sm border border-border rounded-lg px-3 py-2 focus:outline-none focus:border-primary" />
            </div>
            <div className="flex items-center gap-1.5 mt-2">
              {presets.map(p => (
                <button key={p.label} type="button" onClick={() => applyPreset(p.mins)}
                  className="px-2 py-0.5 text-[10px] font-medium bg-surface text-text-secondary rounded-md hover:bg-primary/10 hover:text-primary transition-colors">
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Link to task */}
          <div>
            <label className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
              <CheckSquare size={12} /> Link to Task (optional)
            </label>
            <select value={taskId} onChange={e => handleTaskSelect(e.target.value)}
              className="w-full text-sm border border-border rounded-lg px-3 py-2 focus:outline-none focus:border-primary bg-white">
              <option value="">No task linked</option>
              {tasks.map(t => (
                <option key={t.id} value={t.id}>{t.title}</option>
              ))}
            </select>
          </div>

          {/* Description */}
          <div>
            <label className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
              <FileText size={12} /> Description
            </label>
            <input type="text" value={description} onChange={e => setDescription(e.target.value)}
              placeholder="What will you work on?"
              className="w-full text-sm border border-border rounded-lg px-3 py-2 focus:outline-none focus:border-primary" />
          </div>

          {error && <p className="text-xs text-danger">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-text-secondary hover:bg-surface rounded-lg transition-colors">Cancel</button>
            <button type="submit" disabled={saving}
              className="px-4 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary-600 font-medium disabled:opacity-50 transition-colors">
              {saving ? 'Saving...' : block?.id ? 'Update' : 'Add Block'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
