import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { X, Bell, CheckCheck, Clock, AlertTriangle, Trash2, RotateCcw } from 'lucide-react';
import { parseISO, formatDistanceToNow } from 'date-fns';
import api from '../../services/api';
import { openTaskFromAnywhere } from '../../utils/taskNavigation';
import useRealtimeQuery from '../../realtime/useRealtimeQuery';
import { useAuth } from '../../context/AuthContext';
import AnistonLoader from './AnistonLoader';

const PAGE_SIZE = 50;

/**
 * NotificationsPanel — bell drawer.
 *
 * Phase 4 changes:
 *   - role="dialog" + aria-modal="true" + aria-labelledby on the drawer.
 *   - Esc closes; focus is trapped inside the drawer while open and
 *     returned to the bell on close.
 *   - Notification rows are <button>s (not div onClick) so keyboard users
 *     can Tab/Enter/Space.
 *   - Tab strip uses role="tablist" / role="tab" / aria-selected.
 *   - Pagination with "Load more" button — initial page = 50.
 *   - Distinct loading/empty/error states (introduced in Batch 2; kept).
 */
export default function NotificationsPanel({ onClose }) {
  const { authReady, user } = useAuth();
  const [notifications, setNotifications] = useState([]);
  const [tab, setTab] = useState('all');
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const drawerRef = useRef(null);
  const closeBtnRef = useRef(null);
  // Snapshot of the element that had focus when the drawer opened, so we
  // can return focus to it on close (the bell, typically).
  const previouslyFocusedRef = useRef(null);

  const loadNotifications = useCallback(async (opts = {}) => {
    // Don't fetch before AuthContext has bootstrapped — the request would
    // either succeed (cookie was already valid) or 401-then-silent-refresh,
    // which is the path that produced the "login to view" flicker users
    // saw. Wait for definitive state.
    if (!authReady || !user) {
      setLoading(true);
      return;
    }
    const targetPage = opts.append ? page + 1 : 1;
    if (opts.append) setLoadingMore(true);
    else setErrored(false);
    try {
      const res = await api.get('/notifications', {
        _silent: true,
        params: { page: targetPage, limit: PAGE_SIZE },
      });
      // Backend returns { notifications, pagination: { page, limit, total, totalPages } }.
      // The api interceptor flattens `data` so the fields land at the top level.
      const list = res.data.notifications || [];
      const pagination = res.data.pagination || null;
      setNotifications((prev) => (opts.append ? [...prev, ...list] : list));
      if (pagination) {
        setPage(pagination.page || targetPage);
        setHasMore((pagination.page || targetPage) < (pagination.totalPages || 1));
      } else {
        // Older server shape — assume single page if pagination missing.
        setHasMore(false);
      }
      setErrored(false);
    } catch (err) {
      // 401 is handled by the api interceptor (silent refresh). Other
      // errors (network, 500) leave the list with whatever it had and
      // surface a retry affordance — never a "login to view" message
      // when the user is in fact logged in.
      console.error('Failed to load notifications:', err?.message || err);
      if (!opts.append) setErrored(true);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [authReady, user, page]);

  // Initial load + re-load when auth resolves.
  useEffect(() => {
    // Snapshot the focused element so we can restore on close. Ref is
    // captured once on mount (when the drawer opens).
    if (typeof document !== 'undefined') {
      previouslyFocusedRef.current = document.activeElement;
    }
    loadNotifications();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, user]);

  // Live refresh — when a new notification arrives or a notification is
  // marked read on another tab, the realtime router fires
  // 'notifications.list' which we re-fetch (page 1 only, to avoid
  // re-fetching every loaded page on each event).
  useRealtimeQuery({ queryKey: 'notifications.list', refetch: () => loadNotifications() });

  // Esc to close + focus management.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
      // Light focus trap: when Tab moves focus out of the drawer, wrap it
      // back inside. Not a full WAI-ARIA dialog implementation, but enough
      // to keep keyboard users from accidentally tabbing to the page
      // beneath.
      if (e.key === 'Tab' && drawerRef.current) {
        const focusables = drawerRef.current.querySelectorAll(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input:not([disabled])'
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    // Defer initial focus so the drawer's open animation doesn't fight it.
    const t = setTimeout(() => {
      try { closeBtnRef.current?.focus(); } catch { /* ignore */ }
    }, 50);
    return () => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(t);
      // Restore focus to whatever opened the drawer (the bell button).
      try {
        if (previouslyFocusedRef.current && typeof previouslyFocusedRef.current.focus === 'function') {
          previouslyFocusedRef.current.focus();
        }
      } catch { /* ignore */ }
    };
  }, [onClose]);

  async function markAsRead(id) {
    try {
      await api.put(`/notifications/${id}/read`);
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
    } catch { /* ignore — UI will reconcile on next refetch */ }
  }

  async function markAllRead() {
    try {
      await api.put('/notifications/read-all');
      setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    } catch { /* ignore */ }
  }

  async function deleteOne(id, e) {
    e.stopPropagation();
    try {
      await api.delete(`/notifications/${id}`);
      setNotifications((prev) => prev.filter((n) => n.id !== id));
    } catch { /* ignore */ }
  }

  async function clearRead() {
    try {
      const res = await api.delete('/notifications/clear-read');
      const removed = res?.data?.deleted ?? 0;
      if (removed > 0) {
        setNotifications((prev) => prev.filter((n) => !n.isRead));
      }
    } catch { /* ignore */ }
  }

  // Type-aware click-through. Falls back to /my-work for unknown types.
  async function handleNotificationClick(n) {
    markAsRead(n.id);

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
    } else if (n.entityType === 'dependency_request' && n.entityId) {
      // Dependency requests live on /cross-team or in TaskModal — prefer
      // cross-team since we don't always have parentTaskId here.
      navigate('/cross-team');
    } else if (n.entityType === 'user') {
      // Open the Profile overlay-modal on top of whatever page the user
      // is currently on (App.jsx mounts the modal route when state.background
      // is set). On a direct visit this background is undefined and the
      // route falls back to the page-variant ProfilePage.
      navigate('/profile', { state: { background: location } });
    }

    onClose();
  }

  // Type-aware leading icon. Falls back to a small dot when no icon fits.
  function getNotificationIcon(n) {
    if (n.type === 'deadline_2hour' || n.type === 'priority_change') {
      return <AlertTriangle size={16} className="text-danger mt-0.5 flex-shrink-0" aria-hidden="true" />;
    }
    if (n.type === 'deadline_2day' || n.type === 'due_date') {
      return <Clock size={16} className="text-warning mt-0.5 flex-shrink-0" aria-hidden="true" />;
    }
    return null;
  }

  const filtered = tab === 'unread' ? notifications.filter((n) => !n.isRead) : notifications;

  return (
    // Overlay click closes the panel. The inner drawer stops propagation so
    // clicking inside doesn't trigger the close. role="presentation" keeps
    // the overlay out of the a11y tree — only the drawer is announced.
    <div
      className="fixed inset-0 z-50 bg-black/10"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={drawerRef}
        className="absolute right-0 top-0 h-full w-[380px] max-w-full bg-[var(--primary-background-color)] shadow-xl border-l border-border animate-slide-in-right flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="notifications-panel-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <h2 id="notifications-panel-title" className="text-lg font-bold text-text-primary">
            Notifications
          </h2>
          <button
            ref={closeBtnRef}
            onClick={onClose}
            aria-label="Close notifications"
            className="p-1 rounded-md hover:bg-surface text-text-secondary focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Tab strip + actions */}
        <div className="flex items-center gap-4 px-5 py-2 border-b border-border flex-shrink-0" role="tablist">
          {['all', 'unread'].map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              aria-controls="notifications-list"
              onClick={() => setTab(t)}
              className={`text-sm font-medium pb-1 capitalize focus:outline-none focus:ring-2 focus:ring-primary/40 rounded ${
                tab === t
                  ? 'text-primary border-b-2 border-primary'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {t}
            </button>
          ))}
          <button
            onClick={markAllRead}
            className="ml-auto text-xs text-primary hover:underline flex items-center gap-1 focus:outline-none focus:ring-2 focus:ring-primary/40 rounded px-1"
          >
            <CheckCheck size={13} aria-hidden="true" /> Mark all read
          </button>
          <button
            onClick={clearRead}
            aria-label="Clear read notifications"
            title="Clear read notifications"
            className="text-xs text-text-secondary hover:text-text-primary flex items-center gap-1 focus:outline-none focus:ring-2 focus:ring-primary/40 rounded p-1"
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        </div>

        {/* List */}
        <div
          id="notifications-list"
          className="overflow-y-auto flex-1 min-h-0"
          role="tabpanel"
          aria-labelledby={`tab-${tab}`}
        >
          {loading ? (
            <AnistonLoader variant="section" size="sm" label="Loading notifications" className="py-12" />
          ) : errored ? (
            // Distinct error state — never show "login to view" or any login
            // language while the user is actually logged in. Surface a retry
            // button instead so a transient network issue is recoverable.
            <div className="flex flex-col items-center justify-center py-16 text-text-secondary px-6 text-center" role="alert">
              <AlertTriangle size={28} className="mb-3 text-warning opacity-70" aria-hidden="true" />
              <p className="text-sm text-text-primary">Couldn't load notifications</p>
              <p className="text-xs mt-1">Check your connection and try again.</p>
              <button
                onClick={() => loadNotifications()}
                className="mt-4 inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                <RotateCcw size={12} aria-hidden="true" /> Retry
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-text-secondary" role="status">
              <Bell size={32} className="mb-3 opacity-30" aria-hidden="true" />
              <p className="text-sm">No notifications</p>
            </div>
          ) : (
            <>
              <ul className="list-none m-0 p-0">
                {filtered.map((n) => (
                  <li key={n.id} className="border-b border-border last:border-b-0">
                    {/*
                      Notification row is now a <button> so keyboard users can
                      Tab + Enter/Space. The delete button is a sibling button
                      inside the row to avoid nested-interactive issues — we
                      lay them out side-by-side and rely on the surrounding
                      <li> for the visual row.
                    */}
                    <div className={`group flex items-stretch border-b border-border last:border-b-0 ${!n.isRead ? 'bg-primary/5' : ''}`}>
                      <button
                        type="button"
                        onClick={() => handleNotificationClick(n)}
                        className="flex-1 flex items-start gap-3 px-5 py-3.5 text-left cursor-pointer hover:bg-surface/50 transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-inset"
                      >
                        {getNotificationIcon(n) || (
                          <div
                            className={`w-2 h-2 rounded-full mt-2 flex-shrink-0 ${!n.isRead ? 'bg-primary' : 'bg-transparent'}`}
                            aria-hidden="true"
                          />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className={`text-sm leading-snug ${!n.isRead ? 'text-text-primary font-medium' : 'text-text-primary'}`}>
                            {n.message}
                          </p>
                          <div className="flex items-center gap-2 mt-1">
                            <p className="text-xs text-text-secondary">
                              {n.createdAt ? formatDistanceToNow(parseISO(n.createdAt), { addSuffix: true }) : ''}
                            </p>
                            {n.type && (
                              <span className="text-[9px] text-primary/60 bg-primary/5 px-1.5 py-0.5 rounded capitalize">
                                {String(n.type).replace(/_/g, ' ')}
                              </span>
                            )}
                          </div>
                        </div>
                        {!n.isRead && <span className="sr-only">unread</span>}
                      </button>
                      <button
                        onClick={(e) => deleteOne(n.id, e)}
                        className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity px-3 text-text-secondary hover:text-danger focus:outline-none focus:ring-2 focus:ring-primary/40"
                        title="Delete notification"
                        aria-label="Delete notification"
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              {/* Pagination — server reports totalPages; we expose a simple
                  "Load more" rather than infinite scroll so keyboard users
                  can predictably reach it. */}
              {hasMore && (
                <div className="flex items-center justify-center py-4">
                  <button
                    onClick={() => loadNotifications({ append: true })}
                    disabled={loadingMore}
                    className="text-xs text-text-secondary hover:text-text-primary px-3 py-1.5 rounded-lg border border-border hover:bg-surface focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
                  >
                    {loadingMore ? 'Loading…' : 'Load more'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
