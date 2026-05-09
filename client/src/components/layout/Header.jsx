import React, { useState, useRef, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Bell, Search, HelpCircle, LogOut, User, Settings, ChevronDown, Moon, Sun, Plus, Command, Menu, Link2, Mic, BookOpen, Puzzle, MessageSquare, Archive, Network, Clock } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { isExplicitlyDenied } from '../../utils/permissions';
import api from '../../services/api';
import Avatar from '../common/Avatar';
import NotificationsPanel from '../common/NotificationsPanel';
import GlobalSearch from '../common/GlobalSearch';
import KeyboardShortcuts from '../common/KeyboardShortcuts';
import useRealtimeQuery from '../../realtime/useRealtimeQuery';
import useRealtimeEvent from '../../realtime/useRealtimeEvent';
import { useToast } from '../common/Toast';
import { useTheme } from '../../context/ThemeContext';
import { requestPushPermission, isPushSupported, subscribeToPush, showLocalNotification } from '../../services/pushNotifications';

// Module-scope state for the push pipeline. Survives Header re-mounts (route
// change, theme toggle, HMR) so we don't re-prompt or re-subscribe on every
// render — but resets on full page reload, which is the right cadence for
// retrying a failed subscribe.
//
//   pushPermissionAttempted — true once we've called requestPushPermission().
//                            Re-mounts skip prompting unless we've never
//                            tried in this session.
//   pushSubscribeOk         — true once subscribeToPush succeeded. While
//                            false, we'll retry on next eligible Header
//                            mount (e.g. after the user logs in, or after
//                            VAPID is fixed and the page reloads).
let pushPermissionAttempted = false;
let pushSubscribeOk = false;

export default function Header({ onToggleSidebar }) {
  const { user, authReady, logout, isAdmin, isStrictAdmin, isSuperAdmin, granularPermissions,
    isTier1, isTier2, isTier3, isTier4, tierLabel } = useAuth();
  // Mirror the exact gates the sidebar used for these items so visibility
  // stays identical after the move. Each menu row in the profile dropdown is
  // gated on the same boolean its sidebar counterpart was — no role can
  // newly access (or lose) any of these pages because of this refactor.
  const canSeeAdminSettings = isStrictAdmin || isSuperAdmin || !!granularPermissions?.['admin_settings.view'];
  const canSeeIntegrations  = isStrictAdmin || isSuperAdmin || !!granularPermissions?.['integrations.view'];
  const canSeeFeedback      = isStrictAdmin || isSuperAdmin || !!granularPermissions?.['feedback.view'];
  const canSeeArchive       = isAdmin || isSuperAdmin || !!granularPermissions?.['archive.view'];
  // Org Chart uses an "opt-out" model in granularPermissions — the sidebar
  // showed it unless explicitly denied. Mirror that here so a role that
  // could see Org Chart in the sidebar can also see the new header icon.
  const canSeeOrgChart      = !isExplicitlyDenied('org_chart', 'view', isSuperAdmin, granularPermissions);
  const { success: toastSuccess, info: toastInfo, notify: toastNotify } = useToast();
  const { darkMode, toggleDarkMode } = useTheme();
  const location = useLocation();

  // Request push notification permission and subscribe to VAPID push.
  //
  // Two guards layered here:
  //   1. `authReady && user` — never prompt before AuthContext has finished
  //      its /auth/me bootstrap, and never prompt for an unauthenticated
  //      visitor. Without this, a logged-out user reaching the app via a
  //      protected route's spinner could see a permission prompt while we
  //      were still resolving who they are.
  //   2. Module-scope `pushPermissionAttempted` — re-mounts of the Header
  //      (route changes, theme toggle, HMR) do NOT re-prompt. Once per
  //      browser session is enough; if the user denied once, the permission
  //      API will short-circuit on subsequent calls anyway, but we don't
  //      want a no-op dialog flashing the user's attention.
  useEffect(() => {
    if (!authReady || !user) return;
    if (!isPushSupported()) return;

    // First-time path: prompt for permission (once per session) and then
    // subscribe. If the user previously granted permission, the prompt is
    // skipped and we go straight to subscribe.
    if (!pushPermissionAttempted) {
      pushPermissionAttempted = true;
      requestPushPermission().then(async (perm) => {
        if (perm !== 'granted') return;
        const result = await subscribeToPush();
        pushSubscribeOk = !!result?.ok;
      });
      return;
    }

    // Retry path: a previous subscribe attempt failed (VAPID misconfigured,
    // network blip, etc.). On each subsequent eligible Header mount we
    // re-attempt without re-prompting — the permission was already granted.
    // This makes "fix .env, restart server, reload the tab" recover without
    // requiring the user to re-allow notifications manually.
    if (!pushSubscribeOk && Notification.permission === 'granted') {
      subscribeToPush().then((result) => { pushSubscribeOk = !!result?.ok; });
    }
  }, [authReady, user]);

  // Notification side-effects:
  //
  //   1. In-app toast — fires unconditionally. Cleanly invisible on
  //      backgrounded tabs (the user won't see it until they refocus, and
  //      that's fine).
  //   2. Foreground OS notification (safety net) — fires ONLY when the tab
  //      is HIDDEN (document.hidden=true). When the tab is focused, the
  //      toast is the visible surface and the OS notification would be a
  //      duplicate in the user's view.
  //
  // The safety net uses the SAME stable `notif-<id>` tag the SW push uses,
  // so when both the SW push (from backend Web Push) AND the foreground
  // local notification fire for the same event, browsers tag-collapse them
  // into a single OS-tray entry. That gives us:
  //   - SW push works (VAPID configured, subscription active) → SW handles
  //     OS notification, foreground call is a no-op tag-collision update.
  //   - SW push fails (VAPID misconfig, no subscription) → foreground call
  //     fires the OS notification anyway, so the user is never silently
  //     skipped.
  //   - Tab focused → showLocalNotification's internal `document.hasFocus()`
  //     guard short-circuits, only the toast fires.
  //
  // The structured `notify(...)` toast shape renders as a Teams-style card
  // with a type-aware title and a click-through to the linked task.
  useRealtimeEvent('notification:new', (data) => {
    const n = data?.notification;
    const msg = n?.message;
    if (!msg) return;
    const titleByType = {
      task_assigned: 'Task assigned',
      task_supervisor_added: 'Supervisor role',
      task_role_changed: 'Role updated',
      task_removed: 'Removed from task',
      task_updated: 'Task update',
      comment_added: 'New comment',
      due_date: 'Deadline reminder',
      mention: 'You were mentioned',
      approval_submitted: 'Approval needed',
      approval_approved: 'Approval needed',
      approval_rejected: 'Approval rejected',
      approval_changes_requested: 'Changes requested',
      approval_completed: 'Task approved',
      access_requested: 'Access request',
      access_approved: 'Access approved',
      access_rejected: 'Access rejected',
      extension_requested: 'Extension requested',
      extension_approved: 'Extension approved',
      extension_rejected: 'Extension rejected',
      help_requested: 'Help requested',
      help_responded: 'Help update',
      promotion: 'Promotion',
      priority_change: 'Priority changed',
      deadline_2day: 'Deadline in 2 days',
      deadline_2hour: 'Deadline in 2 hours',
      recurring_generated: 'New recurring task',
      recurring_missed: 'Recurring task missed',
    };
    const toastTitle = titleByType[n?.type] || 'New notification';
    toastNotify({
      title: toastTitle,
      body: msg,
      duration: 5000,
      // Click-through: navigate to the linked task / board / etc. Mirrors the
      // logic in NotificationsPanel's handleNotificationClick.
      onClick: () => {
        const boardId = n?.boardId || data?.boardId;
        if (n?.entityType === 'task' && n?.entityId) {
          if (boardId) navigate(`/boards/${boardId}?taskId=${n.entityId}`);
          else navigate(`/my-work?taskId=${n.entityId}`);
        } else if (n?.entityType === 'board' && n?.entityId) {
          navigate(`/boards/${n.entityId}`);
        } else if (n?.entityType === 'meeting') {
          navigate('/meetings');
        } else if (n?.entityType === 'access_request') {
          navigate('/access-requests');
        } else if (n?.entityType === 'help_request' || n?.entityType === 'dependency_request') {
          navigate('/cross-team');
        }
      },
    });

    // Safety-net OS notification — covers the case where backend Web Push
    // is misconfigured (no VAPID, expired subscription, etc.) so the SW
    // never fires. Internal `document.hasFocus()` guard inside
    // showLocalNotification means a focused tab silently no-ops; ONLY a
    // hidden/backgrounded tab fires this. The stable `notif-<id>` tag
    // matches the SW push tag, so when both fire, browsers collapse them
    // into a single OS-tray entry.
    if (n?.id && Notification && Notification.permission === 'granted') {
      const boardId = n?.boardId || data?.boardId;
      let url = '/';
      if (n.entityType === 'task' && n.entityId) {
        url = boardId ? `/boards/${boardId}?taskId=${n.entityId}` : `/my-work?taskId=${n.entityId}`;
      } else if (n.entityType === 'board' && n.entityId) {
        url = `/boards/${n.entityId}`;
      } else if (n.entityType === 'meeting') {
        url = '/meetings';
      } else if (n.entityType === 'access_request') {
        url = '/access-requests';
      } else if (n.entityType === 'help_request' || n.entityType === 'dependency_request') {
        url = '/cross-team';
      }
      showLocalNotification(toastTitle, {
        body: msg,
        tag: `notif-${n.id}`,
        url,
      });
    }
  });
  useRealtimeEvent('task:unblocked', (data) => { toastSuccess(`Task "${data?.title || 'task'}" unblocked!`); });
  useRealtimeEvent('task:delegated', (data) => { toastInfo(`"${data?.title || 'Task'}" delegated to you`); });

  const navigate = useNavigate();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const menuRef = useRef(null);

  // Load unread count once auth has finished bootstrapping. Without the
  // `authReady && user` gate the fetch could fire during the brief window
  // where a stale legacy storage token is still attached but the cookie
  // session has already been invalidated server-side — that produces a 401,
  // a silent refresh, and a confusing flicker in the bell badge. Gating on
  // confirmed auth state makes the bell deterministic.
  useEffect(() => {
    if (!authReady || !user) return;
    loadUnreadCount();
  }, [authReady, user]);

  // Unread count is a derived cache — every notification:new + notification:read
  // event invalidates 'notifications.unreadCount' via the router, refetching once.
  useRealtimeQuery({ queryKey: 'notifications.unreadCount', refetch: loadUnreadCount });

  useEffect(() => {
    function handleClick(e) { if (menuRef.current && !menuRef.current.contains(e.target)) setShowUserMenu(false); }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  useEffect(() => {
    function handleKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); setShowGlobalSearch(true); }
      if (e.key === '?' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) { e.preventDefault(); setShowShortcuts(true); }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  async function loadUnreadCount() {
    // Defensive guard: the realtime invalidation hook can fire during the
    // brief window between logout and Header unmount. Without this check we
    // fire an authenticated GET for a user who just signed out — the
    // request 401s, the interceptor tries a silent refresh that itself
    // 401s, and the user is bounced to /login mid-logout, occasionally
    // racing the explicit navigate('/login') the menu already invoked.
    if (!authReady || !user) {
      setUnreadCount(0);
      return;
    }
    try {
      const res = await api.get('/notifications/unread-count', { _silent: true });
      setUnreadCount(res.data.unreadCount || res.data.count || 0);
    } catch {
      // Silent — interceptor handles 401 with refresh + retry; any other
      // error is non-actionable for the bell badge.
    }
  }

  // Page title from route
  const getPageTitle = () => {
    const path = location.pathname;
    if (path === '/') return 'Home';
    if (path === '/my-work') return 'My Work';
    if (path === '/dashboard') return 'Dashboard';
    if (path === '/time-plan') return 'Time Plan';
    if (path === '/meetings') return 'Meetings';
    if (path === '/reviews') return 'Reviews';
    if (path === '/users') return 'Team';
    if (path === '/profile') return 'Profile';
    if (path === '/org-chart') return 'Org Chart';
    if (path === '/cross-team') return 'Dependencies';
    if (path === '/admin-settings') return 'Admin Settings';
    if (path === '/admin-dashboard') return 'My Dashboard';
    if (path === '/manager-dashboard') return 'My Dashboard';
    if (path === '/member-dashboard') return 'My Dashboard';
    if (path === '/tasks') return 'Tasks & Workflows';
    if (path === '/integrations') return 'Integrations';
    if (path === '/archive') return 'Archive';
    if (path.startsWith('/boards/')) return 'Board';
    return '';
  };

  return (
    <>
      <header className="h-[52px] bg-white dark:bg-[#1E1F23] border-b border-border dark:border-[#222327] flex items-center justify-between px-5 flex-shrink-0 z-20">
        {/* Left: Hamburger (mobile) + Breadcrumb + Search */}
        <div className="flex items-center gap-4">
          {/* Mobile hamburger */}
          {onToggleSidebar && (
            <button onClick={onToggleSidebar} className="md:hidden p-1.5 rounded-lg hover:bg-surface text-text-secondary" aria-label="Toggle sidebar">
              <Menu size={20} />
            </button>
          )}
          {/* Page context */}
          <div className="hidden md:flex items-center gap-1.5 text-sm">
            <span className="text-text-tertiary">Monday Aniston</span>
            <span className="text-text-muted">/</span>
            <span className="text-text-primary font-medium">{getPageTitle()}</span>
          </div>

          {/* Command Palette Trigger */}
          <button data-tour="search-bar" onClick={() => setShowGlobalSearch(true)}
            className="flex items-center gap-2 text-text-tertiary hover:text-text-secondary px-3 py-1.5 rounded-lg border border-border hover:border-border-dark bg-surface-50 transition-all duration-150 group">
            <Search size={14} />
            <span className="text-xs hidden sm:inline">Search...</span>
            <kbd className="hidden lg:inline-flex items-center text-[10px] text-text-muted bg-surface px-1.5 py-0.5 rounded border border-border font-mono ml-3 group-hover:border-border-dark">
              ⌘K
            </kbd>
          </button>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-1">
          {/* Dependencies — moved from sidebar */}
          <button data-tour="nav-dependencies-header" onClick={() => navigate('/cross-team')}
            title="Dependencies"
            aria-label="Dependencies"
            className={`p-2 rounded-lg hover:bg-surface-100 transition-all duration-150 ${location.pathname === '/cross-team' ? 'text-primary-500 bg-surface-100' : 'text-text-tertiary hover:text-text-primary'}`}>
            <Link2 size={17} strokeWidth={1.8} />
          </button>

          {/* Org Chart — moved from sidebar. Opt-out gate matches the
              sidebar's previous isExplicitlyDenied check exactly. */}
          {canSeeOrgChart && (
            <button data-tour="nav-orgchart-header" onClick={() => navigate('/org-chart')}
              title="Org Chart"
              aria-label="Org Chart"
              className={`p-2 rounded-lg hover:bg-surface-100 transition-all duration-150 ${location.pathname === '/org-chart' ? 'text-primary-500 bg-surface-100' : 'text-text-tertiary hover:text-text-primary'}`}>
              <Network size={17} strokeWidth={1.8} aria-hidden="true" />
            </button>
          )}

          {/* Time Plan — moved from sidebar. No gate (sidebar version was
              also unconditional). */}
          <button data-tour="nav-timeplan-header" onClick={() => navigate('/time-plan')}
            title="Time Plan"
            aria-label="Time Plan"
            className={`p-2 rounded-lg hover:bg-surface-100 transition-all duration-150 ${location.pathname === '/time-plan' ? 'text-primary-500 bg-surface-100' : 'text-text-tertiary hover:text-text-primary'}`}>
            <Clock size={17} strokeWidth={1.8} />
          </button>

          {/* Notes — moved from sidebar */}
          <button data-tour="nav-notes-header" onClick={() => navigate('/notes')}
            title="Notes"
            aria-label="Notes"
            className={`p-2 rounded-lg hover:bg-surface-100 transition-all duration-150 ${location.pathname === '/notes' ? 'text-primary-500 bg-surface-100' : 'text-text-tertiary hover:text-text-primary'}`}>
            <Mic size={17} strokeWidth={1.8} />
          </button>

          {/* Help & SOP — moved from sidebar (BookOpen distinguishes it from
              the existing HelpCircle which opens the keyboard shortcuts modal).
              Opens the Profile overlay-modal at the Guide section by passing
              the current location as `state.background` (App.jsx mounts the
              modal route on top of the existing page). */}
          <button data-tour="nav-helpsop-header" onClick={() => navigate('/profile#guide', { state: { background: location } })}
            title="Help & SOP"
            aria-label="Help & SOP"
            className="p-2 rounded-lg hover:bg-surface-100 transition-all duration-150 text-text-tertiary hover:text-text-primary">
            <BookOpen size={17} strokeWidth={1.8} />
          </button>

          {/* Sub-separator between page-nav icons and notification/system icons */}
          <div className="h-5 w-px bg-border mx-1 hidden sm:block" />

          {/* Notifications. aria-label is a static description; the badge
              text becomes part of the accessible name via aria-label so
              screen readers announce "Notifications, 3 unread" — the
              `aria-live` on the badge is only triggered when the count
              changes after first paint, so the user isn't re-announced on
              every re-render. */}
          <button
            data-tour="notifications"
            onClick={() => setShowNotifications(!showNotifications)}
            aria-label={unreadCount > 0
              ? `Notifications, ${unreadCount} unread`
              : 'Notifications'}
            aria-expanded={showNotifications}
            aria-haspopup="dialog"
            className="relative p-2 rounded-lg hover:bg-surface-100 transition-all duration-150 text-text-tertiary hover:text-text-primary"
          >
            <Bell size={17} strokeWidth={1.8} aria-hidden="true" />
            {unreadCount > 0 && (
              <span
                className="absolute top-1 right-1 bg-danger text-white text-[8px] font-bold rounded-full min-w-[14px] h-[14px] flex items-center justify-center px-0.5 ring-2 ring-white dark:ring-[#1E1F23]"
                aria-live="polite"
                aria-atomic="true"
              >
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>

          {/* Theme Toggle */}
          <button data-tour="theme-toggle" onClick={toggleDarkMode}
            className="p-2 rounded-lg hover:bg-surface-100 transition-all duration-150 text-text-tertiary hover:text-text-primary"
            title={darkMode ? 'Light mode' : 'Dark mode'}>
            {darkMode ? <Sun size={17} strokeWidth={1.8} /> : <Moon size={17} strokeWidth={1.8} />}
          </button>

          {/* Help */}
          <button onClick={() => setShowShortcuts(true)}
            className="p-2 rounded-lg hover:bg-surface-100 transition-all duration-150 text-text-tertiary hover:text-text-primary">
            <HelpCircle size={17} strokeWidth={1.8} />
          </button>

          {/* Separator */}
          <div className="h-5 w-px bg-border mx-1" />

          {/* User Menu */}
          <div ref={menuRef} className="relative">
            <button data-tour="profile-menu" onClick={() => setShowUserMenu(!showUserMenu)}
              className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-surface-100 transition-all duration-150">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-primary-500 to-primary-400 flex items-center justify-center text-white text-[11px] font-semibold shadow-sm">
                {user?.name?.charAt(0)?.toUpperCase() || 'U'}
              </div>
              <span className="hidden md:inline text-sm text-text-primary font-medium">{user?.name?.split(' ')[0]}</span>
              <ChevronDown size={12} className={`text-text-tertiary transition-transform duration-150 ${showUserMenu ? 'rotate-180' : ''}`} />
            </button>

            {showUserMenu && (
              <div className="absolute right-0 top-full mt-1.5 w-60 bg-white dark:bg-[#1E1F23] rounded-xl shadow-dropdown border border-border dark:border-[#222327] py-1 z-50 dropdown-enter overflow-hidden">
                <div className="px-4 py-3 border-b border-border dark:border-[#222327]">
                  <p className="text-sm font-semibold text-text-primary">{user?.name}</p>
                  <p className="text-xs text-text-tertiary mt-0.5">{user?.email}</p>
                  <div className="flex items-center gap-1.5 mt-2">
                    {/* Phase 6 — tier-based badge. Color reflects privilege:
                        Tier 1 = danger (most privileged), Tier 2 = warning,
                        Tier 3 = primary, Tier 4 = neutral. Old role names are
                        no longer rendered anywhere in the UI. */}
                    <span className={`badge ${
                      isTier1 ? 'badge-danger'
                      : isTier2 ? 'badge-warning'
                      : isTier3 ? 'badge-primary'
                      : 'badge-neutral'
                    }`}>{tierLabel}</span>
                    {user?.department && <span className="badge badge-neutral">{user.department}</span>}
                  </div>
                </div>
                <div className="py-1">
                  <button onClick={() => { navigate('/profile', { state: { background: location } }); setShowUserMenu(false); }}
                    className="flex items-center gap-3 px-4 py-2 text-sm hover:bg-surface-50 w-full transition-colors text-text-secondary hover:text-text-primary">
                    <User size={15} strokeWidth={1.8} /> My Profile
                  </button>
                  {/* Administration → Admin Settings page. Gate matches the
                      sidebar's old check exactly (was canManage before; the
                      sidebar version is stricter, so we adopt it here so a
                      role that couldn't see Admin Settings in the sidebar
                      can't see Administration here either). */}
                  {canSeeAdminSettings && (
                    <button onClick={() => { navigate('/admin-settings'); setShowUserMenu(false); }}
                      className="flex items-center gap-3 px-4 py-2 text-sm hover:bg-surface-50 w-full transition-colors text-text-secondary hover:text-text-primary">
                      <Settings size={15} strokeWidth={1.8} /> Administration
                    </button>
                  )}
                  {canSeeIntegrations && (
                    <button onClick={() => { navigate('/integrations'); setShowUserMenu(false); }}
                      className="flex items-center gap-3 px-4 py-2 text-sm hover:bg-surface-50 w-full transition-colors text-text-secondary hover:text-text-primary">
                      <Puzzle size={15} strokeWidth={1.8} /> Integrations
                    </button>
                  )}
                  {canSeeFeedback && (
                    <button onClick={() => { navigate('/feedback'); setShowUserMenu(false); }}
                      className="flex items-center gap-3 px-4 py-2 text-sm hover:bg-surface-50 w-full transition-colors text-text-secondary hover:text-text-primary">
                      <MessageSquare size={15} strokeWidth={1.8} /> Feedback
                    </button>
                  )}
                  {canSeeArchive && (
                    <button onClick={() => { navigate('/archive'); setShowUserMenu(false); }}
                      className="flex items-center gap-3 px-4 py-2 text-sm hover:bg-surface-50 w-full transition-colors text-text-secondary hover:text-text-primary">
                      <Archive size={15} strokeWidth={1.8} /> Archive
                    </button>
                  )}
                </div>
                <div className="border-t border-border dark:border-[#222327]" />
                <button onClick={() => { logout(); navigate('/login'); }}
                  className="flex items-center gap-3 px-4 py-2 text-sm text-danger hover:bg-danger/5 w-full transition-colors">
                  <LogOut size={15} strokeWidth={1.8} /> Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      {showNotifications && <NotificationsPanel onClose={() => { setShowNotifications(false); loadUnreadCount(); }} />}
      {showGlobalSearch && <GlobalSearch onClose={() => setShowGlobalSearch(false)} />}
      {showShortcuts && <KeyboardShortcuts onClose={() => setShowShortcuts(false)} />}
    </>
  );
}
