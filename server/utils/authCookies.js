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

const ONE_HOUR_MS = 60 * 60 * 1000;
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

module.exports = {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  setAuthCookies,
  clearAuthCookies,
  parseCookies,
  getAccessTokenFromRequest,
  getRefreshTokenFromRequest,
};
