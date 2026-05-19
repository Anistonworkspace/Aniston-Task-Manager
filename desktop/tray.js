// Monday Aniston — system tray.
//
// Slice 2 scope:
//   - Create a tray icon with tooltip + context menu (Open / Refresh / Quit).
//   - Left-click on the icon opens/restores the main window.
//   - A first-launch balloon hint on Windows so the user understands the
//     hide-to-tray behavior the first time they click the close (X) button.
//
// Out of scope here:
//   - Native notification dispatch (slice 3).
//   - Unread-count badge overlay on the tray icon (slice 3 or later).
//   - Custom tray icon sizes (current code uses the existing 192px PNG;
//     Electron scales it for the tray automatically. A dedicated 16/32px ICO
//     can be added in slice 5 with the installer).

const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');
const { iconsRoot } = require('./paths');

// Module-scope so the tray survives across createWindow() calls and so the
// first-hide hint fires exactly once per launch (not per window-close).
let tray = null;
let firstHideHintShown = false;

function resolveTrayIconPath() {
  // Slice 5: iconsRoot() resolves to <install>/resources/icons/ in a real
  // packaged build (via electron-builder's extraResources) and to the
  // in-repo client/public/icons/ during dev. The 192px PNG is the smallest
  // bundled asset; we resize it to 16px in createTray() for crisp tray
  // rendering on Windows.
  return path.join(iconsRoot(), 'icon-192.png');
}

function buildContextMenu({ showMainWindow, refresh, clearData, checkForUpdates, testNotification, quit }) {
  return Menu.buildFromTemplate([
    {
      label: 'Open Monday Aniston',
      click: () => showMainWindow(),
    },
    {
      // "Refresh" reloads the renderer — useful as a manual escape hatch if
      // the app gets into a stale state. Slice 3 may add a separate
      // "Check for notifications" item that fires an IPC instead of a full
      // reload, once the notification adapter ships.
      label: 'Refresh',
      click: () => refresh(),
    },
    {
      // Slice 7: Manual update check. Auto-check fires 60 s after launch;
      // this lets the user pull a new version on demand without restarting.
      // The handler reports "you're up to date" in a dialog when there's
      // nothing newer, so the click feels acknowledged either way.
      label: 'Check for updates',
      click: () => checkForUpdates(),
    },
    {
      // Slice 11: deterministic verification that the custom Teams-style
      // notification window is wired correctly. Fires a hardcoded sample
      // notification through the same code path real notifications use.
      // If THIS does not show a Teams card, the user's running EXE does
      // not contain the slice-10 code (rebuild + reinstall needed).
      label: 'Send test notification',
      click: () => testNotification && testNotification(),
    },
    { type: 'separator' },
    {
      // Slice 6.7: "Clear data & sign out" — nuclear option for stuck
      // states. Wipes the persist:aniston session (cookies, localStorage,
      // IndexedDB, cache, service workers) and reloads the renderer.
      // The user has to log in again afterwards, but it recovers from any
      // corrupted-session or stale-cookie symptom in one click.
      label: 'Clear data & sign out',
      click: () => clearData(),
    },
    { type: 'separator' },
    {
      // Explicit quit path — only this exits the app fully.
      label: 'Quit Monday Aniston',
      click: () => quit(),
    },
  ]);
}

/**
 * Build the tray icon. Callbacks come from the main process so the tray has
 * a narrow, well-typed surface: it never reaches into BrowserWindow state on
 * its own.
 */
function createTray({ showMainWindow, refresh, clearData, checkForUpdates, testNotification, quit }) {
  if (tray) return tray;

  const iconPath = resolveTrayIconPath();
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    // Defensive: if the icon path doesn't resolve (e.g. someone moved the
    // assets) fall back to an empty NativeImage. The tray will still render
    // with a default OS placeholder rather than crashing the main process.
    image = nativeImage.createEmpty();
  } else if (process.platform === 'win32') {
    // Tray icons render best at 16px on Windows. nativeImage.resize is cheap
    // and produces a crisper result than letting the shell scale a 192px PNG.
    image = image.resize({ width: 16, height: 16, quality: 'best' });
  }

  tray = new Tray(image);
  tray.setToolTip('Monday Aniston');
  tray.setContextMenu(buildContextMenu({ showMainWindow, refresh, clearData, checkForUpdates, testNotification, quit }));

  // Left-click on the tray icon opens/focuses the window. macOS Tray ignores
  // bare click events in favor of context-menu popup, which is the platform
  // convention — we leave that behavior to the OS there.
  tray.on('click', () => {
    if (process.platform !== 'darwin') showMainWindow();
  });

  // Double-click is also a common Windows tray gesture for "open primary window".
  tray.on('double-click', () => showMainWindow());

  return tray;
}

/**
 * Slice 6.2: the close-to-tray balloon has been suppressed.
 *
 * The original Slice 2 design popped a Windows balloon ("Monday Aniston is
 * still running…") on the first hide-to-tray of each launch, so users would
 * understand why the X button didn't kill the process. In practice users
 * report this notification as noise: it fires on every fresh launch +
 * close, and the tray icon itself is already a strong "this is running"
 * signal. We keep the function as a no-op so the call site in `main.js`
 * doesn't need to be removed — if telemetry ever shows users are confused,
 * we can bring it back with a persistent "seen once ever" flag in
 * userData rather than the per-launch in-memory flag we originally had.
 */
function showHideToTrayHint() {
  if (!tray) return;
  // Intentionally empty — see comment above. `firstHideHintShown` is kept
  // referenced so eslint's no-unused-vars doesn't flag it; the variable
  // remains in case a future toggle wants to restore the legacy behaviour.
  void firstHideHintShown;
}

function destroyTray() {
  if (!tray) return;
  try { tray.destroy(); }
  catch { /* ignore — already gone */ }
  tray = null;
}

module.exports = {
  createTray,
  destroyTray,
  showHideToTrayHint,
};
