import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Bell, Clock, AlertTriangle, CheckCheck } from 'lucide-react';
import { parseISO, formatDistanceToNow } from 'date-fns';
import Modal from '../common/Modal';
import api from '../../services/api';
import { openTaskFromAnywhere } from '../../utils/taskNavigation';

/**
 * UpdatesModal — full-list view for the Home Updates tile.
 *
 * Reuses the shared <Modal> primitive (same focus trap, ESC + outside-click
 * close, scrollable body, app-wide styling). Notifications + unread count
 * are owned by HomePage so this component is purely presentational; it just
 * proxies mark-read / mark-all-read writes back through the parent's
 * `onMarkRead` callback (or directly to the API for batch ops).
 */
export default function UpdatesModal({
  isOpen,
  onClose,
  notifications = [],
  unreadCount = 0,
  onMarkRead,
}) {
  const navigate = useNavigate();
  const location = useLocation();

  // Match NotificationsPanel's icon mapping so the two surfaces feel like
  // one feature seen from two angles, not two parallel implementations.
  function leadingIcon(n) {
    if (n.type === 'deadline_2hour' || n.type === 'priority_change') {
      return <AlertTriangle size={16} className="text-red-500 mt-0.5 flex-shrink-0" aria-hidden="true" />;
    }
    if (n.type === 'deadline_2day' || n.type === 'due_date') {
      return <Clock size={16} className="text-amber-500 mt-0.5 flex-shrink-0" aria-hidden="true" />;
    }
    return (
      <span
        className={`mt-1.5 inline-block w-2 h-2 rounded-full flex-shrink-0 ${
          n.isRead ? 'bg-transparent border border-text-tertiary/40' : 'bg-primary-500'
        }`}
        aria-hidden="true"
      />
    );
  }

  async function handleClick(n) {
    onMarkRead?.(n.id);

    if (n.entityType === 'task' && n.entityId) {
      const opened = await openTaskFromAnywhere(navigate, {
        taskId: n.entityId,
        boardId: n.boardId || n.meta?.boardId,
      });
      if (!opened) navigate('/my-work');
    } else if (n.entityType === 'board' && n.entityId) {
      navigate(`/boards/${n.entityId}`);
    } else if (n.entityType === 'meeting' && n.entityId) {
      navigate('/meetings');
    } else if (n.entityType === 'access_request') {
      navigate('/access-requests');
    } else if (n.entityType === 'help_request') {
      navigate('/cross-team');
    } else if (n.entityType === 'dependency_request') {
      navigate('/cross-team');
    } else if (n.entityType === 'user') {
      navigate('/profile', { state: { background: location } });
    }
    onClose();
  }

  async function handleMarkAllRead() {
    try { await api.put('/notifications/read-all'); } catch { /* realtime reconciles */ }
    // Locally flip every entry — the realtime hook will reconcile on next event.
    notifications.forEach((n) => { if (!n.isRead) onMarkRead?.(n.id); });
  }

  const total = notifications.length;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      title="Updates"
      footer={
        unreadCount > 0 ? (
          <button
            type="button"
            onClick={handleMarkAllRead}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-primary-600 hover:bg-primary-50 dark:hover:bg-primary-900/20 rounded-md transition-colors"
          >
            <CheckCheck size={13} /> Mark all read
          </button>
        ) : null
      }
    >
      {total > 0 && (
        <div className="flex items-center gap-2 mb-3">
          <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded-full bg-surface-100 text-text-secondary text-[10px] font-semibold min-w-[18px]">
            {total} total
          </span>
          {unreadCount > 0 && (
            <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded-full bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300 text-[10px] font-semibold">
              {unreadCount} unread
            </span>
          )}
        </div>
      )}
      {total === 0 ? (
        <div className="flex flex-col items-center justify-center py-14 text-center">
          <Bell size={36} strokeWidth={1.4} className="text-text-tertiary mb-3 opacity-50" aria-hidden="true" />
          <p className="text-sm font-semibold text-text-primary">No updates</p>
          <p className="text-xs text-text-secondary mt-1">You're all caught up</p>
        </div>
      ) : (
        <ul className="-mx-1 divide-y divide-border" role="list">
          {notifications.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => handleClick(n)}
                className={`w-full flex items-start gap-3 px-3 py-3 text-left rounded-md transition-colors hover:bg-surface-50 dark:hover:bg-surface-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary-500 ${
                  !n.isRead ? 'bg-primary-50/40 dark:bg-primary-900/10' : ''
                }`}
              >
                {leadingIcon(n)}
                <div className="flex-1 min-w-0">
                  {/* Full message — no line-clamp. The whole point of opening
                      the modal is to read the full text. */}
                  <p className="text-sm text-text-primary leading-snug whitespace-pre-wrap break-words">
                    {n.message}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {n.createdAt && (
                      <span className="text-[11px] text-text-secondary">
                        {formatDistanceToNow(parseISO(n.createdAt), { addSuffix: true })}
                      </span>
                    )}
                    {n.type && (
                      <span className="text-[10px] font-medium text-primary-700 dark:text-primary-300 bg-primary-50 dark:bg-primary-900/20 px-1.5 py-0.5 rounded capitalize">
                        {String(n.type).replace(/_/g, ' ')}
                      </span>
                    )}
                    {n.entityType && (
                      <span className="text-[10px] text-text-tertiary">
                        · {String(n.entityType).replace(/_/g, ' ')}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
