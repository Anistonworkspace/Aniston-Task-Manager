import React, { useState, useEffect } from 'react';
import { Plus, Edit3, Trash2, Calendar, Clock } from 'lucide-react';
import { format, parseISO, formatDistanceToNow } from 'date-fns';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';
import Avatar from '../common/Avatar';

export default function WorkLogSection({ taskId }) {
  const { user, canManage } = useAuth();
  const [logs, setLogs] = useState([]);
  const [adding, setAdding] = useState(false);
  const [content, setContent] = useState('');
  const [logDate, setLogDate] = useState(new Date().toISOString().slice(0, 10));
  const [editingId, setEditingId] = useState(null);
  const [editContent, setEditContent] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (taskId) loadLogs();
  }, [taskId]);

  async function loadLogs() {
    try {
      setLoading(true);
      const res = await api.get(`/worklogs?taskId=${taskId}`);
      setLogs(res.data.worklogs || res.data.data?.worklogs || []);
    } catch (err) {
      console.error('Failed to load work logs:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd() {
    if (!content.trim()) return;
    try {
      const res = await api.post('/worklogs', { content: content.trim(), taskId, date: logDate });
      const created = res.data.worklog || res.data.data?.worklog;
      if (created) {
        setLogs(prev => [created, ...prev]);
      }
      setContent('');
      setAdding(false);
    } catch (err) {
      console.error('Failed to create work log:', err);
    }
  }

  async function handleUpdate(id) {
    if (!editContent.trim()) return;
    try {
      const res = await api.put(`/worklogs/${id}`, { content: editContent.trim() });
      const updated = res.data.worklog || res.data.data?.worklog;
      setLogs(prev => prev.map(l => l.id === id ? { ...l, ...updated } : l));
      setEditingId(null);
      setEditContent('');
    } catch (err) {
      console.error('Failed to update work log:', err);
    }
  }

  async function handleDelete(id) {
    try {
      await api.delete(`/worklogs/${id}`);
      setLogs(prev => prev.filter(l => l.id !== id));
    } catch (err) {
      console.error('Failed to delete work log:', err);
    }
  }

  function startEdit(log) {
    setEditingId(log.id);
    setEditContent(log.content);
  }

  // Group logs by date
  const grouped = logs.reduce((acc, log) => {
    const d = log.date || log.createdAt?.slice(0, 10);
    if (!acc[d]) acc[d] = [];
    acc[d].push(log);
    return acc;
  }, {});
  const sortedDates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

  return (
    <div className="mb-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <label className="text-sm font-medium text-text-primary flex items-center gap-1.5">
          <Clock size={14} />
          Daily Updates
          {logs.length > 0 && <span className="text-text-tertiary font-normal">({logs.length})</span>}
        </label>
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            className="flex items-center gap-1 text-xs text-primary hover:text-primary-dark transition-colors"
          >
            <Plus size={14} /> Add update
          </button>
        )}
      </div>

      {/* Add form */}
      {adding && (
        <div className="mb-4 p-3 border border-border rounded-lg bg-surface/30">
          <div className="flex items-center gap-2 mb-2">
            <Calendar size={13} className="text-text-tertiary" />
            <input
              type="date"
              value={logDate}
              onChange={(e) => setLogDate(e.target.value)}
              className="text-xs border border-border rounded px-2 py-1 focus:outline-none focus:border-primary"
            />
          </div>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setAdding(false); setContent(''); } }}
            placeholder="What did you work on today?"
            className="w-full text-sm border border-border rounded-md px-3 py-2 focus:outline-none focus:border-primary resize-none min-h-[80px] mb-2"
            autoFocus
          />
          <div className="flex items-center gap-2">
            <button onClick={handleAdd} className="px-3 py-1.5 bg-primary text-white text-xs rounded-md hover:bg-primary-dark transition-colors">
              Save update
            </button>
            <button onClick={() => { setAdding(false); setContent(''); }} className="px-2 py-1.5 text-xs text-text-secondary hover:text-text-primary">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Logs list grouped by date */}
      {loading ? (
        <div className="text-center py-4 text-text-tertiary text-sm">Loading...</div>
      ) : logs.length === 0 ? (
        <div className="text-center py-6 text-text-tertiary text-sm">No updates yet</div>
      ) : (
        <div className="space-y-4">
          {sortedDates.map(dateStr => (
            <div key={dateStr}>
              <div className="text-xs font-medium text-text-secondary mb-2 flex items-center gap-1.5">
                <Calendar size={12} />
                {(() => {
                  try {
                    const d = parseISO(dateStr);
                    const today = new Date().toISOString().slice(0, 10);
                    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
                    if (dateStr === today) return 'Today';
                    if (dateStr === yesterday) return 'Yesterday';
                    return format(d, 'EEE, MMM d, yyyy');
                  } catch { return dateStr; }
                })()}
              </div>
              <div className="space-y-2 pl-1">
                {grouped[dateStr].map(log => {
                  const authorName = log.author?.name || 'Unknown';
                  const isOwn = log.userId === user?.id || log.author?.id === user?.id;
                  const canEdit = isOwn || canManage;

                  return (
                    <div key={log.id} className="flex gap-2.5 group">
                      <Avatar name={authorName} size="sm" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-sm font-medium text-text-primary">{authorName}</span>
                          <span className="text-xs text-text-tertiary">
                            {log.createdAt ? formatDistanceToNow(parseISO(log.createdAt), { addSuffix: true }) : ''}
                          </span>
                          {canEdit && (
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity ml-auto">
                              {isOwn && (
                                <button onClick={() => startEdit(log)} className="p-0.5 rounded hover:bg-surface text-text-tertiary hover:text-text-primary" title="Edit">
                                  <Edit3 size={12} />
                                </button>
                              )}
                              {canManage && (
                                <button onClick={() => handleDelete(log.id)} className="p-0.5 rounded hover:bg-red-50 text-text-tertiary hover:text-danger" title="Delete">
                                  <Trash2 size={12} />
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                        {editingId === log.id ? (
                          <div>
                            <textarea
                              value={editContent}
                              onChange={(e) => setEditContent(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Escape') { setEditingId(null); setEditContent(''); } }}
                              className="w-full text-sm border border-border rounded-md px-3 py-2 focus:outline-none focus:border-primary resize-none min-h-[60px] mb-1"
                              autoFocus
                            />
                            <div className="flex gap-2">
                              <button onClick={() => handleUpdate(log.id)} className="px-2 py-1 bg-primary text-white text-xs rounded hover:bg-primary-dark">Save</button>
                              <button onClick={() => { setEditingId(null); setEditContent(''); }} className="px-2 py-1 text-xs text-text-secondary">Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <p className="text-sm text-text-secondary whitespace-pre-wrap">{log.content}</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
