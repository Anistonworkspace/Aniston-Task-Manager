import React, { useState, useRef, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Bell, Search, HelpCircle, LogOut, User, Settings, ChevronDown, Moon, Sun, Plus, Command, Menu, Waypoints, Mic, BookOpen, Puzzle, MessageSquare, Archive, Network, Clock, Download, RotateCw } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useT } from '../../context/LanguageContext';
import { isExplicitlyDenied } from '../../utils/permissions';
import { isDesktopApp } from '../../utils/runtime';
import api from '../../services/api';
import Avatar from '../common/Avatar';
import NotificationsPanel from '../common/NotificationsPanel';
import ErrorBoundary from '../common/ErrorBoundary';
import GlobalSearch from '../common/GlobalSearch';
import KeyboardShortcuts from '../common/KeyboardShortcuts';
import { useConfirm } from '../common/ConfirmDialog';
import useRealtimeQuery from '../../realtime/useRealtimeQuery';
import useRealtimeEvent from '../../realtime/useRealtimeEvent';
import { useToast } from '../common/Toast';
import { useTheme } from '../../context/ThemeContext';
import { requestPushPermission, isPushSupported, subscribeToPush, showLocalNotification } from '../../services/pushNotifications';
import { useDependenciesBadgeCount, formatBadgeCount } from '../../hooks/useNavBadgeCounts';
import useDebouncedCallback from '../../hooks/useDebouncedCallback';
import useNotificationBurstDispatcher from '../../hooks/useNotificationBurstDispatcher';

// Storm-mitigation (May 2026): bursts of notification:new (e.g. an admin
// who's the escalation target for many missed recurring tasks at once)
// used to dispatch one toast + one OS notification per event, flooding
// the corner of the screen and the OS tray.
//
// Pattern: leading-edge dispatch + trailing summary.
//   - First event of a burst window  → fires the individual toast + OS
//     notification IMMEDIATELY. This restores the pre-storm UX for the
//     common "one task assigned" case — no 1500ms delay.
//   - Subsequent events in window    → accumulate silently.
//   - After NOTIFICATION_BURST_WINDOW_MS of quiet:
//       - If ≥ (threshold - 1) late events accumulated → one grouped
//         summary toast + one grouped OS notification. Result for a
//         30-event storm: 1 leading individual + 1 trailing summary = 2
//         OS notifications, not 30.
//       - Else (1-2 late events) → each fires individually with the same
//         routing as the leading path.
//
// Initial implementation used a pure trailing buffer which delayed single
// notifications by 1500ms — the regression we are fixing here.
const NOTIFICATION_BURST_WINDOW_MS = 1500;
const NOTIFICATION_BURST_GROUP_THRESHOLD = 3;

// Type → human label for individual toasts. Kept module-scope so a fresh
// reference isn't created every render (the burst dispatcher hook reads
// callbacks via a ref so identity stability isn't critical, but pulling
// this out is one less object per render).
const NOTIFICATION_TYPE_TITLES = {
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
  const t = useT();
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
  const confirm = useConfirm();

  // Close the dropdown, ask for confirmation, then run the existing logout
  // flow only on a positive confirmation. Cancel / Escape / backdrop click
  // resolve to false and leave the session intact.
  async function handleSignOut() {
    setShowUserMenu(false);
    const ok = await confirm({
      title: 'Sign out?',
      body: 'Are you sure you want to sign out of your account?',
      confirmLabel: 'Sign out',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    logout();
    navigate('/login');
  }

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
  //   1. In-app toast — fires unconditionally.
  //   2. Foreground OS notification — fires whenever permission is
  //      granted, regardless of tab focus. Uses the SAME stable
  //      `notif-<id>` tag the backend SW push uses, so when both paths
  //      fire for the same event, browsers tag-collapse them into a
  //      single OS-tray entry. The previous behaviour gated this on
  //      `document.hidden || !document.hasFocus()` — that made OS
  //      notifications disappear for users whose backend SW push was
  //      not configured (no VAPID, no subscription), which was the
  //      regression behind "browser notifications are no longer
  //      coming for anything". The focused-tab no-op was the bug.
  //
  // Per-event side effect: toast + (best-effort) OS notification.
  function dispatchIndividualNotification({ n, data }) {
    const msg = n?.message;
    if (!msg) return;
    const toastTitle = NOTIFICATION_TYPE_TITLES[n?.type] || 'New notification';

    toastNotify({
      title: toastTitle,
      body: msg,
      duration: 5000,
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

    // OS notification — permission-guarded here so we don't even call the
    // helper without consent. Inside the helper the hidden-only guard
    // takes care of focused-tab suppression.
    if (n?.id && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
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
  }

  // Per-burst summary side effect — only fires when a burst exceeded the
  // threshold AFTER the leading individual already showed.
  function dispatchGroupedSummary(lateCount) {
    // Leading event already shown → "+ N more notifications" reads more
    // naturally than "You have N+1 notifications" which counts the
    // already-displayed one.
    const grouped = lateCount === 1
      ? '1 more notification arrived'
      : `${lateCount} more notifications arrived`;
    toastNotify({
      title: 'New notifications',
      body: grouped,
      duration: 5000,
      onClick: () => setShowNotifications(true),
    });
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      // Stable per-window tag keeps a second burst from ballooning the tray.
      showLocalNotification('New notifications', {
        body: grouped,
        tag: 'notif-burst',
        url: '/',
      });
    }
  }

  // The dispatcher returns a function we feed each notification:new event
  // into. It manages its own buffer + trailing timer + cleanup.
  const dispatchNotification = useNotificationBurstDispatcher({
    onIndividual: dispatchIndividualNotification,
    onGrouped: dispatchGroupedSummary,
    threshold: NOTIFICATION_BURST_GROUP_THRESHOLD,
    windowMs: NOTIFICATION_BURST_WINDOW_MS,
  });

  useRealtimeEvent('notification:new', (data) => {
    const n = data?.notification;
    if (!n?.message) return; // malformed payload — defensive, no crash
    dispatchNotification({ n, data });
  });

  useRealtimeEvent('task:unblocked', (data) => { toastSuccess(`Task "${data?.title || 'task'}" unblocked!`); });
  useRealtimeEvent('task:delegated', (data) => { toastInfo(`"${data?.title || 'Task'}" delegated to you`); });

  const navigate = useNavigate();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  // Slice 5b: desktop installer manifest. Null until probed; an object once
  // the server confirms the installer has been published. We keep this in
  // state (instead of an inline boolean) so the menu item can render the
  // version + size next to the label. Only meaningful on the web — the
  // desktop app already has the installer; we suppress the fetch entirely
  // there to keep the network panel clean.
  const [desktopManifest, setDesktopManifest] = useState(null);
  // Global header badge — count of active dependency requests assigned to
  // the caller (pending / accepted / working_on_it). Mirrors the
  // "Assigned to Me" tab count on /cross-team. See useDependenciesBadgeCount.
  const dependenciesBadgeCount = useDependenciesBadgeCount();
  const dependenciesBadge = formatBadgeCount(dependenciesBadgeCount);
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

  // Slice 5b: probe `/api/desktop/manifest` once per session to decide
  // whether to surface the "Download Desktop App" item. Skipped entirely
  // inside the desktop app itself (the user already has it). _silent on
  // the request so api.js's global toast handler doesn't fire when the
  // installer hasn't been published yet — a 404 there is a routine
  // "nothing to show" signal, not an error worth telling the user about.
  useEffect(() => {
    if (!authReady || !user) return;
    if (isDesktopApp()) return;
    let cancelled = false;
    api.get('/desktop/manifest', { _silent: true })
      .then((res) => {
        if (cancelled) return;
        // api.js's response interceptor flattens { success, data } onto
        // res.data, so the manifest fields (version, sizeBytes, ...) live
        // directly on res.data.
        if (res?.data?.version) setDesktopManifest(res.data);
      })
      .catch(() => { /* 404 = not published yet; stay null, hide item */ });
    return () => { cancelled = true; };
  }, [authReady, user]);

  // Unread count is a derived cache — every notification:new + notification:read
  // event invalidates 'notifications.unreadCount' via the router. We debounce
  // the refetch so a burst of N notifications (escalation storm, multi-task
  // bulk assign) settles into ONE GET instead of N. The bell's count is still
  // accurate to within the debounce window (~500ms) and the user sees the
  // final value once the burst ends.
  const debouncedLoadUnread = useDebouncedCallback(loadUnreadCount, 500);
  useRealtimeQuery({ queryKey: 'notifications.unreadCount', refetch: debouncedLoadUnread });

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

  // Page title from route — resolved through i18n so the breadcrumb
  // re-renders in the user's selected language without a refresh.
  const getPageTitle = () => {
    const path = location.pathname;
    if (path === '/') return t('header.pages.dashboard');
    if (path === '/my-work') return t('header.pages.myWork');
    if (path === '/dashboard') return t('header.pages.teamDashboard');
    if (path === '/time-plan') return t('header.pages.timePlan');
    if (path === '/meetings') return t('header.pages.meetings');
    if (path === '/reviews') return t('header.pages.reviews');
    if (path === '/users') return t('header.pages.team');
    if (path === '/profile') return t('header.pages.profile');
    if (path === '/org-chart') return t('header.pages.orgChart');
    if (path === '/cross-team') return t('header.pages.dependencies');
    if (path === '/admin-settings') return t('header.pages.adminSettings');
    if (path === '/tasks') return t('header.pages.approvalsAndRequests');
    if (path === '/integrations') return t('header.pages.integrations');
    if (path === '/archive') return t('header.pages.archive');
    if (path.startsWith('/boards/')) return t('header.pages.board');
    return '';
  };

  return (
    <>
      <header
        className="flex items-center justify-between px-5 flex-shrink-0 z-20"
        style={{
          height: '48px',
          backgroundColor: 'var(--primary-background-color)',
          borderBottom: '1px solid var(--layout-border-color)',
        }}
      >
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
            <span className="text-text-tertiary">{t('header.appName')}</span>
            <span className="text-text-muted">/</span>
            <span className="text-text-primary font-medium">{getPageTitle()}</span>
          </div>

          {/* Command Palette Trigger */}
          <button data-tour="search-bar" onClick={() => setShowGlobalSearch(true)}
            className="flex items-center gap-2 text-text-tertiary hover:text-text-secondary px-3 py-1.5 rounded-lg border border-border hover:border-border-dark bg-surface-50 transition-all duration-150 group">
            <Search size={14} />
            <span className="text-xs hidden sm:inline">{t('header.searchHint')}</span>
            <kbd className="hidden lg:inline-flex items-center text-[10px] text-text-muted bg-surface px-1.5 py-0.5 rounded border border-border font-mono ml-3 group-hover:border-border-dark">
              ⌘K
            </kbd>
          </button>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-1">
          {/* Dependencies — moved from sidebar. Badge shows active dependency
              requests assigned to the caller (matches the page's "Assigned to
              Me" tab count). Badge styling matches the bell icon for visual
              consistency. */}
          <button data-tour="nav-dependencies-header" onClick={() => navigate('/cross-team')}
            title={dependenciesBadge ? `${t('header.dependencies')} (${dependenciesBadge})` : t('header.dependencies')}
            aria-label={dependenciesBadge ? `${t('header.dependencies')} (${dependenciesBadge})` : t('header.dependencies')}
            className={`relative p-2 rounded-lg hover:bg-surface-100 transition-all duration-150 ${location.pathname === '/cross-team' ? 'text-primary-500 bg-surface-100' : 'text-text-tertiary hover:text-text-primary'}`}>
            <Waypoints size={17} strokeWidth={1.8} aria-hidden="true" />
            {dependenciesBadge && (
              <span
                className="absolute top-1 right-1 bg-danger text-white text-[8px] font-bold rounded-full min-w-[14px] h-[14px] flex items-center justify-center px-0.5 ring-2 ring-[var(--primary-background-color)]"
                aria-live="polite"
                aria-atomic="true"
              >
                {dependenciesBadge}
              </span>
            )}
          </button>

          {/* Org Chart — moved from sidebar. Opt-out gate matches the
              sidebar's previous isExplicitlyDenied check exactly. */}
          {canSeeOrgChart && (
            <button data-tour="nav-orgchart-header" onClick={() => navigate('/org-chart')}
              title={t('header.orgChart')}
              aria-label={t('header.orgChart')}
              className={`p-2 rounded-lg hover:bg-surface-100 transition-all duration-150 ${location.pathname === '/org-chart' ? 'text-primary-500 bg-surface-100' : 'text-text-tertiary hover:text-text-primary'}`}>
              <Network size={17} strokeWidth={1.8} aria-hidden="true" />
            </button>
          )}

          {/* Time Plan — moved from sidebar. No gate (sidebar version was
              also unconditional). */}
          <button data-tour="nav-timeplan-header" onClick={() => navigate('/time-plan')}
            title={t('header.timePlan')}
            aria-label={t('header.timePlan')}
            className={`p-2 rounded-lg hover:bg-surface-100 transition-all duration-150 ${location.pathname === '/time-plan' ? 'text-primary-500 bg-surface-100' : 'text-text-tertiary hover:text-text-primary'}`}>
            <Clock size={17} strokeWidth={1.8} />
          </button>

          {/* Notes — moved from sidebar */}
          <button data-tour="nav-notes-header" onClick={() => navigate('/notes')}
            title={t('header.notes')}
            aria-label={t('header.notes')}
            className={`p-2 rounded-lg hover:bg-surface-100 transition-all duration-150 ${location.pathname === '/notes' ? 'text-primary-500 bg-surface-100' : 'text-text-tertiary hover:text-text-primary'}`}>
            <Mic size={17} strokeWidth={1.8} />
          </button>

          {/* Help & SOP — moved from sidebar (BookOpen distinguishes it from
              the existing HelpCircle which opens the keyboard shortcuts modal).
              Opens the Profile overlay-modal at the Guide section by passing
              the current location as `state.background` (App.jsx mounts the
              modal route on top of the existing page). */}
          <button data-tour="nav-helpsop-header" onClick={() => navigate('/profile#guide', { state: { background: location } })}
            title={t('header.helpAndSop')}
            aria-label={t('header.helpAndSop')}
            className="p-2 rounded-lg hover:bg-surface-100 transition-all duration-150 text-text-tertiary hover:text-text-primary">
            <BookOpen size={17} strokeWidth={1.8} />
          </button>

          {/* Sub-separator between page-nav icons and notification/system icons */}
          <div className="h-5 w-px bg-border mx-1 hidden sm:block" />

          {/* Slice 6.2: Refresh button. Mirrors the tray menu's Refresh
              item — useful when the app gets into a stale state and the
              user wants to recover without closing the window. A full
              page reload here is cheap and resets all in-memory state;
              the persistent session cookie keeps the user signed in. */}
          <button
            onClick={() => window.location.reload()}
            title="Refresh app"
            aria-label="Refresh app"
            className="p-2 rounded-lg hover:bg-surface-100 transition-all duration-150 text-text-tertiary hover:text-text-primary"
          >
            <RotateCw size={17} strokeWidth={1.8} />
          </button>

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
              ? `${t('header.notifications')} (${unreadCount})`
              : t('header.notifications')}
            aria-expanded={showNotifications}
            aria-haspopup="dialog"
            className="relative p-2 rounded-lg hover:bg-surface-100 transition-all duration-150 text-text-tertiary hover:text-text-primary"
          >
            <Bell size={17} strokeWidth={1.8} aria-hidden="true" />
            {unreadCount > 0 && (
              <span
                className="absolute top-1 right-1 bg-danger text-white text-[8px] font-bold rounded-full min-w-[14px] h-[14px] flex items-center justify-center px-0.5 ring-2 ring-[var(--primary-background-color)]"
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
            title={darkMode ? t('header.lightMode') : t('header.darkMode')}>
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
              <div
                className="absolute right-0 top-full mt-1.5 w-60 py-1 z-50 dropdown-enter overflow-hidden"
                style={{
                  backgroundColor: 'var(--dialog-background-color)',
                  borderRadius: 'var(--border-radius-medium)',
                  boxShadow: 'var(--box-shadow-medium)',
                  border: '1px solid var(--layout-border-color)',
                }}
              >
                <div
                  className="px-4 py-3"
                  style={{ borderBottom: '1px solid var(--layout-border-color)' }}
                >
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
                  {/* Slice 5b: Download Desktop App.
                      Only renders on the web (the desktop app already runs the
                      installer's output) AND only when `/api/desktop/manifest`
                      confirmed a published installer. We use a plain <a> with
                      the cookie-authed download endpoint as its href so the
                      browser handles streaming + native download progress —
                      far better UX than buffering 80+ MB through fetch/blob.
                      `download` attribute is just a filename hint; the server
                      already sets Content-Disposition: attachment. */}
                  {!isDesktopApp() && desktopManifest && (
                    <a
                      href="/api/desktop/download"
                      download="Monday-Aniston-Setup.exe"
                      onClick={() => setShowUserMenu(false)}
                      className="flex items-center gap-3 px-4 py-2 text-sm hover:bg-surface-50 w-full transition-colors text-text-secondary hover:text-text-primary"
                      title={`v${desktopManifest.version}${desktopManifest.sizeBytes ? ` • ${Math.round(desktopManifest.sizeBytes / (1024 * 1024))} MB` : ''}`}
                    >
                      <Download size={15} strokeWidth={1.8} />
                      <span>Download Desktop App</span>
                      <span className="ml-auto text-xs text-text-tertiary">v{desktopManifest.version}</span>
                    </a>
                  )}
                </div>
                <div style={{ borderTop: '1px solid var(--layout-border-color)' }} />
                <button onClick={handleSignOut}
                  className="flex items-center gap-3 px-4 py-2 text-sm text-danger hover:bg-danger/5 w-full transition-colors">
                  <LogOut size={15} strokeWidth={1.8} /> Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      {/* Notification/Search/Shortcuts panels each get their own boundary.
          A render crash in one (e.g. malformed notification payload) must
          not take down the global Header — it lives on every page. */}
      {showNotifications && (
        <ErrorBoundary name="Notifications" variant="section">
          <NotificationsPanel onClose={() => { setShowNotifications(false); loadUnreadCount(); }} />
        </ErrorBoundary>
      )}
      {showGlobalSearch && (
        <ErrorBoundary name="Search" variant="section">
          <GlobalSearch onClose={() => setShowGlobalSearch(false)} />
        </ErrorBoundary>
      )}
      {showShortcuts && (
        <ErrorBoundary name="Keyboard shortcuts" variant="section">
          <KeyboardShortcuts onClose={() => setShowShortcuts(false)} />
        </ErrorBoundary>
      )}
    </>
  );
}
