import React, { useState, useEffect, useCallback } from 'react';
import {
  ClipboardCheck, Clock, HelpCircle, ChevronDown, Check, X,
  AlertTriangle, Calendar, MessageSquare, ExternalLink, Filter,
} from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import Avatar from '../components/common/Avatar';

const TABS = [
  { id: 'approvals', label: 'Approvals', icon: ClipboardCheck, color: '#8b5cf6' },
  { id: 'extensions', label: 'Extensions', icon: Clock, color: '#f59e0b' },
  { id: 'help', label: 'Help Requests', icon: HelpCircle, color: '#e2445c' },
];

const STATUS_COLORS = {
  pending: { bg: 'bg-yellow-50', text: 'text-yellow-700', border: 'border-yellow-200', label: 'Pending' },
  pending_approval: { bg: 'bg-yellow-50', text: 'text-yellow-700', border: 'border-yellow-200', label: 'Pending Approval' },
  approved: { bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200', label: 'Approved' },
  rejected: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200', label: 'Rejected' },
  changes_requested: { bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200', label: 'Changes Requested' },
  in_review: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200', label: 'In Review' },
  resolved: { bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200', label: 'Resolved' },
  meeting_scheduled: { bg: 'bg-indigo-50', text: 'text-indigo-700', border: 'border-indigo-200', label: 'Meeting Scheduled' },
};

const URGENCY_COLORS = {
  low: 'bg-blue-100 text-blue-700',
  medium: 'bg-yellow-100 text-yellow-700',
  high: 'bg-orange-100 text-orange-700',
  critical: 'bg-red-100 text-red-700',
};

export default function TasksPage() {
  const { canManage, isAdmin } = useAuth();
  const [activeTab, setActiveTab] = useState('approvals');
  const [data, setData] = useState({ approvals: [], extensions: [], helpRequests: [] });
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [actionLoading, setActionLoading] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get('/task-extras/workflow-items');
      setData(res.data.data || res.data);
    } catch (err) {
      console.error('Failed to load workflow items:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Approval actions
  async function handleApprove(taskId) {
    setActionLoading(taskId);
    try {
      await api.post(`/task-extras/${taskId}/approve`, { comment: '' });
      fetchData();
    } catch (err) { console.error(err); } finally { setActionLoading(null); }
  }

  async function handleRequestChanges(taskId) {
    const comment = prompt('Reason for requesting changes:');
    if (comment === null) return;
    setActionLoading(taskId);
    try {
      await api.post(`/task-extras/${taskId}/request-changes`, { comment });
      fetchData();
    } catch (err) { console.error(err); } finally { setActionLoading(null); }
  }

  // Extension actions
  async function handleApproveExtension(extId, suggestedDate) {
    setActionLoading(extId);
    try {
      await api.put(`/extensions/${extId}/approve`, { reviewNote: '', suggestedDate });
      fetchData();
    } catch (err) { console.error(err); } finally { setActionLoading(null); }
  }

  async function handleRejectExtension(extId) {
    const note = prompt('Reason for rejection:');
    if (note === null) return;
    setActionLoading(extId);
    try {
      await api.put(`/extensions/${extId}/reject`, { reviewNote: note });
      fetchData();
    } catch (err) { console.error(err); } finally { setActionLoading(null); }
  }

  // Help request actions
  async function handleResolveHelp(helpId) {
    setActionLoading(helpId);
    try {
      await api.put(`/help-requests/${helpId}/status`, { status: 'resolved' });
      fetchData();
    } catch (err) { console.error(err); } finally { setActionLoading(null); }
  }

  // Filter items by status
  function filterByStatus(items, statusField = 'approvalStatus') {
    if (statusFilter === 'all') return items;
    return items.filter(item => (item[statusField] || item.status) === statusFilter);
  }

  const counts = {
    approvals: data.approvals?.filter(t => t.approvalStatus === 'pending_approval').length || 0,
    extensions: data.extensions?.filter(e => e.status === 'pending').length || 0,

    help: data.helpRequests?.filter(h => h.status !== 'resolved').length || 0,
  };

  function StatusBadge({ status }) {
    const cfg = STATUS_COLORS[status] || STATUS_COLORS.pending;
    return (
      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${cfg.bg} ${cfg.text} ${cfg.border}`}>
        {cfg.label}
      </span>
    );
  }

  return (
    <div className="min-h-screen bg-background p-6 space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-text-primary flex items-center gap-2">
          <ClipboardCheck size={24} className="text-primary" /> Tasks & Workflows
        </h1>
        <p className="text-sm text-text-tertiary mt-0.5">Approvals, extensions, and help requests</p>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 bg-white rounded-xl border border-border p-1">
        {TABS.map(tab => (
          <button key={tab.id} onClick={() => { setActiveTab(tab.id); setStatusFilter('all'); }}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${activeTab === tab.id ? 'bg-primary text-white shadow-sm' : 'text-text-secondary hover:bg-surface'}`}>
            <tab.icon size={15} />
            {tab.label}
            {counts[tab.id] > 0 && (
              <span className={`ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${activeTab === tab.id ? 'bg-white/20 text-white' : 'bg-danger/10 text-danger'}`}>
                {counts[tab.id]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Status Filter */}
      <div className="flex items-center gap-2">
        <Filter size={13} className="text-text-tertiary" />
        <span className="text-xs text-text-tertiary font-medium">Status:</span>
        {['all', 'pending', 'approved', 'rejected', 'resolved'].map(s => (
          <button key={s} onClick={() => setStatusFilter(s)}
            className={`px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors ${statusFilter === s ? 'bg-primary text-white border-primary' : 'border-border text-text-secondary hover:bg-surface'}`}>
            {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="p-12 text-center text-text-tertiary text-sm">Loading...</div>
      ) : (
        <div className="space-y-3">

          {/* ═══ APPROVALS TAB ═══ */}
          {activeTab === 'approvals' && (
            filterByStatus(data.approvals || [], 'approvalStatus').length === 0 ? (
              <EmptyState icon={ClipboardCheck} message="No approval items" />
            ) : filterByStatus(data.approvals || [], 'approvalStatus').map(task => (
              <div key={task.id} className="bg-white rounded-xl border border-border p-4 hover:shadow-sm transition-shadow">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-sm font-semibold text-text-primary">{task.title}</h3>
                      <StatusBadge status={task.approvalStatus} />
                    </div>
                    <div className="flex items-center gap-3 text-xs text-text-tertiary">
                      {task.board && (
                        <span className="flex items-center gap-1">
                          <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: task.board.color || '#0073ea' }} />
                          {task.board.name}
                        </span>
                      )}
                      {task.assignee && (
                        <span className="flex items-center gap-1">
                          <Avatar name={task.assignee.name} size="xs" /> {task.assignee.name}
                        </span>
                      )}
                      <span>Updated {formatDistanceToNow(new Date(task.updatedAt), { addSuffix: true })}</span>
                    </div>
                    {task.approvalChain?.length > 0 && (
                      <div className="mt-2 space-y-1.5">
                        {task.approvalChain.slice(-3).map((entry, i) => (
                          <div key={i} className="text-[11px]">
                            <p className="text-text-tertiary">
                              <span className="font-medium text-text-secondary">{entry.userName}</span>
                              {' '}<span className={`font-semibold ${entry.action === 'approved' ? 'text-green-600' : entry.action === 'changes_requested' ? 'text-orange-600' : 'text-blue-600'}`}>
                                {entry.action === 'changes_requested' ? 'requested changes' : entry.action === 'submitted' ? 'submitted for approval' : entry.action}
                              </span>
                              {entry.timestamp && <span className="text-text-tertiary ml-1">· {new Date(entry.timestamp).toLocaleString()}</span>}
                            </p>
                            {entry.comment && (
                              <p className="text-xs text-text-secondary bg-surface/50 px-2.5 py-1.5 rounded-md mt-1 border-l-2 border-primary/30 italic">
                                "{entry.comment}"
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {canManage && task.approvalStatus === 'pending_approval' && (
                    <div className="flex items-center gap-2 ml-4">
                      <button onClick={() => handleApprove(task.id)} disabled={actionLoading === task.id}
                        className="px-3 py-1.5 text-xs font-medium bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:opacity-50 flex items-center gap-1">
                        <Check size={12} /> Approve
                      </button>
                      <button onClick={() => handleRequestChanges(task.id)} disabled={actionLoading === task.id}
                        className="px-3 py-1.5 text-xs font-medium bg-orange-500 text-white rounded-lg hover:bg-orange-600 disabled:opacity-50 flex items-center gap-1">
                        <MessageSquare size={12} /> Request Changes
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}

          {/* ═══ EXTENSIONS TAB ═══ */}
          {activeTab === 'extensions' && (
            filterByStatus(data.extensions || []).length === 0 ? (
              <EmptyState icon={Clock} message="No extension requests" />
            ) : filterByStatus(data.extensions || []).map(ext => (
              <div key={ext.id} className="bg-white rounded-xl border border-border p-4 hover:shadow-sm transition-shadow">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-sm font-semibold text-text-primary">{ext.task?.title || 'Task'}</h3>
                      <StatusBadge status={ext.status} />
                    </div>
                    <div className="flex items-center gap-3 text-xs text-text-tertiary mb-2">
                      {ext.task?.board && (
                        <span className="flex items-center gap-1">
                          <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: ext.task.board.color || '#0073ea' }} />
                          {ext.task.board.name}
                        </span>
                      )}
                      {ext.requester && (
                        <span className="flex items-center gap-1">
                          <Avatar name={ext.requester.name} size="xs" /> {ext.requester.name}
                        </span>
                      )}
                      <span>{formatDistanceToNow(new Date(ext.createdAt), { addSuffix: true })}</span>
                    </div>
                    <div className="flex items-center gap-4 text-xs">
                      <span className="text-text-secondary">Current: <span className="font-semibold">{ext.currentDueDate}</span></span>
                      <span className="text-primary font-bold">→</span>
                      <span className="text-text-secondary">Proposed: <span className="font-semibold text-primary">{ext.proposedDueDate}</span></span>
                    </div>
                    {ext.reason && <p className="text-xs text-text-tertiary mt-1 italic">"{ext.reason}"</p>}
                    {ext.reviewNote && <p className="text-xs text-text-secondary mt-1">Review: {ext.reviewNote}</p>}
                  </div>
                  {canManage && ext.status === 'pending' && (
                    <div className="flex items-center gap-2 ml-4">
                      <button onClick={() => handleApproveExtension(ext.id, ext.proposedDueDate)} disabled={actionLoading === ext.id}
                        className="px-3 py-1.5 text-xs font-medium bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:opacity-50 flex items-center gap-1">
                        <Check size={12} /> Approve
                      </button>
                      <button onClick={() => {
                        const newDate = prompt('Suggest a different date (YYYY-MM-DD):', ext.proposedDueDate);
                        if (newDate) handleApproveExtension(ext.id, newDate);
                      }} disabled={actionLoading === ext.id}
                        className="px-3 py-1.5 text-xs font-medium bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 flex items-center gap-1">
                        <Calendar size={12} /> Edit Date
                      </button>
                      <button onClick={() => handleRejectExtension(ext.id)} disabled={actionLoading === ext.id}
                        className="px-3 py-1.5 text-xs font-medium bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-50 flex items-center gap-1">
                        <X size={12} /> Reject
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}

          {/* ═══ HELP REQUESTS TAB ═══ */}
          {activeTab === 'help' && (
            filterByStatus(data.helpRequests || []).length === 0 ? (
              <EmptyState icon={HelpCircle} message="No help requests" />
            ) : filterByStatus(data.helpRequests || []).map(hr => (
              <div key={hr.id} className="bg-white rounded-xl border border-border p-4 hover:shadow-sm transition-shadow">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-sm font-semibold text-text-primary">{hr.task?.title || 'Task'}</h3>
                      <StatusBadge status={hr.status} />
                      {hr.urgency && (
                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${URGENCY_COLORS[hr.urgency] || ''}`}>
                          {hr.urgency}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-text-tertiary mb-1">
                      {hr.requester && <span className="flex items-center gap-1"><Avatar name={hr.requester.name} size="xs" /> From: {hr.requester.name}</span>}
                      {hr.helper && <span className="flex items-center gap-1">→ To: {hr.helper.name}</span>}
                      {hr.task?.board && (
                        <span className="flex items-center gap-1">
                          <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: hr.task.board.color || '#0073ea' }} />
                          {hr.task.board.name}
                        </span>
                      )}
                      <span>{formatDistanceToNow(new Date(hr.createdAt), { addSuffix: true })}</span>
                    </div>
                    <p className="text-xs text-text-secondary">{hr.description}</p>
                    {hr.preferredTime && <p className="text-[10px] text-text-tertiary mt-1">Preferred time: {hr.preferredTime}</p>}
                    {hr.meetingLink && <a href={hr.meetingLink} target="_blank" rel="noreferrer" className="text-[10px] text-primary flex items-center gap-1 mt-1"><ExternalLink size={10} /> Meeting Link</a>}
                  </div>
                  {hr.status !== 'resolved' && (
                    <div className="flex items-center gap-2 ml-4">
                      <button onClick={() => handleResolveHelp(hr.id)} disabled={actionLoading === hr.id}
                        className="px-3 py-1.5 text-xs font-medium bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:opacity-50 flex items-center gap-1">
                        <Check size={12} /> Resolve
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function EmptyState({ icon: Icon, message }) {
  return (
    <div className="text-center py-16 bg-white rounded-xl border border-border">
      <Icon size={32} className="mx-auto text-text-tertiary mb-2" />
      <p className="text-sm text-text-secondary">{message}</p>
    </div>
  );
}
