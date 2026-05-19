// Monday Aniston — Electron preload.
//
// The preload runs in a sandboxed context that has access to a small set of
// Electron APIs (ipcRenderer via contextBridge, process.argv) but no Node
// modules. Its jobs:
//
//   Slice 1: expose the runtime config the main process injected via
//            webPreferences.additionalArguments, so api.js and socket.js
//            in the renderer can synchronously read the correct backend URL.
//
//   Slice 3: expose two narrow IPC functions:
//     - notify(payload)       -> ipcRenderer.invoke('aniston:notify', payload)
//     - onNavigate(callback)  -> renderer subscribes to 'aniston:navigate'
//                                events fired by the main process after a
//                                notification click.
//
// Every IPC addition here MUST:
//   - Be the smallest possible function surface;
//   - Validate / clamp payloads on the preload side too (defense in depth;
//     main process re-validates);
//   - Be invoke-only (ipcRenderer.invoke / handle), never event-stream
//     unless absolutely required, to keep the renderer→main contract
//     unidirectional and request/response.

const { contextBridge, ipcRenderer } = require('electron');

// -------- Runtime config (slice 1) --------------------------------------

function readRuntime() {
  try {
    const arg = (process.argv || []).find(
      (a) => typeof a === 'string' && a.startsWith('--aniston-runtime=')
    );
    if (!arg) return null;
    const json = arg.slice('--aniston-runtime='.length);
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && parsed.isDesktop === true) {
      return parsed;
    }
  } catch { /* fall through */ }
  return null;
}

const runtime = readRuntime();

// -------- Notification bridge (slice 3) ---------------------------------

// Closure-scoped because Object.freeze on the exposed bridge would otherwise
// prevent us from mutating the registration. The freeze still applies to the
// outer surface so the renderer cannot replace methods on window.anistonDesktop.
let navigateCallback = null;

// Buffer for a single 'aniston:navigate' event that arrived before the
// renderer registered its onNavigate callback. This happens when:
//   - the renderer was destroyed (renderer crash) and the user clicked a
//     pending notification before the new renderer fully mounted;
//   - or in any other case where main calls webContents.send() before
//     react-router has wired up.
// We buffer at most ONE URL (the most recent wins). Multiple pending
// navigations are intentionally unsupported -- a notification click is a
// single user intent.
let pendingNavigateUrl = null;

ipcRenderer.on('aniston:navigate', (_event, payload) => {
  const url = payload && typeof payload.url === 'string' ? payload.url : null;
  if (!url) return;
  if (navigateCallback) {
    try { navigateCallback(url); }
    catch { /* renderer-side bug; swallow so preload stays healthy */ }
  } else {
    pendingNavigateUrl = url;
  }
});

/**
 * Renderer-side input clamp. The main process re-validates these strings
 * (sanitisation, URL guardrails, dedup) -- doing it here as well makes
 * mis-shaped payloads obvious at the renderer call site and keeps the IPC
 * wire small.
 */
function clampNotifyPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const title = typeof payload.title === 'string' ? payload.title.slice(0, 200) : '';
  if (!title) return null;
  return {
    title,
    body: typeof payload.body === 'string' ? payload.body.slice(0, 500) : '',
    tag: typeof payload.tag === 'string' && payload.tag.length > 0
      ? payload.tag.slice(0, 200)
      : undefined,
    url: typeof payload.url === 'string' && payload.url.startsWith('/')
      ? payload.url.slice(0, 1000)
      : undefined,
  };
}

function notify(rawPayload) {
  const safe = clampNotifyPayload(rawPayload);
  if (!safe) return Promise.resolve({ ok: false, reason: 'invalid-payload' });
  return ipcRenderer.invoke('aniston:notify', safe);
}

/**
 * Slice 6.2 — open Microsoft / SSO OAuth in an in-app child window.
 *
 * The renderer cannot create BrowserWindows itself (no node integration);
 * this IPC asks the main process to open the OAuth URL in a child window
 * that shares the desktop's persist:aniston session partition. The
 * promise resolves once the OAuth flow completes (Microsoft redirects
 * back to monday.anistonav.com with `?sso=success`) or the user closes
 * the child window. Validation of the URL happens on both sides: here we
 * reject anything that isn't a non-empty string, main re-validates that
 * the protocol is https.
 */
function openSso(authUrl) {
  if (typeof authUrl !== 'string' || authUrl.length === 0) {
    return Promise.resolve({ ok: false, reason: 'invalid-url' });
  }
  return ipcRenderer.invoke('aniston:open-sso', authUrl);
}

function onNavigate(cb) {
  if (typeof cb !== 'function') {
    // Allow null/undefined to clear an existing subscription.
    navigateCallback = null;
    return () => {};
  }
  navigateCallback = cb;
  // Replay any URL that arrived before the callback registered. Cleared
  // after the first delivery so a later re-registration doesn't replay
  // stale data.
  if (pendingNavigateUrl) {
    const url = pendingNavigateUrl;
    pendingNavigateUrl = null;
    try { cb(url); } catch { /* renderer-side bug; swallow */ }
  }
  return () => { if (navigateCallback === cb) navigateCallback = null; };
}

// -------- Expose to the renderer ----------------------------------------

if (runtime) {
  // Frozen surface -- the renderer cannot replace `notify` or `onNavigate`
  // with malicious shims. The functions themselves capture preload-side
  // closures; the renderer never gets a direct ipcRenderer handle.
  contextBridge.exposeInMainWorld(
    'anistonDesktop',
    Object.freeze({
      isDesktop: true,
      isPackaged: !!runtime.isPackaged,
      appVersion: typeof runtime.appVersion === 'string' ? runtime.appVersion : null,
      platform: typeof runtime.platform === 'string' ? runtime.platform : null,
      config: Object.freeze({
        apiBaseUrl: typeof runtime.apiBaseUrl === 'string' ? runtime.apiBaseUrl : null,
        socketUrl: typeof runtime.socketUrl === 'string' ? runtime.socketUrl : null,
      }),
      notify,
      onNavigate,
      openSso,
    })
  );
}
