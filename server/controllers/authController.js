const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const { User, RefreshToken, PendingLoginToken } = require('../models');
const { validationResult } = require('express-validator');
const { Op } = require('sequelize');
const { getTeamsConfig } = require('../config/teams');
const {
  setAuthCookies,
  clearAuthCookies,
  getRefreshTokenFromRequest,
  setPendingLoginCookie,
  clearPendingLoginCookie,
  getPendingLoginTokenFromRequest,
} = require('../utils/authCookies');

// Single-active-session feature.
//
// A "session" in this app is a RefreshToken row. We bind every access
// token to its refresh-token JTI via the new `sid` claim. The auth
// middleware (server/middleware/auth.js) looks up the session row on
// every request: if it has been hard-revoked (revokedAt set AND
// replacedByJti null), the request is rejected and cookies are cleared.
//
// Force-logout works because revokeAllRefreshTokensForUser sets
// revokedAt only on currently-active rows (replacedByJti null). Rows
// already revoked by rotation are untouched, so an in-flight access
// token whose `sid` points to a rotation-revoked row continues to be
// accepted by the middleware until its natural 1-h expiry. Only hard
// revokes (logout / force-logout / password change) kill an access
// token mid-flight.
const PENDING_LOGIN_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PENDING_LOGIN_TTL_SEC = 5 * 60;

/**
 * SHA-256 hex of a raw token. Used to look up pending_login_tokens rows
 * without ever storing the raw token. Length is always 64.
 */
function hashPendingToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Issue a pending-login token row for `user`. Returns the RAW token
 * (caller delivers it to the client — for local login via the response
 * body, for SSO via an httpOnly cookie). Only the hash is persisted.
 *
 * `origin` is either 'local' or 'sso' and is checked at consume time
 * so a local-login pending token can't be consumed by the SSO force
 * endpoint and vice versa.
 */
async function createPendingLoginToken(user, origin, req) {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const hashed = hashPendingToken(rawToken);
  const expiresAt = new Date(Date.now() + PENDING_LOGIN_TTL_MS);

  await PendingLoginToken.create({
    userId: user.id,
    tokenHash: hashed,
    expiresAt,
    origin,
    ip: req?.ip?.slice(0, 45) || null,
    userAgent: req?.headers?.['user-agent']?.slice(0, 255) || null,
  });

  return rawToken;
}

/**
 * Atomically consume a pending-login token. Returns `{ok:true, userId}`
 * on success or `{ok:false, reason}` on failure. The reason is opaque
 * to the client — callers translate it into a generic error message.
 *
 * Single-use is enforced at the DB layer via an UPDATE that filters
 * `used_at IS NULL` and `expires_at > now()`. A race that loses the
 * update returns 0 rows and is rejected.
 */
async function consumePendingLoginToken(rawToken, expectedOrigin) {
  if (!rawToken || typeof rawToken !== 'string') {
    return { ok: false, reason: 'missing' };
  }
  const hashed = hashPendingToken(rawToken);
  // Look the row up first — separate from the UPDATE so we can return a
  // useful reason (expired vs already-used vs wrong-origin). The
  // single-use guarantee comes from the conditional UPDATE below, not
  // from this read.
  const row = await PendingLoginToken.findOne({ where: { tokenHash: hashed } });
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.usedAt) return { ok: false, reason: 'used' };
  if (new Date(row.expiresAt) <= new Date()) return { ok: false, reason: 'expired' };
  if (row.origin !== expectedOrigin) return { ok: false, reason: 'origin_mismatch' };

  const [affected] = await PendingLoginToken.update(
    { usedAt: new Date() },
    { where: { id: row.id, usedAt: null } }
  );
  if (affected === 0) {
    // Lost the race — another request consumed it microseconds before us.
    return { ok: false, reason: 'used' };
  }

  return { ok: true, userId: row.userId, row };
}

/**
 * Return the currently-active session row for a user, or null. "Active"
 * = revokedAt is null AND expiresAt is in the future. Rows that have
 * been rotated have revokedAt set, so they don't count.
 *
 * Used by the login flow to decide whether to mint tokens immediately
 * (no active session) or return SESSION_ALREADY_ACTIVE (active session
 * exists somewhere else).
 */
async function findActiveSessionForUser(userId) {
  return RefreshToken.findOne({
    where: {
      userId,
      revokedAt: null,
      expiresAt: { [Op.gt]: new Date() },
    },
    order: [['issuedAt', 'DESC']],
  });
}

/**
 * Atomically establish a brand-new session for `user`. Mints a refresh
 * token (which writes the RefreshToken row), then mints an access
 * token whose `sid` claim equals the new refresh JTI. Sets both
 * httpOnly cookies. Returns `{accessToken, refreshToken, sid}`.
 *
 * Used by:
 *   - normal local login (no active session)
 *   - force-login (after revoking all prior sessions)
 *   - SSO callback (no active session)
 *   - SSO force-login (after revoking all prior sessions)
 *
 * The refresh-then-access ordering matters: we need the JTI in hand
 * before we can sign the access token.
 */
async function establishSession(user, res, req) {
  const { token: refreshToken, jti } = await issueRefreshToken(user.id, req);
  const accessToken = generateToken(user.id, jti);
  setAuthCookies(res, { accessToken, refreshToken });
  return { accessToken, refreshToken, sid: jti };
}

/**
 * Force-logout helper used by both the local force-login endpoint and
 * the SSO force-login endpoint. Revokes every active refresh token for
 * the user (hard revoke — replacedByJti stays null so the middleware
 * treats it as a kill rather than a rotation), force-disconnects every
 * active socket for the user, and emits `auth:force_logout` so the
 * other device's UI can render the "you were signed out because…"
 * banner before the socket closes.
 *
 * Returns the number of refresh tokens revoked and sockets killed for
 * caller-side logging.
 */
async function revokeAllSessionsForForceLogout(userId, reason = 'forced_other_device') {
  const tokensRevoked = await revokeAllRefreshTokensForUser(userId);

  let socketsKilled = 0;
  try {
    const socketService = require('../services/socketService');
    socketsKilled = await socketService.disconnectUser(userId, null, {
      event: 'auth:force_logout',
      payload: { reason },
    });
  } catch (err) {
    // socket service may not be initialized in tests
    console.warn('[Auth.forceLogout] socket disconnect failed:', err && err.message);
  }

  return { tokensRevoked, socketsKilled };
}

// In-memory store for per-email login rate limiting
// Key: email, Value: { count, firstAttempt }
const loginAttempts = new Map();
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function checkLoginRateLimit(email) {
  const now = Date.now();
  const entry = loginAttempts.get(email);
  if (!entry) return { allowed: true };
  // Reset window if expired
  if (now - entry.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(email);
    return { allowed: true };
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    return { allowed: false, retryAfterMs: LOGIN_WINDOW_MS - (now - entry.firstAttempt) };
  }
  return { allowed: true };
}

function recordFailedLogin(email) {
  const now = Date.now();
  const entry = loginAttempts.get(email);
  if (!entry || now - entry.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.set(email, { count: 1, firstAttempt: now });
  } else {
    entry.count += 1;
  }
}

function clearLoginAttempts(email) {
  loginAttempts.delete(email);
}

/**
 * Validate password strength: 8+ chars, uppercase, lowercase, number, special char.
 */
function validatePassword(password) {
  if (!password || password.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter.';
  if (!/[a-z]/.test(password)) return 'Password must contain at least one lowercase letter.';
  if (!/\d/.test(password)) return 'Password must contain at least one number.';
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) return 'Password must contain at least one special character.';
  return null;
}

/**
 * Generate a short-lived access token (1 hour).
 *
 * The `sid` (session id) claim is the JTI of the refresh-token row that
 * represents this session. The auth middleware looks the row up on
 * every request — when it's hard-revoked (revokedAt set,
 * replacedByJti null), the access token stops working immediately even
 * though the JWT itself is still cryptographically valid.
 *
 * `sid` is optional for backward compatibility with the very small
 * window of access tokens minted before this feature deployed; those
 * tokens continue to work for at most 1 hour (their natural exp).
 * Every NEW login or refresh issues a token with sid populated.
 */
const generateToken = (userId, sid = null) => {
  const payload = { id: userId };
  if (sid) payload.sid = sid;
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });
};

// Refresh token lifetime kept in one place so the JWT and the DB row agree.
const REFRESH_TOKEN_TTL_DAYS = 7;
const REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * Issue a refresh token AND record it in the refresh_tokens table.
 *
 * Every refresh token now carries a `jti` (JWT ID) UUID claim. The DB row,
 * keyed by the same JTI, is the authoritative "is this token still alive?"
 * record consulted on `/api/auth/refresh`.
 *
 * Caller passes optional `req` so we capture user-agent / IP for forensics
 * (best-effort — no failure if missing).
 *
 * Returns the JWT string. Backward-compatible with callers that don't await
 * the DB write — we still issue a usable JWT even if the DB insert fails;
 * the lookup at refresh time will then 401 the user, which is safer than
 * the alternative (signed token with no DB record = stealth bypass).
 */
async function issueRefreshToken(userId, req) {
  const jti = crypto.randomUUID();
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + REFRESH_TOKEN_TTL_MS);

  const token = jwt.sign(
    { id: userId, type: 'refresh', jti },
    process.env.JWT_SECRET,
    { expiresIn: `${REFRESH_TOKEN_TTL_DAYS}d` }
  );

  try {
    await RefreshToken.create({
      jti,
      userId,
      issuedAt,
      expiresAt,
      userAgent: req?.headers?.['user-agent']?.slice(0, 255) || null,
      ip: req?.ip?.slice(0, 45) || null,
    });
  } catch (err) {
    // Don't throw — but log loudly. A persistent failure here means refresh
    // tokens are issued but unverifiable, which the refresh endpoint will
    // catch and reject. Loudness here helps ops diagnose before users notice.
    console.error('[Auth] Failed to record refresh token:', err && err.message);
  }
  // Returns BOTH the token and the JTI. The single-active-session feature
  // needs the JTI so it can embed it as `sid` in the access token minted
  // by establishSession() / refresh rotation. Callers that only want the
  // string destructure `{token}`.
  return { token, jti };
}

/**
 * Revoke a single refresh token by JTI. Idempotent (no-op if already
 * revoked). Optionally records the JTI of the new replacement token so we
 * can detect token-reuse on the next refresh attempt against the old JTI.
 */
async function revokeRefreshToken(jti, replacedByJti = null) {
  if (!jti) return;
  try {
    await RefreshToken.update(
      {
        revokedAt: new Date(),
        ...(replacedByJti ? { replacedByJti } : {}),
      },
      { where: { jti, revokedAt: null } }
    );
  } catch (err) {
    console.warn('[Auth] revokeRefreshToken failed:', err && err.message);
  }
}

/**
 * Revoke every active refresh token for a user. Used on (a) password change,
 * (b) detected token-reuse (chain compromise), (c) optional admin
 * "logout everywhere" actions.
 */
async function revokeAllRefreshTokensForUser(userId) {
  if (!userId) return 0;
  try {
    const [count] = await RefreshToken.update(
      { revokedAt: new Date() },
      { where: { userId, revokedAt: null } }
    );
    return count || 0;
  } catch (err) {
    console.warn('[Auth] revokeAllRefreshTokensForUser failed:', err && err.message);
    return 0;
  }
}

/**
 * POST /api/auth/register
 */
const register = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { name, email, password, department } = req.body;

    const existingUser = await User.findOne({ where: { email: email.toLowerCase() } });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email already exists.',
      });
    }

    const user = await User.create({
      name,
      email: email.toLowerCase(),
      password,
      department: department || null,
      accountStatus: 'pending',
      hasLocalPassword: true,
      passwordChangedAt: new Date(),
    });

    res.status(201).json({
      success: true,
      message: 'Your account request has been submitted. An admin will review and approve it.',
      data: { pending: true },
    });
  } catch (error) {
    console.error('[Auth] Register error:', error);
    res.status(500).json({ success: false, message: 'Server error during registration.' });
  }
};

/**
 * POST /api/auth/login
 *
 * Single-active-session aware login flow:
 *
 *  1. Validate format (express-validator) and per-email rate limit.
 *  2. Look up the user — ALWAYS run bcrypt.compare (against the real
 *     hash if found, or a dummy hash if not) so the response time
 *     reveals nothing about whether the email exists.
 *  3. If password didn't match → 401 generic (no enumeration).
 *  4. AFTER password is verified, check isActive / accountStatus.
 *     A wrong password and a deactivated account return distinct
 *     responses, but both require a valid password first — so an
 *     attacker without the password learns nothing.
 *  5. Check for an active session (RefreshToken row with revokedAt
 *     null + expiresAt in the future). If found, mint a single-use
 *     pending-login token (5 min TTL) and return
 *     `{code:'SESSION_ALREADY_ACTIVE', pendingLoginToken}` with HTTP
 *     200 + success:false. The client renders the "another session is
 *     active — continue here?" UI.
 *  6. Otherwise, establish a brand-new session via establishSession()
 *     (refresh row + access token whose `sid` claim is the new JTI).
 */
const login = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, password } = req.body;
    const normalizedEmail = email.trim().toLowerCase();

    // Per-email rate limiting (in-memory; see audit F-10 for the
    // multi-instance hardening note). Returns 429 well before bcrypt
    // burns CPU on a spray.
    const rateCheck = checkLoginRateLimit(normalizedEmail);
    if (!rateCheck.allowed) {
      return res.status(429).json({
        success: false,
        message: 'Too many login attempts. Try again later.',
      });
    }

    const user = await User.findOne({ where: { email: normalizedEmail } });

    // Constant-time-ish password compare. If the user doesn't exist we
    // still run bcrypt against a dummy hash so the response timing
    // doesn't differ from the user-exists/wrong-password case. The dummy
    // hash is a precomputed bcrypt of the empty string at cost 12 —
    // generating it on every request would itself be a leak.
    const DUMMY_BCRYPT =
      '$2a$12$CwTycUXWue0Thq9StjUM0uJ8.tRBQVrYxLPXM0aL0WJqXqfNw3qfu';
    let isMatch = false;
    if (user && user.password) {
      isMatch = await user.comparePassword(password);
    } else if (user && user.authProvider === 'microsoft' && !user.hasLocalPassword) {
      // Microsoft SSO user with no local password — also run a dummy
      // compare so the response time is uniform.
      await bcrypt.compare(password || '', DUMMY_BCRYPT);
      isMatch = false;
    } else {
      // No user OR user with no password set at all. Dummy compare
      // for timing parity, then fall through to the generic 401.
      await bcrypt.compare(password || '', DUMMY_BCRYPT);
      isMatch = false;
    }

    if (!user || !isMatch) {
      recordFailedLogin(normalizedEmail);
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    // Password verified — now apply account-status checks. These leak
    // status only to a caller who already proved they own the
    // credentials, which is the intended security tradeoff.
    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: 'Account has been deactivated. Contact an administrator.',
      });
    }

    if (user.accountStatus === 'pending') {
      return res.status(403).json({
        success: false,
        message: 'Your account is pending admin approval. Please wait for approval.',
      });
    }

    if (user.accountStatus === 'rejected') {
      return res.status(403).json({
        success: false,
        message: 'Your account request was rejected. Contact an administrator.',
      });
    }

    // Successful auth — clear rate-limit counter regardless of session-
    // conflict outcome below. The user proved possession of the
    // password; that's enough to not penalize their IP further.
    clearLoginAttempts(normalizedEmail);

    // ── Single-active-session check ──────────────────────────────
    // If a live refresh-token row exists for this user, do NOT mint a
    // new session. Return a structured 200 with a 5-minute single-use
    // pending-login token. The client renders the "already signed in
    // elsewhere — continue here?" UI and posts to /auth/login/force
    // to actually take over.
    const activeSession = await findActiveSessionForUser(user.id);
    if (activeSession) {
      const rawPendingToken = await createPendingLoginToken(user, 'local', req);
      // Best-effort device hint for the UI. Never any PII beyond what
      // the user could already see in their own Account Settings.
      const otherDevice = {
        userAgent: (activeSession.userAgent || '').slice(0, 80) || null,
        ip: activeSession.ip || null,
        issuedAt: activeSession.issuedAt,
      };
      return res.json({
        success: false,
        code: 'SESSION_ALREADY_ACTIVE',
        message: 'This account is already signed in on another device or browser.',
        data: {
          pendingLoginToken: rawPendingToken,
          expiresIn: PENDING_LOGIN_TTL_SEC,
          otherDevice,
        },
      });
    }

    // No active session — mint a fresh one. establishSession writes the
    // refresh row, signs the access token with `sid` = new JTI, and
    // sets both httpOnly cookies on the response.
    await establishSession(user, res, req);

    res.json({
      success: true,
      message: 'Login successful.',
      data: { user: user.toJSON() },
    });
  } catch (error) {
    console.error('[Auth] Login error:', error);
    res.status(500).json({ success: false, message: 'Server error during login.' });
  }
};

/**
 * POST /api/auth/login/force
 *
 * Confirm-and-take-over endpoint for the SESSION_ALREADY_ACTIVE flow.
 * Consumes the pending-login token returned by /api/auth/login, revokes
 * every active refresh token for the user, force-disconnects every
 * socket for the user (with `auth:force_logout` so the other tab gets
 * a clean reason banner), then establishes a brand-new session.
 *
 * Security:
 *   - The pending token is single-use, enforced by a conditional UPDATE
 *     against pending_login_tokens. Reuse fails closed.
 *   - The pending token can only be minted AFTER password verification,
 *     so a caller without the password cannot reach this endpoint.
 *   - We re-validate account status — a user who was deactivated in
 *     the 5-minute pending window is rejected here.
 *   - The token's origin must be 'local'; SSO tokens are rejected so
 *     an attacker who somehow got a pending-SSO cookie can't reuse it
 *     on this endpoint.
 */
const forceLogin = async (req, res) => {
  try {
    const { pendingLoginToken } = req.body || {};
    if (!pendingLoginToken) {
      return res.status(400).json({
        success: false,
        code: 'PENDING_TOKEN_REQUIRED',
        message: 'Confirmation token is required.',
      });
    }

    const consumed = await consumePendingLoginToken(pendingLoginToken, 'local');
    if (!consumed.ok) {
      // 'used' / 'expired' / 'invalid' / 'origin_mismatch' all collapse
      // into a single generic error from the client's perspective. The
      // log line carries the specific reason for ops.
      console.warn(`[Auth.forceLogin] consume failed: ${consumed.reason}`);
      return res.status(400).json({
        success: false,
        code: 'PENDING_TOKEN_INVALID',
        message:
          'Session confirmation expired or invalid. Please enter your password again.',
      });
    }

    const user = await User.findByPk(consumed.userId);
    if (!user || !user.isActive || user.accountStatus !== 'approved') {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_UNAVAILABLE',
        message:
          'This account is no longer available. Please contact an administrator.',
      });
    }

    // Revoke ALL of the user's currently-active refresh tokens, drop
    // every live socket connection, and emit `auth:force_logout` to the
    // soon-to-be-disconnected sockets so the other tab can render a
    // banner instead of just silently dying.
    await revokeAllSessionsForForceLogout(user.id, 'forced_other_device');

    // Mint the new session. From here on the new browser is the only
    // valid session for this user.
    await establishSession(user, res, req);

    res.json({
      success: true,
      message: 'Signed in. The other session has been ended.',
      data: { user: user.toJSON() },
    });
  } catch (error) {
    console.error('[Auth] forceLogin error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * GET /api/auth/profile
 */
const getProfile = async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: { exclude: ['password'] },
    });

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    res.json({ success: true, data: { user } });
  } catch (error) {
    console.error('[Auth] GetProfile error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * PUT /api/auth/profile
 */
const updateProfile = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const allowedFields = ['name', 'avatar', 'department', 'designation', 'departmentId', 'teamsNotificationsEnabled', 'fontSizePreference', 'language'];
    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    // Server-side enum guard for fontSizePreference. The route validator
    // already rejects bad strings, but a defensive check here protects
    // controller-level callers and keeps the DB constraint from ever firing
    // on a normal request path.
    const ALLOWED_FONT_SIZES = ['compact', 'default', 'comfortable', 'large'];
    if (updates.fontSizePreference !== undefined && updates.fontSizePreference !== null) {
      if (!ALLOWED_FONT_SIZES.includes(updates.fontSizePreference)) {
        return res.status(400).json({
          success: false,
          message: `fontSizePreference must be one of: ${ALLOWED_FONT_SIZES.join(', ')}.`,
        });
      }
    }

    // Language preference — restricted to the locales the client actually
    // ships translations for. Same belt-and-braces pattern as fontSize:
    // the route validator already rejects bad input, this is a defensive
    // controller-level check (and protects controller-to-controller callers
    // that bypass express-validator).
    const ALLOWED_LANGUAGES = ['en', 'hi'];
    if (updates.language !== undefined && updates.language !== null) {
      if (!ALLOWED_LANGUAGES.includes(updates.language)) {
        return res.status(400).json({
          success: false,
          message: `language must be one of: ${ALLOWED_LANGUAGES.join(', ')}.`,
        });
      }
    }

    // Block password change for Microsoft SSO users who haven't created a local password
    if (req.body.newPassword && req.user.authProvider === 'microsoft' && !req.user.hasLocalPassword) {
      return res.status(400).json({
        success: false,
        message: 'No local password set. Create a password first from your profile settings.',
      });
    }

    // Allow password change if provided with current password
    if (req.body.newPassword) {
      if (!req.body.currentPassword) {
        return res.status(400).json({
          success: false,
          message: 'Current password is required to set a new password.',
        });
      }

      const isMatch = await req.user.comparePassword(req.body.currentPassword);
      if (!isMatch) {
        return res.status(401).json({
          success: false,
          message: 'Current password is incorrect.',
        });
      }

      updates.password = req.body.newPassword;
    }

    await req.user.update(updates);
    await req.user.reload();

    res.json({
      success: true,
      message: 'Profile updated successfully.',
      data: { user: req.user.toJSON() },
    });
  } catch (error) {
    console.error('[Auth] UpdateProfile error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * GET /api/auth/users
 * Returns all active users (for assigning tasks, adding board members, etc.).
 */
const getAllUsers = async (req, res) => {
  try {
    const { search, role, department } = req.query;

    const where = { isActive: true, accountStatus: 'approved' };

    if (search) {
      where[Op.or] = [
        { name: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
      ];
    }

    if (role) {
      where.role = role;
    }

    if (department) {
      where.department = { [Op.iLike]: `%${department}%` };
    }

    // Phase 5e — closes audit P0-10. Redact sensitive fields (email, role)
    // for non-management tiers. T1/T2 see the full directory; T3/T4 see only
    // the minimum needed to pick someone in an assignable-users dropdown.
    const { hasTierAtLeast } = require('../config/tiers');
    const isManagement = hasTierAtLeast(req.user, 2);
    const attributes = isManagement
      ? ['id', 'name', 'email', 'avatar', 'role', 'department']
      : ['id', 'name', 'avatar', 'department'];

    const users = await User.findAll({
      where,
      attributes,
      order: [['name', 'ASC']],
    });

    res.json({ success: true, data: { users } });
  } catch (error) {
    console.error('[Auth] GetAllUsers error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * POST /api/auth/avatar
 * Upload user avatar image.
 */
const uploadAvatar = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image file provided.' });
    }

    const { storeFile, cleanupOnError } = require('../services/storageService');
    const { url } = await storeFile({
      filePath: req.file.path,
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      category: 'avatar',
    });

    await req.user.update({ avatar: url });
    await req.user.reload();

    res.json({
      success: true,
      message: 'Avatar updated successfully.',
      data: { user: req.user.toJSON(), avatarUrl: url },
    });
  } catch (error) {
    console.error('[Auth] UploadAvatar error:', error);
    const { cleanupOnError } = require('../services/storageService');
    cleanupOnError(req.file);
    res.status(500).json({ success: false, message: 'Server error uploading avatar.' });
  }
};

/**
 * POST /api/auth/forgot-password
 * Generate a reset token. Works for local users AND Microsoft SSO users with a local password.
 * Always returns the same response to prevent email enumeration.
 */
const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });

    const GENERIC_MSG = 'If that email exists, a reset link has been sent.';

    const user = await User.findOne({ where: { email: email.toLowerCase() } });
    if (!user) {
      return res.json({ success: true, message: GENERIC_MSG });
    }

    // Only generate reset if user has a local password
    // Microsoft-only users (no local password) get the same generic response
    const hasPassword = user.hasLocalPassword || user.authProvider === 'local';
    if (!hasPassword) {
      return res.json({ success: true, message: GENERIC_MSG });
    }

    // Generate a random token, store its hash in DB
    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    await user.update({
      passwordResetToken: hashedToken,
      passwordResetExpires: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
    });

    const resetUrl = `${process.env.CLIENT_URL || 'http://localhost:3000'}/reset-password?token=${rawToken}`;

    // In production, send email. For now, log only in development.
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[Auth] Password reset requested for ${email}. Reset URL: ${resetUrl}`);
    }

    res.json({
      success: true,
      message: GENERIC_MSG,
      data: process.env.NODE_ENV === 'development' ? { resetUrl } : {},
    });
  } catch (error) {
    console.error('[Auth] ForgotPassword error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * POST /api/auth/reset-password
 * Reset password using a stored hashed token (single-use, 1-hour expiry).
 */
const resetPassword = async (req, res) => {
  try {
    const { token, newPassword, confirmNewPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ success: false, message: 'Token and new password are required.' });
    }
    if (confirmNewPassword !== undefined && newPassword !== confirmNewPassword) {
      return res.status(400).json({ success: false, message: 'Passwords do not match.' });
    }
    const pwError = validatePassword(newPassword);
    if (pwError) {
      return res.status(400).json({ success: false, message: pwError });
    }

    // Hash the provided token and look up in DB
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const user = await User.findOne({
      where: {
        passwordResetToken: hashedToken,
        passwordResetExpires: { [Op.gt]: new Date() },
      },
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'Reset link is invalid or has expired.',
      });
    }

    // Update password and clear reset token (single-use enforcement)
    await user.update({
      password: newPassword,
      hasLocalPassword: true,
      passwordChangedAt: new Date(),
      passwordResetToken: null,
      passwordResetExpires: null,
    });

    // Revoke all refresh tokens too — a forgot-password recovery is a strong
    // signal the user lost control of (or wants to reset) their sessions.
    await revokeAllRefreshTokensForUser(user.id);

    res.json({ success: true, message: 'Password reset successfully. You can now login.' });
  } catch (error) {
    console.error('[Auth] ResetPassword error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * POST /api/auth/create-password (authenticated — user must be logged in via Microsoft SSO first)
 * Allows Microsoft SSO users to create a local password for dual auth.
 */
const createPassword = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { password, confirmPassword } = req.body;

    if (!password || !confirmPassword) {
      return res.status(400).json({ success: false, message: 'Password and confirmation are required.' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ success: false, message: 'Passwords do not match.' });
    }

    const pwError = validatePassword(password);
    if (pwError) {
      return res.status(400).json({ success: false, message: pwError });
    }

    const user = await User.findByPk(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    if (user.hasLocalPassword) {
      return res.status(400).json({
        success: false,
        message: 'Password already exists. Use change-password instead.',
      });
    }

    await user.update({
      password,
      hasLocalPassword: true,
      passwordChangedAt: new Date(),
    });

    res.json({
      success: true,
      message: 'Password created successfully. You can now log in with your email and password.',
    });
  } catch (error) {
    console.error('[Auth] CreatePassword error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * PUT /api/auth/change-password (authenticated)
 * Change password for users who already have a local password.
 */
const changePassword = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { currentPassword, newPassword, confirmNewPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmNewPassword) {
      return res.status(400).json({ success: false, message: 'All password fields are required.' });
    }

    if (newPassword !== confirmNewPassword) {
      return res.status(400).json({ success: false, message: 'New passwords do not match.' });
    }

    const pwError = validatePassword(newPassword);
    if (pwError) {
      return res.status(400).json({ success: false, message: pwError });
    }

    const user = await User.findByPk(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    if (!user.hasLocalPassword && user.authProvider !== 'local') {
      return res.status(400).json({
        success: false,
        message: 'No local password set. Use create-password first.',
      });
    }

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
    }

    await user.update({
      password: newPassword,
      passwordChangedAt: new Date(),
    });

    // Revoke every active refresh token for this user. Combined with the
    // `iat < passwordChangedAt` check in refreshTokenEndpoint this gives us
    // belt-and-braces invalidation: even if a stolen refresh token slipped
    // past the timestamp check (clock skew, race), the per-token denylist
    // catches it on the next refresh attempt.
    await revokeAllRefreshTokensForUser(user.id);

    res.json({
      success: true,
      message: 'Password changed successfully. Please log in again.',
    });
  } catch (error) {
    console.error('[Auth] ChangePassword error:', error);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * GET /api/auth/pending-accounts
 */
const getPendingAccounts = async (req, res) => {
  try {
    const users = await User.findAll({
      where: { accountStatus: 'pending' },
      attributes: ['id', 'name', 'email', 'department', 'createdAt'],
      order: [['createdAt', 'DESC']],
    });
    res.json({ success: true, data: { users } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * PUT /api/auth/approve/:userId
 */
const approveAccount = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    await user.update({ accountStatus: 'approved' });
    res.json({ success: true, message: `${user.name}'s account has been approved.` });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * PUT /api/auth/reject/:userId
 *
 * Rejecting a pending account destroys the user row. Tier-2 actors are
 * blocked by `assertCanDelete` (decision #4 — T2 cannot delete anything,
 * anywhere) so they receive 403 even though the route admits them via
 * `managerOrAdmin`. Tier 1 may still reject pending accounts.
 */
const rejectAccount = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const { assertCanDelete } = require('../services/tierEnforcement');
    const { sendIfTierError } = require('../utils/tierResponseHelpers');
    if (sendIfTierError(res, () => assertCanDelete(req.user, 'user', { isOwnResource: false }))) return;

    await user.destroy();
    res.json({ success: true, message: `Account request from ${user.name} has been rejected and removed.` });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * POST /api/auth/refresh
 *
 * Exchange a valid refresh token for new access + refresh tokens, rotating
 * the refresh token in the process.
 *
 * Validation order (each must pass):
 *   1. JWT signature + expiry      — same as before, via jwt.verify.
 *   2. JWT `type === 'refresh'`     — reject access-token attempts.
 *   3. User exists and is active    — handles soft-delete / deactivation.
 *   4. JWT iat ≥ passwordChangedAt  — broad-sweep defence against tokens
 *                                     issued before a forced password reset.
 *   5. JTI exists in refresh_tokens — gate against forged JWTs (signature
 *                                     valid but not actually issued by us)
 *                                     and against tokens we revoked
 *                                     (logout, changePassword, etc.).
 *   6. JTI not revoked              — the per-token denylist itself.
 *   7. JTI not already rotated      — TOKEN-REUSE DETECTION. If the row's
 *                                     `replacedByJti` is set, this token was
 *                                     already exchanged. The fact that
 *                                     someone is replaying it is a strong
 *                                     signal of theft → we revoke EVERY
 *                                     active token for the user, not just
 *                                     this one.
 *
 * On success we revoke the presented JTI (recording the new JTI as its
 * `replacedByJti` for the chain audit trail) and issue a new pair.
 *
 * Backward compatibility note (soft cutover)
 * ------------------------------------------
 * Tokens issued before this code shipped do NOT carry a `jti` claim. They'd
 * fail step 5. To avoid forcing every active session to re-login on deploy
 * we accept claim-less tokens once: they pass through with steps 1–4 and a
 * fresh JTI'd token is issued. After the natural 7-day window all legacy
 * tokens have expired; from then on every refresh hits the full chain.
 */
const refreshTokenEndpoint = async (req, res) => {
  try {
    // D-1: prefer the httpOnly cookie. Falls back to req.body.refreshToken
    // for clients that haven't migrated yet.
    const refreshToken = getRefreshTokenFromRequest(req);
    if (!refreshToken) {
      return res.status(400).json({ success: false, message: 'refreshToken required.' });
    }

    const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
    if (decoded.type !== 'refresh') {
      return res.status(401).json({ success: false, message: 'Invalid token type.' });
    }

    const user = await User.findByPk(decoded.id);
    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, message: 'User not found or inactive.' });
    }

    // Phase 7 — Reject refresh tokens that pre-date the user's last password
    // change. Without this, a stolen long-lived refresh token survives any
    // forced reset until its 7-day natural expiry.
    if (user.passwordChangedAt && decoded.iat) {
      const passwordChangedAtSec = Math.floor(new Date(user.passwordChangedAt).getTime() / 1000);
      if (decoded.iat + 1 < passwordChangedAtSec) {
        return res.status(401).json({
          success: false,
          message: 'Session expired. Please log in again.',
          code: 'PASSWORD_CHANGED',
        });
      }
    }

    // Soft-cutover: tokens issued before D-2 don't carry a `jti`. Treat them
    // as legacy — let them refresh once, the new token will be tracked.
    if (!decoded.jti) {
      const { token: newRefreshToken, jti: newJti } = await issueRefreshToken(user.id, req);
      const newToken = generateToken(user.id, newJti);
      setAuthCookies(res, { accessToken: newToken, refreshToken: newRefreshToken });
      return res.json({ success: true });
    }

    const record = await RefreshToken.findByPk(decoded.jti);
    if (!record) {
      // JWT signature is valid AND user is active AND iat is newer than
      // passwordChangedAt — but we have no record of issuing this JTI. That
      // shouldn't happen unless the refresh_tokens row was wiped (schema
      // reset) OR the token was forged with our secret (catastrophic, but
      // either way we 401). Don't try to be clever.
      return res.status(401).json({ success: false, message: 'Refresh token is no longer valid. Please log in again.', code: 'TOKEN_NOT_TRACKED' });
    }

    if (record.revokedAt) {
      // Two cases: (a) we revoked this token (logout / changePassword) — fine,
      // 401. (b) it was already rotated (replacedByJti is set) and someone is
      // replaying the OLD token — strong indicator of session compromise.
      // Burn the chain.
      if (record.replacedByJti) {
        await revokeAllRefreshTokensForUser(user.id);
        return res.status(401).json({
          success: false,
          message: 'Session compromised — all sessions have been ended. Please log in again.',
          code: 'TOKEN_REUSE_DETECTED',
        });
      }
      return res.status(401).json({
        success: false,
        message: 'Refresh token has been revoked. Please log in again.',
        code: 'TOKEN_REVOKED',
      });
    }

    // All checks passed — issue new pair and rotate the old row.
    // Single-active-session: the new access token's `sid` is the NEW
    // refresh JTI, so the middleware's session lookup follows the
    // current head of the rotation chain. The OLD refresh row gets
    // revokedAt + replacedByJti set, which the middleware treats as
    // a rotation (NOT a hard revoke) so any in-flight access token
    // issued in the previous cycle stays valid until natural expiry.
    const { token: newRefreshToken, jti: newJti } = await issueRefreshToken(user.id, req);
    const newToken = generateToken(user.id, newJti);
    await revokeRefreshToken(decoded.jti, newJti || null);

    // D-1: refresh the cookies so the new pair takes effect on the next
    // request. The browser overwrites the old cookies in place because the
    // (name, path, domain) tuple matches. Phase 2: the body no longer
    // carries the tokens — the cookies are the sole delivery channel.
    setAuthCookies(res, { accessToken: newToken, refreshToken: newRefreshToken });

    res.json({ success: true });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Refresh token expired. Please login again.' });
    }
    res.status(401).json({ success: false, message: 'Invalid refresh token.' });
  }
};

/**
 * GET /api/auth/microsoft
 * Start Microsoft SSO flow — return the authorization URL.
 */
const microsoftAuthUrl = async (req, res) => {
  try {
    const config = await getTeamsConfig();
    if (!config.isConfigured) {
      return res.status(503).json({
        success: false,
        message: 'Microsoft integration is not configured. Ask your admin to set it up in Integrations.',
      });
    }
    if (!config.ssoEnabled) {
      return res.status(503).json({
        success: false,
        message: 'Microsoft SSO is not enabled. Ask your admin to enable it in Integrations.',
      });
    }

    const state = jwt.sign({ type: 'sso_state' }, process.env.JWT_SECRET, { expiresIn: '10m' });

    const authUrl = `${config.authUrl}/authorize?` + new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      redirect_uri: config.ssoRedirectUri,
      scope: config.ssoScopes.join(' '),
      state,
      response_mode: 'query',
      prompt: 'select_account',
    }).toString();

    res.json({ success: true, data: { authUrl } });
  } catch (error) {
    console.error('[Auth] Microsoft SSO URL error:', error);
    res.status(500).json({ success: false, message: 'Failed to start Microsoft sign-in.' });
  }
};

/**
 * GET /api/auth/microsoft/callback
 * Microsoft SSO callback — exchange code for tokens, find/create user, issue JWT.
 */
const microsoftCallback = async (req, res) => {
  const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';
  const { code, state, error: authError } = req.query;

  if (authError) {
    return res.redirect(`${CLIENT_URL}/login?sso=error&msg=${encodeURIComponent(authError)}`);
  }

  if (!code || !state) {
    return res.redirect(`${CLIENT_URL}/login?sso=error&msg=missing_params`);
  }

  try {
    // Verify state token
    try {
      const decoded = jwt.verify(state, process.env.JWT_SECRET);
      if (decoded.type !== 'sso_state') throw new Error('Invalid state');
    } catch {
      return res.redirect(`${CLIENT_URL}/login?sso=error&msg=invalid_state`);
    }

    const config = await getTeamsConfig();

    // Exchange code for tokens
    const tokenRes = await axios.post(
      `${config.authUrl}/token`,
      new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.ssoRedirectUri,
        scope: config.ssoScopes.join(' '),
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in, id_token } = tokenRes.data;

    // Decode id_token claims. NOTE: signature is not verified here because the token
    // was just received over a TLS-secured server-to-server token-exchange call; Microsoft
    // is the only party that could have produced it. We still validate iss/aud below.
    // For defense-in-depth a future change can verify the JWT signature via JWKS.
    let email, name, oid, iss, aud;
    if (id_token) {
      const payload = JSON.parse(Buffer.from(id_token.split('.')[1], 'base64').toString());
      email = (payload.email || payload.preferred_username || '').toLowerCase();
      name = payload.name || '';
      // Prefer the Azure AD object id (oid). NEVER fall back to `sub` — `sub` is
      // application-scoped and is not a stable cross-app identifier.
      oid = payload.oid || '';
      iss = payload.iss || '';
      aud = payload.aud || '';
    }

    // Fallback: fetch profile from Graph API (only if id_token didn't give us email/oid).
    if (!email || !oid) {
      try {
        const profileRes = await axios.get('https://graph.microsoft.com/v1.0/me', {
          headers: { Authorization: `Bearer ${access_token}` },
        });
        email = email || (profileRes.data.mail || profileRes.data.userPrincipalName || '').toLowerCase();
        name = name || profileRes.data.displayName || '';
        oid = oid || profileRes.data.id || '';
      } catch (profileErr) {
        console.error('[Auth] SSO profile fetch error:', profileErr.message);
        return res.redirect(`${CLIENT_URL}/login?sso=error&msg=profile_fetch_failed`);
      }
    }

    if (!email) {
      return res.redirect(`${CLIENT_URL}/login?sso=error&msg=no_email`);
    }

    // Validate id_token issuer + audience. This catches a token produced for a
    // different app or, in single-tenant mode, a different tenant.
    if (id_token && config.clientId) {
      if (aud && aud !== config.clientId) {
        console.error('[Auth] SSO rejected: id_token audience does not match client id.');
        return res.redirect(`${CLIENT_URL}/login?sso=error&msg=${encodeURIComponent('Invalid identity token.')}`);
      }
      // For single-tenant deployments (tenantId is a real GUID, not 'common'/'organizations'/'consumers'),
      // pin the issuer to that tenant. Multi-tenant deployments accept any verified Microsoft issuer.
      const tid = config.tenantId;
      const isSingleTenant = tid && !['common', 'organizations', 'consumers'].includes(tid);
      if (isSingleTenant && iss) {
        const expectedIssuers = [
          `https://login.microsoftonline.com/${tid}/v2.0`,
          `https://sts.windows.net/${tid}/`,
        ];
        if (!expectedIssuers.includes(iss)) {
          console.error(`[Auth] SSO rejected: unexpected id_token issuer (got=${iss}).`);
          return res.redirect(`${CLIENT_URL}/login?sso=error&msg=${encodeURIComponent('Invalid identity token.')}`);
        }
      }
    }

    // ---- Resolve the local user DETERMINISTICALLY ----
    // The previous implementation used `Op.or` between email and teamsUserId, which
    // returned the wrong row whenever two users matched (e.g. a stale duplicated
    // teamsUserId). We now resolve OID-first, then email, with explicit conflict
    // detection at every step. We use findAll (not findOne) so duplicates surface
    // instead of being silently swallowed.
    let user = null;
    let matchedBy = null;

    // Step 1 — OID lookup (Microsoft object id is the stable, primary identifier).
    if (oid) {
      const oidMatches = await User.findAll({ where: { teamsUserId: oid } });
      if (oidMatches.length > 1) {
        console.error(
          `[Auth] SSO security error: ${oidMatches.length} users share teamsUserId for ` +
            `incoming email=${email}. User ids=[${oidMatches.map((u) => u.id).join(',')}].`
        );
        return res.redirect(
          `${CLIENT_URL}/login?sso=error&msg=${encodeURIComponent(
            'Account conflict detected — multiple users are linked to this Microsoft identity. Contact your administrator.'
          )}`
        );
      }
      if (oidMatches.length === 1) {
        const candidate = oidMatches[0];
        // The OID-matched user's email should match the SSO email. If it doesn't,
        // the teamsUserId on this row is stale/wrong — refuse to log in.
        if ((candidate.email || '').toLowerCase() !== email) {
          console.error(
            `[Auth] SSO security error: OID matched user ${candidate.id} but email differs ` +
              `(db=${candidate.email}, sso=${email}). Refusing login.`
          );
          return res.redirect(
            `${CLIENT_URL}/login?sso=error&msg=${encodeURIComponent(
              'Account conflict detected — Microsoft identity does not match this account. Contact your administrator.'
            )}`
          );
        }
        user = candidate;
        matchedBy = 'oid';
      }
    }

    // Step 2 — Email lookup as a fallback for first-time linking.
    if (!user) {
      const emailMatches = await User.findAll({ where: { email } });
      if (emailMatches.length > 1) {
        console.error(`[Auth] SSO security error: duplicate emails detected for ${email}.`);
        return res.redirect(
          `${CLIENT_URL}/login?sso=error&msg=${encodeURIComponent(
            'Account conflict detected — multiple users have this email. Contact your administrator.'
          )}`
        );
      }
      if (emailMatches.length === 1) {
        const candidate = emailMatches[0];
        // If the candidate is already linked to a DIFFERENT Microsoft identity,
        // refuse — this prevents silently overwriting an existing link.
        if (candidate.teamsUserId && oid && candidate.teamsUserId !== oid) {
          console.error(
            `[Auth] SSO security error: email ${email} is already linked to a different ` +
              `Microsoft identity (db=${candidate.teamsUserId.slice(0, 6)}…, sso=${oid.slice(0, 6)}…).`
          );
          return res.redirect(
            `${CLIENT_URL}/login?sso=error&msg=${encodeURIComponent(
              'This account is linked to a different Microsoft identity. Contact your administrator.'
            )}`
          );
        }
        user = candidate;
        matchedBy = 'email';
      }
    }

    if (user) {
      // Update teams tokens. Only set teamsUserId when not already set, and only when
      // we have an OID — never blindly overwrite an existing link.
      const updates = {
        teamsAccessToken: access_token,
        teamsTokenExpiry: new Date(Date.now() + expires_in * 1000),
      };
      if (refresh_token) updates.teamsRefreshToken = refresh_token;
      if (oid && !user.teamsUserId) updates.teamsUserId = oid;
      // Only change authProvider if user has no local password set
      if (user.authProvider === 'local' && !user.password) updates.authProvider = 'microsoft';
      await user.update(updates);

      // Check account status
      if (!user.isActive) {
        return res.redirect(`${CLIENT_URL}/login?sso=error&msg=${encodeURIComponent('Account has been deactivated.')}`);
      }
      if (user.accountStatus === 'pending') {
        return res.redirect(`${CLIENT_URL}/login?sso=error&msg=${encodeURIComponent('Account is pending admin approval.')}`);
      }
      if (user.accountStatus === 'rejected') {
        return res.redirect(`${CLIENT_URL}/login?sso=error&msg=${encodeURIComponent('Account request was rejected.')}`);
      }
    } else {
      // No user matched — auto-create. Always role='member'; role is NEVER taken
      // from the Microsoft profile.
      user = await User.create({
        name: name || email.split('@')[0],
        email,
        password: null,
        authProvider: 'microsoft',
        role: 'member',
        teamsUserId: oid,
        teamsAccessToken: access_token,
        teamsRefreshToken: refresh_token,
        teamsTokenExpiry: new Date(Date.now() + expires_in * 1000),
        isActive: true,
        accountStatus: 'approved',
      });
      matchedBy = 'created';
    }

    console.log(`[Auth] SSO login resolved: user=${user.id} email=${user.email} matchedBy=${matchedBy}`);

    // ── Single-active-session — SSO branch ───────────────────────
    // Mirror the local-login behaviour: if a live session already
    // exists for this user, DO NOT silently take it over. Mint a
    // pending-login token, drop it into an httpOnly cookie (so it
    // never appears in browser history / Referer headers), and
    // redirect to /login?sso=session_conflict. The frontend renders
    // the "continue here?" UI and posts to /auth/login/force-sso,
    // which reads the cookie and consumes the token.
    const activeSession = await findActiveSessionForUser(user.id);
    if (activeSession) {
      const rawPendingToken = await createPendingLoginToken(user, 'sso', req);
      setPendingLoginCookie(res, rawPendingToken);
      return res.redirect(`${CLIENT_URL}/login?sso=session_conflict`);
    }

    // No active session — establish one. establishSession writes the
    // refresh row, signs the access token with `sid` = new JTI, and
    // sets both httpOnly cookies. The frontend reads the cookie on
    // /login?sso=success and calls /auth/me to load the user.
    await establishSession(user, res, req);
    res.redirect(`${CLIENT_URL}/login?sso=success`);
  } catch (error) {
    console.error('[Auth] Microsoft SSO callback error:', error.response?.data || error.message);
    res.redirect(`${CLIENT_URL}/login?sso=error&msg=${encodeURIComponent('Authentication failed. Please try again.')}`);
  }
};

/**
 * GET /api/auth/login/pending-sso
 *
 * Read-only endpoint the SSO conflict page calls to confirm there is a
 * valid pending-SSO cookie and to surface the email/name of the
 * authenticated user (so the UI can say "Continue as <name>?"). Does
 * NOT consume the token — only inspects it.
 *
 * Returns:
 *   200 { success:true, data:{ email, name, avatar, otherDevice } }
 *   401 if the cookie is missing/expired/used/origin-mismatched.
 */
const getPendingSsoInfo = async (req, res) => {
  try {
    const rawToken = getPendingLoginTokenFromRequest(req);
    if (!rawToken) {
      return res.status(401).json({
        success: false,
        code: 'PENDING_SSO_MISSING',
        message: 'No pending SSO sign-in.',
      });
    }
    const hashed = hashPendingToken(rawToken);
    const row = await PendingLoginToken.findOne({ where: { tokenHash: hashed } });
    if (!row || row.usedAt || new Date(row.expiresAt) <= new Date() || row.origin !== 'sso') {
      clearPendingLoginCookie(res);
      return res.status(401).json({
        success: false,
        code: 'PENDING_SSO_INVALID',
        message: 'Pending SSO sign-in expired. Please sign in again.',
      });
    }
    const user = await User.findByPk(row.userId, {
      attributes: ['id', 'name', 'email', 'avatar'],
    });
    if (!user) {
      clearPendingLoginCookie(res);
      return res.status(401).json({ success: false, message: 'User not found.' });
    }
    // Best-effort device hint for the UI. Look up the active session
    // we'd be displacing; safe to omit if it disappeared in the
    // meantime (still allow the confirm flow to proceed).
    const activeSession = await findActiveSessionForUser(user.id);
    const otherDevice = activeSession
      ? {
          userAgent: (activeSession.userAgent || '').slice(0, 80) || null,
          ip: activeSession.ip || null,
          issuedAt: activeSession.issuedAt,
        }
      : null;
    res.json({
      success: true,
      data: {
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        otherDevice,
      },
    });
  } catch (err) {
    console.error('[Auth] getPendingSsoInfo error:', err && err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * POST /api/auth/login/force-sso
 *
 * SSO equivalent of /api/auth/login/force. Reads the pending-SSO token
 * from the httpOnly cookie (set by microsoftCallback when it detected a
 * conflict), consumes it, revokes every existing session for the user,
 * force-disconnects their sockets, and establishes a new session.
 *
 * Security:
 *   - Token origin must be 'sso'; a local-login pending token cannot be
 *     redeemed here.
 *   - Single-use enforced at the DB layer.
 *   - User must still be active + approved; deactivated-in-the-window
 *     case is rejected.
 *   - The token came from a successful Microsoft `code` exchange, so
 *     password proof is implicit through the OAuth round-trip.
 */
const forceLoginSSO = async (req, res) => {
  try {
    const rawToken = getPendingLoginTokenFromRequest(req);
    if (!rawToken) {
      return res.status(400).json({
        success: false,
        code: 'PENDING_TOKEN_REQUIRED',
        message: 'Pending SSO sign-in is missing or expired. Please sign in again.',
      });
    }

    const consumed = await consumePendingLoginToken(rawToken, 'sso');
    if (!consumed.ok) {
      clearPendingLoginCookie(res);
      console.warn(`[Auth.forceLoginSSO] consume failed: ${consumed.reason}`);
      return res.status(400).json({
        success: false,
        code: 'PENDING_TOKEN_INVALID',
        message: 'Pending SSO sign-in expired or invalid. Please sign in again.',
      });
    }

    const user = await User.findByPk(consumed.userId);
    if (!user || !user.isActive || user.accountStatus !== 'approved') {
      clearPendingLoginCookie(res);
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_UNAVAILABLE',
        message:
          'This account is no longer available. Please contact an administrator.',
      });
    }

    await revokeAllSessionsForForceLogout(user.id, 'forced_other_device');
    await establishSession(user, res, req);
    clearPendingLoginCookie(res);

    res.json({
      success: true,
      message: 'Signed in. The other session has been ended.',
      data: { user: user.toJSON() },
    });
  } catch (err) {
    console.error('[Auth] forceLoginSSO error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

/**
 * GET /api/auth/sso-status
 * Check if Microsoft SSO is enabled (public — used by login page).
 */
const getSsoStatus = async (req, res) => {
  try {
    const config = await getTeamsConfig();
    res.json({
      success: true,
      data: { ssoEnabled: config.isConfigured && config.ssoEnabled },
    });
  } catch {
    res.json({ success: true, data: { ssoEnabled: false } });
  }
};

/**
 * GET /api/auth/assignable-users
 * Returns users that the current user can assign tasks to, based on org hierarchy.
 */
const getAssignableUsersList = async (req, res) => {
  try {
    const { getAssignableUsers } = require('../services/hierarchyService');
    const users = await getAssignableUsers(req.user);
    res.json({ success: true, data: { users } });
  } catch (error) {
    console.error('[Auth] getAssignableUsers error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch assignable users.' });
  }
};

module.exports = {
  register,
  login,
  forceLogin,
  forceLoginSSO,
  getPendingSsoInfo,
  getProfile,
  updateProfile,
  getAllUsers,
  getAssignableUsersList,
  uploadAvatar,
  forgotPassword,
  resetPassword,
  createPassword,
  changePassword,
  getPendingAccounts,
  approveAccount,
  rejectAccount,
  refreshTokenEndpoint,
  microsoftAuthUrl,
  microsoftCallback,
  getSsoStatus,
  // D-2 helpers exported so auth routes (logout) and other modules
  // (admin "logout everywhere") can revoke tokens cleanly.
  revokeRefreshToken,
  revokeAllRefreshTokensForUser,
};
