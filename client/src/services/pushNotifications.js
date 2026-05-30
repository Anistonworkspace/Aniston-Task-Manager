/**
 * Push Notification Service
 * Handles browser push permission, VAPID subscription, and local notifications.
 */
import api from './api';
import safeLog from '../utils/safeLog';

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
    safeLog.warn('[Push] subscribeToPush: browser does not support Notification + ServiceWorker.');
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
      safeLog.error(
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
      safeLog.warn('[Push] subscribeToPush: service worker not ready', err);
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
          safeLog.warn(
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
        safeLog.warn('[Push] PushManager.subscribe failed', err);
        return { ok: false, reason: 'subscribe-failed' };
      }
    }

    // 5. POST to backend so the row is active for this user.
    try {
      await api.post('/push/subscribe', { subscription: subscription.toJSON() });
    } catch (err) {
      safeLog.warn('[Push] Saving subscription on backend failed', err);
      return { ok: false, reason: 'save-failed' };
    }

    console.log(
      `[Push] Subscribed: endpoint=…${subscription.endpoint.slice(-24)} `
      + `permission=${Notification.permission}`
    );
    return { ok: true, endpoint: subscription.endpoint };
  } catch (err) {
    safeLog.warn('[Push] subscribeToPush unexpected error', err);
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
    safeLog.warn('[Push] unsubscribeFromPush failed', err);
    return null;
  }
}

/**
 * Show a local OS notification.
 *
 * Caller is the Header's `notification:new` listener (after the leading-edge
 * burst dispatcher). The guards in this helper are the single safe place
 * to enforce policy so any future caller inherits the same behaviour:
 *
 *   - Permission must be 'granted'. Anything else → silent no-op.
 *   - Notification API must exist (`typeof Notification !== 'undefined'`)
 *     — guards iOS Safari < 16 + headless test environments.
 *   - Caller MUST pass a stable `options.tag` (typically `notif-<id>`).
 *     This is the dedup with the backend SW push: when both paths fire
 *     for the same logical event, browsers tag-collapse them into one
 *     OS-tray entry. `renotify: false` (set below) means the second call
 *     silently updates the first without re-popping.
 *
 * Focus policy (May 2026):
 *   We ALWAYS attempt showNotification regardless of tab focus. Users
 *   expect Slack/Teams-style behaviour where the OS card surfaces even
 *   when the app is open (peripheral-vision alerting + OS notification
 *   centre history). Tag-collapse prevents duplicates with the SW push.
 *
 * SW-vs-fallback selection (May 2026 follow-up fix):
 *   The previous version branched on `navigator.serviceWorker.ready` —
 *   but `.ready` is a Promise that is ALWAYS truthy. In dev (where
 *   client/src/main.jsx intentionally never registers a service worker
 *   to avoid fighting Vite HMR) the SW never activates, so `.ready`
 *   never resolves, the `.then` never fires, and the `new Notification`
 *   fallback was never reached. Foreground OS notifications were
 *   silently impossible.
 *
 *   Correct gate: `navigator.serviceWorker.controller` is the boolean
 *   "is an active SW currently controlling this page?". When false we
 *   go straight to the `new Notification(...)` constructor — which works
 *   on every modern browser when permission is granted, no SW required.
 *
 *   We also race `.ready` against a defensive timeout so a registered-
 *   but-stalled SW (rare; happens during install) can't hang the call
 *   forever; if `.ready` hasn't resolved in 800ms we fall back too.
 *
 * Two render paths (in order):
 *   1. SW.showNotification — preferred when controller is active. Plays
 *      nicely with the existing notificationclick handler in sw.js.
 *   2. `new Notification()` — used in dev, on first-page-load before SW
 *      activation, and as the safety net for any SW-path failure.
 */
export async function showLocalNotification(title, options = {}) {
  const tag = options.tag || `aniston-${Date.now()}`;
  const body = options.body || '';
  const url = options.url || '/';
  const icon = options.icon || '/icons/anistonlogo.png';
  const badge = options.badge || '/icons/anistonlogo.png';

  // Slice 10 — Desktop bridge path (P0 fix from the prior audit).
  //
  // When running inside the Electron desktop wrapper, prefer the main-
  // process notification adapter. It:
  //   - works regardless of `Notification.permission` (web permission
  //     state is unreliable for file:// renderers),
  //   - fires Teams-style cards via the custom notification window when
  //     available, falling back to Windows Toast XML on failure,
  //   - SURVIVES the main window being hidden to the tray (the renderer
  //     stays alive thanks to backgroundThrottling:false, but the OS
  //     toast originates in the main process where lifecycle is
  //     simpler).
  //
  // Slice 12 — Pass the user's current app theme so the notification
  // card matches. ThemeContext owns `darkMode` and mirrors it to
  // localStorage('darkMode'); reading directly from there here keeps
  // this service file pure (no React import). Unknown / missing →
  // notification window defaults to 'light' (Slice 12 requirement).
  let theme = 'light';
  try {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('darkMode') : null;
    if (stored === 'true') theme = 'dark';
  } catch { /* ignore — fall through to light */ }

  // The bridge returns { ok: true } on dispatch (incl. deduped) or
  // { ok: false, reason } on failure. We treat any non-ok response as
  // signal to fall through to the web paths below so the user is never
  // silently dropped.
  try {
    if (typeof window !== 'undefined'
        && window.anistonDesktop
        && typeof window.anistonDesktop.notify === 'function') {
      const result = await window.anistonDesktop.notify({ title, body, tag, url, theme });
      if (result && result.ok) return;
      safeLog.warn('[showLocalNotification] desktop bridge declined, falling back', result);
    }
  } catch (err) {
    safeLog.warn('[showLocalNotification] desktop bridge threw, falling back', err);
  }

  // Web paths beyond this point. They require Notification API + granted
  // permission. The desktop path above does NOT need either (it goes
  // through the main process).
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;

  const swOpts = {
    body, icon, badge, tag,
    renotify: false,
    data: { url, notificationId: options.notificationId || null },
  };

  // SW path — only attempted when an active controller is present. This
  // is the only reliable signal that `ready` will resolve in finite
  // time. Dev (no SW registered) goes straight to the fallback below.
  if (
    typeof navigator !== 'undefined'
    && navigator.serviceWorker
    && navigator.serviceWorker.controller
  ) {
    try {
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('sw-ready-timeout')), 800)
        ),
      ]);
      if (reg && typeof reg.showNotification === 'function') {
        await reg.showNotification(title, swOpts);
        return; // SW path succeeded — backend SW push (same tag) collapses.
      }
    } catch (err) {
      // SW path stalled or failed — surface the reason once, then fall
      // through to the constructor path so the user still sees the card.
      // eslint-disable-next-line no-console
      safeLog.warn('[showLocalNotification] SW path failed, falling back', err);
    }
  }

  // Fallback: direct `new Notification(...)`. Works without a SW —
  // critical for the localhost dev environment where the SW is
  // intentionally unregistered.
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
