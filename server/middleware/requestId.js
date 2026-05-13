// requestId — attach a stable identifier to every request so error logs
// and the error responses we return to the client can be correlated.
//
// The id is exposed as `req.id` to other middleware/controllers and echoed
// in the `X-Request-ID` response header so curl users / browser DevTools
// can copy it into a support ticket. The error handler stamps it inside
// the response body too (under `error.requestId`).
//
// We honour an inbound `X-Request-ID` header (set by an upstream proxy or
// the frontend) when it looks well-formed, otherwise we mint a fresh
// crypto.randomUUID. Validating inbound IDs prevents log-injection — an
// attacker can't ship `\n[Server] CRITICAL: ...` as a "request id" and
// have it appear on its own line in our log file.

const crypto = require('crypto');

// Accept only sane-looking ids: 8–64 chars, ascii alphanumeric + dash +
// underscore. UUIDs (with hyphens), short hex ids, and nanoid output all
// pass; anything with a control character or whitespace is rejected.
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function requestIdMiddleware(req, res, next) {
  const inbound = req.headers['x-request-id'];
  let id;
  if (typeof inbound === 'string' && ID_PATTERN.test(inbound)) {
    id = inbound;
  } else {
    id = crypto.randomUUID();
  }
  req.id = id;
  // Surface to clients (and any logging proxy in front of us). Safe to expose
  // — the id is opaque and carries no PII.
  res.setHeader('X-Request-ID', id);
  next();
}

module.exports = requestIdMiddleware;
module.exports.requestIdMiddleware = requestIdMiddleware;
