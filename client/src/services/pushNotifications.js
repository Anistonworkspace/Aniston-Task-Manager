/**
 * Push Notification Service
 * Handles browser push permission, VAPID subscription, and local notifications.
 */
import api from './api';

export function isPushSupported() {
  return 'Notification' in window && 'serviceWorker' in navigator;
}

export function getPermissionStatus() {
  if (!isPushSupported()) return 'unsupported';
  return Notification.permission;
}

export async function requestPushPermission() {
  if (!isPushSupported()) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  const permission = await Notification.requestPermission();
  return permission;
}

/**
 * Subscribe to server-side VAPID push notifications.
 * Called after permission is granted.
 *
 * Diagnostic logging is verbose by design — the previous silent-fail
 * implementation made it impossible to diagnose "OS notifications don't
 * fire" reports. Every step now logs success or the specific reason it
 * stopped. Callers can use the returned object's `reason` field to surface
 * actionable hints in the UI.
 *
 * Returns:
 *   { ok: true, endpoint }                      on success
 *   { ok: false, reason: 'unsupported' }        no Notification API
 *   { ok: false, reason: 'permission' }         user denied / unset
 *   { ok: false, reason: 'vapid-not-configured' } backend has no VAPID keys
 *   { ok: false, reason: 'sw-not-ready' }       SW didn't activate
 *   { ok: false, reason: 'subscribe-failed' }   PushManager subscribe threw
 *   { ok: false, reason: 'save-failed' }        backend POST failed
 *   { ok: false, reason: 'vapid-key-mismatch' } existing sub vs new public key
 */
export async function subscribeToPush() {
  if (!isPushSupported()) {
    console.warn('[Push] subscribeToPush: browser does not support Notification + ServiceWorker.');
    return { ok: false, reason: 'unsupported' };
  }
  if (Notification.permission !== 'granted') {
    console.log(`[Push] subscribeToPush: permission is "${Notification.permission}", skipping.`);
    return { ok: false, reason: 'permission' };
  }

  try {
    // 1. Pull VAPID public key from server.
    const keyRes = await api.get('/push/vapid-key');
    const { publicKey, configured } = keyRes.data?.data || keyRes.data || {};
    if (!configured || !publicKey) {
      console.error(
        '[Push] subscribeToPush: backend reports VAPID NOT configured. '
        + 'Set VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY in server/.env. '
        + 'In-app toasts will work; OS notifications will not.'
      );
      return { ok: false, reason: 'vapid-not-configured' };
    }

    // 2. Wait for SW to be ready.
    let registration;
    try {
      registration = await navigator.serviceWorker.ready;
    } catch (err) {
      console.warn('[Push] subscribeToPush: service worker not ready:', err?.message);
      return { ok: false, reason: 'sw-not-ready' };
    }

    // 3. Check for an existing PushManager subscription. If present and the
    //    `applicationServerKey` it was created with no longer matches the
    //    server's current VAPID public key (e.g. dev re-generated keys),
    //    we MUST unsubscribe and re-subscribe — otherwise web-push.send
    //    will return 401/403 every time.
    let subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      const existingKey = subscription.options?.applicationServerKey;
      if (existingKey) {
        const existingB64 = uint8ArrayToBase64Url(new Uint8Array(existingKey));
        if (existingB64 !== normalizeBase64(publicKey)) {
          console.warn(
            '[Push] Existing subscription was created against a different VAPID '
            + 'public key. Unsubscribing and re-subscribing so backend pushes deliver.'
          );
          try { await subscription.unsubscribe(); } catch { /* ignore */ }
          subscription = null;
        }
      }
    }

    // 4. Create a fresh subscription if needed.
    if (!subscription) {
      const applicationServerKey = urlBase64ToUint8Array(publicKey);
      try {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
      } catch (err) {
        console.warn('[Push] PushManager.subscribe failed:', err?.message);
        return { ok: false, reason: 'subscribe-failed' };
      }
    }

    // 5. POST to backend so the row is active for this user.
    try {
      await api.post('/push/subscribe', { subscription: subscription.toJSON() });
    } catch (err) {
      console.warn('[Push] Saving subscription on backend failed:', err?.message);
      return { ok: false, reason: 'save-failed' };
    }

    console.log(
      `[Push] Subscribed: endpoint=…${subscription.endpoint.slice(-24)} `
      + `permission=${Notification.permission}`
    );
    return { ok: true, endpoint: subscription.endpoint };
  } catch (err) {
    console.warn('[Push] subscribeToPush unexpected error:', err?.message);
    return { ok: false, reason: 'unknown' };
  }
}

/** Helpers for VAPID-key drift detection. */
function normalizeBase64(s) {
  return String(s).trim().replace(/=+$/, '');
}
function uint8ArrayToBase64Url(arr) {
  let s = '';
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  // btoa → standard base64; convert to base64url and strip padding.
  return window.btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Get the current device's PushSubscription endpoint (or null if not subscribed).
 * Used by the logout flow so the backend can deactivate the right row.
 */
export async function getCurrentSubscriptionEndpoint() {
  try {
    if (!isPushSupported()) return null;
    const registration = await navigator.serviceWorker.ready;
    const sub = await registration.pushManager.getSubscription();
    return sub?.endpoint || null;
  } catch {
    return null;
  }
}

/**
 * Unsubscribe the browser-side PushManager subscription. The backend row is
 * deactivated separately via the /api/auth/logout endpoint (which also
 * disconnects the socket). We unsubscribe locally so even if the backend
 * call somehow fails the OS push channel is broken from this device.
 *
 * Best-effort: silently no-ops on browsers without push support, and never
 * throws — the caller is the logout flow which must always proceed.
 */
export async function unsubscribeFromPush() {
  try {
    if (!isPushSupported()) return null;
    const registration = await navigator.serviceWorker.ready;
    const sub = await registration.pushManager.getSubscription();
    if (!sub) return null;
    const endpoint = sub.endpoint;
    try { await sub.unsubscribe(); } catch { /* best-effort */ }
    return endpoint;
  } catch (err) {
    console.warn('[Push] unsubscribeFromPush failed:', err.message);
    return null;
  }
}

/**
 * Show a local OS notification — safety-net for events whose backend Web
 * Push didn't fire (e.g. VAPID misconfigured in dev). The caller is the
 * Header's `notification:new` listener; the SAFE guards live here so any
 * future caller automatically gets the same behaviour:
 *
 *   - Permission must be 'granted'.
 *   - The page must be HIDDEN (document.hidden=true) OR document must
 *     not have focus. A focused tab uses the in-app toast as the visible
 *     surface; doubling up with an OS notification is the duplicate the
 *     user explicitly does not want.
 *   - Caller MUST pass a stable `options.tag` (typically `notif-<id>`) so
 *     when the SW push ALSO fires for the same logical event, browsers
 *     tag-collapse the two into a single OS-tray entry.
 *
 * Two render paths:
 *   - Preferred: SW.showNotification (works on every modern browser, plays
 *     nicely with our existing notificationclick handler).
 *   - Fallback: `new Notification()` for the rare browser without an
 *     active service worker registration.
 */
export function showLocalNotification(title, options = {}) {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  // Hidden-only guard — a focused/visible tab gets the in-app toast and
  // doesn't need an OS notification competing for attention.
  const hidden = (typeof document !== 'undefined') && (document.hidden || !document.hasFocus());
  if (!hidden) return;

  const tag = options.tag || `aniston-${Date.now()}`;
  const body = options.body || '';
  const url = options.url || '/';
  const icon = options.icon || '/icons/anistonlogo.png';
  const badge = options.badge || '/icons/anistonlogo.png';

  // Prefer SW path so the existing notificationclick handler in sw.js
  // (which knows how to focus an open tab and route via React Router)
  // handles the click. Tag-collapse with backend Web Push happens
  // automatically when both fire with the same tag.
  if (navigator.serviceWorker && navigator.serviceWorker.ready) {
    navigator.serviceWorker.ready
      .then((reg) => reg.showNotification(title, {
        body, icon, badge, tag, renotify: false, data: { url, notificationId: options.notificationId || null },
      }))
      .catch(() => fallbackNewNotification(title, { body, icon, badge, tag, url }));
    return;
  }
  fallbackNewNotification(title, { body, icon, badge, tag, url });
}

function fallbackNewNotification(title, { body, icon, badge, tag, url }) {
  try {
    const notification = new Notification(title, { body, icon, badge, tag });
    notification.onclick = () => {
      window.focus();
      notification.close();
      if (url) window.location.href = url;
    };
    // OS controls duration; this is a defensive fallback for the legacy
    // `new Notification()` path which does not auto-dismiss in some browsers.
    setTimeout(() => { try { notification.close(); } catch { /* ignore */ } }, 8000);
  } catch { /* ignore — best-effort */ }
}

// Helper: Convert base64 VAPID key to Uint8Array
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
