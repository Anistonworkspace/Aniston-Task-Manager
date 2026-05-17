'use strict';

/**
 * Tests for server/middleware/apiKeyAuth.js — Phase 2.3 of the QA
 * remediation plan (docs/qa-audit-2026-05-17.md → §22 P0 item #3).
 * Previously 0% coverage.
 *
 * Per skill §8 — middleware tests use mock req/res/next. We cover:
 *   - X-API-Key path (DB-managed key → active / disabled / expired)
 *   - X-API-Key path (legacy HRMS_API_KEY env-var fallback)
 *   - JWT Bearer path (valid / expired / malformed / deactivated user)
 *   - No-auth-supplied 401
 *
 * Notes:
 *   - We mock models (User, ApiKey) and jsonwebtoken to make this a pure
 *     unit test — no DB hit. CLAUDE.md's project convention is to mock
 *     models at the boundary so this matches existing patterns.
 *   - The lastUsedAt update is fire-and-forget; the test allows the
 *     `.save().catch(() => {})` Promise to dangle (intentional in prod).
 */

jest.mock('../../models', () => ({
  User: { findByPk: jest.fn() },
  ApiKey: { findOne: jest.fn() },
}));

jest.mock('jsonwebtoken', () => ({
  verify: jest.fn(),
}));

const { User, ApiKey } = require('../../models');
const jwt = require('jsonwebtoken');
const { apiKeyOrJwt } = require('../../middleware/apiKeyAuth');

function mockRes() {
  const res = {
    status: jest.fn(function (c) { res.statusCode = c; return this; }),
    json: jest.fn(function (b) { res.body = b; return this; }),
  };
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.JWT_SECRET = 'test-secret';
  delete process.env.HRMS_API_KEY;
});

// ─── X-API-Key path — database-managed keys ────────────────────

describe('apiKeyOrJwt — DB-managed API key', () => {
  it('passes with valid, active key + sets req.authMethod="apiKey" + apiKeyId', async () => {
    const apiKeyRow = {
      id: 'key-1',
      isActive: true,
      expiresAt: null,
      save: jest.fn().mockResolvedValue(undefined),
    };
    ApiKey.findOne.mockResolvedValue(apiKeyRow);

    const req = { headers: { 'x-api-key': 'plaintext-key' } };
    const res = mockRes();
    const next = jest.fn();

    await apiKeyOrJwt(req, res, next);

    expect(ApiKey.findOne).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.authMethod).toBe('apiKey');
    expect(req.apiKeyId).toBe('key-1');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('updates lastUsedAt on the matched row (fire-and-forget)', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    ApiKey.findOne.mockResolvedValue({ id: 'k', isActive: true, expiresAt: null, save });

    const req = { headers: { 'x-api-key': 'k' } };
    await apiKeyOrJwt(req, mockRes(), jest.fn());

    expect(save).toHaveBeenCalledTimes(1);
  });

  it('returns 401 "API key has been disabled" when row.isActive=false', async () => {
    ApiKey.findOne.mockResolvedValue({ id: 'k', isActive: false, save: jest.fn() });

    const req = { headers: { 'x-api-key': 'k' } };
    const res = mockRes(); const next = jest.fn();
    await apiKeyOrJwt(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toEqual({ success: false, message: 'API key has been disabled.' });
  });

  it('returns 401 "API key has expired" when expiresAt is in the past', async () => {
    ApiKey.findOne.mockResolvedValue({
      id: 'k',
      isActive: true,
      expiresAt: new Date(Date.now() - 60_000), // 1 min ago
      save: jest.fn(),
    });

    const req = { headers: { 'x-api-key': 'k' } };
    const res = mockRes(); const next = jest.fn();
    await apiKeyOrJwt(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toEqual({ success: false, message: 'API key has expired.' });
  });

  it('passes a key whose expiresAt is in the future', async () => {
    ApiKey.findOne.mockResolvedValue({
      id: 'k',
      isActive: true,
      expiresAt: new Date(Date.now() + 86_400_000), // +1 day
      save: jest.fn().mockResolvedValue(undefined),
    });

    const req = { headers: { 'x-api-key': 'k' } };
    const res = mockRes(); const next = jest.fn();
    await apiKeyOrJwt(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

// ─── X-API-Key path — legacy HRMS_API_KEY env-var fallback ─────

describe('apiKeyOrJwt — legacy HRMS_API_KEY env fallback', () => {
  it('passes when supplied key matches the env var (timing-safe equal)', async () => {
    ApiKey.findOne.mockResolvedValue(null);
    process.env.HRMS_API_KEY = 'legacy-secret-123';

    const req = { headers: { 'x-api-key': 'legacy-secret-123' } };
    const res = mockRes(); const next = jest.fn();
    await apiKeyOrJwt(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.authMethod).toBe('apiKey');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects when the supplied key differs from the env var (same length)', async () => {
    ApiKey.findOne.mockResolvedValue(null);
    process.env.HRMS_API_KEY = 'legacy-secret-123';

    const req = { headers: { 'x-api-key': 'legacy-secret-XXX' } }; // same length, different content
    const res = mockRes(); const next = jest.fn();
    await apiKeyOrJwt(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toEqual({ success: false, message: 'Invalid API key.' });
  });

  it('rejects when the supplied key has a different length from the env var', async () => {
    // timingSafeEqual throws on length mismatch — the explicit length-check
    // in the middleware short-circuits before that and avoids the throw.
    ApiKey.findOne.mockResolvedValue(null);
    process.env.HRMS_API_KEY = 'short';

    const req = { headers: { 'x-api-key': 'much-longer-key' } };
    const res = mockRes(); const next = jest.fn();
    await apiKeyOrJwt(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects when env var is not set + no DB row found', async () => {
    ApiKey.findOne.mockResolvedValue(null);
    // process.env.HRMS_API_KEY intentionally unset

    const req = { headers: { 'x-api-key': 'whatever' } };
    const res = mockRes(); const next = jest.fn();
    await apiKeyOrJwt(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toEqual({ success: false, message: 'Invalid API key.' });
  });

  it('falls back to legacy when DB lookup throws (does not 5xx)', async () => {
    ApiKey.findOne.mockRejectedValue(new Error('db down'));
    process.env.HRMS_API_KEY = 'fallback-key';

    const req = { headers: { 'x-api-key': 'fallback-key' } };
    const res = mockRes(); const next = jest.fn();

    // Swallow the console.error noise from the catch block
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await apiKeyOrJwt(req, res, next);
    errorSpy.mockRestore();

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.authMethod).toBe('apiKey');
  });
});

// ─── JWT Bearer path ────────────────────────────────────────────

describe('apiKeyOrJwt — JWT Bearer token', () => {
  it('passes with a valid Bearer token, sets req.user + authMethod="jwt"', async () => {
    jwt.verify.mockReturnValue({ id: 'u-1' });
    User.findByPk.mockResolvedValue({ id: 'u-1', isActive: true, role: 'admin' });

    const req = { headers: { authorization: 'Bearer good.token.here' } };
    const res = mockRes(); const next = jest.fn();
    await apiKeyOrJwt(req, res, next);

    expect(jwt.verify).toHaveBeenCalledWith('good.token.here', 'test-secret');
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toMatchObject({ id: 'u-1' });
    expect(req.authMethod).toBe('jwt');
  });

  it('returns 401 "Malformed authorization header" when "Bearer " has no token after', async () => {
    const req = { headers: { authorization: 'Bearer ' } };
    const res = mockRes(); const next = jest.fn();
    await apiKeyOrJwt(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toEqual({ success: false, message: 'Malformed authorization header.' });
  });

  it('returns 401 when token decodes to a user that no longer exists', async () => {
    jwt.verify.mockReturnValue({ id: 'ghost' });
    User.findByPk.mockResolvedValue(null);

    const req = { headers: { authorization: 'Bearer ghost-token' } };
    const res = mockRes(); const next = jest.fn();
    await apiKeyOrJwt(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toEqual({ success: false, message: 'Token is valid but user no longer exists.' });
  });

  it('returns 403 when user is found but isActive=false', async () => {
    jwt.verify.mockReturnValue({ id: 'u-2' });
    User.findByPk.mockResolvedValue({ id: 'u-2', isActive: false });

    const req = { headers: { authorization: 'Bearer deactivated' } };
    const res = mockRes(); const next = jest.fn();
    await apiKeyOrJwt(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toEqual({ success: false, message: 'Account has been deactivated.' });
  });

  it('returns 401 "Token has expired" for TokenExpiredError', async () => {
    jwt.verify.mockImplementation(() => { const e = new Error('exp'); e.name = 'TokenExpiredError'; throw e; });

    const req = { headers: { authorization: 'Bearer expired' } };
    const res = mockRes(); const next = jest.fn();
    await apiKeyOrJwt(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toEqual({ success: false, message: 'Token has expired.' });
  });

  it('returns 401 "Invalid token" for JsonWebTokenError', async () => {
    jwt.verify.mockImplementation(() => { const e = new Error('bad'); e.name = 'JsonWebTokenError'; throw e; });

    const req = { headers: { authorization: 'Bearer malformed' } };
    const res = mockRes(); const next = jest.fn();
    await apiKeyOrJwt(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toEqual({ success: false, message: 'Invalid token.' });
  });

  it('returns 500 for unknown JWT errors', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('unexpected'); });

    const req = { headers: { authorization: 'Bearer x' } };
    const res = mockRes(); const next = jest.fn();
    await apiKeyOrJwt(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.body).toEqual({ success: false, message: 'Authentication error.' });
  });
});

// ─── No auth supplied ──────────────────────────────────────────

describe('apiKeyOrJwt — no auth provided', () => {
  it('returns 401 with the helpful message naming both options', async () => {
    const req = { headers: {} };
    const res = mockRes(); const next = jest.fn();
    await apiKeyOrJwt(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body.message).toMatch(/X-API-Key/);
    expect(res.body.message).toMatch(/Bearer/);
  });

  it('returns 401 when Authorization is present but not a Bearer scheme', async () => {
    const req = { headers: { authorization: 'Basic dXNlcjpwYXNz' } };
    const res = mockRes(); const next = jest.fn();
    await apiKeyOrJwt(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
