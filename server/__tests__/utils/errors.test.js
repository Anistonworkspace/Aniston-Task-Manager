'use strict';

/**
 * Tests for server/utils/errors.js — Phase 2.1 of the QA remediation plan
 * (docs/qa-audit-2026-05-17.md → §22 P0 item #1). Previously 0% coverage.
 *
 * Pure-logic file: no DB, no I/O, no async. Per skill §5.1 we cover
 *   - constructor defaults
 *   - constructor with each option permutation
 *   - prototype chain (`instanceof AppError` MUST hold for every subclass
 *     because the global handler in middleware/errorHandler.js decides
 *     trust based on that check)
 *   - the asyncHandler resolves/rejects/sync-throw paths
 */

const {
  ERROR_CODES,
  AppError,
  ValidationError,
  BadRequestError,
  AuthError,
  PermissionError,
  NotFoundError,
  ConflictError,
  PayloadTooLargeError,
  RateLimitError,
  ServiceUnavailableError,
  UpstreamError,
  asyncHandler,
} = require('../../utils/errors');

describe('ERROR_CODES', () => {
  it('is frozen so call sites cannot mutate the contract', () => {
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
  });

  it('exposes every code the global handler + frontend errorMap rely on', () => {
    // If you change this list, also update client/src/utils/errorMap.js
    // and server/middleware/errorHandler.js DEFAULT_USER_MESSAGES.
    const required = [
      'VALIDATION_FAILED', 'BAD_REQUEST',
      'AUTH_REQUIRED', 'AUTH_INVALID_CREDENTIALS', 'AUTH_SESSION_EXPIRED',
      'AUTH_TOKEN_INVALID', 'AUTH_TOKEN_REUSE', 'AUTH_SESSION_CONFLICT',
      'FORBIDDEN', 'PERMISSION_DENIED', 'TIER_INSUFFICIENT',
      'NOT_FOUND', 'CONFLICT', 'DUPLICATE',
      'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_MEDIA',
      'RATE_LIMITED',
      'INTERNAL_ERROR', 'DB_ERROR',
      'UPSTREAM_ERROR', 'SERVICE_UNAVAILABLE',
    ];
    for (const k of required) {
      expect(ERROR_CODES[k]).toBe(k);
    }
  });
});

describe('AppError', () => {
  it('defaults statusCode 500 + INTERNAL_ERROR code when no opts passed', () => {
    const err = new AppError('boom');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toBe('boom');
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe(ERROR_CODES.INTERNAL_ERROR);
    expect(err.safeMessage).toBe('boom');
    expect(err.isOperational).toBe(true);
    expect(err.name).toBe('AppError');
  });

  it('captures statusCode + code from opts', () => {
    const err = new AppError('nope', { statusCode: 418, code: 'TEAPOT' });
    expect(err.statusCode).toBe(418);
    expect(err.code).toBe('TEAPOT');
  });

  it('records details only when provided (no undefined property leak)', () => {
    const withDetails = new AppError('bad', { details: [{ field: 'email' }] });
    expect(withDetails.details).toEqual([{ field: 'email' }]);

    const without = new AppError('bad');
    expect(Object.prototype.hasOwnProperty.call(without, 'details')).toBe(false);
  });

  it('records cause only when provided', () => {
    const root = new Error('root');
    const wrapped = new AppError('outer', { cause: root });
    expect(wrapped.cause).toBe(root);

    const standalone = new AppError('outer');
    expect(Object.prototype.hasOwnProperty.call(standalone, 'cause')).toBe(false);
  });

  it('captures a stack trace', () => {
    const err = new AppError('stacked');
    expect(typeof err.stack).toBe('string');
    expect(err.stack.length).toBeGreaterThan(0);
  });

  it('safeMessage mirrors message at construction time', () => {
    // safeMessage is what the global handler reflects to the client;
    // message + safeMessage being the same is the contract callers rely on
    // when they throw AppError with a user-facing string.
    const err = new AppError('User-facing copy');
    expect(err.safeMessage).toBe(err.message);
  });
});

describe('ValidationError', () => {
  it('defaults to 400 / VALIDATION_FAILED', () => {
    const e = new ValidationError();
    expect(e).toBeInstanceOf(AppError);
    expect(e.statusCode).toBe(400);
    expect(e.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    expect(e.message).toBe('Validation failed.');
  });

  it('accepts details so the handler can echo field-level errors', () => {
    const details = [{ path: 'email', msg: 'invalid' }];
    const e = new ValidationError('Bad form', details);
    expect(e.details).toBe(details);
    expect(e.statusCode).toBe(400);
  });
});

describe('BadRequestError', () => {
  it('defaults to 400 / BAD_REQUEST', () => {
    const e = new BadRequestError();
    expect(e.statusCode).toBe(400);
    expect(e.code).toBe(ERROR_CODES.BAD_REQUEST);
  });
});

describe('AuthError', () => {
  it('defaults to 401 / AUTH_REQUIRED', () => {
    const e = new AuthError();
    expect(e.statusCode).toBe(401);
    expect(e.code).toBe(ERROR_CODES.AUTH_REQUIRED);
  });

  it('accepts a specific auth code for better client UX', () => {
    const e = new AuthError('Your session ended.', { code: ERROR_CODES.AUTH_SESSION_EXPIRED });
    expect(e.code).toBe(ERROR_CODES.AUTH_SESSION_EXPIRED);
    expect(e.statusCode).toBe(401);
  });
});

describe('PermissionError', () => {
  it('defaults to 403 / PERMISSION_DENIED', () => {
    const e = new PermissionError();
    expect(e.statusCode).toBe(403);
    expect(e.code).toBe(ERROR_CODES.PERMISSION_DENIED);
  });

  it('accepts TIER_INSUFFICIENT as the more specific code', () => {
    const e = new PermissionError('Need tier 2.', { code: ERROR_CODES.TIER_INSUFFICIENT });
    expect(e.code).toBe(ERROR_CODES.TIER_INSUFFICIENT);
  });
});

describe('NotFoundError', () => {
  it('defaults to 404 / NOT_FOUND', () => {
    const e = new NotFoundError();
    expect(e.statusCode).toBe(404);
    expect(e.code).toBe(ERROR_CODES.NOT_FOUND);
  });
});

describe('ConflictError', () => {
  it('defaults to 409 / CONFLICT', () => {
    const e = new ConflictError();
    expect(e.statusCode).toBe(409);
    expect(e.code).toBe(ERROR_CODES.CONFLICT);
  });

  it('accepts DUPLICATE as a more specific code', () => {
    const e = new ConflictError('Already exists.', { code: ERROR_CODES.DUPLICATE });
    expect(e.code).toBe(ERROR_CODES.DUPLICATE);
  });
});

describe('PayloadTooLargeError', () => {
  it('defaults to 413 / PAYLOAD_TOO_LARGE', () => {
    const e = new PayloadTooLargeError();
    expect(e.statusCode).toBe(413);
    expect(e.code).toBe(ERROR_CODES.PAYLOAD_TOO_LARGE);
  });
});

describe('RateLimitError', () => {
  it('defaults to 429 / RATE_LIMITED with no retryAfter', () => {
    const e = new RateLimitError();
    expect(e.statusCode).toBe(429);
    expect(e.code).toBe(ERROR_CODES.RATE_LIMITED);
    expect(Object.prototype.hasOwnProperty.call(e, 'retryAfter')).toBe(false);
  });

  it('captures retryAfter when supplied (used by errorHandler for the header)', () => {
    const e = new RateLimitError('Slow down.', { retryAfter: 30 });
    expect(e.retryAfter).toBe(30);
  });

  it('ignores retryAfter=null (matches null-vs-undefined intent)', () => {
    const e = new RateLimitError('Slow down.', { retryAfter: null });
    expect(Object.prototype.hasOwnProperty.call(e, 'retryAfter')).toBe(false);
  });
});

describe('ServiceUnavailableError', () => {
  it('defaults to 503 / SERVICE_UNAVAILABLE', () => {
    const e = new ServiceUnavailableError();
    expect(e.statusCode).toBe(503);
    expect(e.code).toBe(ERROR_CODES.SERVICE_UNAVAILABLE);
  });
});

describe('UpstreamError', () => {
  it('defaults to 502 / UPSTREAM_ERROR (NOT 500 — externals failing != server bug)', () => {
    const e = new UpstreamError();
    expect(e.statusCode).toBe(502);
    expect(e.code).toBe(ERROR_CODES.UPSTREAM_ERROR);
  });
});

describe('every subclass is instanceof AppError (errorHandler relies on this)', () => {
  // The global handler checks `err instanceof AppError` to decide whether
  // to trust err.safeMessage. If a subclass loses prototype linkage this
  // entire trust chain silently fails.
  it.each([
    ['ValidationError', new ValidationError()],
    ['BadRequestError', new BadRequestError()],
    ['AuthError', new AuthError()],
    ['PermissionError', new PermissionError()],
    ['NotFoundError', new NotFoundError()],
    ['ConflictError', new ConflictError()],
    ['PayloadTooLargeError', new PayloadTooLargeError()],
    ['RateLimitError', new RateLimitError()],
    ['ServiceUnavailableError', new ServiceUnavailableError()],
    ['UpstreamError', new UpstreamError()],
  ])('%s instanceof AppError', (_name, instance) => {
    expect(instance).toBeInstanceOf(AppError);
    expect(instance).toBeInstanceOf(Error);
    expect(instance.isOperational).toBe(true);
  });
});

describe('asyncHandler', () => {
  it('calls the handler with (req, res, next)', async () => {
    const fn = jest.fn().mockResolvedValue(undefined);
    const wrapped = asyncHandler(fn);
    const req = {}; const res = {}; const next = jest.fn();
    await wrapped(req, res, next);
    expect(fn).toHaveBeenCalledWith(req, res, next);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards an async rejection to next()', async () => {
    const boom = new Error('async fail');
    const wrapped = asyncHandler(async () => { throw boom; });
    const next = jest.fn();
    await wrapped({}, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(boom);
  });

  it('does NOT catch a synchronous throw — by design (Express does)', () => {
    // `Promise.resolve(fn(...))` evaluates fn(...) BEFORE wrapping. If fn
    // throws synchronously, the throw escapes the wrapper and bubbles up
    // to Express's own middleware try/catch. This is the same behavior as
    // express-async-handler. If we ever want to catch sync throws too,
    // change the wrapper to `Promise.resolve().then(() => fn(...))`.
    const boom = new Error('sync fail');
    const wrapped = asyncHandler(() => { throw boom; });
    const next = jest.fn();
    expect(() => wrapped({}, {}, next)).toThrow(boom);
    expect(next).not.toHaveBeenCalled();
  });

  it('does not call next() when the handler resolves successfully', async () => {
    const wrapped = asyncHandler(async (req, res) => { res.ok = true; });
    const res = {};
    const next = jest.fn();
    await wrapped({}, res, next);
    expect(res.ok).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards a non-Error rejection (string / object) without unwrapping it', async () => {
    // Production code shouldn't `throw "string"` but if it ever does, we
    // want the original value to reach the handler (which logs it raw)
    // rather than getting swallowed.
    const wrapped = asyncHandler(async () => { throw 'oops'; }); // eslint-disable-line no-throw-literal
    const next = jest.fn();
    await wrapped({}, {}, next);
    expect(next).toHaveBeenCalledWith('oops');
  });
});
