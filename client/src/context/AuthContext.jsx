import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import api from '../services/api';
import { connect, disconnect } from '../services/socket';

const AuthContext = createContext(null);
const INACTIVITY_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const WARNING_BEFORE_LOGOUT = 30 * 1000; // Warn 30 seconds before logout

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(sessionStorage.getItem('token'));
  const [loading, setLoading] = useState(true);
  const [viewAsRole, setViewAsRole] = useState(null);
  const [permissionGrants, setPermissionGrants] = useState([]);
  const lastActivityRef = useRef(Date.now());
  const inactivityTimerRef = useRef(null);
  const logoutWarningShownRef = useRef(false);

  const logout = useCallback(() => {
    sessionStorage.removeItem('token');
    sessionStorage.removeItem('user');
    sessionStorage.removeItem('refreshToken');
    // Also clear localStorage for backward compat
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setToken(null);
    setUser(null);
    setViewAsRole(null);
    setPermissionGrants([]);
    setEffectivePermissions({});
    setIsHierarchyManager(false);
    disconnect();
  }, []);

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
    setViewAsRole(null);
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
      setViewAsRole(null);
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
  const effectiveRole = (isSuperAdmin && viewAsRole) ? viewAsRole : user?.role;
  const isAdmin = effectiveRole === 'admin';
  const isManager = effectiveRole === 'manager';
  const isAssistantManager = effectiveRole === 'assistant_manager';
  const isMember = effectiveRole === 'member';
  const canManage = isAdmin || isManager || isAssistantManager || user?.isSuperAdmin;
  const isDirector = ['director', 'vp', 'ceo'].includes(user?.hierarchyLevel);

  const switchViewAs = (role) => {
    if (!isSuperAdmin) return;
    setViewAsRole(role === user?.role ? null : role);
  };

  return (
    <AuthContext.Provider value={{
      user, token, loading, login, loginWithToken, logout, updateProfile,
      isAdmin, isManager, isAssistantManager, isMember, canManage, isDirector,
      isSuperAdmin, isHierarchyManager, viewAsRole, switchViewAs, effectiveRole,
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
