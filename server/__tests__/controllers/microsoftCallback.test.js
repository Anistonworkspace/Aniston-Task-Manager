'use strict';

/**
 * Tests for the Microsoft SSO callback controller (`microsoftCallback`).
 *
 * These tests focus on the security gates layered around the token exchange:
 *   - id_token audience must match the configured client id
 *   - id_token issuer must match the configured tenant (single-tenant deploys)
 *   - OID is the stable identity — collisions / mismatches must be rejected
 *   - Email-already-linked-to-a-different-OID must be rejected (no silent
 *     overwrite of an existing SSO link)
 *   - Deactivated accounts must be turned away
 *   - First-time users get auto-created with role='member'
 *
 * No real Microsoft endpoints, sockets, DB, or cookies are involved — every
 * external dependency is mocked.  We invoke `microsoftCallback` as a plain
 * function with stub `req` / `res` objects, asserting the redirect target.
 */

process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';
process.env.CLIENT_URL = 'http://localhost:3000';

// ─── Mocks (declared before any require of the mocked modules) ───────────

jest.mock('../../models', () => ({
  User: {
    findAll: jest.fn(),
    findOne: jest.fn(),
    findByPk: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    // Mirror the real model's allowlist so controller code that does
    // `attributes: User.SAFE_USER_ATTRIBUTES` resolves to a real array.
    SAFE_USER_ATTRIBUTES: [
      'id', 'name', 'email', 'authProvider', 'avatar', 'role',
      'department', 'designation', 'teamsUserId', 'teamsNotificationsEnabled',
      'isActive', 'localStatusOverride', 'isSuperAdmin', 'tier',
      'accountStatus', 'hierarchyLevel', 'title', 'hasLocalPassword',
      'passwordChangedAt', 'fontSizePreference', 'language',
      'createdAt', 'updatedAt', 'departmentId', 'workspaceId', 'managerId',
    ],
  },
  RefreshToken: {
    findOne: jest.fn(),
    findAll: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  PendingLoginToken: {
    create: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
  },
}));

jest.mock('axios', () => ({
  post: jest.fn(),
  get: jest.fn(),
}));

jest.mock('../../config/teams', () => ({
  getTeamsConfig: jest.fn().mockResolvedValue({
    isConfigured: true,
    ssoEnabled: true,
    clientId: 'aniston-app-client-id',
    clientSecret: 'shh',
    tenantId: '11111111-2222-3333-4444-555555555555',
    authUrl: 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/oauth2/v2.0',
    ssoRedirectUri: 'http://localhost:5000/api/auth/microsoft/callback',
    ssoScopes: ['openid', 'profile', 'email'],
  }),
}));

jest.mock('../../services/socketService', () => ({
  emitToBoard: jest.fn(),
  emitToUser: jest.fn(),
  forceDisconnectUser: jest.fn(),
  getIO: jest.fn(() => ({ emit: jest.fn() })),
}));

jest.mock('../../utils/authCookies', () => ({
  setAuthCookies: jest.fn(),
  clearAuthCookies: jest.fn(),
  getRefreshTokenFromRequest: jest.fn(),
  setPendingLoginCookie: jest.fn(),
  clearPendingLoginCookie: jest.fn(),
  getPendingLoginTokenFromRequest: jest.fn(),
}));

// P0-5: Teams OAuth tokens are encrypted at rest — mock to pass-through so
// assertions don't need to know about the encryption format.
jest.mock('../../utils/teamsTokenStorage', () => ({
  encryptTeamsToken: jest.fn((t) => `enc:${t}`),
  decryptTeamsToken: jest.fn((t) => String(t || '').replace(/^enc:/, '')),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────

const jwt = require('jsonwebtoken');
const axios = require('axios');
const { microsoftCallback } = require('../../controllers/authController');
const { User, RefreshToken, PendingLoginToken } = require('../../models');

// ─── Helpers ──────────────────────────────────────────────────────────────

function buildIdToken({ email, name, oid, iss, aud }) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ email, name, oid, iss, aud })).toString('base64url');
  return `${header}.${payload}.fake-signature`;
}

function validState() {
  return jwt.sign({ type: 'sso_state' }, process.env.JWT_SECRET, { expiresIn: '5m' });
}

function makeRes() {
  return {
    redirect: jest.fn(),
    cookie: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
}

function defaultTokenResponse({ idTokenOpts } = {}) {
  const tenant = '11111111-2222-3333-4444-555555555555';
  const id_token = buildIdToken({
    email: 'alice@aniston.com',
    name: 'Alice',
    oid: 'ms-oid-alice',
    iss: `https://login.microsoftonline.com/${tenant}/v2.0`,
    aud: 'aniston-app-client-id',
    ...idTokenOpts,
  });
  return {
    data: {
      access_token: 'fake-access-token',
      refresh_token: 'fake-refresh-token',
      expires_in: 3600,
      id_token,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no active session — go straight to establishSession path.
  RefreshToken.findOne.mockResolvedValue(null);
  RefreshToken.create.mockResolvedValue({ id: 'rt-1', jti: 'jti-new', token: 'rt-raw' });
  PendingLoginToken.create.mockResolvedValue({ id: 'pl-1' });
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe('microsoftCallback — happy path', () => {
  it('logs in an existing user matched by OID and redirects to /login?sso=success', async () => {
    axios.post.mockResolvedValue(defaultTokenResponse());
    const existingUser = {
      id: 'u-alice',
      email: 'alice@aniston.com',
      teamsUserId: 'ms-oid-alice',
      isActive: true,
      accountStatus: 'approved',
      authProvider: 'microsoft',
      password: null,
      update: jest.fn().mockResolvedValue(true),
    };
    User.findAll.mockResolvedValueOnce([existingUser]); // OID lookup hit

    const req = { query: { code: 'auth-code', state: validState() }, headers: {}, ip: '127.0.0.1' };
    const res = makeRes();
    await microsoftCallback(req, res);

    expect(res.redirect).toHaveBeenCalledTimes(1);
    expect(res.redirect.mock.calls[0][0]).toMatch(/\/login\?sso=success$/);
    expect(existingUser.update).toHaveBeenCalled();
    expect(User.create).not.toHaveBeenCalled();
  });

  it('auto-creates a new user (role=member, OID linked) on first login', async () => {
    axios.post.mockResolvedValue(defaultTokenResponse());
    User.findAll
      .mockResolvedValueOnce([])  // OID lookup miss
      .mockResolvedValueOnce([]); // email lookup miss
    const created = {
      id: 'u-new',
      email: 'alice@aniston.com',
      teamsUserId: 'ms-oid-alice',
      isActive: true,
      accountStatus: 'approved',
      role: 'member',
      update: jest.fn().mockResolvedValue(true),
    };
    User.create.mockResolvedValue(created);

    const req = { query: { code: 'auth-code', state: validState() }, headers: {}, ip: '127.0.0.1' };
    const res = makeRes();
    await microsoftCallback(req, res);

    expect(User.create).toHaveBeenCalledWith(expect.objectContaining({
      email: 'alice@aniston.com',
      role: 'member',
      teamsUserId: 'ms-oid-alice',
      authProvider: 'microsoft',
      accountStatus: 'approved',
    }));
    expect(res.redirect.mock.calls[0][0]).toMatch(/sso=success/);
  });
});

describe('microsoftCallback — token validation', () => {
  it('rejects when id_token audience does not match the configured client id', async () => {
    axios.post.mockResolvedValue(defaultTokenResponse({
      idTokenOpts: { aud: 'someone-elses-client-id' },
    }));
    // Email lookup still runs (audience check fires after profile fallback) —
    // make sure no user is found so we don't bypass the audience check via
    // some unrelated path.
    User.findAll.mockResolvedValue([]);

    const req = { query: { code: 'c', state: validState() }, headers: {}, ip: '1.1.1.1' };
    const res = makeRes();
    await microsoftCallback(req, res);

    expect(res.redirect).toHaveBeenCalledTimes(1);
    expect(res.redirect.mock.calls[0][0]).toMatch(/sso=error/);
    expect(res.redirect.mock.calls[0][0]).toMatch(/Invalid%20identity%20token/);
    expect(User.create).not.toHaveBeenCalled();
  });

  it('rejects when id_token issuer is for a different tenant (single-tenant mode)', async () => {
    axios.post.mockResolvedValue(defaultTokenResponse({
      idTokenOpts: {
        iss: 'https://login.microsoftonline.com/AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA/v2.0',
      },
    }));
    User.findAll.mockResolvedValue([]);

    const req = { query: { code: 'c', state: validState() }, headers: {}, ip: '1.1.1.1' };
    const res = makeRes();
    await microsoftCallback(req, res);

    expect(res.redirect.mock.calls[0][0]).toMatch(/sso=error/);
    expect(res.redirect.mock.calls[0][0]).toMatch(/Invalid%20identity%20token/);
    expect(User.create).not.toHaveBeenCalled();
  });

  it('rejects invalid state token (CSRF protection)', async () => {
    const req = { query: { code: 'c', state: 'totally.invalid.state' }, headers: {}, ip: '1.1.1.1' };
    const res = makeRes();
    await microsoftCallback(req, res);

    expect(res.redirect.mock.calls[0][0]).toMatch(/sso=error/);
    expect(res.redirect.mock.calls[0][0]).toMatch(/invalid_state/);
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('microsoftCallback — identity collisions', () => {
  it('rejects when OID matches an existing user with a different email', async () => {
    axios.post.mockResolvedValue(defaultTokenResponse());
    // OID hits a user but their stored email differs from the SSO email
    User.findAll.mockResolvedValueOnce([
      {
        id: 'u-bob',
        email: 'bob@aniston.com',           // different from sso email alice@
        teamsUserId: 'ms-oid-alice',
        isActive: true,
        accountStatus: 'approved',
      },
    ]);

    const req = { query: { code: 'c', state: validState() }, headers: {}, ip: '1.1.1.1' };
    const res = makeRes();
    await microsoftCallback(req, res);

    expect(res.redirect.mock.calls[0][0]).toMatch(/sso=error/);
    expect(res.redirect.mock.calls[0][0]).toMatch(/Account%20conflict/);
    expect(User.create).not.toHaveBeenCalled();
  });

  it('rejects when multiple users share the same teamsUserId (data corruption)', async () => {
    axios.post.mockResolvedValue(defaultTokenResponse());
    User.findAll.mockResolvedValueOnce([
      { id: 'u-1', email: 'alice@aniston.com', teamsUserId: 'ms-oid-alice' },
      { id: 'u-2', email: 'alice@aniston.com', teamsUserId: 'ms-oid-alice' },
    ]);

    const req = { query: { code: 'c', state: validState() }, headers: {}, ip: '1.1.1.1' };
    const res = makeRes();
    await microsoftCallback(req, res);

    expect(res.redirect.mock.calls[0][0]).toMatch(/sso=error/);
    expect(res.redirect.mock.calls[0][0]).toMatch(/Account%20conflict/);
  });

  it('rejects when email is already linked to a different Microsoft identity', async () => {
    axios.post.mockResolvedValue(defaultTokenResponse());
    // OID lookup misses → falls through to email lookup, which finds a user
    // whose teamsUserId is already set to a DIFFERENT OID.
    User.findAll
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'u-alice',
          email: 'alice@aniston.com',
          teamsUserId: 'ms-oid-DIFFERENT-identity',
          isActive: true,
          accountStatus: 'approved',
        },
      ]);

    const req = { query: { code: 'c', state: validState() }, headers: {}, ip: '1.1.1.1' };
    const res = makeRes();
    await microsoftCallback(req, res);

    expect(res.redirect.mock.calls[0][0]).toMatch(/sso=error/);
    expect(res.redirect.mock.calls[0][0]).toMatch(/different%20Microsoft%20identity/);
  });
});

describe('microsoftCallback — account status gates', () => {
  it('rejects deactivated accounts with a clear message', async () => {
    axios.post.mockResolvedValue(defaultTokenResponse());
    User.findAll.mockResolvedValueOnce([{
      id: 'u-alice',
      email: 'alice@aniston.com',
      teamsUserId: 'ms-oid-alice',
      isActive: false,
      accountStatus: 'approved',
      update: jest.fn().mockResolvedValue(true),
    }]);

    const req = { query: { code: 'c', state: validState() }, headers: {}, ip: '1.1.1.1' };
    const res = makeRes();
    await microsoftCallback(req, res);

    expect(res.redirect.mock.calls[0][0]).toMatch(/sso=error/);
    expect(res.redirect.mock.calls[0][0]).toMatch(/deactivated/);
  });

  it('links a local-account user (existing email, no prior teamsUserId) on first SSO', async () => {
    axios.post.mockResolvedValue(defaultTokenResponse());
    const localUser = {
      id: 'u-local',
      email: 'alice@aniston.com',
      teamsUserId: null,             // never linked before
      authProvider: 'local',
      password: '$2a$10$hashed',
      isActive: true,
      accountStatus: 'approved',
      update: jest.fn().mockResolvedValue(true),
    };
    User.findAll
      .mockResolvedValueOnce([])      // OID miss
      .mockResolvedValueOnce([localUser]); // email hit

    const req = { query: { code: 'c', state: validState() }, headers: {}, ip: '1.1.1.1' };
    const res = makeRes();
    await microsoftCallback(req, res);

    expect(localUser.update).toHaveBeenCalledWith(expect.objectContaining({
      teamsUserId: 'ms-oid-alice',
    }));
    // authProvider should NOT change because user has a local password
    expect(localUser.update.mock.calls[0][0].authProvider).toBeUndefined();
    expect(res.redirect.mock.calls[0][0]).toMatch(/sso=success/);
  });
});

describe('microsoftCallback — column narrowing & token-write isolation (incident 2026-05-14)', () => {
  it('passes SAFE_USER_ATTRIBUTES to both match queries (never selects token columns)', async () => {
    axios.post.mockResolvedValue(defaultTokenResponse());
    // OID miss, then email miss — exercises both match queries.
    User.findAll
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    User.create.mockResolvedValue({
      id: 'u-new',
      email: 'alice@aniston.com',
      teamsUserId: 'ms-oid-alice',
      isActive: true,
      accountStatus: 'approved',
      update: jest.fn().mockResolvedValue(true),
    });

    const req = { query: { code: 'c', state: validState() }, headers: {}, ip: '1.1.1.1' };
    const res = makeRes();
    await microsoftCallback(req, res);

    expect(User.findAll).toHaveBeenCalledTimes(2);
    for (const call of User.findAll.mock.calls) {
      const opts = call[0] || {};
      expect(Array.isArray(opts.attributes)).toBe(true);
      // Token columns must NEVER appear in the match-query projection.
      expect(opts.attributes).not.toContain('teamsAccessToken');
      expect(opts.attributes).not.toContain('teamsRefreshToken');
      expect(opts.attributes).not.toContain('password');
      expect(opts.attributes).not.toContain('passwordResetToken');
      // The columns needed for the security checks below MUST be present.
      expect(opts.attributes).toEqual(expect.arrayContaining(['id', 'email', 'teamsUserId', 'isActive', 'accountStatus']));
    }
  });

  it('establishes a session even when the post-match token UPDATE fails (TOAST corruption)', async () => {
    axios.post.mockResolvedValue(defaultTokenResponse());
    const existingUser = {
      id: 'u-alice',
      email: 'alice@aniston.com',
      teamsUserId: 'ms-oid-alice',
      isActive: true,
      accountStatus: 'approved',
      authProvider: 'microsoft',
      password: null,
      // Simulate the exact Postgres error we saw in production: a UPDATE
      // against a row whose TOAST chunks are damaged.
      update: jest.fn().mockRejectedValue(
        Object.assign(new Error('attempted to delete invisible tuple'), {
          name: 'SequelizeDatabaseError',
        })
      ),
    };
    User.findAll.mockResolvedValueOnce([existingUser]);

    const req = { query: { code: 'c', state: validState() }, headers: {}, ip: '1.1.1.1' };
    const res = makeRes();
    await microsoftCallback(req, res);

    // SSO must still resolve successfully — Microsoft already authenticated
    // the user; failing to persist the delegated token is a Teams-feature
    // warning, not an authentication failure.
    expect(existingUser.update).toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledTimes(1);
    expect(res.redirect.mock.calls[0][0]).toMatch(/sso=success/);
    expect(res.redirect.mock.calls[0][0]).not.toMatch(/sso=error/);
  });
});
