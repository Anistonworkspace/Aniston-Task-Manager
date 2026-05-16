// Monday Aniston — runtime path resolution.
//
// Why this exists
// ---------------
// The desktop wrapper needs to load two kinds of files at runtime:
//   1. The built React app (client/dist/index.html + its assets).
//   2. App icons (used by the window chrome, tray, and notifications).
//
// In dev / ANISTON_FORCE_PROD simulation mode, both live in the in-repo
// `client/` tree -- `__dirname` is `desktop/`, so a `..\client\...` path
// resolves correctly.
//
// In a real packaged build (electron-builder), the JS files are packed into
// `app.asar` and `__dirname` points inside the asar archive. The client
// build and icons are deliberately NOT included in the asar -- they live
// in `<install>/resources/client-dist/` and `<install>/resources/icons/`
// via electron-builder's `extraResources` config. We read them through
// `process.resourcesPath` so the asar load path doesn't apply.
//
// Selection signal
// ----------------
// `app.isPackaged` is the only reliable signal that we're in a true
// packaged build. The ANISTON_FORCE_PROD env var (used elsewhere in main.js
// to simulate the production URL config) is intentionally NOT consulted
// here: that simulation runs from the dev source tree and must keep
// reading the in-repo paths, not process.resourcesPath which would point
// at Electron's own bundled resources.

const { app } = require('electron');
const path = require('path');

function iconsRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'icons');
  }
  return path.join(__dirname, '..', 'client', 'public', 'icons');
}

function clientIndexHtml() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'client-dist', 'index.html');
  }
  return path.join(__dirname, '..', 'client', 'dist', 'index.html');
}

module.exports = { iconsRoot, clientIndexHtml };
