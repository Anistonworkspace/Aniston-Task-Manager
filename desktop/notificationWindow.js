// Custom Teams-style notification window (Slice 10).
//
// What it does
// ------------
// Renders OS notifications inside a frameless, transparent, non-focusing
// Electron BrowserWindow that we anchor bottom-right of the primary
// display's workArea (above the taskbar). Multiple notifications stack
// vertically inside the window — newest at the bottom, like Teams. The
// window auto-resizes its height based on rendered card count.
//
// Why a custom window and not just `new Notification()`
// ----------------------------------------------------
// The default Electron Notification (which uses Windows ToastGeneric) is
// constrained by Windows shell:
//   - Cannot persist on hover (auto-dismisses on a system clock).
//   - Cannot control exact position (Windows Action Center owns layout).
//   - Limited styling — no app-themed cards, no clickable per-action
//     regions that survive past the ~5 s window.
// The Teams desktop app gets around this by rendering its own popup.
// We do the same here for the same UX reasons.
//
// Fallback
// --------
// If the custom window fails to create, callers fall back to the existing
// native Notification path in `notifications.js`. The user always sees
// something; the only difference is which transport renders the card.
//
// Lifecycle
// ---------
//   - Window is created lazily on the first notification.
//   - Window stays alive between notifications (cheap; the card list is
//     re-rendered, not the BrowserWindow itself).
//   - Window closes when the app quits (will-quit handler).
//
// Security
// --------
//   - nodeIntegration: false
//   - contextIsolation: true
//   - sandbox: true
//   - Dedicated preload (notification-card-preload.js) exposing a tiny
//     `window.notifBridge` surface.
//   - Local file:// HTML with a strict CSP.
//   - Click URL is validated by the caller (`notifications.js`) before
//     reaching us; we only forward known SPA paths back to main.

const { BrowserWindow, screen, ipcMain, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const sharedLog = require('./log');

// Tunables. Kept in one place so behaviour changes need one edit.
const WIN_WIDTH = 360;
const WIN_MIN_HEIGHT = 80;
const SCREEN_MARGIN_RIGHT = 16;
const SCREEN_MARGIN_BOTTOM = 16;
const DEFAULT_DURATION_MS = 8000;     // Auto-dismiss when not hovered
const HOVER_GRACE_MS = 1500;          // Extra time after hover-leave
const MAX_VISIBLE = 5;                // Hard cap: prevents screen takeover
const RATE_LIMIT_WINDOW_MS = 4000;    // Spike detection window
const RATE_LIMIT_MAX = 5;             // Max cards per window
const RATE_LIMIT_COOLDOWN_MS = 10000; // Pause new dispatches after spike

let win = null;
let onClickHandler = null;
let onCloseHandler = null;

// Lifecycle flags so we can fast-fail when the page never finished
// loading (asset missing, CSP block, GPU crash) — the audit symptom
// where show() returned ok:true but no card ever appeared.
let pageLoaded = false;
let pageFailed = false;

// Permanent disable. Set to true after a hard failure that there is no
// point retrying (e.g. notification-card.html missing from the packaged
// asar — every retry will hit the same error). Once tripped, show()
// returns ok:false immediately so callers fall through to the native
// Toast adapter.
let disabledReason = null;

// id -> { payload, hovered, expiresAt, timer }
const activeCards = new Map();
// Spike detector — rolling window of timestamps.
const recentDispatches = [];
let cooldownUntil = 0;

function getCardPreloadPath() {
  return path.join(__dirname, 'notification-card-preload.js');
}
function getCardHtmlPath() {
  return path.join(__dirname, 'notification-card.html');
}

/**
 * Compute the bottom-right anchor in workArea coordinates. workArea
 * excludes the Windows taskbar, so notifications never overlap the
 * tray icons.
 */
function computePosition(targetWidth, targetHeight) {
  const display = screen.getPrimaryDisplay();
  const { workArea } = display;
  const x = workArea.x + workArea.width - targetWidth - SCREEN_MARGIN_RIGHT;
  const y = workArea.y + workArea.height - targetHeight - SCREEN_MARGIN_BOTTOM;
  return { x, y };
}

function ensureWindow(diag) {
  if (disabledReason) {
    sharedLog.notif(`notif-window: disabled (${disabledReason}) — short-circuit to native fallback`);
    return null;
  }
  if (win && !win.isDestroyed()) return win;

  const htmlPath = getCardHtmlPath();
  const preloadPath = getCardPreloadPath();
  // Pre-flight: confirm the bundled HTML + preload are actually
  // packaged. Missing assets are the highest-value silent-failure mode
  // (electron-builder `files` config slipped, asar layout drift). When
  // either is missing, mark the window permanently disabled — every
  // retry would hit the same error — and log it loudly so the user
  // sees it even without enabling debug env vars.
  if (!fs.existsSync(htmlPath)) {
    disabledReason = `notification-card.html missing at ${htmlPath}`;
    sharedLog.notif(`notif-window: PERMANENT DISABLE — ${disabledReason}`);
    return null;
  }
  if (!fs.existsSync(preloadPath)) {
    disabledReason = `notification-card-preload.js missing at ${preloadPath}`;
    sharedLog.notif(`notif-window: PERMANENT DISABLE — ${disabledReason}`);
    return null;
  }

  try {
    pageLoaded = false;
    pageFailed = false;
    win = new BrowserWindow({
      width: WIN_WIDTH,
      height: WIN_MIN_HEIGHT,
      x: 0,
      y: 0,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      // closable: false would also block app.quit teardown on some
      // versions; the X button is handled in-card via IPC, so we just
      // skip taskbar / focus instead of preventing close entirely.
      closable: true,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      hasShadow: false,
      // Crucial — keep notification clicks from stealing focus from
      // the user's current foreground app.
      acceptFirstMouse: true,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
        // Distinct partition — does NOT share cookies / storage with
        // the main app's persist:aniston. The card UI is purely local.
        partition: 'persist:aniston-notifications',
      },
    });
    // alwaysOnTop modes: 'screen-saver' floats over everything except
    // fullscreen apps; 'floating' is fine for non-fullscreen workflows.
    // We pick 'screen-saver' to behave like a system notification.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });

    // Track readiness so show() can defer sends until the renderer's
    // inline script has registered its IPC callbacks. did-finish-load
    // fires AFTER the page's `load` event, i.e. inline scripts have
    // run, so by then the bridge.onShow callback is in place.
    win.webContents.on('did-finish-load', () => {
      pageLoaded = true;
      sharedLog.notif(`notif-window: did-finish-load url=${htmlPath}`);
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
      pageFailed = true;
      sharedLog.notif(`notif-window: did-fail-load main=${isMain} code=${code} desc=${desc} url=${url}`);
      // Tear down the window so next show() either retries or
      // disables. Mark permanent disable for a file-not-found code
      // (-6 ERR_FILE_NOT_FOUND) — no point retrying a missing asset.
      if (isMain && code === -6) {
        disabledReason = `card HTML failed to load (ERR_FILE_NOT_FOUND): ${url}`;
      }
      try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
      win = null;
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      sharedLog.notif(`notif-window: render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
      try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
      win = null;
    });
    win.webContents.on('preload-error', (_e, errPath, err) => {
      sharedLog.notif(`notif-window: preload-error path=${errPath} err=${err && err.message ? err.message : err}`);
    });

    sharedLog.notif(`notif-window: creating window htmlPath=${htmlPath}`);
    win.loadFile(htmlPath).catch((err) => {
      sharedLog.notif(`notif-window: loadFile rejected: ${err && err.message ? err.message : err}`);
      pageFailed = true;
      try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
      win = null;
    });
    win.on('closed', () => { win = null; pageLoaded = false; });
    return win;
  } catch (err) {
    sharedLog.notif(`notif-window: BrowserWindow create threw: ${err && err.message ? err.message : err}`);
    win = null;
    return null;
  }
}

function relayout(width, height) {
  if (!win || win.isDestroyed()) return;
  const safeWidth = Math.max(WIN_WIDTH, Math.min(800, Math.floor(width || WIN_WIDTH)));
  const safeHeight = Math.max(WIN_MIN_HEIGHT, Math.min(1200, Math.floor(height || WIN_MIN_HEIGHT)));
  const { x, y } = computePosition(safeWidth, safeHeight);
  try {
    win.setBounds({ x, y, width: safeWidth, height: safeHeight });
  } catch { /* ignore */ }
  if (activeCards.size > 0 && !win.isVisible()) {
    try { win.showInactive(); } catch { /* ignore */ }
  } else if (activeCards.size === 0 && win.isVisible()) {
    try { win.hide(); } catch { /* ignore */ }
  }
}

function dismiss(id, reason, diag) {
  const entry = activeCards.get(id);
  if (!entry) return;
  if (entry.timer) {
    try { clearTimeout(entry.timer); } catch { /* ignore */ }
  }
  activeCards.delete(id);
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('notif-card:dismiss', { id }); } catch { /* ignore */ }
  }
  if (diag) diag(`notif-window: dismissed ${id} (reason=${reason})`);
  // If the queue is empty, hide the window after a short delay so the
  // dismiss animation finishes first.
  if (activeCards.size === 0) {
    setTimeout(() => {
      if (activeCards.size === 0 && win && !win.isDestroyed()) {
        try { win.hide(); } catch { /* ignore */ }
      }
    }, 280);
  }
}

function scheduleAutoDismiss(id, durationMs, diag) {
  const entry = activeCards.get(id);
  if (!entry) return;
  if (entry.timer) {
    try { clearTimeout(entry.timer); } catch { /* ignore */ }
  }
  entry.expiresAt = Date.now() + durationMs;
  entry.timer = setTimeout(() => {
    const e = activeCards.get(id);
    if (!e) return;
    if (e.hovered) {
      // User is hovering — extend by HOVER_GRACE_MS and re-arm.
      scheduleAutoDismiss(id, HOVER_GRACE_MS, diag);
      return;
    }
    dismiss(id, 'timeout', diag);
  }, durationMs);
}

/**
 * Show a notification card.
 *
 * payload shape:
 *   id        string  — required, used for dedup + dismiss
 *   title     string  — required
 *   body      string
 *   url       string  — SPA path, validated by the caller
 *   iconUrl   string  — file:// URL of an icon
 *   sender    string  — optional display name (drives initials)
 *
 * Returns:
 *   { ok: true }                    on dispatch
 *   { ok: true, deduped: true }     when id already active (no re-show)
 *   { ok: false, reason: 'rate-limit' } during cooldown
 *   { ok: false, reason: 'window-create-failed' }
 */
function show({ payload, onClick, onClose, diag }) {
  // Spike detection: count dispatches in the rolling window. If we're
  // over RATE_LIMIT_MAX, enter a cooldown where new dispatches are
  // dropped. The renderer's in-app toast and burst dispatcher already
  // throttle their own emissions; this is belt-and-suspenders.
  const now = Date.now();
  while (recentDispatches.length > 0 && recentDispatches[0] < now - RATE_LIMIT_WINDOW_MS) {
    recentDispatches.shift();
  }
  if (now < cooldownUntil) {
    sharedLog.notif(`notif-window: rate-limited (cooldown)`);
    return { ok: false, reason: 'rate-limit' };
  }
  recentDispatches.push(now);
  if (recentDispatches.length > RATE_LIMIT_MAX) {
    cooldownUntil = now + RATE_LIMIT_COOLDOWN_MS;
    sharedLog.notif(`notif-window: rate limit tripped — cooling down ${RATE_LIMIT_COOLDOWN_MS}ms`);
    return { ok: false, reason: 'rate-limit' };
  }

  if (!payload || typeof payload.id !== 'string' || !payload.id) {
    sharedLog.notif(`notif-window: invalid payload (no id)`);
    return { ok: false, reason: 'invalid-payload' };
  }
  if (activeCards.has(payload.id)) {
    sharedLog.notif(`notif-window: deduped id=${payload.id}`);
    return { ok: true, deduped: true };
  }

  // Enforce MAX_VISIBLE — when we'd exceed, dismiss the OLDEST card
  // first to make room. Iteration order of Map is insertion-order, so
  // the first entry is always the oldest.
  while (activeCards.size >= MAX_VISIBLE) {
    const oldest = activeCards.keys().next().value;
    if (!oldest) break;
    dismiss(oldest, 'capacity', diag);
  }

  const w = ensureWindow(diag);
  if (!w) {
    sharedLog.notif(`notif-window: ensureWindow returned null (reason=${disabledReason || 'create-failed'})`);
    return { ok: false, reason: disabledReason ? 'permanently-disabled' : 'window-create-failed' };
  }
  if (pageFailed) {
    sharedLog.notif(`notif-window: page previously failed to load — refusing`);
    return { ok: false, reason: 'page-failed' };
  }

  // Cache the click/close handlers — they're closed over by the IPC
  // listeners registered once below.
  onClickHandler = onClick;
  onCloseHandler = onClose;

  const entry = {
    payload,
    hovered: false,
    expiresAt: 0,
    timer: null,
  };
  activeCards.set(payload.id, entry);

  // The card UI doesn't know about webContents readiness — if the
  // BrowserWindow is still loading the HTML, the 'notif-card:show'
  // IPC fires before the page's script registers its listener. We
  // defer until did-finish-load if the contents are still loading.
  const wc = w.webContents;
  const cardPayload = {
    id: payload.id,
    title: payload.title || '',
    body: payload.body || '',
    url: payload.url || '',
    iconUrl: payload.iconUrl || '',
    sender: payload.sender || '',
    ts: payload.ts || '',
  };
  const sendShow = () => {
    try { wc.send('notif-card:show', cardPayload); } catch { /* renderer gone */ }
  };
  if (wc.isLoading()) {
    wc.once('did-finish-load', sendShow);
  } else {
    sendShow();
  }

  // Start the auto-dismiss timer immediately. Hover events from the
  // card will extend it.
  scheduleAutoDismiss(payload.id, DEFAULT_DURATION_MS, diag);

  sharedLog.notif(`notif-window: dispatched id=${payload.id} pageLoaded=${pageLoaded} title-len=${cardPayload.title.length} body-len=${cardPayload.body.length}`);
  return { ok: true };
}

/**
 * Hook IPC handlers from the card window back to the main process
 * callbacks. Called once at app startup.
 */
function wireIpc(diag) {
  ipcMain.on('notif-card:click', (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') return;
    const entry = activeCards.get(payload.id);
    if (!entry) return;
    if (onClickHandler) {
      try { onClickHandler({ url: entry.payload.url }); }
      catch (err) { diag(`notif-window: click handler threw: ${err && err.message}`); }
    }
    dismiss(payload.id, 'click', diag);
  });
  ipcMain.on('notif-card:close', (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') return;
    if (onCloseHandler) {
      try { onCloseHandler({ id: payload.id }); } catch { /* ignore */ }
    }
    dismiss(payload.id, 'user-close', diag);
  });
  ipcMain.on('notif-card:hover', (_event, payload) => {
    if (!payload || typeof payload.id !== 'string') return;
    const entry = activeCards.get(payload.id);
    if (!entry) return;
    entry.hovered = !!payload.hovered;
    if (!entry.hovered) {
      // Re-arm the timeout with grace so the card stays a bit after
      // the cursor leaves (matches Teams behaviour).
      scheduleAutoDismiss(payload.id, HOVER_GRACE_MS, diag);
    }
    // If hovered=true we let the timer expire naturally; expiry
    // checks `hovered` and extends.
  });
  ipcMain.on('notif-card:bounds', (_event, payload) => {
    if (!payload) return;
    relayout(payload.width, payload.height);
  });
}

function destroy() {
  for (const id of Array.from(activeCards.keys())) {
    const e = activeCards.get(id);
    if (e && e.timer) {
      try { clearTimeout(e.timer); } catch { /* ignore */ }
    }
  }
  activeCards.clear();
  if (win && !win.isDestroyed()) {
    try { win.destroy(); } catch { /* ignore */ }
  }
  win = null;
}

module.exports = {
  show,
  wireIpc,
  destroy,
};
