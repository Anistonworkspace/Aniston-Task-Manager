import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { FolderKanban, Mail, Lock, ArrowRight, Eye, EyeOff, ShieldAlert, Monitor } from 'lucide-react';
import api from '../../services/api';
import { getErrorMessage, getErrorCode } from '../../utils/errorMap';
import AnistonLoader from '../common/AnistonLoader';

// Pretty-printer for the device hint surfaced in the conflict banner.
// We deliberately keep this compact and best-effort — the user-agent
// string is opaque and not always present.
function formatDeviceHint(other) {
  if (!other) return null;
  const ua = (other.userAgent || '').toLowerCase();
  let browser = null;
  if (ua.includes('edg/')) browser = 'Edge';
  else if (ua.includes('chrome/')) browser = 'Chrome';
  else if (ua.includes('firefox/')) browser = 'Firefox';
  else if (ua.includes('safari/')) browser = 'Safari';
  let os = null;
  if (ua.includes('windows')) os = 'Windows';
  else if (ua.includes('mac os')) os = 'macOS';
  else if (ua.includes('android')) os = 'Android';
  else if (ua.includes('iphone') || ua.includes('ipad')) os = 'iOS';
  else if (ua.includes('linux')) os = 'Linux';
  const parts = [browser, os].filter(Boolean);
  return parts.length > 0 ? parts.join(' on ') : null;
}

export default function Login() {
  const { login, forceLogin, forceLoginSSO, loginWithToken, logout } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState(''); // non-error notice (e.g. forced-out banner)
  const [loading, setLoading] = useState(false);
  const [ssoLoading, setSsoLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [ssoEnabled, setSsoEnabled] = useState(false);

  // ── Single-active-session state ──────────────────────────────
  // pendingLoginToken comes back from /auth/login when
  // SESSION_ALREADY_ACTIVE. It lives in React state only — never
  // sessionStorage / localStorage / a cookie. The countdown is for UX
  // ("expires in N seconds"); when it hits zero we drop back to the
  // password form with a clear "please sign in again" message.
  const [conflictMode, setConflictMode] = useState(null); // 'local' | 'sso' | null
  const [pendingLoginToken, setPendingLoginToken] = useState(null);
  const [pendingExpiresAt, setPendingExpiresAt] = useState(null);
  const [pendingSecondsLeft, setPendingSecondsLeft] = useState(0);
  const [otherDevice, setOtherDevice] = useState(null);
  const [pendingUserDisplay, setPendingUserDisplay] = useState(null); // SSO only

  // Check SSO status and handle SSO callback
  useEffect(() => {
    api.get('/auth/sso-status').then(res => {
      setSsoEnabled(res.data?.data?.ssoEnabled ?? false);
    }).catch(() => {});

    // ── Force-logout reason banner ──────────────────────────────
    // AuthContext stashes the reason in sessionStorage when the
    // socket delivers 'auth:force_logout'. We surface it once on
    // mount, then clear so a manual login attempt afterwards doesn't
    // keep showing the banner.
    try {
      const forcedReason = sessionStorage.getItem('aniston:force_logout_reason');
      if (forcedReason === 'forced_other_device') {
        setInfo('You were signed out because this account was used to sign in on another device.');
      }
      sessionStorage.removeItem('aniston:force_logout_reason');
    } catch { /* ignore */ }

    const params = new URLSearchParams(window.location.search);
    const ssoStatus = params.get('sso');

    if (ssoStatus === 'success') {
      window.history.replaceState({}, '', window.location.pathname);
      setSsoLoading(true);
      loginWithToken()
        .then(() => navigate('/'))
        .catch(() => setError('SSO login failed. Please try again.'))
        .finally(() => setSsoLoading(false));
    } else if (ssoStatus === 'session_conflict') {
      // SSO branch of the single-active-session UX. The Microsoft
      // callback already verified the user via OAuth and dropped a
      // pending-SSO httpOnly cookie. We just need to know whose
      // account is pending and render the confirm banner.
      window.history.replaceState({}, '', window.location.pathname);
      setConflictMode('sso');
      // Pull the pending-SSO info so the banner can say "Continue as
      // <name>?" — purely a UX nicety. If this fails the user can
      // still confirm; the force endpoint reads the cookie itself.
      api.get('/auth/login/pending-sso', { _silent: true })
        .then(res => {
          const d = res.data?.data || {};
          setPendingUserDisplay({ email: d.email, name: d.name, avatar: d.avatar });
          setOtherDevice(d.otherDevice || null);
          // SSO pending cookie TTL = 5 min, fixed server-side. We
          // don't know the exact remaining time; pessimistic 5min.
          const expiresAt = Date.now() + 5 * 60 * 1000;
          setPendingExpiresAt(expiresAt);
        })
        .catch(() => {
          setConflictMode(null);
          setError('Your Microsoft sign-in session expired. Please sign in again.');
        });
    } else if (ssoStatus === 'error') {
      const msg = params.get('msg') || 'Microsoft sign-in failed.';
      logout();
      setError(decodeURIComponent(msg));
      window.history.replaceState({}, '', window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pending-token expiry countdown. Updates every second so the UI can
  // show "Expires in 4m 30s" and switch the banner to "session
  // confirmation expired" at zero.
  useEffect(() => {
    if (!pendingExpiresAt) return;
    const tick = () => {
      const remaining = Math.max(0, Math.floor((pendingExpiresAt - Date.now()) / 1000));
      setPendingSecondsLeft(remaining);
      if (remaining <= 0) {
        // Token window closed. Drop back to the password form. For
        // SSO that means re-running the Microsoft handshake; for
        // local login that means re-typing the password.
        setConflictMode(null);
        setPendingLoginToken(null);
        setPendingExpiresAt(null);
        setPendingUserDisplay(null);
        setOtherDevice(null);
        setError('Session confirmation expired. Please sign in again.');
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [pendingExpiresAt]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setInfo('');
    if (!email || !password) { setError('Please fill in all fields'); return; }
    setLoading(true);
    try {
      const result = await login(email.trim().toLowerCase(), password);
      // Single-active-session: the API didn't actually log us in — it
      // surfaced an existing session and gave us a 5-minute pending
      // token to confirm takeover. Render the banner.
      if (result && result.sessionAlreadyActive) {
        setConflictMode('local');
        setPendingLoginToken(result.pendingLoginToken);
        setPendingExpiresAt(Date.now() + (result.expiresIn || 300) * 1000);
        setOtherDevice(result.otherDevice || null);
        setPassword(''); // clear password from the DOM
        return;
      }
      navigate('/');
    } catch (err) {
      // Map backend `code` to the canonical login string. We override
      // VALIDATION_FAILED to a shorter message here — the generic
      // "check the highlighted fields" copy from the map is for forms
      // with field-level highlights; the login form is two fields, so
      // the classic "Invalid email or password" reads cleaner.
      const message = getErrorMessage(err, {
        VALIDATION_FAILED: 'Invalid email or password.',
        AUTH_INVALID_CREDENTIALS: 'Invalid email or password.',
      });
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  async function handleForceLogin() {
    setError('');
    setLoading(true);
    try {
      if (conflictMode === 'sso') {
        await forceLoginSSO();
      } else {
        await forceLogin(pendingLoginToken);
      }
      navigate('/');
    } catch (err) {
      const code = getErrorCode(err);
      if (code === 'PENDING_TOKEN_INVALID' || code === 'PENDING_TOKEN_REQUIRED') {
        setError('Session confirmation expired. Please sign in again.');
      } else {
        setError(getErrorMessage(err) || 'Could not take over the session. Please try again.');
      }
      // Drop back to the password form on any error — the token is
      // single-use either way.
      setConflictMode(null);
      setPendingLoginToken(null);
      setPendingExpiresAt(null);
      setPendingUserDisplay(null);
      setOtherDevice(null);
    } finally {
      setLoading(false);
    }
  }

  function handleCancelConflict() {
    setConflictMode(null);
    setPendingLoginToken(null);
    setPendingExpiresAt(null);
    setPendingUserDisplay(null);
    setOtherDevice(null);
    setError('');
  }

  async function handleMicrosoftSSO() {
    setError('');
    setSsoLoading(true);
    logout();
    try {
      // Detect desktop mode. The preload exposes `window.anistonDesktop`
      // ONLY when running inside the packaged Electron wrapper; the web
      // bundle stays on the legacy full-page redirect path below.
      const isDesktop = typeof window !== 'undefined'
          && window.anistonDesktop
          && typeof window.anistonDesktop.openSso === 'function';

      // Slice 8 — Desktop-aware OAuth state.
      // When in desktop mode we pass `?desktop=1` to the backend's
      // /auth/microsoft endpoint so it signs `desktop: true` into the
      // OAuth state JWT. microsoftCallback later honours that flag and
      // redirects to a stable backend-owned terminal URL
      // (/api/auth/desktop-complete?status=...) that Electron detects
      // deterministically, instead of the renderer-state URL
      // (/login?sso=...) that broke when Login.jsx routing changed.
      // Web flow unaffected — without `?desktop=1` the state JWT and
      // callback redirect URL are byte-identical to the prior behaviour.
      const microsoftPath = isDesktop ? '/auth/microsoft?desktop=1' : '/auth/microsoft';
      const res = await api.get(microsoftPath);
      const authUrl = res.data?.data?.authUrl || res.data?.authUrl;
      if (!authUrl) {
        setError('Could not start Microsoft sign-in.');
        setSsoLoading(false);
        return;
      }
      // Desktop branch: a full-page navigation to Microsoft's OAuth URL
      // would be blocked by `will-navigate` (cross-origin from file://).
      // The preload bridge opens a child BrowserWindow inside the app
      // that shares the persist:aniston session, so the cookies the
      // OAuth callback sets are visible to the main window.
      //
      // Slice 8 — When openSso resolves with {ok:true} the main process
      // has ALREADY verified the session via net.request to /auth/me
      // (with the same persist:aniston cookies). We trust that and
      // refresh the renderer's AuthContext via loginWithToken() — a
      // single /auth/me round-trip — rather than doing a full
      // window.location.reload(). Cleaner UX (no blank flash) and
      // there is exactly one path that can grant the user past /login:
      // the AuthContext setUser inside loginWithToken plus PublicRoute's
      // user-aware Navigate. No reliance on URL parsing.
      if (isDesktop) {
        const result = await window.anistonDesktop.openSso(authUrl);
        if (result?.ok) {
          try {
            await loginWithToken();
            navigate('/', { replace: true });
          } catch {
            // Extremely rare: cookies disappeared between main's
            // /auth/me verification and ours. Keep user on /login with
            // a clear message rather than an unhelpful blank state.
            setError('Microsoft sign-in completed but session could not be loaded. Please try again.');
            setSsoLoading(false);
          }
        } else {
          // Distinguish the failure modes so the user sees an actionable
          // message. Reasons originate from the main process:
          //   - 'window-closed'         user closed the popup pre-completion
          //   - 'verification-failed'   /auth/me did not 200 within retry budget
          //   - 'server-error'          backend explicitly redirected with status=error
          //   - 'load-failed'           popup failed to load the OAuth URL
          //   - 'not-https'/'invalid-url' impossible from normal flow
          let msg = 'Microsoft sign-in failed. Please try again.';
          if (result?.reason === 'window-closed') {
            msg = 'Microsoft sign-in was cancelled.';
          } else if (result?.reason === 'verification-failed') {
            msg = 'Microsoft sign-in completed, but the session could not be verified. Please try again.';
          } else if (result?.reason === 'server-error') {
            msg = result?.msg
              ? `Microsoft sign-in failed: ${result.msg}`
              : 'Microsoft sign-in failed. Please try again.';
          } else if (result?.reason === 'load-failed') {
            msg = 'Could not open the Microsoft sign-in page. Please check your internet connection and try again.';
          }
          setError(msg);
          setSsoLoading(false);
        }
        return;
      }
      // Web branch: behaves exactly as before — full-page redirect.
      window.location.href = authUrl;
    } catch (err) {
      setError(getErrorMessage(err) || 'Failed to start Microsoft sign-in.');
      setSsoLoading(false);
    }
  }

  if (ssoLoading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-surface gap-3">
        <AnistonLoader variant="inline" size="lg" label="Signing in with Microsoft" />
        <p className="text-sm text-text-secondary">Signing in with Microsoft...</p>
      </div>
    );
  }

  // Pretty mm:ss countdown for the pending banner.
  const mins = Math.floor(pendingSecondsLeft / 60);
  const secs = pendingSecondsLeft % 60;
  const countdown = `${mins}:${String(secs).padStart(2, '0')}`;
  const deviceHint = formatDeviceHint(otherDevice);

  return (
    <div className="min-h-screen flex">
      {/* Left - Form */}
      <div className="flex-1 flex items-center justify-center p-8 bg-surface">
        <div className="w-full max-w-[380px]">
          <div className="flex items-center gap-2.5 mb-8">
            <img src="/icons/anistonlogo.png" alt="Monday Aniston" className="w-10 h-10 rounded-xl object-contain" />
            <div>
              <h1 className="text-xl font-bold text-text-primary leading-tight">Monday Aniston</h1>
              <p className="text-[11px] text-text-secondary">Work Management</p>
            </div>
          </div>

          <h2 className="text-2xl font-bold text-text-primary mb-1">Welcome back!</h2>
          <p className="text-sm text-text-secondary mb-8">Log in to your account to continue</p>

          {/* Force-logout banner (shown once on the next mount after the
              old session was kicked). Distinct visual treatment from the
              error block so it reads as informational rather than failure. */}
          {info && !conflictMode && (
            <div className="bg-amber-50 border border-amber-200 text-amber-900 text-sm px-4 py-2.5 rounded-lg mb-4 flex items-start gap-2">
              <Monitor size={16} className="mt-0.5 shrink-0" />
              <span>{info}</span>
            </div>
          )}

          {error && (
            <div className="bg-danger/10 border border-danger/20 text-danger text-sm px-4 py-2.5 rounded-lg mb-4">{error}</div>
          )}

          {/* ── Session-conflict UI ──────────────────────────────
              Replaces the password form when we have a pending-login
              token (either local-login response or SSO conflict
              redirect). Keeps the page layout intact so the user
              isn't disoriented. */}
          {conflictMode ? (
            <div className="flex flex-col gap-4">
              <div className="bg-amber-50 border border-amber-200 text-amber-900 text-sm px-4 py-3 rounded-lg flex items-start gap-2.5">
                <ShieldAlert size={18} className="mt-0.5 shrink-0 text-amber-600" />
                <div className="flex flex-col gap-1.5 min-w-0">
                  <p className="font-semibold leading-tight">
                    This account is already signed in
                    {conflictMode === 'sso' && pendingUserDisplay?.name
                      ? <> as <span className="text-amber-700">{pendingUserDisplay.name}</span></>
                      : null}
                    .
                  </p>
                  <p className="text-amber-800 leading-snug">
                    For your security, only one device can be signed in to this account at a time.
                  </p>
                  {deviceHint && (
                    <p className="text-amber-800/80 text-xs leading-snug">
                      Other session: {deviceHint}
                      {otherDevice?.ip ? <> · {otherDevice.ip}</> : null}
                    </p>
                  )}
                  <p className="text-amber-700/90 text-xs leading-snug">
                    Confirmation expires in <span className="font-mono">{countdown}</span>
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={handleForceLogin}
                disabled={loading || pendingSecondsLeft <= 0}
                className="w-full bg-primary hover:bg-primary-hover text-white py-2.5 rounded-lg font-semibold text-sm flex items-center justify-center gap-2 transition-colors disabled:opacity-60"
              >
                {loading
                  ? <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white" />
                  : <><span>Continue here &amp; sign out other session</span><ArrowRight size={16} /></>}
              </button>

              <button
                type="button"
                onClick={handleCancelConflict}
                disabled={loading}
                className="w-full bg-transparent hover:bg-surface-100 text-text-secondary py-2 rounded-lg font-medium text-sm transition-colors disabled:opacity-60"
              >
                Cancel
              </button>
            </div>
          ) : (
            <>
              <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <div>
                  <label htmlFor="login-email" className="block text-sm font-medium text-text-primary mb-1.5">Email</label>
                  <div className="relative">
                    <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
                    <input id="login-email" name="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com"
                      className="w-full pl-10 pr-4 py-2.5 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" />
                  </div>
                </div>
                <div>
                  <label htmlFor="login-password" className="block text-sm font-medium text-text-primary mb-1.5">Password</label>
                  <div className="relative">
                    <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
                    <input id="login-password" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password"
                      className="w-full pl-10 pr-10 py-2.5 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" />
                    <button type="button" onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary transition-colors">
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
                <button type="submit" disabled={loading}
                  className="w-full bg-primary hover:bg-primary-hover text-white py-2.5 rounded-lg font-semibold text-sm flex items-center justify-center gap-2 transition-colors disabled:opacity-60 mt-2">
                  {loading ? <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white" /> : <><span>Log in</span><ArrowRight size={16} /></>}
                </button>
              </form>

              {/* Microsoft SSO Button */}
              {ssoEnabled && (
                <>
                  <div className="flex items-center gap-3 my-5">
                    <div className="flex-1 h-px bg-border" />
                    <span className="text-xs text-text-tertiary font-medium">or</span>
                    <div className="flex-1 h-px bg-border" />
                  </div>
                  <button
                    onClick={handleMicrosoftSSO}
                    disabled={ssoLoading}
                    className="w-full flex items-center justify-center gap-3 px-4 py-2.5 bg-surface border border-border rounded-lg text-sm font-medium text-text-primary hover:bg-surface-100 hover:border-border-dark transition-all disabled:opacity-60 shadow-sm"
                  >
                    {ssoLoading ? (
                      <div className="animate-spin rounded-full h-4 w-4 border-2 border-gray-300 border-t-gray-600" />
                    ) : (
                      <svg width="20" height="20" viewBox="0 0 21 21" fill="none">
                        <rect x="1" y="1" width="9" height="9" fill="#F25022"/>
                        <rect x="11" y="1" width="9" height="9" fill="#7FBA00"/>
                        <rect x="1" y="11" width="9" height="9" fill="#00A4EF"/>
                        <rect x="11" y="11" width="9" height="9" fill="#FFB900"/>
                      </svg>
                    )}
                    <span>Sign in with Microsoft</span>
                  </button>
                </>
              )}

              <div className="text-center mt-4">
                <Link to="/forgot-password" className="text-xs text-text-tertiary hover:text-primary">Forgot password?</Link>
              </div>
              <p className="text-sm text-text-secondary text-center mt-4">
                Need an account? Contact your administrator.
              </p>
            </>
          )}
        </div>
      </div>

      {/* Right - Illustration */}
      <div className="hidden lg:flex flex-1 bg-gradient-to-br from-primary via-blue-500 to-purple-600 items-center justify-center p-12">
        <div className="text-center text-white max-w-md">
          <div className="w-20 h-20 rounded-2xl bg-white/20 flex items-center justify-center mx-auto mb-6 backdrop-blur-sm">
            <img src="/icons/anistonlogo.png" alt="Monday Aniston" className="w-14 h-14 object-contain" />
          </div>
          <h2 className="text-3xl font-bold mb-3">Manage your team's work</h2>
          <p className="text-white/80 text-base leading-relaxed">Track tasks, collaborate with your team, and deliver projects on time with Monday Aniston.</p>
        </div>
      </div>
    </div>
  );
}
