'use strict';

/**
 * D-3 — Webhook HMAC signature verification (defence-in-depth).
 *
 * Why this middleware exists
 * --------------------------
 * `/api/webhooks/*` is already gated by a static `x-webhook-key` shared
 * secret (see routes/webhooks.js). That alone protects against random
 * attackers but has two weaknesses:
 *
 *   1. Replay: a valid request captured on the wire can be re-sent
 *      indefinitely. There's no per-request freshness.
 *   2. Body integrity: the static key doesn't bind the secret to the
 *      payload, so a man-in-the-middle could swap one valid request's
 *      body for another's and the static-key check would still pass.
 *
 * HMAC over `${timestamp}.${rawBody}` with a shared secret closes both:
 * the timestamp gives us a replay window, and the body is bound into the
 * signature so a tampered payload no longer matches.
 *
 * Migration mode (warn / strict)
 * ------------------------------
 * Existing senders (n8n, Teams Outgoing Webhooks) won't sign requests
 * out of the box. Switching this on as strict-required would break the
 * pipeline on deploy. Hence the three-mode toggle:
 *
 *   WEBHOOK_REQUIRE_SIGNATURE=off    Default. Verify if a signature is
 *                                    present (catch tampering on senders
 *                                    that DO sign), but don't reject
 *                                    requests that omit the headers.
 *   WEBHOOK_REQUIRE_SIGNATURE=warn   As above PLUS log loudly when an
 *                                    unsigned request arrives so ops can
 *                                    see who still needs to be migrated.
 *   WEBHOOK_REQUIRE_SIGNATURE=strict Reject any request without a valid
 *                                    signature. Flip to this once every
 *                                    sender is signing (verified via the
 *                                    `warn` logs).
 *
 * Header format expected (Aniston-flavoured)
 * ------------------------------------------
 *   X-Aniston-Timestamp: <unix-seconds>
 *   X-Aniston-Signature: sha256=<hex digest>
 *
 * Where the digest is HMAC-SHA256(secret, `${timestamp}.${rawBody}`),
 * hex-encoded, lowercase.
 *
 * Replay window: ±5 minutes. Wide enough to absorb clock skew, narrow
 * enough that captured requests expire before they can be reused at scale.
 */

const crypto = require('crypto');

const REPLAY_WINDOW_SECONDS = 5 * 60; // 5 minutes
const TIMESTAMP_HEADER = 'x-aniston-timestamp';
const SIGNATURE_HEADER = 'x-aniston-signature';

// Read the toggle once per process boot. Restart required to flip modes —
// acceptable for an environment-controlled setting that should be deliberate.
//
// P1-9 — Default to `strict` in production so an operator forgetting to set
// WEBHOOK_REQUIRE_SIGNATURE on a prod deploy doesn't silently accept
// unsigned traffic. Dev/test/CI keep the `off` default so the n8n local
// fixture (which can't sign requests) keeps working.
function readMode() {
  const envDefault = process.env.NODE_ENV === 'production' ? 'strict' : 'off';
  const v = String(process.env.WEBHOOK_REQUIRE_SIGNATURE || envDefault).toLowerCase();
  return ['off', 'warn', 'strict'].includes(v) ? v : envDefault;
}

function readSecret() {
  return process.env.WEBHOOK_HMAC_SECRET || '';
}

// Constant-time compare. Buffers must match length; we pad so a length
// mismatch doesn't leak via early-exit timing.
function safeEqual(aHex, bHex) {
  const a = Buffer.from(String(aHex || ''), 'utf8');
  const b = Buffer.from(String(bHex || ''), 'utf8');
  if (a.length !== b.length) {
    // Compare against itself to keep the timing path uniform.
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * Compute the canonical signature for a request. Exposed for tests +
 * for any sender side helpers we ship.
 */
function computeSignature(secret, timestampStr, rawBody) {
  const bodyBuf = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(rawBody == null ? '' : String(rawBody), 'utf8');
  const h = crypto.createHmac('sha256', secret);
  h.update(String(timestampStr));
  h.update('.');
  h.update(bodyBuf);
  return `sha256=${h.digest('hex')}`;
}

/**
 * Express middleware. Place AFTER the existing static-key webhookAuth so
 * authentication + signature run in the right order: only authenticated
 * callers ever reach the signature check, which means we never burn HMAC
 * compute on anonymous traffic and our error responses don't leak whether
 * a route exists to unauthenticated probers.
 */
function verifyWebhookSignature(req, res, next) {
  const mode = readMode();
  const secret = readSecret();

  const tsRaw = req.headers[TIMESTAMP_HEADER];
  const sigRaw = req.headers[SIGNATURE_HEADER];

  // No headers present → unsigned request.
  if (!tsRaw || !sigRaw) {
    if (mode === 'strict') {
      console.warn(`[Webhook] REJECTED: unsigned request — ${req.method} ${req.originalUrl}`);
      return res.status(401).json({
        success: false,
        message: 'Webhook signature is required.',
        code: 'webhook_unsigned',
      });
    }
    if (mode === 'warn') {
      // Loud so ops can see exactly which sender / IP still needs migration.
      console.warn(
        `[Webhook] UNSIGNED ${req.method} ${req.originalUrl} from ${req.ip} `
        + `ua="${(req.headers['user-agent'] || '').slice(0, 80)}" — `
        + `accepted by warn-mode policy. Migrate the sender to sign requests `
        + `before flipping WEBHOOK_REQUIRE_SIGNATURE=strict.`
      );
    }
    // off / warn → pass through.
    return next();
  }

  // Headers present but no secret configured → operator misconfiguration.
  // Log and (in strict mode) reject. In warn/off we log and accept.
  if (!secret) {
    console.warn('[Webhook] Signature headers present but WEBHOOK_HMAC_SECRET is not set — cannot verify.');
    if (mode === 'strict') {
      return res.status(503).json({
        success: false,
        message: 'Webhook signing is required but WEBHOOK_HMAC_SECRET is not configured on the server.',
        code: 'webhook_secret_missing',
      });
    }
    return next();
  }

  // Replay window check. We expect unix seconds; tolerate ms by detecting
  // a clearly-too-large value and dividing.
  let ts = Number(tsRaw);
  if (!Number.isFinite(ts)) {
    return res.status(401).json({
      success: false,
      message: 'Malformed webhook timestamp.',
      code: 'webhook_bad_timestamp',
    });
  }
  if (ts > 1e12) ts = Math.floor(ts / 1000); // accept ms, normalise to seconds
  const nowSec = Math.floor(Date.now() / 1000);
  const skew = Math.abs(nowSec - ts);
  if (skew > REPLAY_WINDOW_SECONDS) {
    return res.status(401).json({
      success: false,
      message: 'Webhook timestamp is outside the allowed window.',
      code: 'webhook_replay_window',
    });
  }

  // Compute the expected signature over the EXACT bytes received. We rely
  // on the express.json `verify` hook (set in server.js) to attach
  // req.rawBody. If for some reason it's missing (e.g. a route bypassed
  // the body parser) we fall back to a JSON re-serialisation, which is
  // permissive but at least catches unsigned tampering.
  const rawBody = req.rawBody != null
    ? req.rawBody
    : Buffer.from(req.body == null ? '' : JSON.stringify(req.body), 'utf8');
  const expected = computeSignature(secret, ts, rawBody);

  if (!safeEqual(expected, sigRaw)) {
    console.warn(`[Webhook] REJECTED: bad signature — ${req.method} ${req.originalUrl} from ${req.ip}`);
    return res.status(401).json({
      success: false,
      message: 'Invalid webhook signature.',
      code: 'webhook_bad_signature',
    });
  }

  return next();
}

module.exports = {
  verifyWebhookSignature,
  computeSignature,    // exported for senders / tests
  REPLAY_WINDOW_SECONDS,
  TIMESTAMP_HEADER,
  SIGNATURE_HEADER,
};
