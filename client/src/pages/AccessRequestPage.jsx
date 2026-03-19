import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import {
  Key, Plus, Clock, Check, X, AlertCircle, Shield, Send, ChevronDown, RefreshCw
} from 'lucide-react';

const STATUS_STYLES = {
  pending: { bg: 'bg-yellow-50 dark:bg-yellow-900/10', text: 'text-yellow-700', border: 'border-yellow-200' },
  approved: { bg: 'bg-green-50 dark:bg-green-900/10', text: 'text-green-700', border: 'border-green-200' },
  rejected: { bg: 'bg-red-50 dark:bg-red-900/10', text: 'text-red-700', border: 'border-red-200' },
  expired: { bg: 'bg-gray-50 dark:bg-gray-900/10', text: 'text-gray-500', border: 'border-gray-200' },
};

export default function AccessRequestPage() {
  const { user, canManage } = useAuth();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [workspaces, setWorkspaces] = useState([]);
  const [form, setForm] = useState({
    resourceType: 'workspace',
    resourceId: '',
    requestType: 'view',
    reason: '',
    isTemporary: false,
    expiresAt: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchData();
  }, []);

  async function fetchData() {
    try {
      const [reqRes, wsRes] = await Promise.all([
        api.get('/access-requests'),
        api.get('/workspaces'),
      ]);
      setRequests(reqRes.data.requests || []);
      setWorkspaces(wsRes.data.workspaces || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!form.resourceType || !form.requestType) {
      setError('Resource type and access level are required.');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/access-requests', {
        ...form,
        resourceId: form.resourceId || null,
        expiresAt: form.expiresAt || null,
      });
      setShowCreate(false);
      setForm({ resourceType: 'workspace', resourceId: '', requestType: 'view', reason: '', isTemporary: false, expiresAt: '' });
      fetchData();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to submit request.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        {[1,2,3].map(i => <div key={i} className="animate-pulse bg-gray-100 dark:bg-zinc-800 rounded-xl h-24" />)}
      </div>
    );
  }

  const myRequests = requests.filter(r => r.userId === user?.id);
  const pending = myRequests.filter(r => r.status === 'pending');
  const resolved = myRequests.filter(r => r.status !== 'pending');

  return (
    <div className="p-6 max-w-[900px] mx-auto">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2">
              <Key size={24} className="text-primary" />
              Access Requests
            </h1>
            <p className="text-sm text-gray-500 mt-0.5">Request access to workspaces, boards, and team dashboards</p>
          </div>
          <button onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 px-4 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors">
            <Plus size={14} /> New Request
          </button>
        </div>
      </motion.div>

      {/* Create Request Form */}
      <AnimatePresence>
        {showCreate && (
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
            className="bg-white dark:bg-zinc-800 rounded-xl border border-gray-200 dark:border-zinc-700 p-5 mb-6 shadow-sm">
            <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-4 flex items-center gap-2">
              <Send size={14} className="text-primary" /> Request Access
            </h3>

            {error && (
              <div className="bg-red-50 dark:bg-red-900/10 text-red-600 text-xs px-3 py-2 rounded-lg mb-3 flex items-center gap-1.5">
                <AlertCircle size={12} /> {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Resource Type</label>
                  <select value={form.resourceType} onChange={e => setForm({ ...form, resourceType: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary">
                    <option value="workspace">Workspace</option>
                    <option value="board">Board</option>
                    <option value="team">Team Dashboard</option>
                    <option value="dashboard">Analytics Dashboard</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Access Level</label>
                  <select value={form.requestType} onChange={e => setForm({ ...form, requestType: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary">
                    <option value="view">View Only</option>
                    <option value="edit">Edit</option>
                    <option value="assign">Assign Tasks</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
              </div>

              {form.resourceType === 'workspace' && workspaces.length > 0 && (
                <div>
                  <label className="text-xs text-gray-500 block mb-1">Select Workspace</label>
                  <select value={form.resourceId} onChange={e => setForm({ ...form, resourceId: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary">
                    <option value="">All workspaces</option>
                    {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </div>
              )}

              <div>
                <label className="text-xs text-gray-500 block mb-1">Reason / Justification</label>
                <textarea value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })}
                  rows={2} placeholder="Why do you need this access?"
                  className="w-full px-3 py-2 border border-gray-200 dark:border-zinc-600 rounded-lg text-sm focus:outline-none focus:border-primary resize-none" />
              </div>

              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
                  <input type="checkbox" checked={form.isTemporary} onChange={e => setForm({ ...form, isTemporary: e.target.checked })}
                    className="rounded border-gray-300 text-primary focus:ring-primary" />
                  Temporary access
                </label>
                {form.isTemporary && (
                  <input type="date" value={form.expiresAt} onChange={e => setForm({ ...form, expiresAt: e.target.value })}
                    className="text-xs border border-gray-200 dark:border-zinc-600 rounded-md px-2 py-1.5 focus:outline-none focus:border-primary" />
                )}
              </div>

              <div className="flex gap-2 pt-2">
                <button type="submit" disabled={submitting}
                  className="px-5 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1.5">
                  {submitting ? <RefreshCw size={12} className="animate-spin" /> : <Send size={12} />}
                  Submit Request
                </button>
                <button type="button" onClick={() => setShowCreate(false)}
                  className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700">Cancel</button>
              </div>
            </form>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Pending Requests */}
      {pending.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-gray-600 dark:text-gray-400 mb-3 flex items-center gap-1.5">
            <Clock size={14} /> Pending ({pending.length})
          </h2>
          <div className="space-y-3">
            {pending.map(r => (
              <RequestCard key={r.id} request={r} />
            ))}
          </div>
        </div>
      )}

      {/* Resolved Requests */}
      <div>
        <h2 className="text-sm font-semibold text-gray-600 dark:text-gray-400 mb-3">History</h2>
        <div className="space-y-3">
          {resolved.map(r => (
            <RequestCard key={r.id} request={r} />
          ))}
          {resolved.length === 0 && pending.length === 0 && (
            <div className="text-center py-12 text-gray-400">
              <Shield size={32} className="mx-auto mb-2 opacity-40" />
              <p className="text-sm">No access requests yet</p>
              <p className="text-xs mt-1">Click "New Request" to request access to resources</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RequestCard({ request: r }) {
  const styles = STATUS_STYLES[r.status] || STATUS_STYLES.pending;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
      className={`rounded-xl border p-4 ${styles.bg} ${styles.border}`}>
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${styles.text} bg-white/50`}>{r.status}</span>
            <span className="text-xs text-gray-500 capitalize">{r.requestType} access to {r.resourceType}</span>
          </div>
          {r.reason && <p className="text-xs text-gray-600 dark:text-gray-400 italic mt-1">"{r.reason}"</p>}
          {r.isTemporary && r.expiresAt && (
            <p className="text-[10px] text-yellow-600 flex items-center gap-1 mt-1"><Clock size={10} /> Until {new Date(r.expiresAt).toLocaleDateString()}</p>
          )}
          {r.reviewNote && <p className="text-xs text-gray-500 mt-1">Admin note: {r.reviewNote}</p>}
        </div>
        <p className="text-[10px] text-gray-400">{new Date(r.createdAt).toLocaleDateString()}</p>
      </div>
    </motion.div>
  );
}
