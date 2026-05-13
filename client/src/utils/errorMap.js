// errorMap — single place where backend error codes turn into the strings
// the user actually sees in toasts, banners, and inline form errors.
//
// The keys here MUST stay in sync with server/utils/errors.js ERROR_CODES
// and the canonical strings in server/middleware/errorHandler.js. If the
// backend adds a new code, add it here too; until then the fallback
// "Something went wrong" applies.
//
// Why a frontend table even though the backend already sends `message`?
//   1. The backend message is correct for English. The map gives us a
//      single place to localise later (Hindi + future locales).
//   2. We can override backend copy for components that need a shorter
//      or context-specific string (e.g. inline "Invalid email or password"
//      next to the password field vs the longer banner in a toast).
//   3. If a controller forgets to wrap its error and a raw Sequelize
//      message somehow surfaces, the map shields the user from the leak.

const MESSAGES = Object.freeze({
  // 400
  VALIDATION_FAILED: 'Some of the information you provided is not valid. Please check the highlighted fields and try again.',
  BAD_REQUEST: 'This request could not be processed.',
  // 401
  AUTH_REQUIRED: 'You need to sign in to continue.',
  AUTH_INVALID_CREDENTIALS: 'Invalid email or password.',
  AUTH_SESSION_EXPIRED: 'Your session has expired. Please log in again.',
  AUTH_TOKEN_INVALID: 'Your session is no longer valid. Please log in again.',
  AUTH_TOKEN_REUSE: 'For your security we ended this session. Please log in again.',
  AUTH_SESSION_CONFLICT: 'Another session is already active for this account.',
  // 403
  FORBIDDEN: 'You do not have permission to perform this action.',
  PERMISSION_DENIED: 'You do not have permission to perform this action.',
  TIER_INSUFFICIENT: 'You do not have permission to perform this action.',
  // 404
  NOT_FOUND: 'This item was not found or may have been deleted.',
  // 409
  CONFLICT: 'This action conflicts with the current state. Please refresh and try again.',
  DUPLICATE: 'An item like this already exists.',
  // 413
  PAYLOAD_TOO_LARGE: 'The file or request is too large.',
  // 415
  UNSUPPORTED_MEDIA: 'This file type is not supported.',
  // 429
  RATE_LIMITED: 'Too many requests. Please wait a moment and try again.',
  // 500 / 502 / 503
  INTERNAL_ERROR: 'Something went wrong on our end. Please try again.',
  DB_ERROR: 'Something went wrong on our end. Please try again.',
  UPSTREAM_ERROR: 'A connected service did not respond correctly. Please try again.',
  SERVICE_UNAVAILABLE: 'This service is temporarily unavailable. Please try again in a moment.',

  // Legacy / domain-specific codes that pre-date the centralized system —
  // listed here so the message comes through this map even when the
  // backend uses an older code string.
  rate_limited:           'Too many requests. Please wait a moment and try again.',
  SESSION_ALREADY_ACTIVE: 'Another session is already active for this account.',
  SESSION_REVOKED:        'Your session was ended on another device. Please log in again.',
  PENDING_TOKEN_INVALID:  'Session confirmation expired. Please sign in again.',
  PENDING_TOKEN_REQUIRED: 'Session confirmation is required. Please sign in again.',
  ACCOUNT_UNAVAILABLE:    'This account is unavailable. Please contact your administrator.',
  AI_NOT_CONFIGURED:      'AI is not configured. Ask an admin to set up AI in Integrations.',
  AI_PROVIDER_UNSUPPORTED:'The selected AI provider type is not supported.',
  DEPENDENCY_CIRCULAR:    'This would create a circular dependency between the selected tasks.',
  DEPENDENCY_DUPLICATE:   'This dependency already exists for these tasks.',
});

// Fallback when no code maps and no backend message is usable.
export const FALLBACK_MESSAGE = 'Something went wrong. Please try again.';

// Network-level fallbacks. These don't have backend codes because the
// request never reached the server.
export const NETWORK_ERROR_MESSAGE = 'Network error. Please check your connection.';
export const TIMEOUT_ERROR_MESSAGE = 'The request took too long. Please try again.';
export const OFFLINE_ERROR_MESSAGE = 'You appear to be offline. Please check your connection.';

// Extract a canonical error code from a thrown Axios error. The backend
// stamps `code` at the top level for legacy callers AND under `error.code`
// for new code; we check both, then fall back to the HTTP status.
export function getErrorCode(err) {
  const data = err?.response?.data;
  if (!data || typeof data !== 'object') return null;
  if (typeof data?.error?.code === 'string') return data.error.code;
  if (typeof data?.code === 'string') return data.code;
  return null;
}

// Extract the requestId stamped by the backend so support tickets can
// reference an exact log line. Surfaced from response body first, falling
// back to the X-Request-ID header.
export function getRequestId(err) {
  const data = err?.response?.data;
  if (typeof data?.error?.requestId === 'string') return data.error.requestId;
  const header = err?.response?.headers?.['x-request-id'];
  return typeof header === 'string' ? header : null;
}

// Resolve a user-facing message for an Axios error. Priority:
//   1. Known code → canonical message from MESSAGES
//   2. Network-level error → connection-themed message
//   3. Backend-supplied message (already vetted by errorHandler.js)
//   4. Fallback
//
// Callers can override step 1 with the `overrides` map (e.g. Login
// converts the long "validation failed" message to the shorter
// "Invalid email or password" the form needs).
export function getErrorMessage(err, overrides) {
  // Cancelled requests aren't user-visible errors.
  if (err?.code === 'ERR_CANCELED' || err?.__CANCEL__) return null;

  // No response = network-level failure (offline, DNS, CORS, timeout).
  if (!err?.response) {
    if (err?.code === 'ECONNABORTED' || /timeout/i.test(err?.message || '')) {
      return TIMEOUT_ERROR_MESSAGE;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return OFFLINE_ERROR_MESSAGE;
    }
    return NETWORK_ERROR_MESSAGE;
  }

  const code = getErrorCode(err);
  if (code) {
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, code)) {
      return overrides[code];
    }
    if (MESSAGES[code]) return MESSAGES[code];
  }

  // Final fallback: trust the backend's `message` field (which is now
  // always produced by errorHandler.js with safe copy). If for some
  // reason it's missing or empty, use the generic fallback.
  const backendMessage = err.response?.data?.message;
  if (typeof backendMessage === 'string' && backendMessage.trim()) {
    return backendMessage;
  }
  return FALLBACK_MESSAGE;
}

// Whole-error helper for callers that want both the message and the
// machine-readable bits in one shot.
export function describeError(err) {
  return {
    message: getErrorMessage(err),
    code: getErrorCode(err),
    status: err?.response?.status ?? 0,
    requestId: getRequestId(err),
  };
}

export const ERROR_MESSAGES = MESSAGES;
