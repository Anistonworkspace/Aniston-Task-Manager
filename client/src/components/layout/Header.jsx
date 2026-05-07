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
import { requestPushPermission, showLocalNotification, isPushSupported, subscribeToPush } from '../../services/pushNotifications';

export default function Header({ onToggleSidebar }) {
  const { user, logout, isAdmin, isStrictAdmin, isSuperAdmin, granularPermissions,
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
  const { success: toastSuccess, info: toastInfo } = useToast();
  const { darkMode, toggleDarkMode } = useTheme();
  const location = useLocation();

  // Request push notification permission and subscribe to VAPID push
  useEffect(() => {
    if (isPushSupported()) {
      requestPushPermission().then((perm) => {
        if (perm === 'granted') subscribeToPush();
      });
    }
  }, []);

  // Notification side-effects (toast + browser push) need the raw payload —
  // useRealtimeEvent is the right hook here. The unread COUNT, on the other
  // hand, is a derived cache that gets bumped to via the queryKey below.
  useRealtimeEvent('notification:new', (data) => {
    const msg = data?.notification?.message;
    if (msg) toastInfo(msg);
    if (msg) {
      showLocalNotification('Monday Aniston', {
        body: msg,
        tag: `notif-${data?.notification?.id || Date.now()}`,
        url: data?.notification?.entityType === 'task' ? '/my-work' : '/',
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

  // Load unread count once on mount — socket events keep it updated
  useEffect(() => { loadUnreadCount(); }, []);

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
    try {
      const res = await api.get('/notifications/unread-count');
      setUnreadCount(res.data.unreadCount || res.data.count || 0);
    } catch {}
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

          {/* Notifications */}
          <button data-tour="notifications" onClick={() => setShowNotifications(!showNotifications)}
            className="relative p-2 rounded-lg hover:bg-surface-100 transition-all duration-150 text-text-tertiary hover:text-text-primary">
            <Bell size={17} strokeWidth={1.8} />
            {unreadCount > 0 && (
              <span className="absolute top-1 right-1 bg-danger text-white text-[8px] font-bold rounded-full min-w-[14px] h-[14px] flex items-center justify-center px-0.5 ring-2 ring-white dark:ring-[#1E1F23]">
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
