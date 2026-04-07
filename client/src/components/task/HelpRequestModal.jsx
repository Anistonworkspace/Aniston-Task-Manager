import React, { useState, useEffect } from 'react';
import { HelpCircle, X, Send, Calendar, AlertCircle, Clock, Video, Check } from 'lucide-react';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';

const URGENCY_CONFIG = {
  low: { label: 'Low', color: '#579bfc' },
  medium: { label: 'Medium', color: '#fdab3d' },
  high: { label: 'High', color: '#e2445c' },
  critical: { label: 'Critical', color: '#333' },
};

export default function HelpRequestModal({ task, onClose }) {
  const { user, canManage } = useAuth();
  const [users, setUsers] = useState([]);
  const [requests, setRequests] = useState([]);
  const [requestedTo, setRequestedTo] = useState('');
  const [description, setDescription] = useState('');
  const [urgency, setUrgency] = useState('medium');
  const [preferredTime, setPreferredTime] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchData();
  }, [task?.id]);

  async function fetchData() {
    try {
      const [usersRes, reqRes] = await Promise.all([
        api.get('/auth/users'),
        api.get(`/help-requests?taskId=${task?.id}`),
      ]);
      // Show managers and admins first
      const allUsers = (usersRes.data.users || usersRes.data || []).filter(u => u.id !== user?.id && u.isActive !== false);
      setUsers(allUsers.sort((a, b) => {
        if (a.role === 'admin' && b.role !== 'admin') return -1;
        if (a.role === 'manager' && b.role === 'member') return -1;
        return 0;
      }));
      setRequests(reqRes.data.helpRequests || []);
    } catch {}
  }

  async function handleSubmit() {
    if (!requestedTo || !description.trim()) { setError('Please select who to ask and describe what you need.'); return; }
    setLoading(true); setError('');
    try {
      await api.post('/help-requests', { taskId: task.id, requestedTo, description, urgency, preferredTime: preferredTime || null });
      setDescription(''); setRequestedTo(''); setPreferredTime('');
      fetchData();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to submit.');
    } finally { setLoading(false); }
  }

  async function updateStatus(id, status, meetingLink) {
    try {
      await api.put(`/help-requests/${id}/status`, { status, meetingLink });
      fetchData();
    } catch {}
  }

  const STATUS_BADGE = {
    pending: 'bg-yellow-100 text-yellow-700',
    in_review: 'bg-blue-100 text-blue-700',
    meeting_scheduled: 'bg-purple-100 text-purple-700',
    resolved: 'bg-green-100 text-green-700',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-800 rounded-xl border border-gray-200 dark:border-zinc-700 w-full max-w-md shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 dark:border-zinc-700">
          <h2 className="text-sm font-bold text-gray-800 dark:text-gray-200 flex items-center gap-2"><HelpCircle size={15} className="text-primary" /> Request Help</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
        </div>

        <div className="p-5 max-h-[70vh] overflow-y-auto">
          <div className="mb-4 p-3 bg-gray-50 dark:bg-zinc-700 rounded-lg">
            <p className="text-xs text-gray-500">Task: <span className="font-medium text-gray-800 dark:text-gray-200">{task?.title}</span></p>
          </div>

          {/* Request form */}
          <div className="space-y-3 mb-4">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Ask for help from</label>
              <select value={requestedTo} onChange={e => setRequestedTo(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary">
                <option value="">Select person...</option>
                {users.map(u => (
                  <option key={u.id} value={u.id}>{u.name} ({u.role}{u.designation ? ` - ${u.designation}` : ''})</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">What help do you need?</label>
              <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3}
                placeholder="Describe what you're stuck on..."
                className="w-full px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary resize-none" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Urgency</label>
                <div className="flex gap-1">
                  {Object.entries(URGENCY_CONFIG).map(([key, cfg]) => (
                    <button key={key} onClick={() => setUrgency(key)}
                      className={`flex-1 text-[10px] py-1.5 rounded font-medium transition-all ${urgency === key ? 'text-white' : 'text-gray-500 bg-gray-100 dark:bg-zinc-700'}`}
                      style={urgency === key ? { backgroundColor: cfg.color } : {}}>
                      {cfg.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Preferred time (optional)</label>
                <input type="text" value={preferredTime} onChange={e => setPreferredTime(e.target.value)}
                  placeholder="e.g., Today 3-4pm"
                  className="w-full px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-xs focus:outline-none focus:border-primary" />
              </div>
            </div>
            {error && <p className="text-xs text-red-500 flex items-center gap-1"><AlertCircle size={11} /> {error}</p>}
            <button onClick={handleSubmit} disabled={loading}
              className="w-full py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center gap-1.5">
              <Send size={13} /> Send Help Request
            </button>
          </div>

          {/* Request history */}
          {requests.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">Help Request History</h3>
              <div className="space-y-2">
                {requests.map(hr => (
                  <div key={hr.id} className="p-3 border border-gray-100 dark:border-zinc-700 rounded-lg">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{hr.requester?.name}</span>
                        <span className="text-gray-400">→</span>
                        <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{hr.helper?.name}</span>
                      </div>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${STATUS_BADGE[hr.status] || 'bg-gray-100 text-gray-500'}`}>{hr.status.replace(/_/g, ' ')}</span>
                    </div>
                    <p className="text-[11px] text-gray-500">{hr.description}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ backgroundColor: `${URGENCY_CONFIG[hr.urgency]?.color}15`, color: URGENCY_CONFIG[hr.urgency]?.color }}>
                        {hr.urgency}
                      </span>
                      {hr.preferredTime && <span className="text-[10px] text-gray-400 flex items-center gap-0.5"><Clock size={9} /> {hr.preferredTime}</span>}
                      {hr.meetingLink && <a href={hr.meetingLink} target="_blank" className="text-[10px] text-primary flex items-center gap-0.5"><Video size={9} /> Join Meeting</a>}
                    </div>

                    {/* Manager actions */}
                    {hr.status === 'pending' && canManage && hr.requestedTo === user?.id && (
                      <div className="flex gap-2 mt-2">
                        <button onClick={() => updateStatus(hr.id, 'in_review')} className="text-[10px] bg-blue-500 text-white px-2 py-1 rounded">Start Review</button>
                        <button onClick={() => updateStatus(hr.id, 'resolved')} className="text-[10px] bg-green-500 text-white px-2 py-1 rounded flex items-center gap-0.5"><Check size={9} /> Resolve</button>
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
