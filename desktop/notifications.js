// Monday Aniston — native Electron notification adapter (main process).
//
// Renderer calls window.anistonDesktop.notify({ title, body, tag, url })
// -> preload validates + clamps -> ipcRenderer.invoke('aniston:notify', ...)
// -> main process re-validates here -> new Notification({...}).show()
//
// Why a main-process Notification (not just the renderer's web one):
//   - Works regardless of the renderer's web Notification permission state
//     (which is unreliable in packaged Electron loaded from file://).
//   - Survives the renderer being hidden to the system tray.
//   - Gives us a deterministic 'click' handler in the main process so we
//     can focus the window AND tell the renderer where to navigate, without
//     relying on the renderer being responsive at click time.
//
// Slice 3 is intentionally narrow: title + body + click action only. We do
// NOT use Windows Toast actions / inline reply yet -- those need a packaged
// AppUserModelId and shipped XML templates, which is slice 5 territory.

const { Notification } = require('electron');
const path = require('path');
const { iconsRoot } = require('./paths');

// In-memory dedup. Same `notif-<id>` tag arriving twice within DEDUP_WINDOW_MS
// shows once. The renderer's burst dispatcher already throttles its own
// emissions; this is belt-and-suspenders for any path that fires the same
// tag twice (e.g. a future second adapter, or a buggy retry).
const recentNotifications = new Map();
const DEDUP_WINDOW_MS = 3000;
const DEDUP_TRIM_AT = 200;

// ASCII control characters: U+0000-U+001F + U+007F. Built via RegExp
// constructor with double-escaped \u so the literal source survives copy
// through tools that might collapse \u escapes into raw control bytes.
const CONTROL_CHARS_RE = new RegExp('[\\u0000-\\u001F\\u007F]', 'g');

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Strip control characters and clamp length. OS notification renderers
 * treat the strings as plain text -- there is no HTML/JS execution context
 * to escape against. The clamp prevents a malformed/oversized payload from
 * blowing up the OS toast layout or stalling Action Center rendering.
 */
function sanitize(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARS_RE, ' ').slice(0, maxLen);
}

/**
 * Click-action URL guardrails. Only relative SPA paths are accepted; anything
 * with a scheme is rejected so a malicious or buggy renderer cannot make a
 * notification click open `file://`, `javascript:`, or an external `https://`
 * link. Length-clamped to keep React Router parser inputs sane.
 */
function validateClickUrl(raw) {
  if (!isNonEmptyString(raw)) return null;
  if (!raw.startsWith('/')) return null;       // forbid schemes
  if (raw.startsWith('//')) return null;        // forbid protocol-relative
  return raw.slice(0, 1000);
}

function rememberTag(tag) {
  const now = Date.now();
  recentNotifications.set(tag, now);
  if (recentNotifications.size > DEDUP_TRIM_AT) {
    const cutoff = now - DEDUP_WINDOW_MS * 4;
    for (const [k, t] of recentNotifications) {
      if (t < cutoff) recentNotifications.delete(k);
    }
  }
}

function shouldDedup(tag) {
  if (!tag) return false;
  const last = recentNotifications.get(tag);
  return !!(last && Date.now() - last < DEDUP_WINDOW_MS);
}

/**
 * Show an OS notification.
 *
 * @param {object} args
 * @param {object} args.payload         Renderer-supplied { title, body, tag, url }.
 * @param {function} args.onClick       Called with { url } when the user clicks
 *                                      the OS toast. May be invoked at any time
 *                                      after `.show()` -- the OS may keep the
 *                                      toast in Action Center for hours.
 *
 * @returns {{ ok: boolean, deduped?: boolean, reason?: string, error?: string }}
 */
function notify({ payload, onClick }) {
  if (!Notification.isSupported()) {
    return { ok: false, reason: 'unsupported' };
  }

  const title = sanitize(payload && payload.title, 200);
  const body = sanitize(payload && payload.body, 500);
  if (!title) return { ok: false, reason: 'invalid-title' };

  const tag = isNonEmptyString(payload && payload.tag) ? payload.tag.slice(0, 200) : null;
  const url = validateClickUrl(payload && payload.url);

  if (shouldDedup(tag)) return { ok: true, deduped: true };
  if (tag) rememberTag(tag);

  let n;
  try {
    n = new Notification({
      title,
      body,
      // Bundled app icon. Slice 5: iconsRoot() handles both packaged
      // (process.resourcesPath/icons/) and dev (in-repo client/public/icons/)
      // cases so this code path is identical regardless of how Electron
      // was launched.
      icon: path.join(iconsRoot(), 'icon-512.png'),
      silent: false,
    });
  } catch (err) {
    return { ok: false, reason: 'construct-failed', error: String(err && err.message || err) };
  }

  // Click -> renderer navigation. Wrapped in try/catch so a callback bug
  // never bubbles up to Electron's main loop.
  n.on('click', () => {
    try { if (onClick) onClick({ url }); }
    catch (err) { console.warn('[Aniston Desktop] notify onClick threw:', err && err.message); }
  });

  // OS-level failure (Focus Assist suppression, app excluded from
  // notifications in Settings, action-center disabled, etc.). Logged only
  // -- there is no programmatic recovery available.
  n.on('failed', (_event, error) => {
    console.warn('[Aniston Desktop] notification failed:', error);
  });

  try { n.show(); }
  catch (err) {
    return { ok: false, reason: 'show-failed', error: String(err && err.message || err) };
  }

  return { ok: true };
}

module.exports = { notify };
