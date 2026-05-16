// Slice 5b — desktop installer download endpoint.
//
// Serves the Windows installer EXE and its release manifest to authenticated
// users. Both files live on the application server's local filesystem under
// server/downloads/desktop/, populated by scripts/publish-desktop-installer.js.
//
// We deliberately do NOT mount this directory as a static asset. Going
// through a controller lets us (a) keep the EXE behind `authenticate` so
// only signed-in employees can grab it, (b) emit a structured 404 +
// machine-readable code when nothing has been published yet, and (c) gives
// us a clean injection point later for per-user / tier-aware update gates
// (e.g. only roll an update out to admins first) without re-plumbing storage.

const fs = require('fs');
const path = require('path');
const safeLogger = require('../utils/safeLogger');

const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads', 'desktop');
const INSTALLER_FILENAME = 'Monday-Aniston-Setup.exe';
const MANIFEST_FILENAME = 'desktop-update.json';

const installerPath = () => path.join(DOWNLOADS_DIR, INSTALLER_FILENAME);
const manifestPath = () => path.join(DOWNLOADS_DIR, MANIFEST_FILENAME);

/**
 * GET /api/desktop/manifest
 *
 * Returns the JSON manifest for the currently published desktop installer.
 * Used by the web profile dropdown to decide whether to show the "Download
 * Desktop App" item, and (in a future slice) by the desktop app itself for
 * "is there a newer version?" checks.
 *
 * Auth: any authenticated user.
 */
exports.getManifest = async (req, res) => {
  try {
    const mp = manifestPath();
    if (!fs.existsSync(mp)) {
      // Soft-404 with a machine-readable code so the client can hide the
      // dropdown item silently rather than rendering a broken state.
      return res.status(404).json({
        success: false,
        code: 'INSTALLER_NOT_PUBLISHED',
        message: 'No desktop installer has been published yet.',
      });
    }
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(mp, 'utf-8'));
    } catch (parseErr) {
      safeLogger.error('[DesktopDownload] manifest parse failed', { err: parseErr });
      return res.status(500).json({
        success: false,
        message: 'Desktop manifest is malformed.',
      });
    }
    return res.status(200).json({ success: true, data: manifest });
  } catch (err) {
    safeLogger.error('[DesktopDownload] getManifest error', { err, userId: req.user?.id });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
};

/**
 * GET /api/desktop/download
 *
 * Streams the desktop installer EXE to the authenticated user. Express's
 * `res.download` handles Content-Type, Content-Disposition (attachment with
 * the filename below), Content-Length and range-resume headers for us.
 *
 * Auth: any authenticated user.
 *
 * No user input is consumed (no path params, no query string), so there is
 * no path-traversal surface. The served path is hard-coded to the canonical
 * INSTALLER_FILENAME under DOWNLOADS_DIR.
 */
exports.downloadInstaller = async (req, res) => {
  try {
    const ip = installerPath();
    if (!fs.existsSync(ip)) {
      return res.status(404).json({
        success: false,
        code: 'INSTALLER_NOT_PUBLISHED',
        message: 'No desktop installer has been published yet.',
      });
    }
    safeLogger.info('[DesktopDownload] installer download', { userId: req.user?.id });
    return res.download(ip, INSTALLER_FILENAME, (err) => {
      // `res.download` invokes this callback after the response stream
      // closes — error here means the client disconnected mid-stream OR
      // file read failed. Log only when headers haven't been sent (so the
      // 5xx path below can fire); if they have, the response is already
      // committed and we just record the disconnect.
      if (err) {
        safeLogger.warn('[DesktopDownload] stream ended with error', {
          err,
          userId: req.user?.id,
          headersSent: res.headersSent,
        });
      }
    });
  } catch (err) {
    safeLogger.error('[DesktopDownload] downloadInstaller error', { err, userId: req.user?.id });
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: 'Internal server error' });
    }
  }
};
