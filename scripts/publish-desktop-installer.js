#!/usr/bin/env node
//
// Slice 5b — publish the freshly-built desktop installer to the app's own
// download endpoint storage.
//
// What it does
// ------------
// 1. Reads desktop/dist/Monday-Aniston-Setup.exe (built by `npm run desktop:dist`).
// 2. Copies it to server/downloads/desktop/Monday-Aniston-Setup.exe so the
//    backend `/api/desktop/download` route can stream it.
// 3. Writes server/downloads/desktop/desktop-update.json — a small manifest
//    the web profile dropdown reads to decide whether to show the
//    "Download Desktop App" item (and to display version + size).
//
// Why a separate step (not auto-run during `desktop:dist`)
// -------------------------------------------------------
// "Build the EXE" and "publish the EXE to end users" are intentionally
// distinct actions. A developer can build locally to verify the installer
// works without immediately exposing the new version to everyone who opens
// the dropdown on prod. Once they're happy, `npm run desktop:publish`
// flips the bit by copying the artefacts into the server's downloads/
// folder (which on prod is mounted into the backend container).
//
// CLI flags
// ---------
//   --release-notes="..."    Optional. String stored in the manifest's
//                            `releaseNotes` field, surfaced by the dropdown
//                            (and by future auto-updater UIs).
//   --mandatory              Optional. Marks the release as mandatory in
//                            the manifest. v1 dropdown ignores it; reserved
//                            for a future "force update" flow.
//
// Out of scope
// ------------
//   - No S3 / CDN upload (deliberate choice for v1: app-hosted only).
//   - No checksum / signature verification yet — the installer is unsigned
//     anyway in v1; once code-signing lands, this script will compute the
//     sha256 and embed it in the manifest.
//   - No prod-host SSH push — that's the deploy pipeline's job. This script
//     runs on the build host (local laptop or CI).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_EXE = path.join(REPO_ROOT, 'desktop', 'dist', 'Monday-Aniston-Setup.exe');
const DEST_DIR = path.join(REPO_ROOT, 'server', 'downloads', 'desktop');
const DEST_EXE = path.join(DEST_DIR, 'Monday-Aniston-Setup.exe');
const DEST_MANIFEST = path.join(DEST_DIR, 'desktop-update.json');
const DESKTOP_PKG = path.join(REPO_ROOT, 'desktop', 'package.json');

/**
 * Compute a SHA-256 hex digest of the installer.
 *
 * Why: the desktop updater (desktop/updater.js) re-hashes the downloaded
 * EXE before spawning it as the new installer. Mismatch → refuse to
 * execute. This catches MITM tampering on the install endpoint, partial
 * or corrupted downloads, and the (theoretical) case of an attacker who
 * compromised the backend storage but not the manifest signing path.
 * For v1 the manifest itself is delivered over TLS + behind authenticate
 * middleware, so a tampered hash + tampered EXE coordinated by the same
 * attacker would still bypass the check; that gap closes when we add
 * EV/OV code-signing later.
 */
function sha256Hex(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function fail(msg) {
  console.error(`[publish-desktop] ${msg}`);
  process.exit(1);
}

function readArgValue(flag) {
  const prefix = `${flag}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

if (!fs.existsSync(SRC_EXE)) {
  fail(`Installer not found at ${SRC_EXE}\nRun "npm run desktop:dist" first.`);
}

if (!fs.existsSync(DESKTOP_PKG)) {
  fail(`Could not read desktop/package.json at ${DESKTOP_PKG}`);
}

let version;
try {
  version = JSON.parse(fs.readFileSync(DESKTOP_PKG, 'utf-8')).version;
} catch (err) {
  fail(`Could not parse desktop/package.json: ${err.message}`);
}
if (typeof version !== 'string' || !version) {
  fail('desktop/package.json is missing a "version" field.');
}

fs.mkdirSync(DEST_DIR, { recursive: true });
fs.copyFileSync(SRC_EXE, DEST_EXE);
const stat = fs.statSync(DEST_EXE);

// Wrap async work in an IIFE so we can `await` the hash computation
// without changing the script's CLI shape.
(async () => {
  let sha256;
  try {
    sha256 = await sha256Hex(DEST_EXE);
  } catch (err) {
    fail(`Could not compute SHA-256 of installer: ${err.message}`);
  }

  const manifest = {
    version,
    platform: 'win32',
    // The dropdown link points here — same as the route mounted in server.js.
    // Kept absolute against the production hostname so a copy of the manifest
    // served from a different origin (e.g. ops tooling) still routes back to
    // the canonical download endpoint.
    installerUrl: 'https://monday.anistonav.com/api/desktop/download',
    releaseNotes: readArgValue('--release-notes') || '',
    mandatory: hasFlag('--mandatory'),
    publishedAt: new Date().toISOString(),
    sizeBytes: stat.size,
    // SHA-256 hex digest of the installer EXE. The desktop updater
    // re-hashes the downloaded file and refuses to spawn it if the
    // hash differs from this field.
    sha256,
  };

  fs.writeFileSync(DEST_MANIFEST, JSON.stringify(manifest, null, 2));

  console.log(`[publish-desktop] Published v${version} (${stat.size} bytes)`);
  console.log(`[publish-desktop]   installer  -> ${path.relative(REPO_ROOT, DEST_EXE)}`);
  console.log(`[publish-desktop]   manifest   -> ${path.relative(REPO_ROOT, DEST_MANIFEST)}`);
  console.log(`[publish-desktop]   sha256     -> ${sha256}`);
  console.log('[publish-desktop] Next: commit the EXE + manifest, then deploy the server so');
  console.log('[publish-desktop] /api/desktop/{manifest,download} ship the new artefacts.');
})().catch((err) => fail(`Unexpected: ${err.message}`));
