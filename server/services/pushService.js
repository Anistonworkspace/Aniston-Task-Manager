const webpush = require('web-push');
const { Op } = require('sequelize');

// Configure VAPID
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@aniston.com';

let pushConfigured = false;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
    pushConfigured = true;
    console.log('[Push] VAPID configured successfully');
  } catch (err) {
    console.warn('[Push] VAPID configuration failed:', err.message);
  }
}

/**
 * Lazy-load the model so this file can be required before sequelize init.
 */
function getModel() {
  return require('../models').PushSubscription;
}

/**
 * Save (or re-activate) a push subscription for the authenticated user.
 *
 * Endpoint is unique-per-browser. Two important rules enforced here:
 *   1. If the SAME endpoint already exists under another userId (browser was
 *      previously signed into a different account), we re-link it to the new
 *      userId. The old user can never receive a push at this endpoint again.
 *   2. isActive is always set to true on subscribe so a re-login after logout
 *      re-enables delivery without losing the subscription history.
 *
 * Returns the persisted row (or null on failure — never throws).
 */
async function saveSubscription(userId, subscription, meta = {}) {
  if (!userId || !subscription || !subscription.endpoint) return null;
  const PushSubscription = getModel();
  if (!PushSubscription) return null;

  const endpoint = subscription.endpoint;
  const p256dh = subscription.keys?.p256dh || '';
  const auth = subscription.keys?.auth || '';

  if (!p256dh || !auth) return null;

  try {
    // Endpoint is the natural unique key. Use upsert via findOne+update/create
    // so we control re-linking when the same browser switches users.
    const existing = await PushSubscription.findOne({ where: { endpoint } });
    if (existing) {
      await existing.update({
        userId,
        p256dh,
        auth,
        userAgent: meta.userAgent || existing.userAgent,
        deviceId: meta.deviceId || existing.deviceId,
        isActive: true,
        lastSeenAt: new Date(),
        deactivatedAt: null,
      });
      return existing;
    }
    return await PushSubscription.create({
      userId,
      endpoint,
      p256dh,
      auth,
      userAgent: meta.userAgent || null,
      deviceId: meta.deviceId || null,
      isActive: true,
      lastSeenAt: new Date(),
    });
  } catch (err) {
    console.warn('[Push] saveSubscription failed:', err.message);
    return null;
  }
}

/**
 * Mark a subscription inactive (logout from this device).
 *
 * Scoped by userId AND endpoint so a user cannot deactivate someone else's
 * subscription by sending a forged endpoint. We do NOT hard-delete on logout —
 * the row is preserved (isActive=false, deactivatedAt set) so the same browser
 * re-activating on next login is a single UPDATE rather than a fresh row.
 */
async function deactivateSubscription(userId, endpoint) {
  if (!userId || !endpoint) return 0;
  const PushSubscription = getModel();
  if (!PushSubscription) return 0;
  try {
    const [count] = await PushSubscription.update(
      { isActive: false, deactivatedAt: new Date() },
      { where: { userId, endpoint } }
    );
    return count;
  } catch (err) {
    console.warn('[Push] deactivateSubscription failed:', err.message);
    return 0;
  }
}

/**
 * Mark every active subscription for this user inactive. Used by the "logout
 * all devices" path (currently unused — single-device logout is the default).
 */
async function deactivateAllForUser(userId) {
  if (!userId) return 0;
  const PushSubscription = getModel();
  if (!PushSubscription) return 0;
  try {
    const [count] = await PushSubscription.update(
      { isActive: false, deactivatedAt: new Date() },
      { where: { userId, isActive: true } }
    );
    return count;
  } catch (err) {
    console.warn('[Push] deactivateAllForUser failed:', err.message);
    return 0;
  }
}

/**
 * Hard-delete a subscription by endpoint. Called when web-push reports the
 * endpoint is permanently gone (404/410) so the row stops being retried.
 */
async function deleteByEndpoint(endpoint) {
  if (!endpoint) return 0;
  const PushSubscription = getModel();
  if (!PushSubscription) return 0;
  try {
    return await PushSubscription.destroy({ where: { endpoint } });
  } catch (err) {
    console.warn('[Push] deleteByEndpoint failed:', err.message);
    return 0;
  }
}

/**
 * Send a web push notification to every ACTIVE subscription for a user.
 *
 * Fire-and-forget from the caller's perspective: errors are logged, expired
 * endpoints are evicted from the DB, and the function never throws.
 *
 * Does nothing if VAPID is not configured (prevents `webpush.sendNotification`
 * from throwing on misconfigured environments).
 */
async function sendPushToUser(userId, payload) {
  if (!pushConfigured || !userId) return;
  const PushSubscription = getModel();
  if (!PushSubscription) return;

  let subs = [];
  try {
    subs = await PushSubscription.findAll({
      where: { userId, isActive: true },
      attributes: ['id', 'endpoint', 'p256dh', 'auth'],
      raw: true,
    });
  } catch (err) {
    console.warn('[Push] subscription lookup failed:', err.message);
    return;
  }
  if (!subs.length) return;

  const data = JSON.stringify({
    title: payload.title || 'Monday Aniston',
    body: payload.body || payload.message || 'New notification',
    tag: payload.tag || `notif-${Date.now()}`,
    url: payload.url || '/',
  });

  const sendOne = async (sub) => {
    const subscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };
    try {
      await webpush.sendNotification(subscription, data);
    } catch (err) {
      const code = err?.statusCode;
      if (code === 404 || code === 410) {
        // Endpoint permanently gone — drop it.
        await deleteByEndpoint(sub.endpoint);
      } else if (code === 401 || code === 403) {
        // Auth/VAPID error — do NOT delete (might be transient config issue).
        console.warn('[Push] auth error sending to', sub.endpoint.slice(0, 60), code);
      } else {
        console.warn('[Push] send error:', err.message);
      }
    }
  };

  await Promise.allSettled(subs.map(sendOne));
}

module.exports = {
  pushConfigured,
  vapidPublicKey: VAPID_PUBLIC,
  saveSubscription,
  deactivateSubscription,
  deactivateAllForUser,
  deleteByEndpoint,
  sendPushToUser,
};
