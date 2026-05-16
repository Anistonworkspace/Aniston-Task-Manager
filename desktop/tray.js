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

function buildContextMenu({ showMainWindow, refresh, quit }) {
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
function createTray({ showMainWindow, refresh, quit }) {
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
  tray.setContextMenu(buildContextMenu({ showMainWindow, refresh, quit }));

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
 * Show the first-time hint balloon so the user knows the app is still
 * running after they close the window. Windows-only; macOS and most Linux
 * desktops don't have an equivalent native balloon API exposed by Electron.
 *
 * `firstHideHintShown` is in-memory only — a fresh launch shows the hint
 * once again. That keeps the implementation dependency-free (no JSON file
 * to maintain) and the cost of re-showing once per launch is acceptable.
 * A future improvement could persist the seen-flag to userData if user
 * feedback suggests the hint is noisy.
 */
function showHideToTrayHint() {
  if (!tray) return;
  if (firstHideHintShown) return;
  if (process.platform !== 'win32') return;
  firstHideHintShown = true;
  try {
    tray.displayBalloon({
      title: 'Monday Aniston is still running',
      content:
        'The app was minimised to the system tray so notifications keep working. '
        + 'Right-click the tray icon and choose "Quit" to exit fully.',
      iconType: 'info',
    });
  } catch {
    // displayBalloon throws on legacy Windows builds without the toast API.
    // Non-fatal — the user just doesn't see the hint.
  }
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
