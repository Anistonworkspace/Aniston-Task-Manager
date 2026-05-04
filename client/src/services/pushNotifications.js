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
 */
export async function subscribeToPush() {
  if (!isPushSupported() || Notification.permission !== 'granted') return false;

  try {
    // Get VAPID public key from server
    const keyRes = await api.get('/push/vapid-key');
    const { publicKey, configured } = keyRes.data?.data || keyRes.data || {};
    if (!configured || !publicKey) return false;

    // Wait for service worker
    const registration = await navigator.serviceWorker.ready;

    // Check existing subscription
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      // Convert VAPID key to Uint8Array
      const applicationServerKey = urlBase64ToUint8Array(publicKey);
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
    }

    // Send subscription to server
    await api.post('/push/subscribe', { subscription: subscription.toJSON() });
    console.log('[Push] Subscribed to server push notifications');
    return true;
  } catch (err) {
    console.warn('[Push] Subscription failed:', err.message);
    return false;
  }
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
 * Show a local browser notification (when app is in foreground but tab is not focused)
 */
export function showLocalNotification(title, options = {}) {
  if (Notification.permission !== 'granted') return;
  if (document.hasFocus()) return;

  try {
    const notification = new Notification(title, {
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      tag: options.tag || 'aniston-hub',
      ...options,
    });

    notification.onclick = () => {
      window.focus();
      notification.close();
      if (options.url) window.location.href = options.url;
    };

    setTimeout(() => notification.close(), 8000);
  } catch (e) {
    // Fallback to service worker notification
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.ready.then((reg) => {
        reg.showNotification(title, {
          icon: '/favicon.svg',
          badge: '/favicon.svg',
          tag: options.tag || 'aniston-hub',
          body: options.body || '',
          data: { url: options.url || '/' },
        });
      });
    }
  }
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
