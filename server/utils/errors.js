// Centralized error classes for the Aniston backend.
//
// Use these in controllers/services in place of `throw new Error('...')` so
// the global handler can map them to a stable HTTP status + machine-readable
// error code + safe user-facing message. Anything thrown that isn't an
// AppError falls through to the generic 500 path and is logged in full
// server-side but only "Internal server error." reaches the client.
//
// Error codes are stable identifiers the frontend can map to localized
// strings. They MUST NOT change without coordinating with `client/src/utils/errorMap.js`.

const ERROR_CODES = Object.freeze({
  // 400
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  BAD_REQUEST: 'BAD_REQUEST',
  // 401
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_SESSION_EXPIRED: 'AUTH_SESSION_EXPIRED',
  AUTH_TOKEN_INVALID: 'AUTH_TOKEN_INVALID',
  AUTH_TOKEN_REUSE: 'AUTH_TOKEN_REUSE',
  AUTH_SESSION_CONFLICT: 'AUTH_SESSION_CONFLICT',
  // 403
  FORBIDDEN: 'FORBIDDEN',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  TIER_INSUFFICIENT: 'TIER_INSUFFICIENT',
  // 404
  NOT_FOUND: 'NOT_FOUND',
  // 409
  CONFLICT: 'CONFLICT',
  DUPLICATE: 'DUPLICATE',
  // 413
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  // 415
  UNSUPPORTED_MEDIA: 'UNSUPPORTED_MEDIA',
  // 429
  RATE_LIMITED: 'RATE_LIMITED',
  // 500
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  DB_ERROR: 'DB_ERROR',
  // 502
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  // 503
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
});

class AppError extends Error {
  // Throwing an AppError signals "this is intended to reach the client".
  // The global handler reads statusCode + code + safeMessage and produces
  // a structured response. Other fields (cause, details) are server-only
  // logging context unless explicitly marked safe.
  constructor(message, { statusCode = 500, code = ERROR_CODES.INTERNAL_ERROR, details, cause } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.safeMessage = message;
    if (details !== undefined) this.details = details;
    if (cause !== undefined) this.cause = cause;
    this.isOperational = true;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message = 'Validation failed.', details, opts = {}) {
    super(message, { statusCode: 400, code: ERROR_CODES.VALIDATION_FAILED, details, ...opts });
  }
}

class BadRequestError extends AppError {
  constructor(message = 'Bad request.', opts = {}) {
    super(message, { statusCode: 400, code: ERROR_CODES.BAD_REQUEST, ...opts });
  }
}

class AuthError extends AppError {
  // Default to the most generic auth failure. Specific code = better frontend
  // UX (login form vs session-expired banner), so pass the right code from
  // the call site rather than relying on the default.
  constructor(message = 'Authentication required.', { code = ERROR_CODES.AUTH_REQUIRED, ...rest } = {}) {
    super(message, { statusCode: 401, code, ...rest });
  }
}

class PermissionError extends AppError {
  constructor(message = 'You do not have permission to perform this action.', { code = ERROR_CODES.PERMISSION_DENIED, ...rest } = {}) {
    super(message, { statusCode: 403, code, ...rest });
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Resource not found.', opts = {}) {
    super(message, { statusCode: 404, code: ERROR_CODES.NOT_FOUND, ...opts });
  }
}

class ConflictError extends AppError {
  constructor(message = 'This action conflicts with the current state.', { code = ERROR_CODES.CONFLICT, ...rest } = {}) {
    super(message, { statusCode: 409, code, ...rest });
  }
}

class PayloadTooLargeError extends AppError {
  constructor(message = 'Payload too large.', opts = {}) {
    super(message, { statusCode: 413, code: ERROR_CODES.PAYLOAD_TOO_LARGE, ...opts });
  }
}

class RateLimitError extends AppError {
  constructor(message = 'Too many requests. Please try again later.', { retryAfter, ...rest } = {}) {
    super(message, { statusCode: 429, code: ERROR_CODES.RATE_LIMITED, ...rest });
    if (retryAfter != null) this.retryAfter = retryAfter;
  }
}

class ServiceUnavailableError extends AppError {
  constructor(message = 'This service is temporarily unavailable.', opts = {}) {
    super(message, { statusCode: 503, code: ERROR_CODES.SERVICE_UNAVAILABLE, ...opts });
  }
}

class UpstreamError extends AppError {
  // For failures from outbound calls (Microsoft Graph, Deepgram, AI providers).
  // Never put the upstream error.message into `message` here — that's where
  // API-key fragments and provider stack traces typically leak.
  constructor(message = 'An upstream service failed. Please try again.', opts = {}) {
    super(message, { statusCode: 502, code: ERROR_CODES.UPSTREAM_ERROR, ...opts });
  }
}

// asyncHandler — drop-in wrapper for Express handlers that lets you write
// pure async functions without try/catch boilerplate. Any thrown error
// (AppError or otherwise) is forwarded to next() and lands in the global
// handler. Existing controllers don't have to migrate; this is opt-in.
//
//   router.get('/foo', asyncHandler(async (req, res) => { ... }));
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = {
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
};
