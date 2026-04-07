import React, { useState } from 'react';
import { X, HelpCircle, AlertTriangle } from 'lucide-react';
import api from '../../services/api';
import Avatar from '../common/Avatar';

const URGENCY_OPTIONS = [
  { value: 'low', label: 'Low', color: '#579bfc' },
  { value: 'medium', label: 'Medium', color: '#fdab3d' },
  { value: 'high', label: 'High', color: '#e2445c' },
  { value: 'critical', label: 'Critical', color: '#333333' },
];

export default function HelpRequestModal({ task, members = [], onClose, onSubmit }) {
  const [requestTo, setRequestTo] = useState('');
  const [description, setDescription] = useState('');
  const [urgency, setUrgency] = useState('medium');
  const [preferredTime, setPreferredTime] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Filter to only show managers and admins
  const managers = members.filter(m => m.role === 'admin' || m.role === 'manager');

  async function handleSubmit(e) {
    e.preventDefault();
    if (!requestTo || !description.trim()) return;
    setSubmitting(true);
    try {
      await api.post('/helpRequests', {
        taskId: task.id,
        requestedTo: requestTo,
        description: description.trim(),
        urgency,
        preferredTime: preferredTime || null,
      });
      if (onSubmit) onSubmit();
      onClose();
    } catch (err) {
      console.error('Failed to request help:', err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-800 rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden animate-slide-in" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-border dark:border-zinc-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <HelpCircle size={20} className="text-warning" />
            <h3 className="text-lg font-semibold text-text-primary dark:text-white">Request Help</h3>
          </div>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary p-1"><X size={18} /></button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Task Info */}
          <div className="bg-surface dark:bg-zinc-700 rounded-lg p-3">
            <p className="text-xs text-text-tertiary mb-1">Task</p>
            <p className="text-sm font-medium text-text-primary dark:text-white">{task.title}</p>
          </div>

          {/* Request To */}
          <div>
            <label className="text-xs font-medium text-text-secondary mb-1.5 block">Request Help From</label>
            <select value={requestTo} onChange={(e) => setRequestTo(e.target.value)}
              className="w-full text-sm border border-border dark:border-zinc-600 rounded-lg px-3 py-2.5 focus:outline-none focus:border-primary bg-transparent" required>
              <option value="">Select manager or admin...</option>
              {managers.map(m => (
                <option key={m.id} value={m.id}>{m.name} ({m.role})</option>
              ))}
            </select>
          </div>

          {/* Description */}
          <div>
            <label className="text-xs font-medium text-text-secondary mb-1.5 block">What Help Do You Need?</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
              placeholder="Describe the help you need..."
              className="w-full text-sm border border-border dark:border-zinc-600 rounded-lg px-3 py-2.5 focus:outline-none focus:border-primary bg-transparent resize-none" required />
          </div>

          {/* Urgency */}
          <div>
            <label className="text-xs font-medium text-text-secondary mb-1.5 block">Urgency Level</label>
            <div className="flex gap-2">
              {URGENCY_OPTIONS.map(opt => (
                <button key={opt.value} type="button" onClick={() => setUrgency(opt.value)}
                  className={`flex-1 py-2 rounded-lg text-xs font-medium text-white transition-all ${
                    urgency === opt.value ? 'ring-2 ring-offset-2 ring-gray-400 scale-105' : 'opacity-70 hover:opacity-100'
                  }`} style={{ backgroundColor: opt.color }}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Preferred Time */}
          <div>
            <label className="text-xs font-medium text-text-secondary mb-1.5 block">Preferred Time (Optional)</label>
            <input type="datetime-local" value={preferredTime} onChange={(e) => setPreferredTime(e.target.value)}
              className="w-full text-sm border border-border dark:border-zinc-600 rounded-lg px-3 py-2.5 focus:outline-none focus:border-primary bg-transparent" />
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 py-2.5 border border-border rounded-lg text-sm hover:bg-surface transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={submitting || !requestTo || !description.trim()}
              className="flex-1 py-2.5 bg-warning text-white rounded-lg text-sm font-medium hover:bg-warning-dark transition-colors disabled:opacity-50">
              {submitting ? 'Sending...' : 'Send Help Request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
