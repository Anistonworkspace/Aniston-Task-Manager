import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import api from '../services/api';
import { connect, disconnect, disconnectForLogout, subscribe, getSocketId } from '../services/socket';
import { unsubscribeFromPush } from '../services/pushNotifications';
import safeLog from '../utils/safeLog';
import {
  TIER_1, TIER_2, TIER_3, TIER_4,
  resolveTier as resolveTierFn,
  hasTierAtLeast as hasTierAtLeastFn,
  tierLabel as tierLabelFn,
} from '../utils/tiers';

const AuthContext = createContext(null);
// Inactivity timeout is configurable by Super Admin via /api/system-settings/session-timeout.
// These constants are the safety bounds + the fallback used while the value is
// being fetched (or if the fetch fails). Mirror server-side bounds.
const DEFAULT_INACTIVITY_MINUTES = 5;
const MIN_INACTIVITY_MINUTES = 5;
const MAX_INACTIVITY_MINUTES = 1440; // 24 hours
const WARNING_BEFORE_LOGOUT = 30 * 1000; // Warn 30 seconds before logout

const clampInactivityMinutes = (raw) => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_INACTIVITY_MINUTES;
  if (n < MIN_INACTIVITY_MINUTES) return MIN_INACTIVITY_MINUTES;
  if (n > MAX_INACTIVITY_MINUTES) return MAX_INACTIVITY_MINUTES;
  return Math.round(n);
};

// Multi-tab logout sync. When one tab calls logout, every other tab in the
// same browser context (same origin) receives a 'logout' message and tears
// itself down identically. Falls back gracefully on browsers without
// BroadcastChannel — the storage event below also catches the change.
const LOGOUT_CHANNEL_NAME = 'monday-aniston-auth';
const logoutChannel =
  typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel(LOGOUT_CHANNEL_NAME)
    : null;

/**
 * Tell every active service worker about our auth state. The SW reads this
 * to decide whether to render real push bodies or a generic "sign in to view"
 * card on stale post-logout pushes. Mirrors `window.__ANISTON_AUTH__` so the
 * AUTH_CHECK fast path (main.jsx) and the SW fast path stay aligned.
 *
 * Best-effort: missing SW or postMessage failures are silent. The decision
 * is also fenced by the backend deactivating the push row, so this is one
 * of two independent layers stopping the post-logout body leak.
 */
function broadcastAuthStateToSW(state) {
  try { window.__ANISTON_AUTH__ = state; } catch { /* ignore */ }
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  navigator.serviceWorker.ready
    .then((reg) => {
      try { reg.active && reg.active.postMessage({ type: 'AUTH_STATE', state }); } catch { /* ignore */ }
    })
    .catch(() => { /* ignore — SW may not be installed yet */ });
  try {
    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'AUTH_STATE', state });
    }
  } catch { /* ignore */ }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(sessionStorage.getItem('token'));
  const [loading, setLoading] = useState(true);
  const [permissionGrants, setPermissionGrants] = useState([]);
  const lastActivityRef = useRef(Date.now());
  const inactivityTimerRef = useRef(null);
  const logoutWarningShownRef = useRef(false);
  // Configured by Super Admin in Admin Settings → Security. The ref is what
  // the running interval reads on each tick so updates take effect mid-session
  // without restarting the timer; the state is for UI consumers (e.g. the
  // Security tab) that need to re-render when the value changes.
  const [inactivityTimeoutMinutes, setInactivityTimeoutMinutes] = useState(DEFAULT_INACTIVITY_MINUTES);
  const inactivityMinutesRef = useRef(DEFAULT_INACTIVITY_MINUTES);

  // Pull the latest configured timeout from the server. Safe to call repeatedly;
  // any failure leaves the previous value intact (or the default on first run)
  // so a transient network error never breaks login.
  const refreshInactivityTimeout = useCallback(async () => {
    try {
      const res = await api.get('/system-settings/session-timeout');
      const minutes = clampInactivityMinutes(res.data?.data?.inactivityTimeoutMinutes);
      inactivityMinutesRef.current = minutes;
      setInactivityTimeoutMinutes(minutes);
      return minutes;
    } catch (err) {
      console.warn('[Auth] Failed to load inactivity timeout, using fallback:', err?.message);
      return inactivityMinutesRef.current;
    }
  }, []);

  // Apply a freshly-saved value locally — used by the Security tab right after
  // a successful PUT so the new timeout takes effect in the current session
  // without a round-trip or page refresh.
  const applyInactivityTimeoutMinutes = useCallback((minutes) => {
    const clamped = clampInactivityMinutes(minutes);
    inactivityMinutesRef.current = clamped;
    setInactivityTimeoutMinutes(clamped);
    // Reset the activity clock so the new window starts now, not from whatever
    // long-stale timestamp predated the change.
    lastActivityRef.current = Date.now();
    logoutWarningShownRef.current = false;
    const banner = document.getElementById('logout-warning-banner');
    if (banner) banner.remove();
    return clamped;
  }, []);

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
    // Tell the SW we're logged out so any stale pushes that arrive in the
    // next few minutes render the generic "sign in to view" card instead of
    // leaking task titles to the OS tray.
    broadcastAuthStateToSW('loggedOut');
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
    //    D-1 Phase 2: no JS-readable token to capture — auth rides the
    //    cookie that the browser will send on the /auth/logout call below
    //    automatically (api client has withCredentials: true). The backend
    //    reads the refresh-token cookie itself and revokes the JTI; we no
    //    longer ship the token in the request body.
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
        // D-1 Phase 2: no Bearer header, no refreshToken body. The auth
        // and refresh tokens ride on the httpOnly cookies (withCredentials
        // on the api client). Backend reads them server-side, revokes the
        // JTI, and clears the cookies on the response.
        await api.post(
          '/auth/logout',
          { endpoint: pushEndpoint, socketId, allDevices },
          { _silent: true }
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
    // D-1 Phase 2: cookie-only session lookup. No JS-readable token to
    // probe — we just hit /auth/me. If the cookie is present and valid,
    // the request succeeds. If not, the server responds 401 and we treat
    // it as "not logged in" (loading=false, no user). This is one extra
    // request per page load for unauthenticated visitors compared to the
    // pre-Phase-2 behaviour, but the request is cheap (auth-only check)
    // and the security win is closing the storage-token exposure.
    //
    // Storage cleanup is preserved as a one-time drain for any leftover
    // tokens written before Phase 2 deployed. After all pre-deploy
    // sessions expire (≤ refresh token TTL = 7 days) this becomes dead
    // code; safe to keep until then.
    try {
      // _silent: the api interceptor will not emit a global `api-error`
      // toast for this request, and a refresh-chain failure that ends
      // here with status 400 (no refresh cookie on login page) will be
      // tagged so we don't surface it as a scary console error either.
      const res = await api.get('/auth/me', { _silent: true });
      const u = res.data?.data?.user || res.data?.user || res.data;
      setUser(u);
      connect();
      // Tell the SW we're authenticated so stale-push detection trusts it.
      broadcastAuthStateToSW('authenticated');
      if (u?.id) await loadPermissions();
    } catch (err) {
      // Three legitimate "not signed in" shapes hit this catch:
      //   1. /auth/me returns 401 (no cookie at all).
      //   2. /auth/me returns 401, the interceptor silently tries
      //      /auth/refresh, refresh returns 400 (no refresh cookie),
      //      and the rejection that bubbles here is the refresh error
      //      with `_isRefreshFailure: true` tagged by the interceptor.
      //   3. Network unavailable (no err.response).
      // None of these are user-actionable on the login page — the form
      // already handles invalid-credentials; this code path runs on
      // every page load to probe for an existing session. So we stay
      // silent in production. In dev, safeLog.debug surfaces the error
      // for diagnostics without spamming the console with full
      // AxiosError dumps.
      const isAnonymousProbe =
        err?.response?.status === 401 ||
        err?._isRefreshFailure === true;
      if (!isAnonymousProbe) {
        safeLog.warn('[Auth] loadUser unexpected error', err);
      } else {
        safeLog.debug('[Auth] loadUser anonymous (no session)');
      }
      // One-time drain of pre-Phase-2 storage tokens.
      sessionStorage.removeItem('token');
      sessionStorage.removeItem('user');
      sessionStorage.removeItem('refreshToken');
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      localStorage.removeItem('refreshToken');
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
  //
  // Phase 6 — we now ALSO listen for 'user:force_refresh' which fires on
  // both role/tier changes (userController.updateUser) and permission
  // grants (permissionController). When that fires, we reload BOTH the
  // user record AND the permissions so a demoted-T1-now-T4 user's frontend
  // tier helpers (isTier1, isStrictAdmin, canManage) refresh in the same
  // ~socket round-trip as the permission grants. Without this, the user
  // object stayed stale until the next /auth/me call (~minutes) while
  // permissions had already changed — confusing UI state that showed
  // admin chrome but failed every action with 403.
  useEffect(() => {
    if (!user) return;
    const unsubscribePerm = subscribe('permissions:updated', () => {
      console.log('[Auth] permissions:updated received — refreshing grants');
      loadPermissions();
    });
    const unsubscribeForce = subscribe('user:force_refresh', (payload) => {
      console.log('[Auth] user:force_refresh received — reloading user + grants', payload?.reason);
      // Reload the user record first so tier/role helpers update before
      // any guards re-render against the new permission map. loadUser
      // itself calls loadPermissions on success, so this is a single
      // chained call rather than two parallel ones.
      loadUser();
    });
    // Keep backward-compat with the existing 'user:role-updated' event
    // which carries the structured payload some surfaces (toasts) rely
    // on. The force_refresh fires in addition, not instead, so this is
    // an additive listener.
    const unsubscribeRole = subscribe('user:role-updated', () => {
      console.log('[Auth] user:role-updated received — reloading user + grants');
      loadUser();
    });
    return () => {
      if (unsubscribePerm) unsubscribePerm();
      if (unsubscribeForce) unsubscribeForce();
      if (unsubscribeRole) unsubscribeRole();
    };
  }, [user, loadPermissions, loadUser]);

  // Single-active-session: the server emits 'auth:force_logout' on the
  // OLD device's socket when a new device confirms takeover via
  // /auth/login/force or /auth/login/force-sso. We tear down local
  // state and redirect to /login with a reason banner so the displaced
  // user understands why they were signed out.
  //
  // The reason flag is read by Login.jsx once on mount and then
  // cleared. sessionStorage is acceptable here — it's a non-secret UX
  // hint, not a credential.
  useEffect(() => {
    if (!user) return;
    const unsubscribe = subscribe('auth:force_logout', (payload) => {
      const reason = payload?.reason || 'forced_other_device';
      try { sessionStorage.setItem('aniston:force_logout_reason', reason); } catch { /* ignore */ }
      localCleanup();
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    });
    return () => { if (unsubscribe) unsubscribe(); };
  }, [user, localCleanup]);

  // Inactivity tracker — logout after the configured period of no activity.
  // The interval reads inactivityMinutesRef on each tick, so changes made by a
  // Super Admin take effect immediately in the current session without
  // tearing down and rebuilding listeners.
  useEffect(() => {
    if (!user) return;

    // Pull the configured value once the user is loaded. Best-effort — on
    // failure we keep whatever value the ref already holds (default 5 min).
    refreshInactivityTimeout();

    const resetActivity = () => {
      lastActivityRef.current = Date.now();
      logoutWarningShownRef.current = false;
    };

    const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
    events.forEach(e => window.addEventListener(e, resetActivity, { passive: true }));

    inactivityTimerRef.current = setInterval(() => {
      const timeoutMs = clampInactivityMinutes(inactivityMinutesRef.current) * 60 * 1000;
      const idle = Date.now() - lastActivityRef.current;
      // Show warning 30s before logout
      if (idle > (timeoutMs - WARNING_BEFORE_LOGOUT) && !logoutWarningShownRef.current) {
        logoutWarningShownRef.current = true;
        // Create a visible warning banner
        const banner = document.createElement('div');
        banner.id = 'logout-warning-banner';
        banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#df2f4a;color:white;text-align:center;padding:10px;font-size:14px;font-weight:600;';
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
      if (idle > timeoutMs) {
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
  }, [user, logout, refreshInactivityTimeout]);

  const login = async (email, password) => {
    // D-1 Phase 2: backend sets httpOnly cookies and returns ONLY the user
    // record. The session lives in the cookie — no JS-readable token to
    // store, no XSS exfiltration vector. The socket connect() picks the
    // cookie up via withCredentials on the handshake (see socket.js).
    //
    // Single-active-session: the backend can return a structured 200
    // response with `success:false, code:'SESSION_ALREADY_ACTIVE'` when
    // another live session exists. We pass that through unchanged to
    // the caller (Login.jsx) which renders the "another session is
    // active — continue here?" UI. The body carries a 5-minute single-
    // use pendingLoginToken that the caller hands to forceLogin() to
    // take over.
    const res = await api.post('/auth/login', { email, password });
    if (res.data && res.data.success === false && res.data.code === 'SESSION_ALREADY_ACTIVE') {
      // Surface the structured payload to the caller. Token lives only
      // in React state at the call site — never in storage.
      return {
        sessionAlreadyActive: true,
        pendingLoginToken: res.data.data?.pendingLoginToken
          || res.data.pendingLoginToken,
        expiresIn: res.data.data?.expiresIn || res.data.expiresIn || 300,
        otherDevice: res.data.data?.otherDevice || res.data.otherDevice || null,
        message: res.data.message,
      };
    }
    const d = res.data?.data || res.data;
    const newUser = d.user;
    setUser(newUser);
    lastActivityRef.current = Date.now();
    connect();
    broadcastAuthStateToSW('authenticated');
    // Load permission grants after login (await so UI has grants before navigating)
    await loadPermissions();
    return newUser;
  };

  /**
   * Confirm-and-take-over for the single-active-session flow. Called
   * by Login.jsx when the user clicks "Continue here and sign out the
   * other session." Posts the pending-login token to /auth/login/force,
   * which revokes the old session, force-disconnects its sockets, and
   * sets new cookies before returning the user record.
   */
  const forceLogin = async (pendingLoginToken) => {
    const res = await api.post('/auth/login/force', { pendingLoginToken });
    const d = res.data?.data || res.data;
    const newUser = d.user;
    setUser(newUser);
    lastActivityRef.current = Date.now();
    connect();
    broadcastAuthStateToSW('authenticated');
    await loadPermissions();
    return newUser;
  };

  /**
   * SSO equivalent of forceLogin. No request body — the pending-SSO
   * token is delivered via httpOnly cookie set by the Microsoft
   * callback. Same effect: revokes the prior session, kills its
   * sockets, mints a new session.
   */
  const forceLoginSSO = async () => {
    const res = await api.post('/auth/login/force-sso', {});
    const d = res.data?.data || res.data;
    const newUser = d.user;
    setUser(newUser);
    lastActivityRef.current = Date.now();
    connect();
    broadcastAuthStateToSW('authenticated');
    await loadPermissions();
    return newUser;
  };

  // D-1 Phase 2: SSO callback flow no longer carries the token in the URL.
  // The backend sets cookies before issuing the redirect, so by the time
  // this runs the browser already holds the session. We just confirm by
  // hitting /auth/me (cookie auth) and load the user. The function name
  // is kept for backward compat with callers; arguments are now ignored.
  const loginWithToken = async (_unusedToken, _unusedRefreshToken) => {
    try {
      const res = await api.get('/auth/me');
      const u = res.data?.data?.user || res.data?.user || res.data;
      setUser(u);
      lastActivityRef.current = Date.now();
      connect();
      broadcastAuthStateToSW('authenticated');
      loadPermissions();
      return u;
    } catch (err) {
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

  // ─── Tier-based identity (Phase 6) ────────────────────────────────────
  // Tier is the canonical RBAC level going forward. The legacy helpers
  // below (isAdmin, isManager, etc.) are kept as deprecated aliases so the
  // rest of the app keeps working until each component is migrated to
  // tier-based gates. Backend remains the source of truth — this is for
  // UI rendering only.
  const tier = resolveTierFn(user);
  const isTier1 = tier === TIER_1;
  const isTier2 = tier === TIER_2;
  const isTier3 = tier === TIER_3;
  const isTier4 = tier === TIER_4;
  const hasTierAtLeast = (n) => hasTierAtLeastFn(user, n);
  const tierLabel = tierLabelFn(tier);

  // ─── Legacy aliases (deprecated — migrate callers to tier helpers) ───
  // Kept for backward compatibility during Phase 6's per-component rollout.
  const isSuperAdmin = !!user?.isSuperAdmin;
  const effectiveRole = user?.role;
  const isAdmin = isTier1 || isTier2;        // was: admin OR manager
  const isStrictAdmin = isTier1;              // was: strict admin role only
  const isManager = isTier2;                  // legacy alias — encompasses admin+manager
  const isAssistantManager = isTier3;
  const isMember = isTier4;
  const canManage = isTier1 || isTier2;       // admin+manager+T1 (was already this)
  const isDirector = ['director', 'vp', 'ceo'].includes(user?.hierarchyLevel);

  // `authReady` is the canonical "auth bootstrap finished" flag. Consumers
  // that need to defer side-effects until the cookie session has been
  // verified should gate on this rather than (loading || !user) — it stays
  // true even after a logout-then-login cycle, which is the right semantics
  // for "we know whether the user is logged in" (the answer might be "no").
  // Callers still check `user` separately when they need an actual identity.
  const authReady = !loading;

  return (
    <AuthContext.Provider value={{
      user, token, loading, authReady, login, forceLogin, forceLoginSSO, loginWithToken, logout, updateProfile,
      // Tier API (canonical)
      tier, isTier1, isTier2, isTier3, isTier4, hasTierAtLeast, tierLabel,
      // Legacy aliases (deprecated)
      isAdmin, isStrictAdmin, isManager, isAssistantManager, isMember, canManage, isDirector,
      isSuperAdmin, isHierarchyManager, effectiveRole,
      permissionGrants, effectivePermissions, granularPermissions, permissionOverrides, loadPermissions,
      inactivityTimeoutMinutes, refreshInactivityTimeout, applyInactivityTimeoutMinutes,
      INACTIVITY_MIN_MINUTES: MIN_INACTIVITY_MINUTES, INACTIVITY_MAX_MINUTES: MAX_INACTIVITY_MINUTES,
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
