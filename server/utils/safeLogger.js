// safeLogger — winston wrapper that scrubs secrets before they hit disk.
//
// The base logger (utils/logger.js) writes whatever you hand it — including
// Axios error objects whose `.config.headers.Authorization` carries the
// caller's Bearer token, or `.config.data` strings that include the user's
// password from a login attempt. This wrapper runs a redaction pass over
// any object you log so those fields are replaced with `[REDACTED]` before
// winston ever sees them.
//
// Use this everywhere instead of console.* or the bare winston logger.
// The API mirrors winston (info/warn/error/debug) so it's a drop-in.

const logger = require('./logger');

// Keys whose VALUES are always redacted, no matter what they contain. Match
// is case-insensitive so `Authorization` / `authorization` / `AUTHORIZATION`
// all get caught. Add patterns here when a new sensitive field type appears.
const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'password_hash',
  'newpassword',
  'oldpassword',
  'currentpassword',
  'confirmpassword',
  'token',
  'refreshtoken',
  'refresh_token',
  'accesstoken',
  'access_token',
  'id_token',
  'idtoken',
  'jwt',
  'authorization',
  'auth',
  'cookie',
  'set-cookie',
  'setcookie',
  'x-api-key',
  'apikey',
  'api_key',
  'secret',
  'clientsecret',
  'client_secret',
  'otp',
  'totp',
  'resettoken',
  'reset_token',
  'verificationtoken',
  'verification_token',
  'sessionid',
  'session_id',
  'ssotoken',
  'sso_token',
  'p256dh',
  'auth_secret',
  'encryption_key',
  'encryptionkey',
  'vapid_private_key',
  'vapidprivatekey',
  'privatekey',
  'private_key',
  'pendingtoken',
  'pending_token',
  'csrftoken',
  'csrf_token',
]);

// Substring patterns inside string values that imply a credential. We don't
// try to fully validate — we just replace the offending substring with a
// redacted marker so any neighbouring useful context (URLs, error names) is
// preserved.
//
//   - JWT-shaped tokens: three base64url segments joined by dots.
//   - `Bearer xxx` headers anywhere in the string.
const JWT_LIKE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER_HEADER = /\bBearer\s+[A-Za-z0-9._-]+/gi;
// Long random-looking tokens (40+ url-safe chars) often appear in error
// strings from password-reset URLs. We're conservative: only match strings
// that are MOSTLY one base64-ish run, to avoid mangling normal text.
const LONG_TOKEN = /\b[A-Za-z0-9_-]{40,}\b/g;

const MAX_DEPTH = 6;     // anti-runaway against circular / huge graphs
const MAX_STRING = 2000; // truncate giant strings (stack frames, dumps)

function redactString(str) {
  if (typeof str !== 'string') return str;
  let out = str;
  out = out.replace(BEARER_HEADER, 'Bearer [REDACTED]');
  out = out.replace(JWT_LIKE, '[REDACTED_JWT]');
  // Conservative long-token redaction — only when the suspicious chunk is
  // the dominant content of the string (avoids mangling free-form prose).
  if (out.length < 200) {
    out = out.replace(LONG_TOKEN, (match) => {
      // Skip common non-secret long strings (uuids, file hashes printed in
      // contexts we DO want to see). UUID v4 is 36 chars with hyphens — it
      // won't match LONG_TOKEN (40+ no hyphens). SHA-256 hex is 64 chars but
      // it's also content we usually want; only redact when it looks like
      // base64url with mixed case + special chars.
      if (/^[a-f0-9]+$/i.test(match)) return match; // pure hex — likely a hash
      return '[REDACTED]';
    });
  }
  if (out.length > MAX_STRING) {
    out = out.slice(0, MAX_STRING) + '…[truncated]';
  }
  return out;
}

function isSensitiveKey(key) {
  if (typeof key !== 'string') return false;
  const k = key.toLowerCase();
  if (SENSITIVE_KEYS.has(k)) return true;
  // Catch -token / _token / *secret* suffixes we didn't enumerate.
  if (k.endsWith('token') && k !== 'csrftoken') return true;
  if (k.endsWith('_secret') || k.endsWith('secret')) return true;
  return false;
}

// Axios errors carry the original request config (with auth headers) and
// often the request body in `.config.data` (with passwords on login). We
// flatten to a stripped-down shape that preserves the diagnostic fields
// (status, url, method, response data summary) without the secrets.
function redactAxiosError(err) {
  const out = {
    name: err.name,
    message: redactString(err.message),
    code: err.code,
  };
  if (err.config) {
    out.request = {
      method: (err.config.method || '').toUpperCase(),
      // url only — never the full headers/data
      url: typeof err.config.url === 'string' ? err.config.url.split('?')[0] : undefined,
      timeoutMs: err.config.timeout,
    };
  }
  if (err.response) {
    out.response = {
      status: err.response.status,
      statusText: err.response.statusText,
      // Surface ONLY the response data's `code`/`message` if present (typical
      // shape from a well-behaved upstream). Never echo the whole body.
      data: typeof err.response.data === 'object' && err.response.data
        ? {
            code: err.response.data.code,
            message: typeof err.response.data.message === 'string'
              ? redactString(err.response.data.message).slice(0, 200)
              : undefined,
          }
        : undefined,
    };
  }
  if (err.stack) out.stack = redactString(err.stack);
  return out;
}

function isAxiosError(err) {
  return Boolean(err && typeof err === 'object' && err.isAxiosError === true);
}

function isError(err) {
  return err instanceof Error;
}

function redact(value, depth = 0, seen = new WeakSet()) {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'symbol') return value.toString();

  if (isAxiosError(value)) return redactAxiosError(value);

  if (isError(value)) {
    // Generic error — keep name/message/stack (redacted) plus any
    // operational + diagnostic fields. Sequelize errors carry the most
    // useful debug info under `original.message` (PG error text — column
    // names, constraint names) and `sql` (the failed query) — those are
    // SCHEMA leak risk but not SECRET leak risk, and stripping them
    // makes prod outages much harder to diagnose. We pass them through
    // the redactor (so wrapped Axios errors inside them still get
    // scrubbed) but keep the fields themselves.
    const out = {
      name: value.name,
      message: redactString(value.message),
      stack: redactString(value.stack || ''),
    };
    if (value.statusCode != null) out.statusCode = value.statusCode;
    if (value.code != null && typeof value.code === 'string') out.code = value.code;
    if (value.details !== undefined) out.details = redact(value.details, depth + 1, seen);
    // Sequelize-specific diagnostic surface. Flatten `original.message`
    // and `parent.message` to a plain string for log readability — the
    // existing controllers expect exactly that shape.
    if (value.original && typeof value.original === 'object') {
      out.original = typeof value.original.message === 'string'
        ? redactString(value.original.message)
        : redact(value.original, depth + 1, seen);
    }
    if (value.parent && typeof value.parent === 'object') {
      out.parent = typeof value.parent.message === 'string'
        ? redactString(value.parent.message)
        : redact(value.parent, depth + 1, seen);
    }
    if (typeof value.sql === 'string') out.sql = redactString(value.sql);
    if (Array.isArray(value.errors)) {
      out.errors = value.errors.slice(0, 20).map((e) => {
        if (e && typeof e === 'object') {
          return {
            message: typeof e.message === 'string' ? redactString(e.message) : undefined,
            type: e.type,
            path: e.path,
            validatorKey: e.validatorKey,
          };
        }
        return redact(e, depth + 1, seen);
      });
    }
    return out;
  }

  if (typeof value !== 'object') return String(value);

  // Defensive guard against cycles.
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Buffer.isBuffer(value)) return `[Buffer length=${value.length}]`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof RegExp) return value.toString();
  if (value instanceof Map) return '[Map]';
  if (value instanceof Set) return '[Set]';

  if (Array.isArray(value)) {
    // Cap array logging at 50 items so a stray request-body dump can't fill
    // a log line with thousands of entries.
    return value.slice(0, 50).map((v) => redact(v, depth + 1, seen));
  }

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      out[key] = '[REDACTED]';
      continue;
    }
    // Special-case: req.headers — redact authorization/cookie even though
    // the wrapper object's key is the lowercase header name we already
    // catch above. Belt + suspenders.
    out[key] = redact(val, depth + 1, seen);
  }
  return out;
}

function buildMeta(meta) {
  if (meta == null) return undefined;
  if (typeof meta !== 'object') return { value: redact(meta) };
  return redact(meta);
}

function log(level, message, meta) {
  const safeMessage = typeof message === 'string' ? redactString(message) : redact(message);
  const safeMeta = buildMeta(meta);
  const msg = typeof safeMessage === 'string' ? safeMessage : String(safeMessage);
  // Call the per-level method (logger.info/warn/error/debug) rather than
  // the generic logger.log(level, ...). winston supports both, but tests
  // around the codebase mock the per-level methods only — calling .log()
  // breaks those mocks.
  const fn = typeof logger[level] === 'function' ? logger[level] : logger.info;
  if (safeMeta !== undefined) {
    fn.call(logger, msg, safeMeta);
  } else {
    fn.call(logger, msg);
  }
}

module.exports = {
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
  debug: (msg, meta) => log('debug', msg, meta),
  // Expose the redactor for callers that want to sanitise a structure before
  // emitting it some other way (e.g. notification payloads, metrics).
  redact,
  redactString,
  isSensitiveKey,
};
