import React, { useState } from 'react';
import { Shield, Check, X, Clock, MessageSquare, Send } from 'lucide-react';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';

const STATUS_STYLES = {
  pending_approval: { label: 'Pending Approval', bg: 'bg-yellow-50', text: 'text-yellow-700', border: 'border-yellow-200' },
  approved: { label: 'Approved', bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200' },
  changes_requested: { label: 'Changes Requested', bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200' },
};

export default function ApprovalSection({ task, onUpdate }) {
  const { canManage } = useAuth();
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(false);

  const approvalStatus = task?.approvalStatus;
  const approvalChain = task?.approvalChain || [];
  const style = STATUS_STYLES[approvalStatus];

  async function submitForApproval() {
    setLoading(true);
    try {
      const res = await api.post(`/task-extras/${task.id}/submit-approval`, { comment });
      if (onUpdate) onUpdate(res.data.task || res.data);
      setComment('');
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function approve() {
    setLoading(true);
    try {
      const res = await api.post(`/task-extras/${task.id}/approve`, { comment });
      if (onUpdate) onUpdate(res.data.task || res.data);
      setComment('');
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function requestChanges() {
    setLoading(true);
    try {
      const res = await api.post(`/task-extras/${task.id}/request-changes`, { comment });
      if (onUpdate) onUpdate(res.data.task || res.data);
      setComment('');
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mb-5">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider flex items-center gap-1.5">
          <Shield size={12} /> Approval
        </h3>
        {approvalStatus && style && (
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${style.bg} ${style.text} ${style.border} border`}>
            {style.label}
          </span>
        )}
      </div>

      {/* Approval Chain History */}
      {approvalChain.length > 0 && (
        <div className="space-y-1.5 mb-3 max-h-32 overflow-y-auto">
          {approvalChain.map((entry, i) => (
            <div key={i} className="flex items-start gap-2 text-[11px]">
              <div className={`w-4 h-4 rounded-full flex items-center justify-center mt-0.5 ${
                entry.action === 'approved' ? 'bg-green-100 text-green-600' :
                entry.action === 'changes_requested' ? 'bg-red-100 text-red-600' :
                'bg-yellow-100 text-yellow-600'
              }`}>
                {entry.action === 'approved' ? <Check size={8} /> :
                 entry.action === 'changes_requested' ? <X size={8} /> :
                 <Clock size={8} />}
              </div>
              <div>
                <span className="font-medium text-gray-700 dark:text-gray-300">{entry.userName}</span>
                <span className="text-gray-500 ml-1">{entry.action.replace(/_/g, ' ')}</span>
                {entry.comment && <p className="text-gray-500 italic mt-0.5">"{entry.comment}"</p>}
                <p className="text-[9px] text-gray-400">{new Date(entry.timestamp).toLocaleString()}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Comment input */}
      <div className="flex gap-2 mb-2">
        <input type="text" value={comment} onChange={e => setComment(e.target.value)}
          placeholder="Add approval comment..." className="flex-1 text-xs border border-border rounded-md px-2.5 py-1.5 focus:outline-none focus:border-primary" />
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        {!approvalStatus && (
          <button onClick={submitForApproval} disabled={loading}
            className="flex items-center gap-1 px-3 py-1.5 bg-purple-500 text-white text-xs font-medium rounded-md hover:bg-purple-600 disabled:opacity-50">
            <Send size={11} /> Submit for Approval
          </button>
        )}
        {approvalStatus === 'pending_approval' && canManage && (
          <>
            <button onClick={approve} disabled={loading}
              className="flex items-center gap-1 px-3 py-1.5 bg-green-500 text-white text-xs font-medium rounded-md hover:bg-green-600 disabled:opacity-50">
              <Check size={11} /> Approve
            </button>
            <button onClick={requestChanges} disabled={loading}
              className="flex items-center gap-1 px-3 py-1.5 bg-red-500 text-white text-xs font-medium rounded-md hover:bg-red-600 disabled:opacity-50">
              <X size={11} /> Request Changes
            </button>
          </>
        )}
        {approvalStatus === 'changes_requested' && (
          <button onClick={submitForApproval} disabled={loading}
            className="flex items-center gap-1 px-3 py-1.5 bg-purple-500 text-white text-xs font-medium rounded-md hover:bg-purple-600 disabled:opacity-50">
            <Send size={11} /> Resubmit
          </button>
        )}
      </div>
    </div>
  );
}
