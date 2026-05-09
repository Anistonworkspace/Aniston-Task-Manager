const CACHE_NAME = 'monday-aniston-__BUILD_TIMESTAMP__';
const OFFLINE_URL = '/offline.html';

const STATIC_ASSETS = [
  '/',
  '/offline.html',
  '/icons/anistonlogo.png',
];

// SW-local auth state. Clients (open tabs) push their auth state into the SW
// via postMessage so the SW can decide what body text to show on a push and
// whether to show the OS notification at all. This matters for the post-logout
// stale-push case — even if the backend deactivates the row, an in-flight
// push may already be on the wire.
//
// Default to `unknown` (treat as authenticated) so we never silently drop a
// notification meant for a still-logged-in user whose tab happens to be
// closed. Only when at least one client has explicitly told us "I logged
// out" do we flip to `loggedOut`.
let SW_AUTH_STATE = 'unknown'; // 'authenticated' | 'loggedOut' | 'unknown'
let SW_AUTH_AT = 0;

// Notification API paths the SW must NEVER cache. Returning a different
// user's notifications from cache after a logout/login is a privacy leak.
function isUserScopedApi(pathname) {
  if (!pathname.startsWith('/api/')) return false;
  return (
    pathname.startsWith('/api/notifications')
    || pathname.startsWith('/api/auth/me')
    || pathname.startsWith('/api/push/')
  );
}

// Install — cache static assets + IMMEDIATELY activate (no waiting)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  // Force immediate activation — don't wait for user to click update
  self.skipWaiting();
});

// Listen for SKIP_WAITING / AUTH_STATE messages.
//   - SKIP_WAITING: standard SW update gesture.
//   - AUTH_STATE:   { state: 'authenticated' | 'loggedOut' } — clients post
//     this on login and logout so the SW knows whether to render real push
//     bodies or the generic "sign in to view" card. We trust the most recent
//     client message: every tab pushes on auth change, and on logout each tab
//     posts `loggedOut` before tearing itself down.
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data) return;
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'AUTH_STATE' && (data.state === 'authenticated' || data.state === 'loggedOut')) {
    SW_AUTH_STATE = data.state;
    SW_AUTH_AT = Date.now();
    // On explicit logout, also drop any cached entries for user-scoped APIs so
    // a subsequent offline read can't replay the previous user's data.
    if (data.state === 'loggedOut') {
      caches.open(CACHE_NAME).then((cache) => cache.keys().then((reqs) => {
        reqs.forEach((req) => {
          try {
            const u = new URL(req.url);
            if (isUserScopedApi(u.pathname)) cache.delete(req);
          } catch { /* ignore */ }
        });
      })).catch(() => { /* ignore */ });
    }
  }
});

// Activate — delete ALL old caches, then claim all clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => {
          console.log('[SW] Deleting old cache:', key);
          return caches.delete(key);
        })
      );
    }).then(() => {
      // Take control of all open tabs immediately
      return self.clients.claim();
    }).then(() => {
      // Notify all clients to reload with the new version
      return self.clients.matchAll({ type: 'window' }).then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'SW_UPDATED', cacheName: CACHE_NAME });
        });
      });
    })
  );
});

// Fetch — network-first for EVERYTHING to prevent stale content
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Skip non-http(s) requests
  if (!url.protocol.startsWith('http')) return;

  // Skip socket.io requests
  if (url.pathname.startsWith('/socket.io')) return;

  // API requests: network-first with offline fallback.
  // Exception: user-scoped APIs (notifications, auth/me, push) MUST NEVER be
  // cached. Caching them lets a different user — or a logged-out user reading
  // an offline tab — see the previous user's data. We pass-through to network
  // and surface a 503 on offline rather than serving stale.
  if (url.pathname.startsWith('/api/')) {
    if (isUserScopedApi(url.pathname)) {
      event.respondWith(
        fetch(request).catch(() => new Response(
          JSON.stringify({ success: false, message: 'You are offline.' }),
          { headers: { 'Content-Type': 'application/json' }, status: 503 }
        ))
      );
      return;
    }
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          return caches.match(request).then((cached) => {
            return cached || new Response(JSON.stringify({ success: false, message: 'You are offline.' }), {
              headers: { 'Content-Type': 'application/json' },
              status: 503,
            });
          });
        })
    );
    return;
  }

  // Navigation requests: ALWAYS network-first (prevents stale index.html)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          return caches.match(request).then((cached) => {
            return cached || caches.match(OFFLINE_URL);
          });
        })
    );
    return;
  }

  // Static assets (JS/CSS with hashed filenames): network-first with cache fallback
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && (url.pathname.endsWith('.js') || url.pathname.endsWith('.css') || url.pathname.endsWith('.svg') || url.pathname.endsWith('.png') || url.pathname.endsWith('.woff2'))) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => {
        return caches.match(request).then((cached) => {
          if (cached) return cached;
          if (request.mode === 'navigate') return caches.match(OFFLINE_URL);
          return new Response('', { status: 503 });
        });
      })
  );
});

// Push notification handler.
// Browsers REQUIRE a user-visible notification on every push when
// userVisibleOnly:true is set (which we do at subscribe time). If we silently
// drop pushes the browser will revoke the subscription. So when the user is
// logged out we show a generic, non-revealing card and route the click to
// /login — the message body is NOT shown, preventing leakage of task titles
// or other details to a now-logged-out device.
//
// Auth check: at logout, every focused client tab clears sessionStorage AND
// calls /api/push/unsubscribe (which deactivates the row server-side, so the
// backend stops sending pushes here). But there's a small window between
// "user clicks logout" and "backend deactivates the row" where an in-flight
// push may already be on the wire. We additionally inspect the foreground
// clients to see if any of them is still authenticated; if not, we replace
// the body.
async function isAnyClientAuthenticated() {
  // Fast path: if the SW has been told explicitly, trust the latest signal
  // for the next 10 minutes (covers the post-logout stale-push window).
  if (SW_AUTH_STATE !== 'unknown' && Date.now() - SW_AUTH_AT < 10 * 60 * 1000) {
    return SW_AUTH_STATE === 'authenticated';
  }
  try {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (!all || all.length === 0) {
      // No open tabs — we cannot ask the page. Assume authenticated to avoid
      // accidentally hiding a notification arriving for a still-logged-in
      // user who just closed the tab. The backend has already deactivated
      // the row on logout, so this case is rare in practice.
      return true;
    }
    // Ask each client; at least one authenticated client is enough.
    const responses = await Promise.all(
      all.map((c) => new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = (e) => resolve(!!e.data?.authenticated);
        try { c.postMessage({ type: 'AUTH_CHECK' }, [channel.port2]); }
        catch { resolve(false); }
        // Don't hang forever if the page never responds.
        setTimeout(() => resolve(false), 300);
      }))
    );
    return responses.some(Boolean);
  } catch {
    return true; // fail open
  }
}

// Build a deep-link path from the notification entity. Prefer payload.url
// when the backend already computed it; otherwise compose from entityType +
// entityId + boardId so notification clicks reliably open the right place.
function deepLinkFor(data) {
  if (data && typeof data.url === 'string' && data.url.length > 0) return data.url;
  const t = data?.entityType;
  const id = data?.entityId;
  const boardId = data?.boardId;
  if (t === 'task' && id) {
    return boardId ? `/boards/${boardId}?taskId=${id}` : `/my-work?taskId=${id}`;
  }
  if (t === 'board' && id) return `/boards/${id}`;
  if (t === 'meeting') return '/meetings';
  if (t === 'access_request') return '/access-requests';
  if (t === 'help_request') return '/cross-team';
  if (t === 'dependency_request') return '/cross-team';
  return '/';
}

self.addEventListener('push', (event) => {
  let data = { title: 'Monday Aniston', body: 'You have a new notification' };
  try {
    data = event.data.json();
  } catch (e) {
    data.body = event.data?.text() || data.body;
  }

  // Visible diagnostic — Chrome's Application > Service Workers panel logs
  // this. Confirms the SW received the push at all (the most common
  // "OS notification doesn't fire" symptom is the push event never arriving
  // because backend isn't sending it).
  console.log('[SW Push] received:', {
    title: data.title,
    body: (data.body || '').slice(0, 60),
    notificationId: data.notificationId,
    entityType: data.entityType,
    entityId: data.entityId,
  });

  event.waitUntil((async () => {
    const authed = await isAnyClientAuthenticated();
    const title = authed ? (data.title || 'Monday Aniston') : 'Monday Aniston';
    const body = authed
      ? (data.body || data.message || 'New notification')
      : 'You have new activity. Sign in to view.';
    const url = authed ? deepLinkFor(data) : '/login';
    // Stable tag — prefer notification id over a generic 'default' so rapid
    // pushes don't silently collapse into one entry, and so a foreground
    // local-notification using the same id collapses with the OS push
    // (Chrome/Firefox/Edge dedupe by tag automatically).
    const tag = data.tag
      || (data.notificationId ? `notif-${data.notificationId}` : null)
      || (data.entityId ? `entity-${data.entityType || 'x'}-${data.entityId}` : `aniston-${Date.now()}`);

    try {
      await self.registration.showNotification(title, {
        body,
        icon: '/icons/anistonlogo.png',
        badge: '/icons/anistonlogo.png',
        tag,
        // renotify must be paired with a tag — set false so reusing the same
        // tag silently updates the existing notification rather than re-popping.
        renotify: false,
        data: { url, notificationId: data.notificationId || null },
        actions: authed ? (data.actions || []) : [],
      });
      console.log('[SW Push] showNotification ok, tag=%s authed=%s', tag, authed);
    } catch (err) {
      console.error('[SW Push] showNotification failed:', err && err.message);
    }
  })());
});

// Notification click handler — focus an existing tab when possible, otherwise
// open a new one. Falls back to '/' if the deep-link is somehow missing.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    try {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        if (!client.url || !client.url.includes(self.location.origin)) continue;
        try {
          await client.focus();
          // Some browsers ignore client.navigate() if the URL is on the same
          // origin but a different path; fall back to postMessage so the SPA
          // can route via React Router.
          if (typeof client.navigate === 'function') {
            try { await client.navigate(target); return; } catch { /* fall through */ }
          }
          try { client.postMessage({ type: 'NAVIGATE', url: target }); return; } catch { /* fall through */ }
        } catch { /* ignore — try next client */ }
      }
      await self.clients.openWindow(target);
    } catch (err) {
      // Last-ditch: open the root.
      try { await self.clients.openWindow('/'); } catch { /* ignore */ }
    }
  })());
});
