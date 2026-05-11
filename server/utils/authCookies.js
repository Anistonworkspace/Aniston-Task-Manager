/**
 * httpOnly cookie helpers for the access + refresh JWT pair.
 *
 * Why this exists
 * ---------------
 * Pre-D-1, JWTs lived in browser-readable storage (sessionStorage with a
 * localStorage fallback). Any XSS would steal both tokens — the audit (S-2)
 * flagged this as the primary auth-token exposure. Moving the tokens into
 * httpOnly cookies makes them invisible to JS while keeping the SPA flow
 * identical for the user.
 *
 * Migration model — DUAL TRACK during transition
 * ----------------------------------------------
 * Phase 1 (current):
 *   - Backend SETS the cookies on every login / refresh / SSO callback.
 *   - Backend STILL returns the tokens in the response body so old clients
 *     keep working without redeploying the frontend.
 *   - Backend's authenticate middleware accepts either source.
 * Phase 2 (future session, NOT yet):
 *   - Frontend stops storing tokens in sessionStorage / localStorage.
 *   - Backend stops returning tokens in body.
 *
 * No new dependencies — Express has built-in res.cookie() / res.clearCookie().
 * For READING we parse the Cookie header manually here; cookie-parser would
 * work too but isn't worth a new dependency for two named cookies.
 *
 * Cookie attributes
 * -----------------
 *   httpOnly: true  — JS in the page cannot read or write these cookies
 *                     (the entire point — XSS can't exfiltrate them).
 *   secure:   true in production / false in dev — Secure cookies require
 *             HTTPS, which would break local dev on http://localhost.
 *   sameSite: 'lax' — default-deny on cross-origin POSTs (CSRF defence)
 *             while still allowing top-level GETs (so SSO redirect-back from
 *             Microsoft → /login works and the cookie is sent).
 *   path:     '/'   — cookie is sent on every request to this origin.
 *   maxAge:   1h for access, 7d for refresh — match the JWT expiries.
 *
 * Domain attribute is intentionally unset → cookie is bound to the exact
 * origin that set it (e.g. monday.anistonav.com). If the deploy ever splits
 * frontend and API onto different subdomains we'll need to add
 * domain: '.anistonav.com' here.
 */

const ACCESS_COOKIE = 'aniston_at';
const REFRESH_COOKIE = 'aniston_rt';
// Pending-login cookie used ONLY by the SSO conflict path: the callback
// detects that another active session exists, drops the pending-login
// token into this httpOnly cookie (so it never appears in browser
// history / Referer), and redirects to /login?sso=session_conflict. The
// frontend's "continue here" button calls /auth/login/force-sso, which
// reads the cookie and consumes the token. 5-minute TTL — matches the
// local-login pending-token TTL.
const PENDING_LOGIN_COOKIE = 'aniston_plt';

const ONE_HOUR_MS = 60 * 60 * 1000;
const FIVE_MIN_MS = 5 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function baseCookieOptions() {
  return {
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'lax',
    path: '/',
  };
}

/**
 * Set both auth cookies on a response. Caller passes the freshly-issued
 * access + refresh JWT strings; this function never generates or signs
 * tokens, it only attaches them as cookies.
 *
 * `refreshToken` is optional — refresh-only flows (e.g. mid-session token
 * rotation when the access token expires) can pass just the access token.
 */
function setAuthCookies(res, { accessToken, refreshToken }) {
  if (!res || typeof res.cookie !== 'function') return;
  if (accessToken) {
    res.cookie(ACCESS_COOKIE, accessToken, {
      ...baseCookieOptions(),
      maxAge: ONE_HOUR_MS,
    });
  }
  if (refreshToken) {
    res.cookie(REFRESH_COOKIE, refreshToken, {
      ...baseCookieOptions(),
      maxAge: SEVEN_DAYS_MS,
    });
  }
}

/**
 * Clear both cookies. Use on logout. Browsers honour Set-Cookie with an
 * expired date; res.clearCookie does that for us. Path / sameSite / secure
 * MUST match what was used on set, otherwise the browser keeps the original
 * cookie alive — Express's clearCookie will mirror our base options if we
 * pass them explicitly.
 */
function clearAuthCookies(res) {
  if (!res || typeof res.clearCookie !== 'function') return;
  const opts = baseCookieOptions();
  res.clearCookie(ACCESS_COOKIE, opts);
  res.clearCookie(REFRESH_COOKIE, opts);
}

/**
 * Parse the Cookie request header. Returns a plain { name: value } map,
 * URL-decoding values per RFC 6265. Returns {} if no Cookie header.
 *
 * Implementation note: avoiding the `cookie` / `cookie-parser` packages
 * keeps the dependency footprint flat. The parsing is defensive — bad
 * cookie shapes return {} rather than throwing.
 */
function parseCookies(req) {
  const header = req && req.headers && req.headers.cookie;
  if (!header || typeof header !== 'string') return {};
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

/**
 * Read the access JWT from the request — cookie first, then Authorization
 * header as fallback (legacy clients). Returns the raw JWT string or null.
 */
function getAccessTokenFromRequest(req) {
  const cookies = parseCookies(req);
  if (cookies[ACCESS_COOKIE]) return cookies[ACCESS_COOKIE];
  const auth = req && req.headers && req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim() || null;
  }
  return null;
}

/**
 * Read the refresh JWT from the request — cookie first, then request body
 * as fallback (legacy clients passing { refreshToken: '...' }).
 */
function getRefreshTokenFromRequest(req) {
  const cookies = parseCookies(req);
  if (cookies[REFRESH_COOKIE]) return cookies[REFRESH_COOKIE];
  if (req && req.body && typeof req.body.refreshToken === 'string') {
    return req.body.refreshToken;
  }
  return null;
}

/**
 * Set the SSO-conflict pending-login cookie. Used only by the Microsoft
 * SSO callback when an active session already exists for the resolved
 * user. The cookie carries the RAW pending-login token (the DB stores
 * sha256(rawToken)). Lives 5 minutes, httpOnly + Secure(prod) + SameSite=Lax
 * so it survives the redirect chain back from login.microsoftonline.com.
 *
 * The cookie grants exactly one action: "consume me at
 * /auth/login/force-sso." It is NOT an access token and confers no API
 * privilege on its own.
 */
function setPendingLoginCookie(res, rawToken) {
  if (!res || typeof res.cookie !== 'function' || !rawToken) return;
  res.cookie(PENDING_LOGIN_COOKIE, rawToken, {
    ...baseCookieOptions(),
    maxAge: FIVE_MIN_MS,
  });
}

/**
 * Clear the SSO pending-login cookie. Called when (a) the token is
 * consumed by /auth/login/force-sso (success or expiry path) or (b) the
 * user lands on the conflict page and abandons.
 */
function clearPendingLoginCookie(res) {
  if (!res || typeof res.clearCookie !== 'function') return;
  res.clearCookie(PENDING_LOGIN_COOKIE, baseCookieOptions());
}

/**
 * Read the pending-login token from the SSO cookie. Returns the raw
 * token string or null. The caller is responsible for hashing it and
 * looking up the pending_login_tokens row.
 */
function getPendingLoginTokenFromRequest(req) {
  const cookies = parseCookies(req);
  return cookies[PENDING_LOGIN_COOKIE] || null;
}

module.exports = {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  PENDING_LOGIN_COOKIE,
  setAuthCookies,
  clearAuthCookies,
  setPendingLoginCookie,
  clearPendingLoginCookie,
  parseCookies,
  getAccessTokenFromRequest,
  getRefreshTokenFromRequest,
  getPendingLoginTokenFromRequest,
};
