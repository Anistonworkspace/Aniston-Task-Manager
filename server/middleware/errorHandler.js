// Global error-handling middleware.
//
// Responsibilities:
//   1. Classify the thrown error into a known category (AppError subclass,
//      JWT failure, Sequelize failure, Multer failure, bad-JSON body, etc.).
//   2. Produce a SAFE response body — never raw stack traces, never SQL
//      fragments, never column names, never `err.message` outside the
//      allowlist set by AppError subclasses.
//   3. Log the FULL technical context server-side, with secrets redacted.
//   4. Stamp every response with the request id so support can find the
//      matching log line.
//
// Response shape (additive — keeps existing top-level `message`/`errors`
// fields for backward compatibility):
//
//   {
//     "success": false,
//     "message": "Human-readable user-facing message.",
//     "errors":  [...]                       // optional, validation details
//     "code":    "AUTH_INVALID_CREDENTIALS", // optional, top-level for legacy callers
//     "error": {
//       "code":      "AUTH_INVALID_CREDENTIALS",
//       "message":   "Human-readable user-facing message.",
//       "requestId": "abc123-def456-...",
//       "details":   [...]                    // optional
//     }
//   }
//
// Frontend code that reads `err.response.data.message` continues to work
// unchanged; new frontend code should switch to `err.response.data.error.code`.

const { ERROR_CODES, AppError } = require('../utils/errors');
const safeLogger = require('../utils/safeLogger');

// Generic user-facing messages keyed by error code. We never reflect raw
// internal error text to the user — only the curated strings here. AppError
// subclasses carry their OWN safeMessage which overrides this; this table
// is the fallback for non-AppError errors we classify by status code.
const DEFAULT_USER_MESSAGES = Object.freeze({
  [ERROR_CODES.VALIDATION_FAILED]: 'Some of the information you provided is not valid. Please check the highlighted fields and try again.',
  [ERROR_CODES.BAD_REQUEST]:       'This request could not be processed.',
  [ERROR_CODES.AUTH_REQUIRED]:     'You need to sign in to continue.',
  [ERROR_CODES.AUTH_INVALID_CREDENTIALS]: 'Invalid email or password.',
  [ERROR_CODES.AUTH_SESSION_EXPIRED]: 'Your session has expired. Please log in again.',
  [ERROR_CODES.AUTH_TOKEN_INVALID]: 'Your session is no longer valid. Please log in again.',
  [ERROR_CODES.AUTH_TOKEN_REUSE]:  'For your security we ended this session. Please log in again.',
  [ERROR_CODES.AUTH_SESSION_CONFLICT]: 'Another session is already active for this account.',
  [ERROR_CODES.FORBIDDEN]:         'You do not have permission to perform this action.',
  [ERROR_CODES.PERMISSION_DENIED]: 'You do not have permission to perform this action.',
  [ERROR_CODES.TIER_INSUFFICIENT]: 'You do not have permission to perform this action.',
  [ERROR_CODES.NOT_FOUND]:         'This item was not found or may have been deleted.',
  [ERROR_CODES.CONFLICT]:          'This action conflicts with the current state. Please refresh and try again.',
  [ERROR_CODES.DUPLICATE]:         'An item like this already exists.',
  [ERROR_CODES.PAYLOAD_TOO_LARGE]: 'The file or request is too large.',
  [ERROR_CODES.UNSUPPORTED_MEDIA]: 'This file type is not supported.',
  [ERROR_CODES.RATE_LIMITED]:      'Too many requests. Please wait a moment and try again.',
  [ERROR_CODES.INTERNAL_ERROR]:    'Something went wrong on our end. Please try again.',
  [ERROR_CODES.DB_ERROR]:          'Something went wrong on our end. Please try again.',
  [ERROR_CODES.UPSTREAM_ERROR]:    'A connected service did not respond correctly. Please try again.',
  [ERROR_CODES.SERVICE_UNAVAILABLE]: 'This service is temporarily unavailable. Please try again in a moment.',
});

// Classify a thrown error into { statusCode, code, message, details, retryAfter }.
// The returned `message` is what the CLIENT will see. The original error and
// any extra technical context are passed separately to the logger.
function classifyError(err) {
  // 1. AppError and subclasses — trust the call site's intent. The
  //    safeMessage and code were chosen deliberately for user display.
  if (err instanceof AppError) {
    return {
      statusCode: err.statusCode,
      code: err.code,
      message: err.safeMessage || DEFAULT_USER_MESSAGES[err.code] || DEFAULT_USER_MESSAGES[ERROR_CODES.INTERNAL_ERROR],
      details: err.details,
      retryAfter: err.retryAfter,
    };
  }

  // 2. JSON body parse errors (express.json with bad body).
  if (err && err.type === 'entity.parse.failed') {
    return {
      statusCode: 400,
      code: ERROR_CODES.BAD_REQUEST,
      message: 'The request body could not be read.',
    };
  }
  if (err && err.type === 'entity.too.large') {
    return {
      statusCode: 413,
      code: ERROR_CODES.PAYLOAD_TOO_LARGE,
      message: DEFAULT_USER_MESSAGES[ERROR_CODES.PAYLOAD_TOO_LARGE],
    };
  }

  // 3. JWT verification failures.
  if (err && err.name === 'TokenExpiredError') {
    return {
      statusCode: 401,
      code: ERROR_CODES.AUTH_SESSION_EXPIRED,
      message: DEFAULT_USER_MESSAGES[ERROR_CODES.AUTH_SESSION_EXPIRED],
    };
  }
  if (err && (err.name === 'JsonWebTokenError' || err.name === 'NotBeforeError')) {
    return {
      statusCode: 401,
      code: ERROR_CODES.AUTH_TOKEN_INVALID,
      message: DEFAULT_USER_MESSAGES[ERROR_CODES.AUTH_TOKEN_INVALID],
    };
  }

  // 4. Multer (file upload) errors.
  if (err && err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return {
        statusCode: 413,
        code: ERROR_CODES.PAYLOAD_TOO_LARGE,
        message: 'The file you uploaded is too large.',
      };
    }
    // Any other Multer error is treated as a validation problem on the
    // upload (wrong field name, too many files, etc.). Never reflect
    // err.message — Multer messages reveal field names and limits.
    return {
      statusCode: 400,
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'There was a problem with your file upload. Please try again.',
    };
  }

  // 5. Sequelize errors — NEVER echo column names, constraint names, or
  //    SQL fragments to the client. These messages routinely contain
  //    `users_email_key` style strings that reveal schema.
  if (err && typeof err.name === 'string' && err.name.startsWith('Sequelize')) {
    switch (err.name) {
      case 'SequelizeUniqueConstraintError':
        return {
          statusCode: 409,
          code: ERROR_CODES.DUPLICATE,
          message: DEFAULT_USER_MESSAGES[ERROR_CODES.DUPLICATE],
        };
      case 'SequelizeValidationError':
        return {
          statusCode: 400,
          code: ERROR_CODES.VALIDATION_FAILED,
          message: DEFAULT_USER_MESSAGES[ERROR_CODES.VALIDATION_FAILED],
        };
      case 'SequelizeForeignKeyConstraintError':
        return {
          statusCode: 409,
          code: ERROR_CODES.CONFLICT,
          message: 'This action references something that no longer exists.',
        };
      case 'SequelizeConnectionError':
      case 'SequelizeConnectionRefusedError':
      case 'SequelizeHostNotFoundError':
      case 'SequelizeHostNotReachableError':
      case 'SequelizeAccessDeniedError':
        return {
          statusCode: 503,
          code: ERROR_CODES.SERVICE_UNAVAILABLE,
          message: DEFAULT_USER_MESSAGES[ERROR_CODES.SERVICE_UNAVAILABLE],
        };
      default:
        return {
          statusCode: 500,
          code: ERROR_CODES.DB_ERROR,
          message: DEFAULT_USER_MESSAGES[ERROR_CODES.DB_ERROR],
        };
    }
  }

  // 6. Heuristic mapping for legacy controllers that throw an Error with
  //    .statusCode set (TierError follows this pattern).
  if (err && typeof err.statusCode === 'number') {
    const status = err.statusCode;
    if (status === 400) return { statusCode: 400, code: ERROR_CODES.BAD_REQUEST,        message: err.safeMessage || DEFAULT_USER_MESSAGES[ERROR_CODES.BAD_REQUEST] };
    if (status === 401) return { statusCode: 401, code: err.code || ERROR_CODES.AUTH_REQUIRED, message: DEFAULT_USER_MESSAGES[err.code] || DEFAULT_USER_MESSAGES[ERROR_CODES.AUTH_REQUIRED] };
    if (status === 403) return { statusCode: 403, code: err.code || ERROR_CODES.FORBIDDEN, message: DEFAULT_USER_MESSAGES[err.code] || DEFAULT_USER_MESSAGES[ERROR_CODES.FORBIDDEN] };
    if (status === 404) return { statusCode: 404, code: ERROR_CODES.NOT_FOUND,          message: DEFAULT_USER_MESSAGES[ERROR_CODES.NOT_FOUND] };
    if (status === 409) return { statusCode: 409, code: err.code || ERROR_CODES.CONFLICT, message: DEFAULT_USER_MESSAGES[err.code] || DEFAULT_USER_MESSAGES[ERROR_CODES.CONFLICT] };
    if (status === 413) return { statusCode: 413, code: ERROR_CODES.PAYLOAD_TOO_LARGE,  message: DEFAULT_USER_MESSAGES[ERROR_CODES.PAYLOAD_TOO_LARGE] };
    if (status === 429) return { statusCode: 429, code: ERROR_CODES.RATE_LIMITED,       message: DEFAULT_USER_MESSAGES[ERROR_CODES.RATE_LIMITED] };
    if (status >= 500)  return { statusCode: status, code: ERROR_CODES.INTERNAL_ERROR,  message: DEFAULT_USER_MESSAGES[ERROR_CODES.INTERNAL_ERROR] };
  }

  // 7. CORS denied (err.message contains 'CORS: origin ... not allowed').
  if (err && typeof err.message === 'string' && err.message.startsWith('CORS:')) {
    return {
      statusCode: 403,
      code: ERROR_CODES.FORBIDDEN,
      message: 'Request origin not allowed.',
    };
  }

  // 8. Default — generic 500.
  return {
    statusCode: 500,
    code: ERROR_CODES.INTERNAL_ERROR,
    message: DEFAULT_USER_MESSAGES[ERROR_CODES.INTERNAL_ERROR],
  };
}

function errorHandler(err, req, res, _next) {
  // If headers were already sent, hand off to Express's default handler.
  // Anything we try at this point will trigger "Cannot set headers after
  // they were sent" and may corrupt the response.
  if (res.headersSent) {
    return _next(err);
  }

  const classified = classifyError(err);
  const requestId = req.id || 'unknown';
  const userId = req.user?.id;

  // Build the response body. We keep top-level `message`, `errors`, and
  // `code` for backward compatibility with existing frontend code that
  // reads any of those, and add the structured `error` object for new
  // code to consume.
  const body = {
    success: false,
    message: classified.message,
    code: classified.code,
    error: {
      code: classified.code,
      message: classified.message,
      requestId,
    },
  };
  if (classified.details !== undefined) {
    body.errors = Array.isArray(classified.details) ? classified.details : [classified.details];
    body.error.details = classified.details;
  }
  if (classified.retryAfter != null) {
    body.retryAfter = classified.retryAfter;
    body.error.retryAfter = classified.retryAfter;
    res.setHeader('Retry-After', String(classified.retryAfter));
  }

  // 5xx = operational alert. 4xx = expected client error. Log level scales
  // accordingly so a flood of 404s doesn't fill the error log file.
  const logLevel = classified.statusCode >= 500 ? 'error' : 'warn';
  const logMeta = {
    requestId,
    method: req.method,
    path: req.originalUrl,
    statusCode: classified.statusCode,
    code: classified.code,
    ...(userId && { userId }),
    err, // safeLogger redacts secrets + Axios config before this hits disk
  };
  safeLogger[logLevel](`API error ${classified.statusCode} ${classified.code}`, logMeta);

  res.status(classified.statusCode).json(body);
}

module.exports = errorHandler;
module.exports.classifyError = classifyError;
module.exports.DEFAULT_USER_MESSAGES = DEFAULT_USER_MESSAGES;
