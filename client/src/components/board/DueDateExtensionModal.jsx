import React, { useState } from 'react';
import { X, CalendarPlus, Clock, AlertTriangle } from 'lucide-react';
import api from '../../services/api';

export default function DueDateExtensionModal({ task, onClose, onSubmit }) {
  const [proposedDate, setProposedDate] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!proposedDate || !reason.trim()) return;
    setSubmitting(true);
    try {
      await api.post('/extensions', {
        taskId: task.id,
        currentDueDate: task.dueDate,
        proposedDueDate: proposedDate,
        reason: reason.trim(),
      });
      if (onSubmit) onSubmit();
      onClose();
    } catch (err) {
      console.error('Failed to request extension:', err);
    } finally {
      setSubmitting(false);
    }
  }

  const isOverdue = task.dueDate && new Date(task.dueDate) < new Date();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-800 rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden animate-slide-in" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-border dark:border-zinc-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CalendarPlus size={20} className="text-primary" />
            <h3 className="text-lg font-semibold text-text-primary dark:text-white">Request Extension</h3>
          </div>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary p-1"><X size={18} /></button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Task Info */}
          <div className="bg-surface dark:bg-zinc-700 rounded-lg p-3">
            <p className="text-xs text-text-tertiary mb-1">Task</p>
            <p className="text-sm font-medium text-text-primary dark:text-white">{task.title}</p>
            <div className="flex items-center gap-3 mt-2">
              <div className="flex items-center gap-1">
                <Clock size={12} className="text-text-tertiary" />
                <span className="text-xs text-text-secondary">
                  Current: {task.dueDate ? new Date(task.dueDate).toLocaleDateString() : 'No due date'}
                </span>
              </div>
              {isOverdue && (
                <span className="flex items-center gap-1 text-[10px] text-danger font-medium">
                  <AlertTriangle size={10} /> Overdue
                </span>
              )}
            </div>
          </div>

          {/* New Date */}
          <div>
            <label className="text-xs font-medium text-text-secondary mb-1.5 block">New Proposed Due Date</label>
            <input type="date" value={proposedDate} onChange={(e) => setProposedDate(e.target.value)}
              min={new Date().toISOString().split('T')[0]}
              className="w-full text-sm border border-border dark:border-zinc-600 rounded-lg px-3 py-2.5 focus:outline-none focus:border-primary bg-transparent" required />
          </div>

          {/* Reason */}
          <div>
            <label className="text-xs font-medium text-text-secondary mb-1.5 block">Reason for Extension</label>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3}
              placeholder="Explain why you need more time..."
              className="w-full text-sm border border-border dark:border-zinc-600 rounded-lg px-3 py-2.5 focus:outline-none focus:border-primary bg-transparent resize-none" required />
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 py-2.5 border border-border rounded-lg text-sm hover:bg-surface transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={submitting || !proposedDate || !reason.trim()}
              className="flex-1 py-2.5 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-dark transition-colors disabled:opacity-50">
              {submitting ? 'Submitting...' : 'Request Extension'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
