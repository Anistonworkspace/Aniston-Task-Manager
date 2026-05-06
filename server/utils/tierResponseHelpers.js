'use strict';

/**
 * Tier assertion -> HTTP response adapter (Phase 5d).
 *
 * Wraps the throwing tier helpers (assertCanDelete, assertCanGrantTier,
 * assertNotLastTier1Change) so controllers do not have to repeat the
 * try/catch + status/message dance.
 *
 * Usage (sync):
 *   if (sendIfTierError(res, () => assertCanDelete(req.user, 'task'))) return;
 *   await task.destroy();
 *
 * Usage (async):
 *   if (await sendIfTierErrorAsync(res, () =>
 *         assertNotLastTier1Change(target, 'demote', User))) return;
 */

const { TierError } = require('../config/tiers');

function _sendTierError(res, err) {
  res.status(err.status).json({
    success: false,
    message: err.message,
    code: err.code,
  });
}

/**
 * Run a synchronous tier assertion. If it throws TierError, send a 4xx
 * response and return true. Other errors propagate to the caller's
 * outer try/catch as before.
 *
 * @returns {boolean} true if a response was sent (caller MUST return)
 */
function sendIfTierError(res, fn) {
  try {
    fn();
    return false;
  } catch (err) {
    if (err instanceof TierError) {
      _sendTierError(res, err);
      return true;
    }
    throw err;
  }
}

/**
 * Async variant for tier assertions that talk to the DB
 * (e.g. assertNotLastTier1Change).
 *
 * @returns {Promise<boolean>} true if a response was sent
 */
async function sendIfTierErrorAsync(res, fn) {
  try {
    await fn();
    return false;
  } catch (err) {
    if (err instanceof TierError) {
      _sendTierError(res, err);
      return true;
    }
    throw err;
  }
}

module.exports = { sendIfTierError, sendIfTierErrorAsync };
