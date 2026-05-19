// Monday Aniston — desktop auto-updater.
//
// Slice 7 — checks the app's own backend for a newer installer version and
// prompts the user via a native Windows dialog. On accept, downloads the
// new installer into the OS temp directory and spawns it as a detached
// process; the current app quits so the NSIS installer can replace the
// running executable.
//
// Design choices
// --------------
//
// Why NOT electron-updater:
//   - electron-updater wants its own latest.yml format and S3/GitHub
//     hosting conventions. We deliberately host the installer inside our
//     own backend (slice 5b: /api/desktop/{manifest,download}). Rolling
//     our own ~80 lines of update logic is simpler than reshaping the
//     server to match electron-updater's expectations.
//
// Why authenticated manifest:
//   - The manifest endpoint sits behind `authenticate` middleware.
//     `net.request({ session })` automatically sends the persist:aniston
//     cookies, so once the user is logged in the request succeeds; if
//     they're not logged in we get a 401 and silently skip (try again
//     later). No anonymous update notifications leak the existence of
//     newer builds.
//
// Why spawn-and-quit instead of in-place replace:
//   - On Windows you cannot replace a running EXE. The cleanest path is
//     to spawn the new installer (detached, no parent dependency), then
//     `app.quit()` immediately so the install can overwrite our files.
//     The NSIS installer's `oneClick: false` config presents a wizard;
//     `runAfterFinish: true` re-launches the new version after install.

const { app, dialog, net, session, shell, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PROD_HOST = 'monday.anistonav.com';
const MANIFEST_URL = `https://${PROD_HOST}/api/desktop/manifest`;
const DOWNLOAD_URL = `https://${PROD_HOST}/api/desktop/download`;
const PARTITION = 'persist:aniston';

// Where the downloaded installer lands. `temp` is auto-cleaned by Windows;
// we don't need to manage retention ourselves.
function installerTempPath() {
  return path.join(app.getPath('temp'), 'Monday-Aniston-Setup.exe');
}

/**
 * Strict numeric compare of dotted-decimal version strings ("1.2.3" vs
 * "1.2.10"). Treats missing segments as 0. Returns positive when `a` is
 * newer, negative when `b` is newer, 0 when equal. Anything non-numeric
 * is treated as 0 so a malformed manifest can't false-trigger updates.
 */
function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((p) => Number(p) || 0);
  const pb = String(b || '').split('.').map((p) => Number(p) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * GET /api/desktop/manifest with the persist:aniston session cookies.
 * Returns the parsed manifest object on success, null on any failure
 * (no cookie, 4xx/5xx, malformed JSON, network error). Callers treat
 * null as "no update info available right now" and back off.
 *
 * The api.js response interceptor on the web wraps payloads as
 * { success, data } — our backend manifest controller returns the same
 * shape. We accept either { data: {...} } or a flat manifest at the
 * top level so future controller-shape changes don't break us.
 */
function fetchManifest(diag) {
  return new Promise((resolve) => {
    let body = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try { req.abort(); } catch { /* ignore */ }
      resolve(null);
    }, 15000);

    const req = net.request({
      url: MANIFEST_URL,
      method: 'GET',
      session: session.fromPartition(PARTITION),
      useSessionCookies: true,
    });
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        clearTimeout(timeout);
        diag(`updater: manifest fetch returned ${res.statusCode}`);
        resolve(null);
        return;
      }
      res.on('data', (chunk) => { body += chunk.toString(); });
      res.on('end', () => {
        clearTimeout(timeout);
        if (timedOut) return;
        try {
          const json = JSON.parse(body);
          const m = (json && json.data && json.data.version) ? json.data
            : (json && json.version) ? json
            : null;
          resolve(m);
        } catch (err) {
          diag(`updater: manifest JSON parse failed: ${err.message}`);
          resolve(null);
        }
      });
    });
    req.on('error', (err) => {
      clearTimeout(timeout);
      diag(`updater: manifest fetch error: ${err.message}`);
      resolve(null);
    });
    req.end();
  });
}

/**
 * Stream the new installer into the OS temp directory. Resolves with the
 * file path on success, rejects on any failure. We delete any stale
 * download first so partial files from a previous attempt don't fool us.
 */
function downloadInstaller(diag, onProgress) {
  return new Promise((resolve, reject) => {
    const exePath = installerTempPath();
    try { fs.unlinkSync(exePath); } catch { /* not present is fine */ }

    let downloaded = 0;
    let total = 0;
    const req = net.request({
      url: DOWNLOAD_URL,
      method: 'GET',
      session: session.fromPartition(PARTITION),
      useSessionCookies: true,
    });
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`download returned ${res.statusCode}`));
        return;
      }
      total = parseInt(res.headers['content-length'] || '0', 10) || 0;
      const stream = fs.createWriteStream(exePath);
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        stream.write(chunk);
        if (onProgress && total > 0) onProgress(downloaded / total);
      });
      res.on('end', () => {
        stream.end(() => {
          diag(`updater: downloaded ${downloaded} bytes to ${exePath}`);
          resolve(exePath);
        });
      });
      res.on('error', (err) => {
        try { stream.destroy(); } catch { /* ignore */ }
        reject(err);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Show the "update available" dialog, drive the download with a taskbar
 * progress bar, then spawn the installer and quit so it can replace us.
 *
 * Guarded with the module-scoped `checkInFlight` so concurrent triggers
 * (startup check + user-clicked tray "Check for updates" while the
 * first is still running) don't show two dialogs or double-download.
 */
let checkInFlight = false;
let updateDeclinedForVersion = null;

async function checkForUpdates({ mainWindow, diag, triggeredByUser = false }) {
  if (checkInFlight) {
    diag('updater: check already in flight — skipping');
    return;
  }
  checkInFlight = true;
  try {
    const manifest = await fetchManifest(diag);
    if (!manifest) {
      diag('updater: no manifest (offline, not logged in, or server unreachable)');
      if (triggeredByUser && mainWindow && !mainWindow.isDestroyed()) {
        // Manual check — tell the user we couldn't reach the server
        // instead of silently doing nothing.
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          buttons: ['OK'],
          title: 'Check for updates',
          message: 'Could not check for updates',
          detail: 'Make sure you are signed in and have internet access, then try again.',
        });
      }
      return;
    }
    const current = app.getVersion();
    const latest = manifest.version;
    const cmp = compareVersions(latest, current);
    diag(`updater: current=${current} latest=${latest} cmp=${cmp}`);

    if (cmp <= 0) {
      if (triggeredByUser && mainWindow && !mainWindow.isDestroyed()) {
        dialog.showMessageBox(mainWindow, {
          type: 'info',
          buttons: ['OK'],
          title: 'You are up to date',
          message: `Monday Aniston ${current} is the latest version.`,
        });
      }
      return;
    }

    // Auto-trigger has a "don't keep nagging" guard: if we already
    // asked about THIS specific version in this session and the user
    // said Later, leave them alone until they restart or click the
    // tray's "Check for updates" item.
    if (!triggeredByUser && updateDeclinedForVersion === latest) {
      diag(`updater: user already declined ${latest} this session`);
      return;
    }

    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Update Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update available',
      message: `Monday Aniston ${latest} is available`,
      detail: (manifest.releaseNotes && manifest.releaseNotes.trim())
        ? `What's new:\n\n${manifest.releaseNotes}\n\nYou are currently running ${current}.`
        : `You are currently running ${current}.\n\nThe app will close and the installer will run.`,
    });
    if (choice.response !== 0) {
      diag('updater: user clicked Later');
      updateDeclinedForVersion = latest;
      return;
    }

    // Download with taskbar progress.
    diag('updater: user clicked Update Now — starting download');
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.setProgressBar(0); } catch { /* ignore */ }
    }
    let exePath;
    try {
      exePath = await downloadInstaller(diag, (fraction) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          try { mainWindow.setProgressBar(Math.max(0, Math.min(1, fraction))); }
          catch { /* ignore */ }
        }
      });
    } catch (err) {
      diag(`updater: download failed: ${err.message}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.setProgressBar(-1); } catch { /* ignore */ }
        dialog.showMessageBox(mainWindow, {
          type: 'error',
          buttons: ['OK'],
          title: 'Update failed',
          message: 'Could not download the update.',
          detail: `${err.message}\n\nPlease try again later.`,
        });
      }
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.setProgressBar(-1); } catch { /* ignore */ }
    }

    // Spawn the installer detached so we can quit immediately. The
    // installer is NSIS `oneClick: false` so it shows a wizard; user
    // confirms install path, NSIS replaces our running EXE, then the
    // `runAfterFinish: true` config relaunches the new version.
    diag(`updater: spawning installer ${exePath}`);
    try {
      const child = spawn(exePath, [], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (err) {
      diag(`updater: spawn failed: ${err.message}`);
      // Last-ditch: try shell.openPath which uses the default verb.
      try { shell.openPath(exePath); }
      catch (err2) { diag(`updater: openPath also failed: ${err2.message}`); }
    }

    // Quit so the installer can overwrite. Small delay to make sure the
    // spawn() call has actually handed off to the OS.
    setTimeout(() => {
      try {
        // Make sure close-to-tray doesn't intercept this quit.
        if (app.emit) app.emit('before-quit');
        app.quit();
      } catch (err) {
        diag(`updater: app.quit failed: ${err.message}`);
      }
    }, 500);
  } finally {
    checkInFlight = false;
  }
}

module.exports = { checkForUpdates, compareVersions };
