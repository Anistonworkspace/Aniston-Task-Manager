// Shared logging for the Electron main process.
//
// Two streams:
//   diag(msg)  → desktop.log, gated by ANISTON_DESKTOP_LOG / _DEBUG env var.
//                Used for verbose ops/debug traces.
//   notif(msg) → notif.log, ALWAYS written. A tiny audit trail for
//                notification dispatch so the user can verify which path
//                (custom window vs native fallback) actually fired,
//                without first having to enable a debug env var.
//
// Both files live under `app.getPath('userData')/logs/`. The notif file
// is intentionally small — one or two lines per notification — and is
// only written from the main process; the renderer never reaches it.
//
// No PII: callers MUST sanitise titles/bodies before passing them
// through. We log structural facts (path used, length of strings,
// success/failure reasons) — never the actual content of a user's
// notification.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

let diagEnabled = false;
const diagHolder = { stream: null };
const notifHolder = { stream: null };

function setDiagEnabled(v) {
  diagEnabled = !!v;
}

function logsDir() {
  // app.getPath('userData') is only valid after `app.ready`. Notification
  // dispatch is well past app.ready; setDiagEnabled is called from main.js
  // before app.ready but doesn't itself touch the FS. The ensureStream
  // helper below defers FS access to the first write call.
  return path.join(app.getPath('userData'), 'logs');
}

function ensureStream(filename, holder) {
  if (holder.stream) return holder.stream;
  try {
    const dir = logsDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    holder.stream = fs.createWriteStream(path.join(dir, filename), { flags: 'a' });
  } catch { /* ignore — best-effort */ }
  return holder.stream;
}

function _write(holder, filename, msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    const s = ensureStream(filename, holder);
    if (s) s.write(line);
  } catch { /* ignore */ }
  // Also mirror to stdout so a dev launching from a terminal can tail
  // both streams. In a packaged GUI launch stdout is detached; the
  // file is the only sink. That's by design.
  try { console.log(line.trimEnd()); } catch { /* ignore */ }
}

function diag(msg) {
  if (!diagEnabled) return;
  _write(diagHolder, 'desktop.log', msg);
}

function notif(msg) {
  _write(notifHolder, 'notif.log', msg);
}

module.exports = { diag, notif, setDiagEnabled };
