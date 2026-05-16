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

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_EXE = path.join(REPO_ROOT, 'desktop', 'dist', 'Monday-Aniston-Setup.exe');
const DEST_DIR = path.join(REPO_ROOT, 'server', 'downloads', 'desktop');
const DEST_EXE = path.join(DEST_DIR, 'Monday-Aniston-Setup.exe');
const DEST_MANIFEST = path.join(DEST_DIR, 'desktop-update.json');
const DESKTOP_PKG = path.join(REPO_ROOT, 'desktop', 'package.json');

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
};

fs.writeFileSync(DEST_MANIFEST, JSON.stringify(manifest, null, 2));

console.log(`[publish-desktop] Published v${version} (${stat.size} bytes)`);
console.log(`[publish-desktop]   installer  -> ${path.relative(REPO_ROOT, DEST_EXE)}`);
console.log(`[publish-desktop]   manifest   -> ${path.relative(REPO_ROOT, DEST_MANIFEST)}`);
console.log('[publish-desktop] Next: deploy the server so /api/desktop/{manifest,download} pick up the new files.');
