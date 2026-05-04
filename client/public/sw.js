const CACHE_NAME = 'monday-aniston-__BUILD_TIMESTAMP__';
const OFFLINE_URL = '/offline.html';

const STATIC_ASSETS = [
  '/',
  '/offline.html',
  '/icons/anistonlogo.png',
];

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

// Listen for SKIP_WAITING message (fallback for older pattern)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
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

  // API requests: network-first with offline fallback
  if (url.pathname.startsWith('/api/')) {
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
  try {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (!all || all.length === 0) {
      // No open tabs — we cannot ask the page. Assume authenticated to avoid
      // accidentally hiding a notification arriving for a still-logged-in
      // user who just closed the tab. This bias is safe because:
      //   - logout deactivates the backend row, so further pushes don't come.
      //   - if the user truly logged out, they're not looking at the OS
      //     notification anyway.
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
        setTimeout(() => resolve(false), 250);
      }))
    );
    return responses.some(Boolean);
  } catch {
    return true; // fail open
  }
}

self.addEventListener('push', (event) => {
  let data = { title: 'Monday Aniston', body: 'You have a new notification' };
  try {
    data = event.data.json();
  } catch (e) {
    data.body = event.data?.text() || data.body;
  }

  event.waitUntil((async () => {
    const authed = await isAnyClientAuthenticated();
    const title = authed ? (data.title || 'Monday Aniston') : 'Monday Aniston';
    const body = authed
      ? (data.body || data.message || 'New notification')
      : 'You have new activity. Sign in to view.';
    const url = authed ? (data.url || '/') : '/login';

    return self.registration.showNotification(title, {
      body,
      icon: '/icons/anistonlogo.png',
      badge: '/icons/anistonlogo.png',
      tag: data.tag || 'default',
      data: { url },
      actions: authed ? (data.actions || []) : [],
    });
  })());
});

// Notification click handler
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.focus();
          client.navigate(url);
          return;
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
