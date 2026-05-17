'use strict';

/**
 * Tests for server/middleware/errorHandler.js — Phase 2.2 of the QA
 * remediation plan (docs/qa-audit-2026-05-17.md → §22 P0 item #2).
 * Previously 0% coverage.
 *
 * Per skill §8 — middleware tests use mock req/res/next and assert:
 *   - the classified status code
 *   - the body shape (back-compat top-level + new structured `error`)
 *   - the response headers (Retry-After)
 *   - that headersSent short-circuits via next()
 *   - that the logger is called with the right level (5xx=error, 4xx=warn)
 *   - that NO raw SQL/internal text leaks to the body
 *
 * The Sequelize / Multer / JWT error shapes are simulated; we never
 * instantiate the real third-party classes.
 */

jest.mock('../../utils/safeLogger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const safeLogger = require('../../utils/safeLogger');
const errorHandler = require('../../middleware/errorHandler');
const { classifyError, DEFAULT_USER_MESSAGES } = require('../../middleware/errorHandler');
const {
  ERROR_CODES,
  AppError,
  ValidationError,
  AuthError,
  PermissionError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  UpstreamError,
} = require('../../utils/errors');

// Tiny req/res factories — keep them minimal so test setup doesn't drift
// from production behavior.
function mockReq(overrides = {}) {
  return {
    id: 'req-abc',
    method: 'POST',
    originalUrl: '/api/whatever',
    user: { id: 'user-1' },
    ...overrides,
  };
}

function mockRes() {
  const headers = {};
  const res = {
    headersSent: false,
    status: jest.fn(function (code) { res.statusCode = code; return this; }),
    json: jest.fn(function (body) { res.body = body; return this; }),
    setHeader: jest.fn((k, v) => { headers[k] = v; }),
    _headers: headers,
  };
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── classifyError ─────────────────────────────────────────────

describe('classifyError — AppError + subclasses', () => {
  it('trusts AppError safeMessage + code + statusCode', () => {
    const err = new AppError('You sure?', { statusCode: 418, code: 'TEAPOT' });
    const out = classifyError(err);
    expect(out).toEqual({
      statusCode: 418,
      code: 'TEAPOT',
      message: 'You sure?',
      details: undefined,
      retryAfter: undefined,
    });
  });

  it('falls back to the DEFAULT_USER_MESSAGES when safeMessage missing', () => {
    // Construct an AppError-shaped object without a safeMessage so the
    // fallback path runs (real subclasses always set safeMessage, but
    // a custom subclass could omit it).
    const err = new AppError('intentionally ignored', { code: ERROR_CODES.NOT_FOUND });
    err.safeMessage = undefined;
    err.statusCode = 404;
    const out = classifyError(err);
    expect(out.message).toBe(DEFAULT_USER_MESSAGES[ERROR_CODES.NOT_FOUND]);
  });

  it('ValidationError carries 400 + details into the classified output', () => {
    const details = [{ path: 'email', msg: 'required' }];
    const err = new ValidationError('Bad form.', details);
    const out = classifyError(err);
    expect(out).toMatchObject({ statusCode: 400, code: ERROR_CODES.VALIDATION_FAILED, details });
  });

  it('RateLimitError carries retryAfter through to the classified output', () => {
    const err = new RateLimitError('Slow down.', { retryAfter: 30 });
    const out = classifyError(err);
    expect(out.statusCode).toBe(429);
    expect(out.retryAfter).toBe(30);
  });

  it('PermissionError keeps its custom code (TIER_INSUFFICIENT)', () => {
    const err = new PermissionError('Need tier 2.', { code: ERROR_CODES.TIER_INSUFFICIENT });
    const out = classifyError(err);
    expect(out.statusCode).toBe(403);
    expect(out.code).toBe(ERROR_CODES.TIER_INSUFFICIENT);
  });
});

describe('classifyError — body parser errors', () => {
  it('entity.parse.failed → 400 BAD_REQUEST with curated message', () => {
    const err = Object.assign(new Error('Unexpected token'), { type: 'entity.parse.failed' });
    const out = classifyError(err);
    expect(out).toMatchObject({ statusCode: 400, code: ERROR_CODES.BAD_REQUEST });
    expect(out.message).toBe('The request body could not be read.');
    // Must NOT contain the original error text
    expect(out.message).not.toContain('Unexpected token');
  });

  it('entity.too.large → 413 PAYLOAD_TOO_LARGE', () => {
    const err = Object.assign(new Error('body size limit'), { type: 'entity.too.large' });
    const out = classifyError(err);
    expect(out.statusCode).toBe(413);
    expect(out.code).toBe(ERROR_CODES.PAYLOAD_TOO_LARGE);
  });
});

describe('classifyError — JWT errors', () => {
  it('TokenExpiredError → 401 AUTH_SESSION_EXPIRED', () => {
    const err = Object.assign(new Error('jwt expired'), { name: 'TokenExpiredError' });
    const out = classifyError(err);
    expect(out.statusCode).toBe(401);
    expect(out.code).toBe(ERROR_CODES.AUTH_SESSION_EXPIRED);
  });

  it('JsonWebTokenError → 401 AUTH_TOKEN_INVALID', () => {
    const err = Object.assign(new Error('jwt malformed'), { name: 'JsonWebTokenError' });
    const out = classifyError(err);
    expect(out.statusCode).toBe(401);
    expect(out.code).toBe(ERROR_CODES.AUTH_TOKEN_INVALID);
  });

  it('NotBeforeError → 401 AUTH_TOKEN_INVALID', () => {
    const err = Object.assign(new Error('jwt not active'), { name: 'NotBeforeError' });
    const out = classifyError(err);
    expect(out.statusCode).toBe(401);
    expect(out.code).toBe(ERROR_CODES.AUTH_TOKEN_INVALID);
  });
});

describe('classifyError — Multer errors', () => {
  it('LIMIT_FILE_SIZE → 413 PAYLOAD_TOO_LARGE', () => {
    const err = Object.assign(new Error('File too large'), {
      name: 'MulterError',
      code: 'LIMIT_FILE_SIZE',
    });
    const out = classifyError(err);
    expect(out.statusCode).toBe(413);
    expect(out.code).toBe(ERROR_CODES.PAYLOAD_TOO_LARGE);
    expect(out.message).toBe('The file you uploaded is too large.');
  });

  it('any other Multer error → 400 VALIDATION_FAILED with NO original message', () => {
    const err = Object.assign(new Error('Unexpected field "secret"'), {
      name: 'MulterError',
      code: 'LIMIT_UNEXPECTED_FILE',
    });
    const out = classifyError(err);
    expect(out.statusCode).toBe(400);
    expect(out.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    expect(out.message).not.toContain('secret'); // reveals upload field name
    expect(out.message).toBe('There was a problem with your file upload. Please try again.');
  });
});

describe('classifyError — Sequelize errors', () => {
  it('SequelizeUniqueConstraintError → 409 DUPLICATE, no column names leaked', () => {
    const err = Object.assign(new Error('users_email_key violated'), {
      name: 'SequelizeUniqueConstraintError',
    });
    const out = classifyError(err);
    expect(out.statusCode).toBe(409);
    expect(out.code).toBe(ERROR_CODES.DUPLICATE);
    expect(out.message).not.toContain('users_email_key');
  });

  it('SequelizeValidationError → 400 VALIDATION_FAILED', () => {
    const err = Object.assign(new Error('validation issue'), { name: 'SequelizeValidationError' });
    const out = classifyError(err);
    expect(out.statusCode).toBe(400);
    expect(out.code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });

  it('SequelizeForeignKeyConstraintError → 409 CONFLICT', () => {
    const err = Object.assign(new Error('FK violated'), { name: 'SequelizeForeignKeyConstraintError' });
    const out = classifyError(err);
    expect(out.statusCode).toBe(409);
    expect(out.code).toBe(ERROR_CODES.CONFLICT);
  });

  it.each([
    'SequelizeConnectionError',
    'SequelizeConnectionRefusedError',
    'SequelizeHostNotFoundError',
    'SequelizeHostNotReachableError',
    'SequelizeAccessDeniedError',
  ])('%s → 503 SERVICE_UNAVAILABLE', (name) => {
    const err = Object.assign(new Error('conn down'), { name });
    const out = classifyError(err);
    expect(out.statusCode).toBe(503);
    expect(out.code).toBe(ERROR_CODES.SERVICE_UNAVAILABLE);
  });

  it('any other Sequelize* → 500 DB_ERROR', () => {
    const err = Object.assign(new Error('weird db thing'), { name: 'SequelizeDatabaseError' });
    const out = classifyError(err);
    expect(out.statusCode).toBe(500);
    expect(out.code).toBe(ERROR_CODES.DB_ERROR);
  });
});

describe('classifyError — legacy statusCode-only errors', () => {
  it.each([
    [400, ERROR_CODES.BAD_REQUEST],
    [404, ERROR_CODES.NOT_FOUND],
    [413, ERROR_CODES.PAYLOAD_TOO_LARGE],
    [429, ERROR_CODES.RATE_LIMITED],
    [500, ERROR_CODES.INTERNAL_ERROR],
    [502, ERROR_CODES.INTERNAL_ERROR],
    [503, ERROR_CODES.INTERNAL_ERROR],
  ])('statusCode=%i is mapped to %s', (status, expectedCode) => {
    const err = Object.assign(new Error('legacy'), { statusCode: status });
    const out = classifyError(err);
    expect(out.statusCode).toBe(status);
    expect(out.code).toBe(expectedCode);
  });

  it('401 with explicit code is preserved (AUTH_SESSION_EXPIRED)', () => {
    const err = Object.assign(new Error('expired'), { statusCode: 401, code: ERROR_CODES.AUTH_SESSION_EXPIRED });
    const out = classifyError(err);
    expect(out.statusCode).toBe(401);
    expect(out.code).toBe(ERROR_CODES.AUTH_SESSION_EXPIRED);
  });

  it('401 with no code defaults to AUTH_REQUIRED', () => {
    const err = Object.assign(new Error('unauth'), { statusCode: 401 });
    const out = classifyError(err);
    expect(out.code).toBe(ERROR_CODES.AUTH_REQUIRED);
  });

  it('403 with explicit code is preserved (TIER_INSUFFICIENT)', () => {
    const err = Object.assign(new Error('forbidden'), { statusCode: 403, code: ERROR_CODES.TIER_INSUFFICIENT });
    const out = classifyError(err);
    expect(out.code).toBe(ERROR_CODES.TIER_INSUFFICIENT);
  });

  it('403 with no code defaults to FORBIDDEN', () => {
    const err = Object.assign(new Error('forbidden'), { statusCode: 403 });
    const out = classifyError(err);
    expect(out.code).toBe(ERROR_CODES.FORBIDDEN);
  });

  it('409 with explicit code is preserved (DUPLICATE)', () => {
    const err = Object.assign(new Error('dup'), { statusCode: 409, code: ERROR_CODES.DUPLICATE });
    const out = classifyError(err);
    expect(out.code).toBe(ERROR_CODES.DUPLICATE);
  });
});

describe('classifyError — CORS denied', () => {
  it("messages starting with 'CORS:' map to 403 FORBIDDEN", () => {
    const err = new Error('CORS: origin https://evil.example not allowed');
    const out = classifyError(err);
    expect(out.statusCode).toBe(403);
    expect(out.code).toBe(ERROR_CODES.FORBIDDEN);
    expect(out.message).toBe('Request origin not allowed.');
  });
});

describe('classifyError — default fallback', () => {
  it('an unknown error → 500 INTERNAL_ERROR with the curated message', () => {
    const err = new Error('mystery');
    const out = classifyError(err);
    expect(out.statusCode).toBe(500);
    expect(out.code).toBe(ERROR_CODES.INTERNAL_ERROR);
    expect(out.message).toBe(DEFAULT_USER_MESSAGES[ERROR_CODES.INTERNAL_ERROR]);
    expect(out.message).not.toContain('mystery');
  });

  it('handles null / non-Error inputs without throwing', () => {
    expect(classifyError(null).statusCode).toBe(500);
    expect(classifyError(undefined).statusCode).toBe(500);
    expect(classifyError('string').statusCode).toBe(500);
  });
});

// ─── errorHandler (the actual middleware) ──────────────────────

describe('errorHandler — happy paths', () => {
  it('responds with the classified status code + body for an AuthError', () => {
    const err = new AuthError('Sign in.', { code: ERROR_CODES.AUTH_REQUIRED });
    const req = mockReq(); const res = mockRes(); const next = jest.fn();

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toMatchObject({
      success: false,
      message: 'Sign in.',
      code: ERROR_CODES.AUTH_REQUIRED,
      error: {
        code: ERROR_CODES.AUTH_REQUIRED,
        message: 'Sign in.',
        requestId: 'req-abc',
      },
    });
  });

  it('includes details on validation errors (both top-level + structured)', () => {
    const details = [{ path: 'email', msg: 'required' }];
    const err = new ValidationError('Bad form.', details);
    const req = mockReq(); const res = mockRes();

    errorHandler(err, req, res, jest.fn());

    expect(res.body.errors).toEqual(details);
    expect(res.body.error.details).toEqual(details);
  });

  it('wraps a non-array detail in an errors array for back-compat', () => {
    const err = new AppError('oh', { statusCode: 400, code: ERROR_CODES.VALIDATION_FAILED, details: { foo: 'bar' } });
    const req = mockReq(); const res = mockRes();
    errorHandler(err, req, res, jest.fn());
    expect(res.body.errors).toEqual([{ foo: 'bar' }]);
  });

  it('sets Retry-After header + body field for RateLimitError', () => {
    const err = new RateLimitError('Slow down.', { retryAfter: 42 });
    const req = mockReq(); const res = mockRes();

    errorHandler(err, req, res, jest.fn());

    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '42');
    expect(res._headers['Retry-After']).toBe('42');
    expect(res.body.retryAfter).toBe(42);
    expect(res.body.error.retryAfter).toBe(42);
  });

  it('falls through to next() when headers already sent', () => {
    const err = new AppError('boom');
    const req = mockReq();
    const res = mockRes(); res.headersSent = true;
    const next = jest.fn();

    errorHandler(err, req, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('uses requestId="unknown" when req has no id', () => {
    const err = new NotFoundError();
    const req = { method: 'GET', originalUrl: '/x' }; // no id
    const res = mockRes();
    errorHandler(err, req, res, jest.fn());
    expect(res.body.error.requestId).toBe('unknown');
  });
});

describe('errorHandler — logging', () => {
  it('logs at error level for 5xx responses', () => {
    const err = new UpstreamError(); // 502
    const req = mockReq(); const res = mockRes();

    errorHandler(err, req, res, jest.fn());

    expect(safeLogger.error).toHaveBeenCalledTimes(1);
    expect(safeLogger.warn).not.toHaveBeenCalled();
    const [msg, meta] = safeLogger.error.mock.calls[0];
    expect(msg).toContain('API error 502');
    expect(meta).toMatchObject({
      requestId: 'req-abc',
      method: 'POST',
      path: '/api/whatever',
      statusCode: 502,
      code: ERROR_CODES.UPSTREAM_ERROR,
      userId: 'user-1',
    });
    expect(meta.err).toBe(err); // safeLogger receives the raw error for redaction
  });

  it('logs at warn level for 4xx responses', () => {
    const err = new NotFoundError();
    const req = mockReq(); const res = mockRes();

    errorHandler(err, req, res, jest.fn());

    expect(safeLogger.warn).toHaveBeenCalledTimes(1);
    expect(safeLogger.error).not.toHaveBeenCalled();
    const [msg] = safeLogger.warn.mock.calls[0];
    expect(msg).toContain('API error 404');
  });

  it('omits userId from log meta when req.user missing (e.g. pre-auth failure)', () => {
    const err = new AuthError();
    const req = mockReq({ user: undefined });
    const res = mockRes();
    errorHandler(err, req, res, jest.fn());
    const [, meta] = safeLogger.warn.mock.calls[0];
    expect(meta).not.toHaveProperty('userId');
  });
});

describe('errorHandler — security: no internal info leakage to body', () => {
  it('a raw Error with internal text reaches the client only as "Internal server error"-style copy', () => {
    const err = new Error('connection to db at 10.0.0.5:5432 refused');
    const req = mockReq(); const res = mockRes();
    errorHandler(err, req, res, jest.fn());
    expect(res.body.message).not.toContain('10.0.0.5');
    expect(res.body.message).not.toContain('5432');
    expect(res.body.message).toBe(DEFAULT_USER_MESSAGES[ERROR_CODES.INTERNAL_ERROR]);
  });

  it('a Sequelize unique-constraint error does not leak the constraint name', () => {
    const err = Object.assign(new Error('SequelizeUniqueConstraintError: users_email_key already exists'), {
      name: 'SequelizeUniqueConstraintError',
    });
    const req = mockReq(); const res = mockRes();
    errorHandler(err, req, res, jest.fn());
    expect(res.body.message).not.toContain('users_email_key');
    expect(res.status).toHaveBeenCalledWith(409);
  });
});

describe('errorHandler — ConflictError variant', () => {
  it('reflects the safeMessage from a ConflictError', () => {
    const err = new ConflictError('A label by that name already exists.');
    const req = mockReq(); const res = mockRes();
    errorHandler(err, req, res, jest.fn());
    expect(res.body.message).toBe('A label by that name already exists.');
    expect(res.body.code).toBe(ERROR_CODES.CONFLICT);
  });
});
