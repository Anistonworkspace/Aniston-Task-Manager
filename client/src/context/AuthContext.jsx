import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import api from '../services/api';
import { connect, disconnect, disconnectForLogout, subscribe, getSocketId } from '../services/socket';
import { unsubscribeFromPush } from '../services/pushNotifications';

const AuthContext = createContext(null);
const INACTIVITY_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const WARNING_BEFORE_LOGOUT = 30 * 1000; // Warn 30 seconds before logout

// Multi-tab logout sync. When one tab calls logout, every other tab in the
// same browser context (same origin) receives a 'logout' message and tears
// itself down identically. Falls back gracefully on browsers without
// BroadcastChannel — the storage event below also catches the change.
const LOGOUT_CHANNEL_NAME = 'monday-aniston-auth';
const logoutChannel =
  typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel(LOGOUT_CHANNEL_NAME)
    : null;

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(sessionStorage.getItem('token'));
  const [loading, setLoading] = useState(true);
  const [permissionGrants, setPermissionGrants] = useState([]);
  const lastActivityRef = useRef(Date.now());
  const inactivityTimerRef = useRef(null);
  const logoutWarningShownRef = useRef(false);

  /**
   * Local-only teardown — the bit every logout path needs to do, regardless
   * of whether it originated in this tab, another tab in the same browser,
   * or a server-forced disconnect. Idempotent.
   */
  const localCleanup = useCallback(() => {
    sessionStorage.removeItem('token');
    sessionStorage.removeItem('user');
    sessionStorage.removeItem('refreshToken');
    // Also clear localStorage for backward compat with older sessions.
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setToken(null);
    setUser(null);
    setPermissionGrants([]);
    setEffectivePermissions({});
    setIsHierarchyManager(false);
    // Hard disconnect — engages the logoutLatch so even an in-flight
    // reconnect attempt with a stale token is refused. Different from the
    // softer disconnect() used in HMR / reconnects.
    disconnectForLogout();
  }, []);

  /**
   * Active logout — the path the user takes when they click the menu item.
   *
   * Order matters:
   *   1. Snapshot endpoint + socketId BEFORE we tear anything down — once we
   *      disconnect / unsubscribe, the values are gone.
   *   2. Tell the backend to (a) deactivate this device's push subscription
   *      and (b) force-disconnect every socket for this user. We do this
   *      WHILE the auth header is still valid; clearing storage first would
   *      make the request 401.
   *   3. Unsubscribe the browser's PushManager so the OS-level channel
   *      is also broken (defense in depth — backend deactivation alone is
   *      enough, but if backend is down we still want OS push to stop).
   *   4. Local cleanup (storage + state + socket disconnect with latch).
   *   5. Broadcast to other tabs in the same browser so they too tear
   *      down their own state.
   *
   * Every step is best-effort: a failure in one MUST NOT block the rest.
   * The user expects to be logged out even if the network is down.
   */
  const logout = useCallback((opts = {}) => {
    const { broadcast = true, allDevices = false } = opts;

    // 1. Snapshot device identifiers BEFORE local teardown — disconnectForLogout
    //    nulls the socket and unsubscribeFromPush() returns the endpoint that
    //    was active at this moment. We do them synchronously first so the
    //    upcoming auth call still has the right values.
    const socketId = getSocketId();

    // 2. Local cleanup IMMEDIATELY — clears storage + state + disconnects
    //    socket synchronously. Callers that do `logout(); navigate('/login')`
    //    can rely on auth state being gone before the next render.
    //    Note: we keep the token snapshot for the API call below; it's pulled
    //    from sessionStorage by the api interceptor, so we capture it first.
    const tokenSnapshot = sessionStorage.getItem('token') || localStorage.getItem('token');
    localCleanup();

    // 3. Multi-tab broadcast so every other tab in this browser logs out too.
    //    Done early so other tabs start tearing down in parallel.
    if (broadcast) {
      try {
        if (logoutChannel) logoutChannel.postMessage({ type: 'logout', at: Date.now() });
        localStorage.setItem('aniston:logout-at', String(Date.now()));
      } catch { /* ignore */ }
    }

    // 4. Background: unsubscribe browser push + tell backend to deactivate
    //    the DB row + force-disconnect any other sockets we missed. Fully
    //    async, never awaited by the caller — if the network is down the
    //    user is still logged out locally. We re-attach the captured token
    //    explicitly because storage is already cleared.
    (async () => {
      let pushEndpoint = null;
      try { pushEndpoint = await unsubscribeFromPush(); } catch { /* ignore */ }
      try {
        await api.post(
          '/auth/logout',
          { endpoint: pushEndpoint, socketId, allDevices },
          {
            _silent: true,
            headers: tokenSnapshot ? { Authorization: `Bearer ${tokenSnapshot}` } : undefined,
          }
        );
      } catch (err) {
        console.warn('[Auth.logout] backend logout call failed:', err?.message);
      }
    })();
  }, [localCleanup]);

  const [effectivePermissions, setEffectivePermissions] = useState({});
  const [granularPermissions, setGranularPermissions] = useState({});
  const [permissionOverrides, setPermissionOverrides] = useState([]);
  const [isHierarchyManager, setIsHierarchyManager] = useState(false);

  // Load effective permissions (role + grants merged) from the server
  const loadPermissions = useCallback(async () => {
    try {
      const res = await api.get('/auth/me/permissions');
      const data = res.data;
      // Server returns { permissions (legacy), granularPermissions (new), grants, overrides, role, isSuperAdmin }
      const perms = data?.permissions || data?.data?.permissions || {};
      const granular = data?.granularPermissions || data?.data?.granularPermissions || {};
      const rawGrants = data?.grants || data?.data?.grants || [];
      const overrides = data?.overrides || data?.data?.overrides || [];
      setEffectivePermissions(perms);
      setGranularPermissions(granular);
      setPermissionOverrides(overrides);
      setIsHierarchyManager(!!(data?.isHierarchyManager || data?.data?.isHierarchyManager));
      setPermissionGrants((Array.isArray(rawGrants) ? rawGrants : []).map(g => ({
        resourceType: g.resourceType,
        permissionLevel: g.permissionLevel,
        action: g.action,
        resourceId: g.resourceId || null,
        scope: g.scope,
      })));
    } catch (err) {
      console.warn('Failed to load permissions:', err.message);
      setEffectivePermissions({});
      setGranularPermissions({});
      setPermissionGrants([]);
      setPermissionOverrides([]);
    }
  }, []);

  const loadUser = useCallback(async () => {
    // Check sessionStorage first, then localStorage (migration)
    let storedToken = sessionStorage.getItem('token') || localStorage.getItem('token');
    if (!storedToken) { setLoading(false); return; }
    // Migrate from localStorage to sessionStorage
    if (!sessionStorage.getItem('token') && localStorage.getItem('token')) {
      sessionStorage.setItem('token', storedToken);
      localStorage.removeItem('token');
    }
    try {
      const res = await api.get('/auth/me');
      const u = res.data?.data?.user || res.data?.user || res.data;
      setUser(u);
      setToken(storedToken);
      connect(storedToken);
      // Load permission grants after user is loaded (await so they're ready before UI renders)
      if (u?.id) await loadPermissions();
    } catch (err) {
      console.error('Failed to load user:', err);
      sessionStorage.removeItem('token');
      sessionStorage.removeItem('user');
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      setToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [loadPermissions]);

  useEffect(() => { loadUser(); }, [loadUser]);

  // Multi-tab logout sync. When another tab in the same browser logs out,
  // tear down our local state too (no need to call the backend again — that
  // tab already did it). We pass broadcast=false to avoid an echo storm.
  useEffect(() => {
    const onChannelMessage = (e) => {
      if (e?.data?.type === 'logout') {
        localCleanup();
        // Navigate to login — outside React Router because we're in a context
        // that may not be inside a Router during teardown.
        if (window.location.pathname !== '/login') window.location.href = '/login';
      }
    };
    const onStorage = (e) => {
      if (e.key === 'aniston:logout-at') {
        localCleanup();
        if (window.location.pathname !== '/login') window.location.href = '/login';
      }
    };
    if (logoutChannel) logoutChannel.addEventListener('message', onChannelMessage);
    window.addEventListener('storage', onStorage);
    return () => {
      if (logoutChannel) logoutChannel.removeEventListener('message', onChannelMessage);
      window.removeEventListener('storage', onStorage);
    };
  }, [localCleanup]);

  // Live permission refresh — when an admin issues/updates/revokes an
  // override for this user, the server emits 'permissions:updated' to the
  // user's personal socket room. We re-fetch effective permissions so the
  // sidebar, route guards, and in-page checks all reflect the new state
  // without requiring the user to reload.
  useEffect(() => {
    if (!user) return;
    const unsubscribe = subscribe('permissions:updated', () => {
      console.log('[Auth] permissions:updated received — refreshing grants');
      loadPermissions();
    });
    return () => { if (unsubscribe) unsubscribe(); };
  }, [user, loadPermissions]);

  // Inactivity tracker — logout after 5 min of no activity
  useEffect(() => {
    if (!user) return;

    const resetActivity = () => {
      lastActivityRef.current = Date.now();
      logoutWarningShownRef.current = false;
    };

    const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
    events.forEach(e => window.addEventListener(e, resetActivity, { passive: true }));

    inactivityTimerRef.current = setInterval(() => {
      const idle = Date.now() - lastActivityRef.current;
      // Show warning 30s before logout
      if (idle > (INACTIVITY_TIMEOUT - WARNING_BEFORE_LOGOUT) && !logoutWarningShownRef.current) {
        logoutWarningShownRef.current = true;
        // Create a visible warning banner
        const banner = document.createElement('div');
        banner.id = 'logout-warning-banner';
        banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#ef4444;color:white;text-align:center;padding:10px;font-size:14px;font-weight:600;';
        banner.textContent = 'You will be logged out in 30 seconds due to inactivity. Move your mouse to stay logged in.';
        if (!document.getElementById('logout-warning-banner')) {
          document.body.appendChild(banner);
          // Remove banner if user becomes active
          const removeBanner = () => {
            const el = document.getElementById('logout-warning-banner');
            if (el) el.remove();
            events.forEach(e => window.removeEventListener(e, removeBanner));
          };
          events.forEach(e => window.addEventListener(e, removeBanner, { once: true }));
        }
      }
      if (idle > INACTIVITY_TIMEOUT) {
        const el = document.getElementById('logout-warning-banner');
        if (el) el.remove();
        console.log('[Auth] Auto-logout due to inactivity');
        logout();
        window.location.href = '/login';
      }
    }, 10000); // Check every 10 seconds

    return () => {
      events.forEach(e => window.removeEventListener(e, resetActivity));
      if (inactivityTimerRef.current) clearInterval(inactivityTimerRef.current);
    };
  }, [user, logout]);

  const login = async (email, password) => {
    const res = await api.post('/auth/login', { email, password });
    const d = res.data?.data || res.data;
    const newToken = d.token;
    const newUser = d.user;
    sessionStorage.setItem('token', newToken);
    sessionStorage.setItem('user', JSON.stringify(newUser));
    if (d.refreshToken) sessionStorage.setItem('refreshToken', d.refreshToken);
    setToken(newToken);
    setUser(newUser);
    lastActivityRef.current = Date.now();
    connect(newToken);
    // Load permission grants after login (await so UI has grants before navigating)
    await loadPermissions();
    return newUser;
  };

  const loginWithToken = async (newToken, newRefreshToken) => {
    sessionStorage.setItem('token', newToken);
    if (newRefreshToken) sessionStorage.setItem('refreshToken', newRefreshToken);
    setToken(newToken);
    try {
      const res = await api.get('/auth/me');
      const u = res.data?.data?.user || res.data?.user || res.data;
      setUser(u);
      sessionStorage.setItem('user', JSON.stringify(u));
      lastActivityRef.current = Date.now();
      connect(newToken);
      // Load permission grants after token login
      loadPermissions();
      return u;
    } catch (err) {
      sessionStorage.removeItem('token');
      sessionStorage.removeItem('refreshToken');
      setToken(null);
      setUser(null);
      throw err;
    }
  };

  const updateProfile = async (updates) => {
    const res = await api.put('/auth/profile', updates);
    const updatedUser = res.data?.data?.user || res.data?.user;
    setUser(updatedUser);
    sessionStorage.setItem('user', JSON.stringify(updatedUser));
    return updatedUser;
  };

  // Super admin check
  const isSuperAdmin = !!user?.isSuperAdmin;
  const effectiveRole = user?.role;
  // Manager has all access same as admin (for most features)
  const isAdmin = effectiveRole === 'admin' || effectiveRole === 'manager';
  // Strict admin: actual admin role only (for Admin Settings, Integrations, Feedback)
  const isStrictAdmin = effectiveRole === 'admin';
  const isManager = effectiveRole === 'manager';
  const isAssistantManager = effectiveRole === 'assistant_manager';
  const isMember = effectiveRole === 'member';
  // canManage = admin + manager only (NOT assistant_manager)
  const canManage = isAdmin || isManager || user?.isSuperAdmin;
  const isDirector = ['director', 'vp', 'ceo'].includes(user?.hierarchyLevel);

  return (
    <AuthContext.Provider value={{
      user, token, loading, login, loginWithToken, logout, updateProfile,
      isAdmin, isStrictAdmin, isManager, isAssistantManager, isMember, canManage, isDirector,
      isSuperAdmin, isHierarchyManager, effectiveRole,
      permissionGrants, effectivePermissions, granularPermissions, permissionOverrides, loadPermissions,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
