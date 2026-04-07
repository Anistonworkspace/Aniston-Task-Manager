import React, { useState, useEffect } from 'react';
import { MessageSquare, Star, Filter, ChevronDown, ChevronUp, Save, Trash2, BarChart3 } from 'lucide-react';
import api from '../services/api';

const CATEGORIES = [
  { value: 'bug', label: 'Bug Report', color: '#e2445c' },
  { value: 'feature', label: 'Feature Request', color: '#0073ea' },
  { value: 'improvement', label: 'Improvement', color: '#fdab3d' },
  { value: 'praise', label: 'Praise', color: '#00c875' },
  { value: 'other', label: 'Other', color: '#a25ddc' },
];

const STATUSES = [
  { value: 'new', label: 'New', color: '#0073ea' },
  { value: 'reviewed', label: 'Reviewed', color: '#fdab3d' },
  { value: 'in_progress', label: 'In Progress', color: '#a25ddc' },
  { value: 'resolved', label: 'Resolved', color: '#00c875' },
  { value: 'dismissed', label: 'Dismissed', color: '#c4c4c4' },
];

function StarRating({ value }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map(n => (
        <Star key={n} size={12} className={n <= value ? 'text-amber-400 fill-amber-400' : 'text-gray-300'} />
      ))}
    </div>
  );
}

export default function FeedbackPage() {
  const [feedback, setFeedback] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [filterCategory, setFilterCategory] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterRating, setFilterRating] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editStatus, setEditStatus] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [showStats, setShowStats] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  useEffect(() => { loadFeedback(); loadStats(); }, [page, filterCategory, filterStatus, filterRating]);

  async function loadFeedback() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page, limit: 15 });
      if (filterCategory) params.append('category', filterCategory);
      if (filterStatus) params.append('status', filterStatus);
      if (filterRating) params.append('rating', filterRating);

      const res = await api.get(`/feedback?${params}`);
      setFeedback(res.data.feedback || []);
      setTotal(res.data.total || 0);
      setTotalPages(res.data.totalPages || 1);
    } catch (err) {
      console.error('Failed to load feedback:', err);
    } finally {
      setLoading(false);
    }
  }

  async function loadStats() {
    try {
      const res = await api.get('/feedback/stats');
      setStats(res.data);
    } catch {}
  }

  async function handleUpdateFeedback(id) {
    setSaving(true);
    try {
      const res = await api.put(`/feedback/${id}`, { status: editStatus, adminNotes: editNotes });
      const updated = res.data.feedback;
      setFeedback(prev => prev.map(f => f.id === id ? updated : f));
      setEditingId(null);
      loadStats();
    } catch {} finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    try {
      await api.delete(`/feedback/${id}`);
      setFeedback(prev => prev.filter(f => f.id !== id));
      setDeleteConfirm(null);
      loadStats();
    } catch {}
  }

  function startEdit(item) {
    setEditingId(item.id);
    setEditStatus(item.status);
    setEditNotes(item.adminNotes || '');
    setExpandedId(item.id);
  }

  const getCategoryInfo = (val) => CATEGORIES.find(c => c.value === val) || CATEGORIES[4];
  const getStatusInfo = (val) => STATUSES.find(s => s.value === val) || STATUSES[0];

  const formatDate = (dateStr) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  };

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <MessageSquare size={24} className="text-blue-500" />
            Feedback Management
          </h1>
          <p className="text-sm text-gray-500 mt-1">{total} feedback entr{total !== 1 ? 'ies' : 'y'}</p>
        </div>
        <button onClick={() => setShowStats(!showStats)}
          className="px-3 py-2 text-xs font-medium text-gray-500 hover:text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors flex items-center gap-1.5">
          <BarChart3 size={13} /> {showStats ? 'Hide' : 'Show'} Stats
        </button>
      </div>

      {/* Stats Cards */}
      {showStats && stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-4">
            <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Total</p>
            <p className="text-2xl font-bold text-gray-800 dark:text-white mt-1">{stats.total}</p>
          </div>
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-4">
            <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Avg Rating</p>
            <div className="flex items-center gap-2 mt-1">
              <p className="text-2xl font-bold text-amber-500">{stats.avgRating}</p>
              <Star size={16} className="text-amber-400 fill-amber-400" />
            </div>
          </div>
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-4">
            <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">By Category</p>
            <div className="mt-2 space-y-1">
              {(stats.byCategory || []).map(c => {
                const info = getCategoryInfo(c.category);
                return (
                  <div key={c.category} className="flex items-center justify-between text-[11px]">
                    <span style={{ color: info.color }} className="font-medium">{info.label}</span>
                    <span className="text-gray-500">{c.count}</span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-4">
            <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">By Rating</p>
            <div className="mt-2 space-y-1">
              {(stats.byRating || []).map(r => (
                <div key={r.rating} className="flex items-center justify-between text-[11px]">
                  <div className="flex items-center gap-1">
                    {r.rating}<Star size={9} className="text-amber-400 fill-amber-400" />
                  </div>
                  <span className="text-gray-500">{r.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <div className="flex items-center gap-1.5">
          <Filter size={13} className="text-gray-400" />
          <select value={filterCategory} onChange={e => { setFilterCategory(e.target.value); setPage(1); }}
            className="text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 focus:outline-none focus:border-blue-400">
            <option value="">All Categories</option>
            {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
        <select value={filterStatus} onChange={e => { setFilterStatus(e.target.value); setPage(1); }}
          className="text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 focus:outline-none focus:border-blue-400">
          <option value="">All Statuses</option>
          {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select value={filterRating} onChange={e => { setFilterRating(e.target.value); setPage(1); }}
          className="text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 focus:outline-none focus:border-blue-400">
          <option value="">All Ratings</option>
          {[5, 4, 3, 2, 1].map(r => <option key={r} value={r}>{r} Star{r !== 1 ? 's' : ''}</option>)}
        </select>
      </div>

      {/* Feedback List */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="bg-white dark:bg-gray-900 rounded-xl p-5 border border-gray-100 dark:border-gray-800 animate-pulse">
              <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-2/5 mb-2" />
              <div className="h-3 bg-gray-100 dark:bg-gray-800 rounded w-1/3" />
            </div>
          ))}
        </div>
      ) : feedback.length === 0 ? (
        <div className="text-center py-16">
          <MessageSquare size={40} className="text-gray-300 dark:text-gray-600 mx-auto mb-3" />
          <p className="text-sm text-gray-400">No feedback found.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {feedback.map(item => {
            const isExpanded = expandedId === item.id;
            const isEditing = editingId === item.id;
            const catInfo = getCategoryInfo(item.category);
            const statusInfo = getStatusInfo(item.status);

            return (
              <div key={item.id}
                className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-xl overflow-hidden hover:border-gray-200 dark:hover:border-gray-700 transition-colors shadow-sm">
                {/* Header row */}
                <div className="flex items-center gap-3 px-5 py-3.5 cursor-pointer"
                  onClick={() => { setExpandedId(isExpanded ? null : item.id); if (isEditing && !isExpanded) setEditingId(null); }}>
                  <ChevronDown size={14} className={`text-gray-400 transition-transform flex-shrink-0 ${isExpanded ? '' : '-rotate-90'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full text-white flex-shrink-0"
                        style={{ backgroundColor: catInfo.color }}>
                        {catInfo.label}
                      </span>
                      <StarRating value={item.rating} />
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full border flex-shrink-0"
                        style={{ color: statusInfo.color, borderColor: statusInfo.color + '40' }}>
                        {statusInfo.label}
                      </span>
                    </div>
                    <p className="text-sm text-gray-700 dark:text-gray-300 mt-1 truncate">{item.message}</p>
                    <div className="flex items-center gap-3 text-[11px] text-gray-400 mt-0.5 flex-wrap">
                      <span className="font-medium text-gray-500 dark:text-gray-300">{item.submitter?.name || 'Unknown'}</span>
                      {item.submitter?.email && (
                        <span className="text-gray-400">{item.submitter.email}</span>
                      )}
                      <span>{formatDate(item.createdAt)}</span>
                      {item.page && (
                        <span
                          className="inline-flex items-center px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-[10px] font-mono text-blue-500 dark:text-blue-400 cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                          onClick={(e) => { e.stopPropagation(); window.open(item.page, '_blank'); }}
                          title={`Go to ${item.page}`}
                        >
                          {item.page}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
                    <button onClick={() => startEdit(item)}
                      className="p-1.5 text-gray-400 hover:text-blue-500 rounded-md hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors">
                      <Save size={13} />
                    </button>
                    <button onClick={() => setDeleteConfirm(item.id)}
                      className="p-1.5 text-gray-400 hover:text-red-500 rounded-md hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                {/* Expanded content */}
                {isExpanded && (
                  <div className="px-5 pb-4 border-t border-gray-100 dark:border-gray-800 pt-3">
                    <p className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap mb-3">{item.message}</p>

                    {isEditing ? (
                      <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 space-y-3">
                        <div>
                          <label className="text-[11px] font-medium text-gray-500 mb-1 block">Status</label>
                          <select value={editStatus} onChange={e => setEditStatus(e.target.value)}
                            className="text-xs border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 focus:outline-none focus:border-blue-400 w-full">
                            {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="text-[11px] font-medium text-gray-500 mb-1 block">Admin Notes</label>
                          <textarea value={editNotes} onChange={e => setEditNotes(e.target.value)}
                            rows={3} placeholder="Add admin notes..."
                            className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 resize-none focus:outline-none focus:border-blue-400" />
                        </div>
                        <div className="flex justify-end gap-2">
                          <button onClick={() => setEditingId(null)}
                            className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors">Cancel</button>
                          <button onClick={() => handleUpdateFeedback(item.id)} disabled={saving}
                            className="px-4 py-1.5 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-xs font-medium transition-colors disabled:opacity-50">
                            {saving ? 'Saving...' : 'Update'}
                          </button>
                        </div>
                      </div>
                    ) : item.adminNotes ? (
                      <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 mt-2">
                        <p className="text-[11px] font-medium text-blue-600 dark:text-blue-400 mb-1">Admin Notes</p>
                        <p className="text-xs text-gray-600 dark:text-gray-400">{item.adminNotes}</p>
                      </div>
                    ) : null}
                  </div>
                )}

                {/* Delete confirmation */}
                {deleteConfirm === item.id && (
                  <div className="px-5 pb-3 flex items-center gap-2 text-xs">
                    <span className="text-red-500 font-medium">Delete this feedback?</span>
                    <button onClick={() => handleDelete(item.id)}
                      className="px-2 py-1 bg-red-500 text-white rounded text-[11px] font-medium hover:bg-red-600 transition-colors">Yes, delete</button>
                    <button onClick={() => setDeleteConfirm(null)}
                      className="px-2 py-1 text-gray-500 hover:text-gray-700 text-[11px] transition-colors">Cancel</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-6">
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
            className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 transition-colors">
            Previous
          </button>
          <span className="text-xs text-gray-500">Page {page} of {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
            className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40 transition-colors">
            Next
          </button>
        </div>
      )}
    </div>
  );
}
