'use strict';

/**
 * Tests for server/middleware/auth.js
 *
 * All external dependencies (jwt, User model) are mocked so no real
 * database or network calls are made.
 */

process.env.JWT_SECRET = 'test-secret-key';

// ─── Mocks ───────────────────────────────────────────────────────────────────

jest.mock('jsonwebtoken');
jest.mock('../../models', () => ({
  User: {
    findByPk: jest.fn(),
  },
  PermissionGrant: {
    findAll: jest.fn().mockResolvedValue([]),
  },
}));

const jwt = require('jsonwebtoken');
const { User } = require('../../models');
const { authenticate, adminOnly, managerOrAdmin, assistantManagerOnly, requireRole } = require('../../middleware/auth');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a lightweight mock Express req/res/next triple.
 * Pass extra properties on req to simulate headers, user, etc.
 */
function buildMocks(reqOverrides = {}) {
  const req = {
    headers: {},
    user: null,
    ...reqOverrides,
  };
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const next = jest.fn();
  return { req, res, next };
}

function makeActiveUser(overrides = {}) {
  return {
    id: 'user-uuid-1',
    name: 'Test User',
    email: 'test@aniston.com',
    role: 'member',
    isActive: true,
    ...overrides,
  };
}

// ─── authenticate ─────────────────────────────────────────────────────────────

describe('authenticate middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when no Authorization header is present', async () => {
    const { req, res, next } = buildMocks({ headers: {} });

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: expect.stringContaining('No token') })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization header does not start with "Bearer "', async () => {
    const { req, res, next } = buildMocks({ headers: { authorization: 'Basic abc123' } });

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token is invalid (JsonWebTokenError)', async () => {
    const err = new Error('invalid signature');
    err.name = 'JsonWebTokenError';
    jwt.verify.mockImplementation(() => { throw err; });

    const { req, res, next } = buildMocks({ headers: { authorization: 'Bearer bad.token.here' } });

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: 'Invalid token.' })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token has expired (TokenExpiredError)', async () => {
    const err = new Error('jwt expired');
    err.name = 'TokenExpiredError';
    jwt.verify.mockImplementation(() => { throw err; });

    const { req, res, next } = buildMocks({ headers: { authorization: 'Bearer expired.token.here' } });

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: 'Token has expired. Please log in again.' })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when the decoded user no longer exists in the database', async () => {
    jwt.verify.mockReturnValue({ id: 'ghost-user-id' });
    User.findByPk.mockResolvedValue(null);

    const { req, res, next } = buildMocks({ headers: { authorization: 'Bearer valid.token.here' } });

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: expect.stringContaining('user no longer exists') })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when the user account has been deactivated', async () => {
    jwt.verify.mockReturnValue({ id: 'inactive-user-id' });
    User.findByPk.mockResolvedValue(makeActiveUser({ isActive: false }));

    const { req, res, next } = buildMocks({ headers: { authorization: 'Bearer valid.token.here' } });

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: expect.stringContaining('deactivated') })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() and attaches user to req when token is valid and user is active', async () => {
    const mockUser = makeActiveUser({ id: 'active-user-id', role: 'member' });
    jwt.verify.mockReturnValue({ id: mockUser.id });
    User.findByPk.mockResolvedValue(mockUser);

    const { req, res, next } = buildMocks({ headers: { authorization: 'Bearer valid.token.here' } });

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBe(mockUser);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 500 when an unexpected error is thrown during authentication', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('unexpected failure'); });

    const { req, res, next } = buildMocks({ headers: { authorization: 'Bearer some.token' } });

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: 'Authentication error.' })
    );
  });
});

// ─── adminOnly ────────────────────────────────────────────────────────────────

describe('adminOnly middleware', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 403 when req.user is missing', () => {
    const { req, res, next } = buildMocks({ user: null });

    adminOnly(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: expect.stringContaining('Admin') })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when the user role is "member"', () => {
    const { req, res, next } = buildMocks({ user: makeActiveUser({ role: 'member' }) });

    adminOnly(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when the user role is "manager"', () => {
    const { req, res, next } = buildMocks({ user: makeActiveUser({ role: 'manager' }) });

    adminOnly(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when the user role is "admin"', () => {
    const { req, res, next } = buildMocks({ user: makeActiveUser({ role: 'admin' }) });

    adminOnly(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});

// ─── managerOrAdmin ───────────────────────────────────────────────────────────

describe('managerOrAdmin middleware', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 403 when req.user is missing', () => {
    const { req, res, next } = buildMocks({ user: null });

    managerOrAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: expect.stringContaining('Manager or admin') })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when the user role is "member"', () => {
    const { req, res, next } = buildMocks({ user: makeActiveUser({ role: 'member' }) });

    managerOrAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when the user role is "manager"', () => {
    const { req, res, next } = buildMocks({ user: makeActiveUser({ role: 'manager' }) });

    managerOrAdmin(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('calls next() when the user role is "admin"', () => {
    const { req, res, next } = buildMocks({ user: makeActiveUser({ role: 'admin' }) });

    managerOrAdmin(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('calls next() when the user role is "assistant_manager"', () => {
    const { req, res, next } = buildMocks({ user: makeActiveUser({ role: 'assistant_manager' }) });

    managerOrAdmin(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});

// ─── assistantManagerOnly ─────────────────────────────────────────────────────

describe('assistantManagerOnly middleware', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 403 when req.user is missing', () => {
    const { req, res, next } = buildMocks({ user: null });

    assistantManagerOnly(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when user role is "admin" but is not super admin', () => {
    const { req, res, next } = buildMocks({ user: makeActiveUser({ role: 'admin', isSuperAdmin: false }) });

    assistantManagerOnly(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when user role is "member"', () => {
    const { req, res, next } = buildMocks({ user: makeActiveUser({ role: 'member' }) });

    assistantManagerOnly(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when the user role is "assistant_manager"', () => {
    const { req, res, next } = buildMocks({ user: makeActiveUser({ role: 'assistant_manager' }) });

    assistantManagerOnly(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('calls next() when the user is a super admin', () => {
    const { req, res, next } = buildMocks({ user: makeActiveUser({ role: 'member', isSuperAdmin: true }) });

    assistantManagerOnly(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});

// ─── requireRole — privilege-escalation regression guard ─────────────────────
//
// On 2026-05-04 we shipped a fix for a privilege-escalation in `requireRole`'s
// Layer-3 (base-role matrix) fallback. Members had `workspaces.view = true`
// in the matrix, and `requireRole('manager','admin')` on `GET
// /api/workspaces/archived` would erroneously pass them through — leaking
// archived workspace names to non-managers. The fix narrows Layer-3 to
// elevated actions (create/edit/delete/manage) only; `view` no longer
// bypasses an explicit role guard. These tests fail closed on regression.
describe('requireRole middleware — privilege escalation guard', () => {
  beforeEach(() => jest.clearAllMocks());

  function buildReq(role, method = 'GET', url = '/api/workspaces/archived') {
    return buildMocks({
      user: makeActiveUser({ role, isSuperAdmin: false, id: `${role}-uuid` }),
      method,
      originalUrl: url,
    });
  }

  it('passes through admins on a manager/admin-only GET', async () => {
    const { req, res, next } = buildReq('admin');
    await requireRole('manager', 'admin')(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('passes through managers on a manager/admin-only GET', async () => {
    const { req, res, next } = buildReq('manager');
    await requireRole('manager', 'admin')(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 403 for member on GET /api/workspaces/archived (regression)', async () => {
    const { req, res, next } = buildReq('member');
    await requireRole('manager', 'admin')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 403 for assistant_manager on GET /api/workspaces/archived (regression)', async () => {
    const { req, res, next } = buildReq('assistant_manager');
    await requireRole('manager', 'admin')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 403 for member on POST /api/workspaces (mutation, no matrix grant)', async () => {
    const { req, res, next } = buildReq('member', 'POST', '/api/workspaces');
    await requireRole('manager', 'admin')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('still passes super admin even on a non-listed role', async () => {
    const { req, res, next } = buildReq('member');
    req.user.isSuperAdmin = true;
    await requireRole('manager', 'admin')(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});
