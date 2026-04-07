import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Bell, Check, CheckCheck, Clock, AlertTriangle } from 'lucide-react';
import { format, parseISO, formatDistanceToNow } from 'date-fns';
import api from '../../services/api';
import Avatar from './Avatar';

export default function NotificationsPanel({ onClose }) {
  const [notifications, setNotifications] = useState([]);
  const [tab, setTab] = useState('all');
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => { loadNotifications(); }, []);

  async function loadNotifications() {
    try {
      const res = await api.get('/notifications');
      setNotifications(res.data.notifications || res.data || []);
    } catch (err) {
      console.error('Failed to load notifications:', err);
    } finally {
      setLoading(false);
    }
  }

  async function markAsRead(id) {
    try {
      await api.put(`/notifications/${id}/read`);
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, isRead: true } : n));
    } catch {}
  }

  async function markAllRead() {
    try {
      await api.put('/notifications/read-all');
      setNotifications(prev => prev.map(n => ({ ...n, isRead: true })));
    } catch {}
  }

  function handleNotificationClick(n) {
    markAsRead(n.id);

    // Navigate to the correct entity
    if (n.entityType === 'task' && n.entityId) {
      // Try to find boardId from notification meta or fetch task
      api.get(`/tasks/${n.entityId}`).then(res => {
        const task = res.data?.task || res.data?.data?.task || res.data;
        if (task?.boardId) {
          navigate(`/boards/${task.boardId}`);
        }
      }).catch(() => {
        // Fallback to my-work
        navigate('/my-work');
      });
    } else if (n.entityType === 'board' && n.entityId) {
      navigate(`/boards/${n.entityId}`);
    } else if (n.entityType === 'meeting' && n.entityId) {
      navigate('/meetings');
    } else if (n.entityType === 'help_request') {
      navigate('/cross-team');
    }

    onClose();
  }

  function getNotificationIcon(n) {
    if (n.message?.includes('due in 2 hours') || n.message?.includes('2 hours remaining')) {
      return <AlertTriangle size={16} className="text-red-500 mt-0.5 flex-shrink-0" />;
    }
    if (n.message?.includes('due in 2 days') || n.message?.includes('2 days remaining')) {
      return <Clock size={16} className="text-amber-500 mt-0.5 flex-shrink-0" />;
    }
    return null;
  }

  const filtered = tab === 'unread' ? notifications.filter(n => !n.isRead) : notifications;

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="absolute right-0 top-0 h-full w-[380px] max-w-full bg-white dark:bg-dark-surface shadow-xl border-l border-border animate-slide-in-right" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-lg font-bold text-text-primary">Notifications</h2>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-surface text-text-secondary"><X size={18} /></button>
        </div>
        <div className="flex items-center gap-4 px-5 py-2 border-b border-border">
          {['all', 'unread'].map(t => (
            <button key={t} onClick={() => setTab(t)} className={`text-sm font-medium pb-1 capitalize ${tab === t ? 'text-primary border-b-2 border-primary' : 'text-text-secondary hover:text-text-primary'}`}>{t}</button>
          ))}
          <button onClick={markAllRead} className="ml-auto text-xs text-primary hover:underline flex items-center gap-1"><CheckCheck size={13} /> Mark all read</button>
        </div>
        <div className="overflow-y-auto h-[calc(100%-110px)]">
          {loading ? (
            <div className="flex items-center justify-center py-12"><div className="animate-spin rounded-full h-6 w-6 border-2 border-primary/20 border-t-primary" /></div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-text-secondary">
              <Bell size={32} className="mb-3 opacity-30" />
              <p className="text-sm">No notifications</p>
            </div>
          ) : (
            filtered.map(n => (
              <div key={n.id} onClick={() => handleNotificationClick(n)} className={`flex items-start gap-3 px-5 py-3.5 border-b border-border cursor-pointer hover:bg-surface/50 transition-colors ${!n.isRead ? 'bg-primary/5' : ''}`}>
                {getNotificationIcon(n) || <div className={`w-2 h-2 rounded-full mt-2 flex-shrink-0 ${!n.isRead ? 'bg-primary' : 'bg-transparent'}`} />}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-text-primary leading-snug">{n.message}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <p className="text-xs text-text-secondary">
                      {n.createdAt ? formatDistanceToNow(parseISO(n.createdAt), { addSuffix: true }) : ''}
                    </p>
                    {n.entityType && (
                      <span className="text-[9px] text-primary/60 bg-primary/5 px-1.5 py-0.5 rounded capitalize">{n.entityType.replace('_', ' ')}</span>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
