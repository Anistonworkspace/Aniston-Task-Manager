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
const { resolveConfig } = require('./runtimeConfig');
const { createTray, destroyTray, showHideToTrayHint } = require('./tray');
const { notify } = require('./notifications');
const { iconsRoot, clientIndexHtml } = require('./paths');

// Slice 6 diagnostic logging. Gated by env var so packaged production users
// never see DevTools or log files. Two flags:
//   ANISTON_DESKTOP_DEBUG=1   -> auto-open DevTools and write a startup log
//   ANISTON_DESKTOP_LOG=1     -> only write the log (no DevTools popup)
// The log file lives next to the user's Electron userData so we don't litter
// the install directory. Token/cookie redaction is unnecessary here because
// we only log paths, error codes, and console levels.
const DESKTOP_DEBUG = process.env.ANISTON_DESKTOP_DEBUG === '1';
const DESKTOP_LOG = DESKTOP_DEBUG || process.env.ANISTON_DESKTOP_LOG === '1';
let desktopLogStream = null;
function diag(msg) {
  if (!DESKTOP_LOG) return;
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    if (!desktopLogStream) {
      const dir = path.join(app.getPath('userData'), 'logs');
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
      desktopLogStream = fs.createWriteStream(path.join(dir, 'desktop.log'), { flags: 'a' });
    }
    desktopLogStream.write(line);
  } catch { /* ignore log failures */ }
  try { console.log(line.trimEnd()); } catch { /* ignore */ }
}

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
  const docDir = path.dirname(clientIndexHtml()); // ...\client-dist
  // Normalise to a file:// URL prefix Electron returns from webRequest.
  // Drive letters are upper-cased in the URL ("file:///C:/..."), and
  // backslashes are forward-slashes.
  const docDirUrl = `file:///${docDir.replace(/\\/g, '/')}`;
  ses.webRequest.onBeforeRequest({ urls: ['file:///*'] }, (details, callback) => {
    const url = details.url;
    // Pass through requests already rooted inside the client-dist directory.
    if (url.startsWith(docDirUrl + '/')) {
      callback({});
      return;
    }
    // Match `file:///<drive>:/<segment>/...` — drive-root absolute references
    // from `<img src="/icons/...">` and similar. The first path segment is
    // the public-asset folder name (icons, audio, favicon.svg, etc.).
    const m = url.match(/^file:\/\/\/[A-Za-z]:\/([^/]+(?:\/[^?#]*)?)(\?.*)?$/);
    if (!m) {
      callback({});
      return;
    }
    const restPath = m[1];
    // Never rewrite into our own application-script paths — those are the
    // hashed bundle and would already match docDirUrl above. We only
    // rewrite public-root assets.
    const redirectURL = `${docDirUrl}/${restPath}${m[2] || ''}`;
    diag(`asset-rewrite ${url} -> ${redirectURL}`);
    callback({ redirectURL });
  });
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
// it to the foreground. Recreates the window if it was destroyed (which
// only happens during the final quit sequence).
function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
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
  installPublicAssetRewriter();
  installRequestTracer();
  createWindow();
  // Tray must be created AFTER `app.ready` (Tray API isn't available before
  // that). The window already exists by this point; showMainWindow / refresh
  // / quitApp are closures over the module-scoped `mainWindow` and `isQuitting`
  // so they remain valid for the entire app lifetime.
  createTray({
    showMainWindow,
    refresh: refreshMainWindow,
    quit: quitApp,
  });
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
app.on('will-quit', () => { destroyTray(); });

// Defense-in-depth: forbid renderers from spawning <webview> sub-frames or
// attaching Node integrations. Belt-and-suspenders on top of the strict
// webPreferences set above.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});
