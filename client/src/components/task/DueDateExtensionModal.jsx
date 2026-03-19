import React, { useState, useEffect } from 'react';
import { Calendar, Clock, X, Check, AlertCircle, Send } from 'lucide-react';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';

export default function DueDateExtensionModal({ task, onClose, onUpdated }) {
  const { canManage } = useAuth();
  const [proposedDate, setProposedDate] = useState('');
  const [reason, setReason] = useState('');
  const [extensions, setExtensions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reviewNote, setReviewNote] = useState('');

  useEffect(() => {
    if (task?.id) fetchExtensions();
  }, [task?.id]);

  async function fetchExtensions() {
    try {
      const res = await api.get(`/extensions?taskId=${task.id}`);
      setExtensions(res.data.extensions || []);
    } catch {}
  }

  async function handleRequest() {
    if (!proposedDate || !reason.trim()) { setError('Please fill in proposed date and reason.'); return; }
    setLoading(true); setError('');
    try {
      await api.post('/extensions', { taskId: task.id, proposedDueDate: proposedDate, reason });
      setProposedDate(''); setReason('');
      fetchExtensions();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to submit request.');
    } finally { setLoading(false); }
  }

  async function handleApprove(id) {
    try {
      await api.put(`/extensions/${id}/approve`, { reviewNote });
      setReviewNote('');
      fetchExtensions();
      if (onUpdated) onUpdated();
    } catch {}
  }

  async function handleReject(id) {
    try {
      await api.put(`/extensions/${id}/reject`, { reviewNote });
      setReviewNote('');
      fetchExtensions();
    } catch {}
  }

  const STATUS_BADGE = { pending: 'bg-yellow-100 text-yellow-700', approved: 'bg-green-100 text-green-700', rejected: 'bg-red-100 text-red-700' };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-800 rounded-xl border border-gray-200 dark:border-zinc-700 w-full max-w-md shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 dark:border-zinc-700">
          <h2 className="text-sm font-bold text-gray-800 dark:text-gray-200 flex items-center gap-2"><Calendar size={15} className="text-primary" /> Due Date Extension</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
        </div>

        <div className="p-5 max-h-[70vh] overflow-y-auto">
          <div className="mb-4 p-3 bg-gray-50 dark:bg-zinc-700 rounded-lg">
            <p className="text-xs text-gray-500">Task: <span className="font-medium text-gray-800 dark:text-gray-200">{task?.title}</span></p>
            <p className="text-xs text-gray-500">Current due: <span className="font-medium text-gray-800 dark:text-gray-200">{task?.dueDate || 'Not set'}</span></p>
          </div>

          {/* Request form */}
          <div className="space-y-3 mb-4">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Proposed New Date</label>
              <input type="date" value={proposedDate} onChange={e => setProposedDate(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary" />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Reason for Extension</label>
              <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2}
                placeholder="Why do you need more time?"
                className="w-full px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary resize-none" />
            </div>
            {error && <p className="text-xs text-red-500 flex items-center gap-1"><AlertCircle size={11} /> {error}</p>}
            <button onClick={handleRequest} disabled={loading}
              className="w-full py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center gap-1.5">
              <Send size={13} /> Request Extension
            </button>
          </div>

          {/* Extension history */}
          {extensions.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">Extension History</h3>
              <div className="space-y-2">
                {extensions.map(ext => (
                  <div key={ext.id} className="p-3 border border-gray-100 dark:border-zinc-700 rounded-lg">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{ext.requester?.name}</span>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${STATUS_BADGE[ext.status]}`}>{ext.status}</span>
                    </div>
                    <p className="text-[11px] text-gray-500">
                      {ext.currentDueDate} → <span className="font-medium text-primary">{ext.proposedDueDate}</span>
                    </p>
                    <p className="text-[11px] text-gray-500 italic mt-0.5">"{ext.reason}"</p>
                    {ext.reviewNote && <p className="text-[11px] text-gray-400 mt-1">Review: {ext.reviewNote}</p>}

                    {/* Manager actions */}
                    {ext.status === 'pending' && canManage && (
                      <div className="flex gap-2 mt-2">
                        <input type="text" value={reviewNote} onChange={e => setReviewNote(e.target.value)}
                          placeholder="Note..." className="flex-1 text-xs border border-gray-200 dark:border-zinc-600 rounded px-2 py-1 focus:outline-none focus:border-primary" />
                        <button onClick={() => handleApprove(ext.id)} className="px-2 py-1 bg-green-500 text-white text-[10px] rounded hover:bg-green-600"><Check size={10} /></button>
                        <button onClick={() => handleReject(ext.id)} className="px-2 py-1 bg-red-500 text-white text-[10px] rounded hover:bg-red-600"><X size={10} /></button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
