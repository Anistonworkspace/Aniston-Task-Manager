const webpush = require('web-push');

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

// In-memory store for push subscriptions (per userId)
// In production, store in database
const subscriptions = new Map();

function saveSubscription(userId, subscription) {
  if (!subscriptions.has(userId)) subscriptions.set(userId, []);
  const subs = subscriptions.get(userId);
  // Avoid duplicates
  if (!subs.find(s => s.endpoint === subscription.endpoint)) {
    subs.push(subscription);
  }
}

function removeSubscription(userId, endpoint) {
  if (!subscriptions.has(userId)) return;
  const subs = subscriptions.get(userId).filter(s => s.endpoint !== endpoint);
  if (subs.length === 0) subscriptions.delete(userId);
  else subscriptions.set(userId, subs);
}

/**
 * Send push notification to a specific user.
 * Silently fails if user has no subscriptions or push not configured.
 */
async function sendPushToUser(userId, payload) {
  if (!pushConfigured) return;
  const subs = subscriptions.get(userId);
  if (!subs || subs.length === 0) return;

  const data = JSON.stringify({
    title: payload.title || 'Monday Aniston',
    body: payload.body || payload.message || 'New notification',
    tag: payload.tag || `notif-${Date.now()}`,
    url: payload.url || '/',
  });

  const results = await Promise.allSettled(
    subs.map(sub => webpush.sendNotification(sub, data))
  );

  // Remove expired/invalid subscriptions
  results.forEach((result, i) => {
    if (result.status === 'rejected' && result.reason?.statusCode === 410) {
      removeSubscription(userId, subs[i].endpoint);
    }
  });
}

module.exports = {
  pushConfigured,
  vapidPublicKey: VAPID_PUBLIC,
  saveSubscription,
  removeSubscription,
  sendPushToUser,
};
