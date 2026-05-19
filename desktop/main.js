// Monday Aniston — Electron main process.
//
// Slice 1 scope (delivered):
//   - Open a single window that loads either the Vite dev server (dev) or the
//     packaged Vite build (production).
//   - Pass the resolved API + Socket.io URLs into the renderer via the preload.
//   - Rewrite the outgoing Origin header on monday.anistonav.com requests when
//     packaged, so the production backend's CORS + origin-validation accept
//     them and httpOnly cookies bind to monday.anistonav.com. Documented in
//     CLAUDE.md and the slice-0 audit.
//   - Strict webPreferences (contextIsolation, no node, sandboxed).
//
// Slice 2 scope (delivered):
//   - System tray + context menu (Open / Refresh / Quit).
//   - Close (X) hides to tray on Windows/Linux; only "Quit" exits fully.
//   - Single source of truth `isQuitting` so the close intercept doesn't
//     fight the explicit quit path.
//   - `backgroundThrottling: false` keeps the renderer's socket.io connection
//     fully alive while the window is hidden (background throttling can
//     slow reconnect timers; the underlying WebSocket itself is not affected
//     but defence-in-depth here is cheap).
//
// Slice 3 scope (delivered):
//   - IPC channel `aniston:notify` (invoke). Renderer calls
//     window.anistonDesktop.notify({...}); main process validates and shows
//     a native Electron Notification.
//   - Click handler on the notification focuses the main window AND sends
//     `aniston:navigate` to the renderer with the SPA path to open. If the
//     window was just (re)created and is still loading, the navigate event
//     is deferred until did-finish-load so the renderer-side listener has
//     a chance to register first.
//
// Slice 5 scope (this commit):
//   - AppUserModelId set before any window/notification is created. Windows
//     uses this to group toast notifications under the app, enable taskbar
//     pinning, and (in future) host toast actions. Hard-coded to a stable
//     reverse-DNS id so the OS keeps the same identity across installer
//     versions -- changing this would create a parallel app identity and
//     orphan the user's existing pinned shortcuts.
//   - Icon and client/index.html paths now go through desktop/paths.js so
//     they resolve to `process.resourcesPath` in a real packaged build
//     while still finding the in-repo paths during dev / FORCE_PROD mode.
//
// Out of scope for slice 5 (still future):
//   - Code signing (the v1 installer is unsigned -- Windows SmartScreen
//     will warn on first install; documented in desktop/README.md).
//   - Auto-launch on Windows login (a future per-user toggle).
//   - Auto-updater.
//   - Unread-count badge overlay on the tray icon.
//   - Windows Toast action buttons / inline reply.

const { app, BrowserWindow, session, shell, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL, fileURLToPath } = require('url');
const { resolveConfig } = require('./runtimeConfig');
const { createTray, destroyTray, showHideToTrayHint } = require('./tray');
const { notify } = require('./notifications');
const { iconsRoot, clientIndexHtml } = require('./paths');
const updater = require('./updater');
const notificationWindow = require('./notificationWindow');
const sharedLog = require('./log');

// Slice 6 diagnostic logging. Gated by env var so packaged production users
// never see DevTools or log files. Two flags:
//   ANISTON_DESKTOP_DEBUG=1   -> auto-open DevTools and write a startup log
//   ANISTON_DESKTOP_LOG=1     -> only write the log (no DevTools popup)
// The log file lives next to the user's Electron userData so we don't litter
// the install directory. Token/cookie redaction is unnecessary here because
// we only log paths, error codes, and console levels.
const DESKTOP_DEBUG = process.env.ANISTON_DESKTOP_DEBUG === '1';
const DESKTOP_LOG = DESKTOP_DEBUG || process.env.ANISTON_DESKTOP_LOG === '1';
// Slice 11 — diag() is now backed by the shared log module so other
// desktop submodules (notifications.js, notificationWindow.js) can
// write to the same desktop.log file via require('./log').
sharedLog.setDiagEnabled(DESKTOP_LOG);
const diag = sharedLog.diag;

// Stable AppUserModelId. Must be set BEFORE any window/notification is
// created -- otherwise Windows generates a synthetic per-EXE ID and toast
// grouping silently falls back to "exe path" semantics, which breaks once
// the installer's path changes between versions. The format is reverse-DNS
// + app name; the Aniston Technologies LLP `aniston.com` legal domain
// matches the email convention already in use elsewhere in the codebase.
app.setAppUserModelId('com.aniston.monday');

// Single-instance lock. Prevents two Electron processes from racing on the
// shared `persist:aniston` session partition (cookie storage, IndexedDB) and
// double-counting toward the backend's single-active-session enforcement.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const isPackaged = app.isPackaged || process.env.ANISTON_FORCE_PROD === '1';
const runtime = resolveConfig(isPackaged);

const PROD_API_HOSTNAME = 'monday.anistonav.com';
const PROD_ORIGIN = 'https://monday.anistonav.com';

let mainWindow = null;

// Single source of truth for the "user really wants to exit" intent. Set by:
//   - the tray menu's Quit item (via quitApp() → app.quit())
//   - the `before-quit` event (defensive — covers Ctrl+Q, OS shutdown, etc.)
// Read by the window's `close` handler so it knows whether to preventDefault
// (hide-to-tray) or allow the default destroy (real quit).
let isQuitting = false;

function buildRuntimePayload() {
  return JSON.stringify({
    isDesktop: true,
    isPackaged,
    apiBaseUrl: runtime.apiBaseUrl,
    socketUrl: runtime.socketUrl,
    appVersion: app.getVersion(),
    platform: process.platform,
  });
}

function installOriginRewrite() {
  // Only applies in packaged mode. Dev mode hits localhost:5000 from a
  // renderer at localhost:3000, an origin the backend already allows by
  // default — no rewrite needed and we want dev to surface real CORS
  // errors so misconfiguration is visible.
  if (!isPackaged) return;
  const ses = session.fromPartition('persist:aniston');
  ses.webRequest.onBeforeSendHeaders(
    { urls: [`*://${PROD_API_HOSTNAME}/*`] },
    (details, callback) => {
      const headers = { ...details.requestHeaders };
      headers['Origin'] = PROD_ORIGIN;
      callback({ requestHeaders: headers });
    }
  );
}

/**
 * Rewrite Set-Cookie headers from the production backend so they survive
 * cross-site fetches from the file:// renderer.
 *
 * Why this is required (Slice 6.2 — fix data-loads-fail-after-login)
 * ------------------------------------------------------------------
 * The renderer is loaded from `file://`. The API lives at
 * `https://monday.anistonav.com`. In Chromium that pair is treated as
 * "cross-site" — and cookies with the default `SameSite=Lax` (or
 * `SameSite=Strict`) attribute are NOT attached to cross-site XHRs. The
 * symptom in production: POST `/auth/login` succeeds (response sets the
 * cookies, browser stores them), but every subsequent GET `/tasks`,
 * `/boards`, `/notifications` etc. arrives at the server with no cookie
 * and 401s. The renderer's auth state is already populated from the login
 * response body, so the user sees "Logged in as Super Admin" in the
 * sidebar while every data fetch fails with a red toast.
 *
 * We can't change the backend's cookie defaults (the web app relies on
 * `SameSite=Lax` as a CSRF defence). So we rewrite the cookies for the
 * desktop session only: anything the server sends with `SameSite=Lax|Strict`
 * is rewritten to `SameSite=None; Secure`. `None` requires `Secure`, and
 * the destination is HTTPS, so the cookies still travel only over a TLS
 * channel.
 *
 * Scope is restricted to the production hostname so we don't accidentally
 * touch cookies for unrelated origins (Google fonts, Microsoft OAuth, etc.).
 */
function installCookieSameSiteRewriter() {
  if (!isPackaged) return;
  const ses = session.fromPartition('persist:aniston');
  ses.webRequest.onHeadersReceived(
    { urls: [`*://${PROD_API_HOSTNAME}/*`] },
    (details, callback) => {
      const responseHeaders = details.responseHeaders || {};
      // `Set-Cookie` can appear under any case — Node normalises to lower
      // case but Electron forwards whatever the server sent.
      const setCookieKey = Object.keys(responseHeaders).find(
        (k) => k.toLowerCase() === 'set-cookie'
      );
      if (!setCookieKey) {
        callback({});
        return;
      }
      const original = responseHeaders[setCookieKey];
      if (!Array.isArray(original) || original.length === 0) {
        callback({});
        return;
      }
      const rewritten = original.map((cookie) => {
        let next = cookie;
        // Replace any existing SameSite= value with None, or append it.
        if (/;\s*samesite\s*=/i.test(next)) {
          next = next.replace(/;\s*samesite\s*=\s*[^;]+/i, '; SameSite=None');
        } else {
          next = next + '; SameSite=None';
        }
        // SameSite=None requires Secure. The destination is HTTPS so this
        // is always safe; we only add it if not already present.
        if (!/;\s*secure(\s*;|\s*$)/i.test(next)) {
          next = next + '; Secure';
        }
        return next;
      });
      const newHeaders = { ...responseHeaders, [setCookieKey]: rewritten };
      callback({ responseHeaders: newHeaders });
    }
  );
}

/**
 * file:// public-asset rewriter.
 *
 * The client bundle was built with Vite `base: './'` so its OWN assets
 * (the hashed index-*.js / index-*.css under client-dist/assets/) load via
 * './assets/...' and resolve correctly relative to index.html.
 *
 * BUT components scattered across the app reference Vite "public" assets
 * with absolute paths like `<img src="/icons/anistonlogo.png">`. On a
 * normal HTTPS origin those paths resolve to https://host/icons/...; under
 * file:// they resolve to file:///<drive>:/icons/... — which is the drive
 * root, not the directory holding index.html. The image 404s and the user
 * sees a broken icon on Login, in the sidebar, the loader, etc.
 *
 * Instead of editing 7+ source files to thread a base-URL prefix through
 * every <img> and CSS reference, we intercept those requests at the
 * Electron layer and redirect them into the client-dist directory the
 * document already lives in. The rewrite is purely additive: web is
 * unaffected (it never goes through Electron's webRequest), and any
 * request that already points inside client-dist passes through unchanged.
 */
function installPublicAssetRewriter() {
  // Only when the renderer is loading via file://. In dev (Vite dev server
  // at http://localhost:3000) the asset paths resolve correctly already.
  if (!isPackaged) return;
  const ses = session.fromPartition('persist:aniston');
  const docDirRaw = path.dirname(clientIndexHtml()); // ...\client-dist

  // Windows path comparison is a minefield in Electron:
  //   - `Monday Aniston` (space) vs `Monday%20Aniston` in the URL.
  //   - Long Names (`Monday Aniston`) vs 8.3 short names (`MONDAY~1`,
  //     `ANISTO~2`) — Electron's `process.resourcesPath` may return either
  //     form depending on whether the parent directory had a long name,
  //     and Chromium may fetch the OTHER form. We saw this on a real
  //     install where `aniston-user` came through as `ANISTO~2`.
  //   - Case differences (`Programs` vs `programs`).
  //
  // String-comparing file:// URLs directly fails for all three. The robust
  // thing is to (a) canonicalise both paths to their realpath (Node's
  // `fs.realpathSync` expands 8.3 short names to their long-name form on
  // Windows), and (b) compare case-insensitively. The kernel does the
  // canonical resolution for us; we don't try to second-guess every
  // encoding edge case.
  function canonicalizePath(p) {
    try { return fs.realpathSync.native(p).toLowerCase(); }
    catch {
      try { return fs.realpathSync(p).toLowerCase(); }
      catch { return p.toLowerCase(); }
    }
  }
  const docDirCanon = canonicalizePath(docDirRaw);
  // URL form (with %20 / %7E encoding) used to build redirect targets.
  // Cached against the RAW dir — Chromium accepts either short or long
  // name in a file:// URL because the kernel still resolves the file.
  const docDirUrl = pathToFileURL(docDirRaw).href;
  const docDirUrlPrefix = docDirUrl.endsWith('/') ? docDirUrl : docDirUrl + '/';

  function isInsideDocDir(urlString) {
    let urlPath;
    try {
      urlPath = fileURLToPath(urlString);
    } catch {
      return false; // unparsable file:// URL — definitely not ours
    }
    const urlPathCanon = canonicalizePath(urlPath);
    // Equal (the index.html itself) or strictly-inside (assets, icons).
    if (urlPathCanon === docDirCanon) return true;
    return urlPathCanon.startsWith(docDirCanon + path.sep);
  }

  ses.webRequest.onBeforeRequest({ urls: ['file:///*'] }, (details, callback) => {
    const url = details.url;
    // Pass through requests already rooted inside the client-dist directory.
    if (isInsideDocDir(url)) {
      callback({});
      return;
    }
    // Match `file:///<drive>:/<first-segment>/<rest>` — drive-root absolute
    // references from `<img src="/icons/...">` and similar. We only rewrite
    // when the request looks like a public-asset path (not, say, a system
    // file URL the OS may emit for an unrelated reason). The match captures
    // everything after `<drive>:/` so we can splice it onto the doc dir.
    const m = url.match(/^file:\/\/\/[A-Za-z]:\/([^/]+(?:\/[^?#]*)?)(\?.*)?$/);
    if (!m) {
      callback({});
      return;
    }
    const restPath = m[1];
    const redirectURL = `${docDirUrlPrefix}${restPath}${m[2] || ''}`;
    diag(`asset-rewrite ${url} -> ${redirectURL}`);
    callback({ redirectURL });
  });
}

/**
 * Slice 7 — wipe monday.anistonav.com cookies when the user signs out.
 *
 * Symptom this fixes: user clicks Sign Out → app jumps to login page →
 * user closes the app → user re-opens the app → they're already signed
 * in again. Cause: the backend's POST /api/auth/logout response DOES
 * include `Set-Cookie: aniston_at=; Max-Age=0` clearings, but the
 * refresh-token cookie can outlive that and get re-validated on next
 * launch's /auth/refresh. Explicit jar wipe forces a clean exit.
 *
 * Slice 7.1 — race-condition fix (SSO sign-in regression).
 *
 * `Login.jsx` calls `logout()` BEFORE `openSso()` whenever the user
 * clicks "Sign in with Microsoft". That fires `POST /api/auth/logout`
 * which triggers this wipe. The wipe used to run async-immediately,
 * which raced with the OAuth callback's Set-Cookie response — the
 * fresh auth cookies set by OAuth were being deleted by the still-in-
 * flight wipe, and the main window's reload then found an empty jar
 * → /auth/me 401 → stay-on-login.
 *
 * Two guards now prevent that race:
 *
 *   1. `ssoInProgress` is flipped to `true` as early as we can detect
 *      an SSO flow — when the renderer's `/api/auth/microsoft` request
 *      goes out (this is the second of three requests in
 *      handleMicrosoftSSO, after `logout()` and before `openSso()`).
 *      The flag stays true through the popup lifecycle and for an
 *      extra 10 seconds after the popup closes.
 *
 *   2. The wipe is **deferred by 3 seconds**. The /auth/logout
 *      response always lands a few hundred ms before the user has
 *      finished interacting with the Microsoft account picker, so by
 *      3 seconds after logout response the SSO flow is firmly in
 *      progress and ssoInProgress is true. The deferred wipe sees
 *      the flag and skips. For a genuine user-initiated sign-out
 *      (no SSO follows), 3 seconds is well within the user's
 *      tolerance — the navigation away from the app already happened
 *      via React Router's redirect-to-login, the cookie cleanup
 *      after that is invisible.
 */
let ssoInProgress = false;
function markSsoStart(source) {
  ssoInProgress = true;
  diag(`sso-guard: ssoInProgress=true (from ${source})`);
}
function markSsoEnd() {
  // Keep the flag set for an additional grace window so any final
  // post-OAuth /auth/* requests don't race with a wipe scheduled
  // before SSO began.
  setTimeout(() => {
    ssoInProgress = false;
    diag('sso-guard: ssoInProgress=false');
  }, 10000);
}

function installLogoutCookieWipe() {
  if (!isPackaged) return;
  const ses = session.fromPartition('persist:aniston');

  // Early-detect an SSO flow: the renderer's call to GET /auth/microsoft
  // is the second request in the SSO chain (logout → microsoft → openSso).
  // Flipping the flag here ensures the 3-second deferred wipe below
  // (scheduled when /auth/logout response arrives) sees the flag and
  // bails out.
  ses.webRequest.onBeforeRequest(
    { urls: [`*://${PROD_API_HOSTNAME}/api/auth/microsoft*`] },
    (_details, callback) => {
      markSsoStart('webRequest /auth/microsoft');
      callback({});
    }
  );

  ses.webRequest.onCompleted(
    { urls: [`*://${PROD_API_HOSTNAME}/api/auth/logout*`] },
    (details) => {
      // Server may respond 200 or 204; either is "logout succeeded".
      // Anything 4xx/5xx means the cookies are probably still needed,
      // so we leave them alone.
      if (details.statusCode < 200 || details.statusCode >= 300) return;
      diag(`logout: detected /auth/logout status=${details.statusCode} — deferring wipe 3s`);
      setTimeout(async () => {
        if (ssoInProgress) {
          diag('logout: SSO in progress — skipping deferred wipe (would have raced new OAuth cookies)');
          return;
        }
        try {
          const cookies = await ses.cookies.get({ domain: PROD_API_HOSTNAME });
          for (const c of (cookies || [])) {
            const bare = (c.domain || '').replace(/^\./, '');
            if (!bare) continue;
            const url = `https://${bare}${c.path || '/'}`;
            try { await ses.cookies.remove(url, c.name); }
            catch (err) { diag(`logout: remove ${c.name} failed: ${err && err.message}`); }
          }
          diag(`logout: wiped ${cookies.length} cookies for ${PROD_API_HOSTNAME}`);
        } catch (err) {
          diag(`logout: cookie wipe failed: ${err && err.message ? err.message : err}`);
        }
      }, 3000);
    }
  );
}

function installRequestTracer() {
  if (!DESKTOP_LOG) return;
  const ses = session.fromPartition('persist:aniston');
  ses.webRequest.onCompleted({ urls: ['*://*/*', 'file:///*'] }, (details) => {
    diag(`req-completed status=${details.statusCode} type=${details.resourceType} url=${details.url}`);
  });
  ses.webRequest.onErrorOccurred({ urls: ['*://*/*', 'file:///*'] }, (details) => {
    diag(`req-error err=${details.error} type=${details.resourceType} url=${details.url}`);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    title: 'Monday Aniston',
    // Slice 5: window icon goes through the paths helper so packaged builds
    // pick it up from process.resourcesPath/icons/ (where extraResources
    // puts it) and dev/FORCE_PROD reads from the in-repo client/public/icons/.
    icon: path.join(iconsRoot(), 'icon-512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition: 'persist:aniston',
      // Slice 2: keep the renderer fully active when the window is hidden
      // to the tray. Chromium's default background throttling slows timers
      // for hidden windows; WebSocket frames themselves are not throttled,
      // but socket.io's reconnect timer + the burst-dispatcher's setTimeout
      // are. Disabling throttling keeps the notification pipeline snappy.
      backgroundThrottling: false,
      // additionalArguments are appended to process.argv of the renderer
      // process — the preload reads its `--aniston-runtime=...` entry to
      // know what URLs to expose to the page. This avoids a startup IPC
      // round-trip; the value is available synchronously when api.js /
      // socket.js load.
      additionalArguments: [`--aniston-runtime=${buildRuntimePayload()}`],
    },
  });

  // Hide the default Alt-menu in packaged builds. Dev keeps it so devtools
  // shortcuts (Ctrl+Shift+I) still work without extra wiring.
  if (isPackaged) Menu.setApplicationMenu(null);

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Slice 6.3 — recover from a dead / hung renderer instead of leaving
  // the user staring at a blank white window after a re-open.
  //
  // Pattern observed: user clicks the X (window hides to tray), system
  // is under memory pressure for a while, Chromium kills the hidden
  // renderer to reclaim RAM, user later clicks the tray icon, the
  // window shows but the renderer is gone — result is a blank white
  // surface that only Task Manager can clear. We handle two crash
  // paths defensively:
  //
  //   - render-process-gone fires for crash/oom/killed/launchFailed/
  //     integrity-failure exits. We attempt one immediate webContents
  //     reload. If the reload itself throws (very rare), the next
  //     showMainWindow() call below will see isCrashed() and try again.
  //
  //   - unresponsive fires when the renderer's event loop has been
  //     stuck for several seconds (e.g. an infinite loop or a stuck
  //     fetch waiting on a dead socket). Force-crashing the renderer
  //     here turns the silent hang into a render-process-gone event,
  //     which the handler above then recovers from. The alternative
  //     is the user is stuck with a frozen window forever.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      diag(`auto-recover: render-process-gone reason=${details && details.reason}; reloading`);
      mainWindow.webContents.reload();
    } catch { /* next showMainWindow() will retry */ }
  });
  mainWindow.on('unresponsive', () => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      diag('auto-recover: renderer unresponsive; forcing crash for reload');
      mainWindow.webContents.forcefullyCrashRenderer();
    } catch { /* swallow — render-process-gone path is the actual recovery */ }
  });

  // Slice 6 diagnostic taps. All gated by the debug env vars so production
  // users never see them. We capture:
  //   - did-fail-load: any failed file:// or http(s) fetch the renderer tried
  //   - render-process-gone: renderer crash details
  //   - preload-error: preload throwing on load
  //   - console-message: renderer console.* lines (level + line + source)
  //   - unhandled exceptions / rejections via webContents
  if (DESKTOP_LOG) {
    mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      diag(`did-fail-load main=${isMainFrame} code=${errorCode} desc=${errorDescription} url=${validatedURL}`);
    });
    mainWindow.webContents.on('did-finish-load', () => {
      diag(`did-finish-load url=${mainWindow.webContents.getURL()}`);
    });
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
      diag(`render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
    });
    mainWindow.webContents.on('preload-error', (_e, preloadPath, err) => {
      diag(`preload-error path=${preloadPath} err=${err && err.message ? err.message : err}`);
    });
    mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      const lvl = ['verbose', 'info', 'warn', 'error'][level] || `lvl${level}`;
      diag(`renderer-console[${lvl}] ${message}  (at ${sourceId}:${line})`);
    });
  }
  if (DESKTOP_DEBUG) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Lock down navigation. The renderer must not be able to navigate away
  // from our own content. Any link clicks that point at external origins
  // open in the user's default browser via shell.openExternal.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        shell.openExternal(url);
      }
    } catch { /* ignore malformed url */ }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    let u;
    try { u = new URL(url); }
    catch { event.preventDefault(); return; }
    const allowed =
      u.protocol === 'file:' ||
      (!isPackaged && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) ||
      (isPackaged && u.hostname === PROD_API_HOSTNAME);
    if (!allowed) {
      event.preventDefault();
      if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(url);
    }
  });

  if (isPackaged) {
    // Slice 5: clientIndexHtml() resolves to <install>/resources/client-dist/
    // in a real packaged build (where electron-builder's extraResources put
    // the React bundle) and to client/dist/ in the dev source tree when
    // ANISTON_FORCE_PROD=1 is used for prod-URL simulation.
    const indexPath = clientIndexHtml();
    diag(`packaged mode: indexPath=${indexPath} exists=${fs.existsSync(indexPath)}`);
    diag(`resourcesPath=${process.resourcesPath}`);
    diag(`iconsRoot=${iconsRoot()}`);
    mainWindow.loadFile(indexPath).catch((err) => {
      diag(`loadFile rejected: ${err && err.message ? err.message : err}`);
      console.error('[Aniston Desktop] failed to load packaged index.html:', err);
    });
  } else {
    const devUrl = 'http://localhost:3000';
    const tryLoad = () => {
      mainWindow.loadURL(devUrl).catch(() => { /* did-fail-load handles retry */ });
    };
    tryLoad();
    // Vite may not be up yet — retry every second on connection-refused.
    mainWindow.webContents.on('did-fail-load', (_e, errorCode) => {
      const isConnError = errorCode === -102 // CONNECTION_REFUSED
        || errorCode === -105 // NAME_NOT_RESOLVED
        || errorCode === -106 // INTERNET_DISCONNECTED
        || errorCode === -109; // ADDRESS_UNREACHABLE
      if (isConnError) setTimeout(tryLoad, 1000);
    });
  }

  // Slice 2: close-to-tray. Intercept the close gesture (X button, Alt-F4,
  // shell-driven close) and hide the window instead of destroying it. The
  // ONLY exit path is the tray's "Quit" item (or the OS killing the process),
  // both of which set `isQuitting = true` before the close event fires.
  // macOS keeps the standard "hide on close, quit via Cmd-Q" platform
  // convention — the close intercept there would be redundant.
  mainWindow.on('close', (event) => {
    if (isQuitting) return; // fall through → window destroys, app shuts down
    if (process.platform === 'darwin') return; // platform convention
    event.preventDefault();
    mainWindow.hide();
    showHideToTrayHint();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// Helper used by tray actions and second-instance handler. Restores the
// window from any combination of (hidden, minimised, unfocused) and brings
// it to the foreground. Recreates the window if it was destroyed.
//
// Slice 6.3 — defensive recovery paths for the "white screen after
// re-open" bug. Three things can put the window into a state where a
// plain `.show()` produces a blank surface:
//   1. mainWindow is null (the close handler never ran but createWindow's
//      'closed' handler did — possible on Ctrl+Alt+Del kill of the
//      renderer process).
//   2. mainWindow.isDestroyed() — Electron freed the native window object
//      but our reference is stale.
//   3. webContents has crashed — the renderer process died while hidden
//      (Chromium reaps hidden renderers under memory pressure). The
//      window object is still valid, but its content is gone.
//
// We rebuild from scratch in (1)/(2) and reload the renderer in (3).
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = null;
    createWindow();
    return;
  }
  try {
    const wc = mainWindow.webContents;
    if (wc && typeof wc.isCrashed === 'function' && wc.isCrashed()) {
      diag('showMainWindow: webContents crashed — reloading before show');
      wc.reload();
    }
  } catch { /* fall through and try to show anyway */ }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function refreshMainWindow() {
  if (!mainWindow) return;
  try { mainWindow.webContents.reload(); }
  catch { /* renderer already gone */ }
}

function quitApp() {
  // Set the flag BEFORE app.quit() so the imminent close event sees it. This
  // is the one place that flips us out of close-to-tray mode by intent.
  isQuitting = true;
  app.quit();
}

/**
 * Slice 6.7 — "Clear data & sign out" recovery action.
 *
 * Nuclear-option for stuck states (infinite loading, stale cookies, half-
 * loaded session, anything else that survives a normal reload). Wipes the
 * persist:aniston session entirely, then reloads the renderer so the user
 * starts at the login page with an empty cookie jar.
 *
 * Storages cleared:
 *   - cookies (httpOnly auth cookies, anything else)
 *   - localStorage / sessionStorage (font-size pref, legacy tokens)
 *   - indexedDB (none used currently but kept for future-proofing)
 *   - serviceWorkers (none in desktop, but safe to wipe)
 *   - cacheStorage / shadercache / appcache (any cached responses)
 *
 * Not cleared: the diagnostic log file (lives outside the partition).
 */
async function clearAppData() {
  diag('clearAppData: wiping persist:aniston session');
  try {
    const ses = session.fromPartition('persist:aniston');
    await ses.clearStorageData({
      storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'shadercache', 'websql'],
    });
    diag('clearAppData: storage cleared');
  } catch (err) {
    diag(`clearAppData: clearStorageData failed: ${err && err.message ? err.message : err}`);
  }
  // Make sure the user actually sees the result. Open the window if hidden,
  // then reload — the renderer will land on /login with no cookies.
  showMainWindow();
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.reload();
    }
  } catch (err) {
    diag(`clearAppData: reload failed: ${err && err.message ? err.message : err}`);
  }
}

/**
 * Send a SPA-route hint to the renderer. Used after a notification click so
 * the React Router lands on the linked task / board / meeting / etc.
 *
 * Race-condition guard: when the user clicks a notification AFTER the
 * renderer has been destroyed (e.g. renderer crash followed by tray-Open),
 * showMainWindow() creates a fresh window. Its webContents is still loading
 * when this function runs, which means the preload's IPC listener may not
 * be live yet and a raw .send() would drop the message on the floor. We
 * defer to did-finish-load so the preload has time to subscribe.
 */
function navigateRenderer(url) {
  if (isQuitting) return;
  if (!mainWindow) return;
  const wc = mainWindow.webContents;
  const send = () => {
    try { wc.send('aniston:navigate', { url }); }
    catch { /* renderer already gone */ }
  };
  if (wc.isLoading()) {
    wc.once('did-finish-load', send);
  } else {
    send();
  }
}

/**
 * Slice 6.2 — Microsoft SSO inside an in-app child window.
 *
 * Why this exists
 * ---------------
 * Login.jsx normally does `window.location.href = authUrl` to navigate the
 * renderer to Microsoft's OAuth page. On the web that works (the renderer
 * lives at the same origin as the API, so the cookies Microsoft's callback
 * sets are visible). In the packaged desktop app the renderer is loaded
 * via `file://` — `will-navigate` blocks the OAuth URL as cross-origin and
 * opens it externally in the user's default browser. Microsoft completes
 * the auth flow IN THE BROWSER and the cookies are set in the BROWSER's
 * cookie jar, not in Electron's `persist:aniston` session. The desktop
 * window keeps polling /auth/login/pending-sso with no cookies → sees
 * nothing → sits on "Signing in with Microsoft..." forever.
 *
 * Fix: when the renderer detects desktop mode it invokes this IPC instead
 * of touching window.location. We open the OAuth flow in a CHILD
 * BrowserWindow that shares the same `persist:aniston` session partition
 * as the main window — so every cookie Microsoft's callback sets ends up
 * exactly where the main window can read it. When the child navigates back
 * to `monday.anistonav.com` (the OAuth callback target) with `?sso=success`
 * we close it and tell the main window to re-run its auth probe.
 */
ipcMain.handle('aniston:open-sso', async (_event, rawAuthUrl) => {
  if (typeof rawAuthUrl !== 'string' || rawAuthUrl.length === 0) {
    return { ok: false, reason: 'invalid-url' };
  }
  let parsed;
  try { parsed = new URL(rawAuthUrl); }
  catch { return { ok: false, reason: 'invalid-url' }; }
  // Only allow https. Microsoft / Google / any future OAuth provider will
  // always be https; refusing other schemes blocks the obvious shape of a
  // tampered "open arbitrary file://" attack via a hostile preload payload.
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'not-https' };
  }
  if (!mainWindow) return { ok: false, reason: 'no-main-window' };

  // Slice 7.1 — belt-and-suspenders SSO flag. The webRequest hook on
  // /auth/microsoft (in installLogoutCookieWipe above) already sets
  // ssoInProgress before this IPC fires, but flip it again here so a
  // future code path that opens the SSO window without going through
  // the renderer's api.get('/auth/microsoft') still benefits from the
  // logout-wipe skip.
  markSsoStart('openSso IPC');

  // Slice 6.8 — wipe any pre-existing auth cookies for our backend
  // BEFORE the OAuth flow starts. If the user is "logged out" in the
  // UI sense but the cookies are still in the persist:aniston jar
  // (e.g. our backend's /auth/logout didn't fire, or it fired but
  // didn't clear all cookies for some session-conflict edge case),
  // the backend would receive the popup's `/auth/microsoft/callback`
  // request with a still-valid session cookie and short-circuit
  // straight to "you're already logged in as <previous user>" instead
  // of finalising the OAuth as the newly-selected account. Wiping
  // ensures the backend sees the OAuth callback as a brand-new login.
  //
  // Done HERE (before the Promise executor below) so we can use
  // `await` cleanly — the executor passed to `new Promise()` is a
  // plain function, not async, so awaiting inside it is a syntax
  // error.
  try {
    const preSes = session.fromPartition('persist:aniston');
    const stale = await preSes.cookies.get({ domain: PROD_API_HOSTNAME });
    for (const c of (stale || [])) {
      const bare = (c.domain || '').replace(/^\./, '');
      if (!bare) continue;
      const url = `https://${bare}${c.path || '/'}`;
      try { await preSes.cookies.remove(url, c.name); }
      catch (err) { diag(`sso: cookie remove ${c.name} failed: ${err && err.message}`); }
    }
    if (stale && stale.length) {
      diag(`sso: cleared ${stale.length} pre-existing cookies for ${PROD_API_HOSTNAME}`);
    }
  } catch (err) {
    diag(`sso: pre-flight cookie wipe failed: ${err && err.message ? err.message : err}`);
  }

  // Slice 6.8 — force the Microsoft account picker every time SSO is
  // initiated from desktop.
  //
  // Microsoft maintains its OWN session cookies on login.microsoftonline.com,
  // entirely separate from our backend's session. After the user signs in
  // once, those Microsoft cookies cache the account — and every subsequent
  // OAuth round-trip auto-completes as the SAME account, with no UI prompt.
  // That's why "I signed in once as Super, now every SSO attempt logs me
  // back in as Super, even after signing out of our app."
  //
  // The standard fix is the OAuth `prompt=select_account` parameter:
  // Microsoft shows the account-picker dialog with the cached account(s)
  // plus a "Use another account" link. The user can confirm the existing
  // account OR switch to a different one without first wiping Microsoft's
  // session cookies.
  //
  // We modify the URL here (rather than asking the backend to include the
  // param) because (a) the backend is shared with the web app, where the
  // current "auto-complete with cached account" UX is fine, and (b) this
  // is desktop-specific behaviour. If `prompt` is already present we
  // respect the backend's choice and don't override.
  try {
    if (!parsed.searchParams.has('prompt')) {
      parsed.searchParams.set('prompt', 'select_account');
      diag(`sso: added prompt=select_account to authUrl`);
    }
  } catch { /* malformed URL — handled by the new URL() throw above */ }
  rawAuthUrl = parsed.toString();

  return new Promise((resolve) => {
    let resolved = false;
    let ssoWin = null;
    // Captured by maybeFinishOnNav on every navigation so the
    // `closed` handler can do a URL-based last-resort check after
    // webContents is gone.
    let lastSeenUrl = null;

    // Slice 8 — DETERMINISTIC SSO completion detection.
    //
    // History of approaches and why each was insufficient:
    //   - URL pattern matching for `?sso=success`: lost the race when the
    //     in-page Login.jsx replaceState'd the query string off the URL.
    //   - `session.cookies.on('changed')`: cookie events did not fire
    //     reliably across Electron versions / cookie domain shapes.
    //   - URL-heuristic "past-login" detection + cookie-jar polling: the
    //     popup's URL inside React Router could pass /login without the
    //     cookies actually being committed yet, and the cookie poll's
    //     "resolve {ok:true} anyway after timeout" branch silently
    //     reported success when /auth/me would have 401'd. That is the
    //     exact failure mode that produced the "popup closes but main
    //     stuck on login" production bug.
    //
    // The robust replacement:
    //
    //   1. The backend's microsoftCallback (when state.desktop=true)
    //      redirects to /api/auth/desktop-complete?status=success|conflict|error
    //      — a stable backend-owned URL that no UI-routing change can
    //      break. We detect THAT URL exactly.
    //
    //   2. On detection of status=success, we VERIFY the session by
    //      calling /api/auth/me from the main process using net.request
    //      with the SAME persist:aniston session the popup is writing to.
    //      Only a 200 response is treated as success — never a guess
    //      based on cookie presence or URL inference.
    //
    //   3. Legacy fallback (past-login heuristic) is kept ONLY for two
    //      edge cases: (a) state JWTs signed BEFORE this code deployed,
    //      and (b) the SSO-conflict-then-confirm flow where the popup
    //      ends up at '/' after force-sso. Both paths run through the
    //      SAME net.request verification — no path can fake success.

    /**
     * Authoritative session verification. Hits the backend's /api/auth/me
     * from the main process using the persist:aniston session — the same
     * session the popup just wrote cookies into. Returns true ONLY when
     * the server replies 200 (i.e. authenticate middleware accepted the
     * cookie AND the RefreshToken row is still active in the DB). Any
     * 4xx / 5xx / network error is treated as "not authenticated."
     *
     * Retries up to 4 times across ~1.6 s in case the popup's Set-Cookie
     * commit hasn't propagated to the shared session jar yet when we
     * first ask. The interval is short because cookie commit is normally
     * sub-100ms; the retry budget is defensive, not load-bearing.
     */
    async function verifySessionWithBackend() {
      const MAX_ATTEMPTS = 4;
      const INTERVAL_MS = 400;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const ok = await fetchAuthMeOnce();
        if (ok) {
          diag(`sso-verify: /auth/me 200 on attempt ${attempt}/${MAX_ATTEMPTS}`);
          return true;
        }
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, INTERVAL_MS));
        }
      }
      diag(`sso-verify: /auth/me did not return 200 after ${MAX_ATTEMPTS} attempts`);
      return false;
    }

    function fetchAuthMeOnce() {
      return new Promise((resolveOnce) => {
        let timedOut = false;
        let netReq;
        const TIMEOUT_MS = 8000;
        const t = setTimeout(() => {
          timedOut = true;
          try { if (netReq) netReq.abort(); } catch { /* ignore */ }
          resolveOnce(false);
        }, TIMEOUT_MS);
        try {
          netReq = net.request({
            url: `https://${PROD_API_HOSTNAME}/api/auth/me`,
            method: 'GET',
            session: session.fromPartition('persist:aniston'),
            useSessionCookies: true,
          });
          // Match the renderer's Origin so the backend's origin-validation
          // middleware accepts the request (the renderer's traffic gets
          // its Origin rewritten by installOriginRewrite; net.request is
          // not subject to webRequest hooks, so we set it explicitly).
          netReq.setHeader('Origin', PROD_ORIGIN);
          netReq.on('response', (resp) => {
            // Drain the body to release the socket; we only care about
            // the status code.
            resp.on('data', () => {});
            resp.on('end', () => {
              if (timedOut) return;
              clearTimeout(t);
              const ok = resp.statusCode >= 200 && resp.statusCode < 300;
              if (!ok) diag(`sso-verify: /auth/me returned ${resp.statusCode}`);
              resolveOnce(ok);
            });
            resp.on('error', () => {
              clearTimeout(t);
              if (!timedOut) resolveOnce(false);
            });
          });
          netReq.on('error', (err) => {
            clearTimeout(t);
            if (!timedOut) {
              diag(`sso-verify: /auth/me error: ${err && err.message ? err.message : err}`);
              resolveOnce(false);
            }
          });
          netReq.end();
        } catch (err) {
          clearTimeout(t);
          diag(`sso-verify: net.request threw: ${err && err.message ? err.message : err}`);
          resolveOnce(false);
        }
      });
    }

    function finish(result) {
      if (resolved) return;
      resolved = true;
      // Slice 7.1 — schedule the ssoInProgress flag to clear ~10 s
      // after we're done. That keeps the logout-wipe race window
      // fully covered: by the time the main window has reloaded,
      // re-run AuthContext.loadUser, and any post-login API calls
      // have settled, the flag is safely false again.
      markSsoEnd();
      // Cancel any pending verification retry so it doesn't fire after
      // we've already resolved.
      if (verifyTimer) {
        try { clearTimeout(verifyTimer); } catch { /* ignore */ }
        verifyTimer = null;
      }
      // Slice 8 — belt-and-suspenders IPC notification.
      // The openSso promise (resolved below) is the primary success
      // signal for the renderer that called us. But if the renderer
      // crashed and was reborn between openSso start and finish, the
      // promise resolution lands on a dead webContents and the new
      // renderer never learns the OAuth completed. Sending an explicit
      // event lets AuthContext (which subscribes via the preload) catch
      // the success and refresh auth state.
      if (result && result.ok === true && mainWindow && !mainWindow.isDestroyed()) {
        try {
          mainWindow.webContents.send('aniston:sso-complete', { ok: true });
        } catch { /* swallow — promise resolution is the primary path */ }
      }
      // Resolve the renderer's promise immediately so it can refresh
      // auth state while we tear down the child window.
      resolve(result);
      // 500 ms grace period before closing the popup so any in-page JS
      // (its own loginWithToken, navigate('/'), etc.) finishes — not
      // strictly required for the main window, which only needs the
      // cookies that are already in the shared session by now.
      setTimeout(() => {
        try { if (ssoWin && !ssoWin.isDestroyed()) ssoWin.close(); }
        catch { /* already gone */ }
      }, 500);
    }

    ssoWin = new BrowserWindow({
      width: 600,
      height: 750,
      title: 'Sign in',
      parent: mainWindow,
      modal: true,
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        // Share the persist partition so cookies the OAuth callback sets
        // on monday.anistonav.com are visible to the main window once we
        // close this popup and reload.
        partition: 'persist:aniston',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    ssoWin.once('ready-to-show', () => ssoWin.show());

    /**
     * Slice 8 — DETERMINISTIC URL detection.
     *
     * PRIMARY signal: navigation to /api/auth/desktop-complete.
     *   The backend's microsoftCallback redirects there when the OAuth
     *   state carries `desktop: true`. The URL is server-owned and
     *   stable; no React Router / Login.jsx change can break detection.
     *
     * FALLBACK signal: navigation to any path on monday.anistonav.com
     *   that is NOT /login and NOT /auth/* (intermediate). Kept so:
     *     - in-flight state JWTs from a pre-deploy renderer (which lack
     *       the desktop flag and therefore redirect to /login?sso=success)
     *       still work,
     *     - the SSO-conflict-then-confirm flow (popup ends up at '/'
     *       after force-sso) still closes the popup,
     *     - any future legitimate redirect target stays detected.
     *
     * Both signals run through the SAME authoritative verification
     * (verifySessionWithBackend → /api/auth/me). The "resolve {ok:true}
     * anyway after timeout" fallback that hid the production bug is GONE.
     */
    let verifyTimer = null;
    let completionInFlight = false;

    /**
     * Run the authoritative session check and resolve the promise with
     * the actual outcome. Idempotent — only the first invocation
     * actually does work; subsequent calls are no-ops while the first
     * is in flight or after resolve.
     *
     * `expectedStatus` is taken from the desktop-complete URL when
     * available. We honour it: 'conflict' resolves with ok:false so
     * the renderer can surface the right UX (the user can still go
     * through the conflict popup, which navigates to '/' on confirm
     * and re-triggers this verifier via the fallback).
     */
    async function verifyAndFinish(reasonLabel, expectedStatus) {
      if (resolved || completionInFlight) return;
      completionInFlight = true;
      diag(`sso: verifyAndFinish reason=${reasonLabel} expectedStatus=${expectedStatus || 'none'}`);
      if (expectedStatus === 'error') {
        finish({ ok: false, reason: 'server-error', msg: expectedStatus });
        return;
      }
      if (expectedStatus === 'conflict') {
        // Don't auto-resolve a conflict — the popup is now showing the
        // /login?sso=session_conflict UI (server fell back to that for
        // the conflict path) OR will after the redirect to
        // /api/auth/desktop-complete?status=conflict (which is a static
        // info page; the user can re-trigger SSO with the conflict
        // resolved). Either way, do NOT claim success. The fallback
        // detector will fire after the user clicks "Continue here" and
        // the popup navigates to '/'.
        diag('sso: server reported conflict — staying open for user confirmation');
        completionInFlight = false;
        return;
      }
      // success path (or fallback past-login URL) — verify authoritatively.
      const ok = await verifySessionWithBackend();
      if (ok) {
        finish({ ok: true });
      } else {
        finish({ ok: false, reason: 'verification-failed' });
      }
    }

    function maybeFinishOnNav(url) {
      let u;
      try { u = new URL(url); } catch { return; }
      lastSeenUrl = url;
      diag(`sso-window: ${url}`);
      if (u.hostname !== PROD_API_HOSTNAME) return;
      const path = u.pathname || '/';

      // PRIMARY — deterministic completion URL.
      // Backend redirects desktop SSO flows here. Status is one of
      // success | conflict | error. We honour the explicit status
      // instead of inferring from cookies or React state.
      if (path === '/api/auth/desktop-complete' || path === '/api/auth/desktop-complete/') {
        const status = u.searchParams.get('status') || 'error';
        verifyAndFinish(`desktop-complete?status=${status}`, status);
        return;
      }

      // Intermediate auth-callback URLs — stay open, the server will
      // 302 to /api/auth/desktop-complete (or, for pre-deploy state,
      // /login?sso=...) within a few ms.
      if (path.startsWith('/auth/') || path.startsWith('/api/auth/')) {
        diag('sso: on /auth/* — waiting for redirect');
        return;
      }

      if (path === '/login' || path === '/login/') {
        // Stay open. With state.desktop=true the popup should NEVER
        // sit on /login post-callback (server redirects to
        // /api/auth/desktop-complete instead). With pre-deploy state
        // it can be /login?sso=success transiently — the popup's
        // in-page Login.jsx then loginWithTokens and navigates to '/',
        // which the fallback below picks up.
        diag(`sso: on /login — waiting for in-page nav past /login`);
        return;
      }

      // FALLBACK — past-login URL. Reached via:
      //   (a) pre-deploy state JWTs (no `desktop` flag) → backend
      //       redirects to /login?sso=success → popup runs the web
      //       SSO post-handler → navigate('/').
      //   (b) SSO-conflict-then-confirm: popup is on
      //       /login?sso=session_conflict, user clicks Continue here,
      //       forceLoginSSO mints cookies, popup navigates to '/'.
      // Both paths must STILL go through verifySessionWithBackend so
      // a cookie-less navigation can never fake success.
      verifyAndFinish(`fallback past-login (${path})`, 'success');
    }
    ssoWin.webContents.on('did-navigate', (_e, u) => { maybeFinishOnNav(u); });
    ssoWin.webContents.on('did-redirect-navigation', (_e, u) => { maybeFinishOnNav(u); });
    // did-navigate-in-page fires for pushState navigations (React
    // Router's `navigate('/')` after loginWithToken succeeds). Without
    // this listener we'd miss the case where the popup never gets a
    // full-page load past `/login?sso=success` because Login.jsx
    // calls history.replaceState to clear the query string then
    // pushes a new entry for `/`.
    ssoWin.webContents.on('did-navigate-in-page', (_e, u) => { maybeFinishOnNav(u); });
    // did-finish-load is the final safety net — fires once everything
    // (including in-page JS) has settled for the current document.
    ssoWin.webContents.on('did-finish-load', () => {
      try { maybeFinishOnNav(ssoWin.webContents.getURL()); }
      catch { /* webContents may already be gone */ }
    });

    ssoWin.on('closed', () => {
      // If we already detected success, this close is our own teardown
      // — finish() is idempotent so the no-op return below is safe.
      if (resolved) return;
      // Slice 8 — if verification is already in flight when the user
      // closes the window, let the in-flight verifySessionWithBackend
      // call settle and call finish itself. Don't race a parallel
      // finish() from this close handler against that — the in-flight
      // one will resolve with the actual server-side truth.
      if (completionInFlight) {
        diag('sso: window closed while verification in flight — letting it complete');
        return;
      }
      // User-initiated close BEFORE we saw a completion URL. Use
      // lastSeenUrl to guess: if the popup was past /login, the
      // backend session is most likely valid — but we MUST still
      // verify before reporting success (the previous "treat as
      // success" shortcut here was the silent-fail surface in the
      // production bug). For any /login or pre-auth URL, report
      // cancelled.
      if (lastSeenUrl) {
        try {
          const u = new URL(lastSeenUrl);
          if (u.hostname === PROD_API_HOSTNAME) {
            const path = u.pathname || '/';
            const pastLogin = !path.startsWith('/auth/')
              && !path.startsWith('/api/auth/')
              && path !== '/login'
              && path !== '/login/';
            if (pastLogin) {
              diag('sso: window closed past login — verifying session before resolving');
              // verifyAndFinish handles the resolve. completionInFlight
              // is set inside so any duplicate triggers are no-ops.
              verifyAndFinish('window-closed-past-login', 'success');
              return;
            }
          }
        } catch { /* malformed URL */ }
      }
      finish({ ok: false, reason: 'window-closed' });
    });

    ssoWin.loadURL(rawAuthUrl).catch((err) => {
      diag(`sso loadURL failed: ${err && err.message ? err.message : err}`);
      finish({ ok: false, reason: 'load-failed' });
    });
  });
});

// Slice 9 — Update IPC surface for the renderer's Settings → Desktop panel.
//
// Three handlers + one event stream:
//   - aniston:update:get-status   → returns current state snapshot
//   - aniston:update:check        → triggers a check; returns immediately
//   - aniston:update:install      → user explicitly chose to install the
//                                   already-detected update from Settings
//   - aniston:update-state        → broadcast event whenever state changes
//
// State is read-only from the renderer's perspective. The renderer can
// ASK for actions but cannot directly mutate updater state. This keeps
// the trust boundary clean — the renderer cannot fake a "ready" status
// to coax main into spawning an arbitrary EXE.
ipcMain.handle('aniston:update:get-status', () => {
  return updater.getState();
});
ipcMain.handle('aniston:update:check', async () => {
  // Returns immediately; updater drives setState which broadcasts via
  // the 'aniston:update-state' channel below.
  updater.checkForUpdates({ mainWindow, diag, triggeredByUser: true })
    .catch((err) => diag(`update:check error: ${err && err.message}`));
  return { ok: true };
});
ipcMain.handle('aniston:update:install', async () => {
  // `autoInstall: true` makes updater skip its own modal dialog (the
  // user has already confirmed intent via Settings) and drive
  // straight to download → verify → spawn. Updater state events keep
  // the renderer informed throughout.
  updater.checkForUpdates({ mainWindow, diag, triggeredByUser: true, autoInstall: true })
    .catch((err) => diag(`update:install error: ${err && err.message}`));
  return { ok: true };
});

// Subscribe to updater state changes and broadcast each transition to the
// main window's renderer. The renderer's preload bridges these into a
// React subscription via `onUpdateState`.
updater.subscribe((next) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('aniston:update-state', next); }
    catch { /* renderer may be tearing down */ }
  }
});

// Slice 3: renderer -> main IPC bridge. The handler is the ONLY route the
// renderer has to fire OS notifications, and it does NOT pass arbitrary
// arguments through to anything dangerous: notifications.js does its own
// input sanitisation and only the validated payload reaches Electron's
// Notification constructor. The handler returns an object the renderer can
// inspect to decide whether to fall back to in-app toast only.
ipcMain.handle('aniston:notify', (_event, payload) => {
  // payload may be undefined / wrong shape if the preload validation lapsed;
  // notify() guards against that.
  return notify({
    payload,
    onClick: ({ url }) => {
      showMainWindow();
      if (url) navigateRenderer(url);
    },
  });
});

app.on('ready', () => {
  installOriginRewrite();
  installCookieSameSiteRewriter();
  installLogoutCookieWipe();
  installPublicAssetRewriter();
  installRequestTracer();
  // Wire the custom notification window's IPC channels once. Idempotent
  // calls aren't safe (ipcMain.on stacks listeners) so this MUST run
  // exactly once at app boot. The window itself is created lazily on
  // the first notification.
  notificationWindow.wireIpc(diag);
  createWindow();
  // Tray must be created AFTER `app.ready` (Tray API isn't available before
  // that). The window already exists by this point; showMainWindow / refresh
  // / quitApp are closures over the module-scoped `mainWindow` and `isQuitting`
  // so they remain valid for the entire app lifetime.
  createTray({
    showMainWindow,
    refresh: refreshMainWindow,
    clearData: clearAppData,
    checkForUpdates: () => updater.checkForUpdates({
      mainWindow,
      diag,
      triggeredByUser: true,
    }),
    // Slice 11 — verification hook. Fires a sample notification through
    // the SAME notify() path the renderer uses. If the user sees a
    // Teams-style card → the slice-10 code IS active in the running
    // installer. If the user sees a native Windows toast → the
    // installer is the pre-slice-10 build (rebuild + reinstall needed)
    // OR the custom window failed to create (audit log at
    // %APPDATA%\Monday Aniston\logs\notif.log).
    testNotification: () => {
      const { notify } = require('./notifications');
      const result = notify({
        payload: {
          title: 'Test notification',
          body: 'If you see this as a Teams-style card with a purple top strip, the custom notification window is working correctly. If you see a regular Windows toast instead, see notif.log in this app\'s user-data folder for the reason.',
          tag: 'notif-test-' + Date.now(),
          url: '/',
        },
        onClick: ({ url }) => {
          showMainWindow();
          if (url) navigateRenderer(url);
        },
      });
      // Surface a quick dialog so the user knows the action happened
      // even if the notification path silently fell back.
      const { dialog } = require('electron');
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        buttons: ['OK'],
        title: 'Test notification dispatched',
        message: result && result.ok
          ? 'A test notification was dispatched. Look for it in the bottom-right corner of your screen.'
          : 'Test notification dispatch failed: ' + (result && result.reason ? result.reason : 'unknown'),
        detail: 'Check %APPDATA%\\Monday Aniston\\logs\\notif.log for the full trace.',
      });
    },
    quit: quitApp,
  });
  // Auto-update check on startup. 60 s delay so we don't race with the
  // user's login flow — by then either the cookies are in place (manifest
  // request succeeds, we may prompt) or they aren't (request 401s, we
  // silently skip and the user can manually check via the tray menu).
  setTimeout(() => {
    updater.checkForUpdates({ mainWindow, diag, triggeredByUser: false });
  }, 60 * 1000);
});

app.on('window-all-closed', () => {
  // Slice 2: close-to-tray flips this event's semantics. The X button no
  // longer destroys the window (the close handler prevents it and hides
  // instead), so this event normally never fires while the app is "in tray."
  // It DOES still fire after the explicit Quit flow has destroyed the
  // window — in that case we let the platform-default quit happen.
  // It can also fire if the renderer process crashes and Electron tears
  // the window down. We keep the app alive there so the tray icon survives
  // and the user can manually re-open or quit via the menu.
  if (isQuitting && process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('second-instance', () => {
  showMainWindow();
});

// Defensive: any path into shutdown (Ctrl+Q, OS shutdown, user-initiated
// app.quit somewhere) flips the flag so the close intercept doesn't fight us.
app.on('before-quit', () => { isQuitting = true; });

// Clean up the tray icon explicitly. Electron will reap it on process exit
// anyway, but destroying it during will-quit guarantees the icon disappears
// from the system tray promptly rather than lingering for a second after
// the window closes (a known cosmetic issue on Windows when the tray icon
// is not destroyed in the will-quit phase).
app.on('will-quit', () => {
  destroyTray();
  // Tear down the custom notification window too. It would be reaped on
  // process exit anyway, but explicit destroy keeps the bottom-right
  // popup from briefly persisting if app.quit races the renderer
  // teardown.
  try { notificationWindow.destroy(); }
  catch { /* ignore — best-effort cleanup */ }
});

// Defense-in-depth: forbid renderers from spawning <webview> sub-frames or
// attaching Node integrations. Belt-and-suspenders on top of the strict
// webPreferences set above.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});
