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
const { pathToFileURL } = require('url');
const { iconsRoot } = require('./paths');
const notificationWindow = require('./notificationWindow');
const sharedLog = require('./log');

// Diagnostic logger is wired in from main.js when notify() is called.
// We accept it per-call rather than imported so unit tests can mock it.

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
 * XML attribute / text escaper. Toast XML is parsed by Windows
 * ToastNotificationManager as XML, so any of these five characters in a
 * user-supplied title/body would otherwise break the XML or open a content
 * injection. We never serialise user content as anything but plain text
 * inside an element body, but defence-in-depth: escape always.
 */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build a Microsoft-Teams-style Windows Toast XML payload.
 *
 * The vanilla `new Notification({ title, body, icon })` produces a default
 * ToastGeneric binding — a small, two-line card at the bottom-right of the
 * screen. Teams uses a richer toast: a circular app-logo avatar on the
 * left, a one-line bold title, a longer (up to four lines) body, and a
 * footer attribution row. The card sits visually higher on the screen
 * just because it's taller, and `duration="long"` makes it stay ~25s
 * instead of the default ~5s. Hover-to-pause is built into the Windows
 * Action Center renderer and applies to every toast regardless of XML.
 *
 * AppUserModelId (set in main.js) must match the value baked into the
 * Start-menu / desktop shortcut by electron-builder — without that
 * Windows refuses to render custom toast XML and falls back to silence.
 * The installer wires this up automatically when `nsis.shortcutName` and
 * `appId` are both present in package.json (slice 5 config).
 */
function buildToastXml({ title, body, iconUrl }) {
  // BUG FIX (Slice 6.5): the previous version of this function set
  // `scenario="default"` on the <toast> element. That is NOT a valid
  // value in Microsoft's Toast XML schema — the only accepted scenarios
  // are `reminder`, `alarm`, `incomingCall`, `urgent`. Windows
  // ToastNotificationManager silently rejects the entire XML when it
  // fails schema validation, with no `failed` event surfaced to Electron
  // — which is exactly what users saw: every assigned task notification
  // disappeared into the void.
  //
  // The `scenario` attribute is optional. Omitting it gives the default
  // ~5 s presentation, which we override to ~25 s via `duration="long"`.
  // That's all we wanted in the first place.
  //
  // `hint-maxLines` limits each <text> block; default is 1 for title and
  // 3 for subsequent texts. We allow up to 4 body lines so notifications
  // like "Task assigned: <title>. Deadline: <date>. Assigned by: <name>."
  // fit without being truncated mid-sentence.
  return [
    '<toast duration="long">',
      '<visual>',
        '<binding template="ToastGeneric">',
          `<image placement="appLogoOverride" hint-crop="circle" src="${escapeXml(iconUrl)}"/>`,
          `<text hint-maxLines="1">${escapeXml(title)}</text>`,
          `<text hint-maxLines="4">${escapeXml(body)}</text>`,
          '<text placement="attribution">Monday Aniston</text>',
        '</binding>',
      '</visual>',
      // ms-winsoundevent:Notification.IM — the soft chime Windows uses for
      // instant-messaging style alerts. Matches Teams' notification sound.
      '<audio src="ms-winsoundevent:Notification.IM"/>',
    '</toast>',
  ].join('');
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
  const title = sanitize(payload && payload.title, 200);
  const body = sanitize(payload && payload.body, 500);
  if (!title) return { ok: false, reason: 'invalid-title' };

  const tag = isNonEmptyString(payload && payload.tag) ? payload.tag.slice(0, 200) : null;
  const url = validateClickUrl(payload && payload.url);

  if (shouldDedup(tag)) return { ok: true, deduped: true };
  if (tag) rememberTag(tag);

  // Resolve the bundled app icon. Slice 5: iconsRoot() handles both
  // packaged (process.resourcesPath/icons/) and dev (in-repo
  // client/public/icons/) cases. Slice 6.3: we also need the icon as a
  // file:// URL for embedding in the Windows Toast XML — pathToFileURL
  // handles spaces (`Monday Aniston`) and any other char that needs
  // percent-encoding in a URL.
  const iconFsPath = path.join(iconsRoot(), 'icon-512.png');
  const iconUrl = pathToFileURL(iconFsPath).href;

  // Slice 10 — PRIMARY transport: custom Teams-style notification
  // window. The window manages position (bottom-right above the
  // taskbar), hover-persistence, queue, rate limiting, and click →
  // focus + navigate. If creation fails for any reason (display
  // configuration edge case, GPU process down, etc.) the function
  // returns { ok: false } and we fall through to the native path
  // below so the user never silently misses a notification.
  const cardId = tag || `notif-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  try {
    const result = notificationWindow.show({
      payload: {
        id: cardId,
        title,
        body,
        url: url || '',
        iconUrl,
        sender: '', // not yet provided by the renderer; reserved for future
        ts: '',
      },
      onClick: ({ url: clickUrl }) => {
        try { if (onClick) onClick({ url: clickUrl }); }
        catch (err) { console.warn('[Aniston Desktop] notif-card onClick threw:', err && err.message); }
      },
      onClose: () => { /* user dismissed; nothing to do */ },
      diag: (msg) => console.log('[Aniston Desktop]', msg),
    });
    if (result && result.ok) {
      sharedLog.notif(`notify: PATH=custom-window id=${cardId} title-len=${title.length} body-len=${body.length} tag=${tag || 'none'} hasUrl=${!!url} deduped=${!!result.deduped}`);
      return { ok: true, deduped: !!result.deduped };
    }
    if (result && result.reason === 'rate-limit') {
      // Rate-limited — return success-but-deduped so the renderer
      // doesn't escalate to its own fallback. The user is mid-flood;
      // dropping is correct.
      sharedLog.notif(`notify: PATH=rate-limited id=${cardId}`);
      return { ok: true, deduped: true, reason: 'rate-limit' };
    }
    sharedLog.notif(`notify: custom window declined (reason=${result && result.reason}) — falling back to native toast`);
  } catch (err) {
    sharedLog.notif(`notify: custom window threw (${err && err.message}) — falling back to native toast`);
  }

  // Fallback path beyond this point: native Electron Notification.
  // Used only when the custom window failed to create / show.
  if (!Notification.isSupported()) {
    sharedLog.notif(`notify: PATH=unsupported (Notification.isSupported() false)`);
    return { ok: false, reason: 'unsupported' };
  }
  sharedLog.notif(`notify: PATH=native-toast id=${cardId} (custom window unavailable)`);

  // Slice 6.5 — log every notification attempt so the next time toasts
  // silently stop firing we can see exactly what happened. Values are
  // structural (title length, has-url, platform) — never the raw title
  // or body, which can contain user content.
  console.log(`[Aniston Desktop] notify: title-len=${title.length} body-len=${body.length} tag=${tag || 'none'} hasUrl=${!!url} platform=${process.platform}`);

  // Helper: build a Notification with the bells-and-whistles toast XML
  // on Windows, or the plain options elsewhere. Returns the constructed
  // Notification or throws.
  function buildNotification({ useToastXml }) {
    const ctorOptions = {
      title,
      body,
      icon: iconFsPath,
      silent: false,
    };
    if (useToastXml && process.platform === 'win32') {
      ctorOptions.toastXml = buildToastXml({ title, body, iconUrl });
    }
    return new Notification(ctorOptions);
  }

  // Helper: attach click + failed listeners to a notification instance.
  // Used for both the primary and the fallback path so behaviour is
  // identical regardless of which one ends up firing.
  function attachListeners(n, label) {
    n.on('click', () => {
      try { if (onClick) onClick({ url }); }
      catch (err) { console.warn('[Aniston Desktop] notify onClick threw:', err && err.message); }
    });
    n.on('failed', (_event, error) => {
      console.warn(`[Aniston Desktop] notification(${label}) failed:`, error);
    });
    n.on('show', () => {
      console.log(`[Aniston Desktop] notification(${label}) shown`);
    });
  }

  // Primary path: try the rich Teams-style toast XML on Windows.
  // Two failure modes are guarded:
  //   (a) constructor throws — happens when toastXml is malformed
  //       (electron does some pre-flight validation).
  //   (b) show() throws — extremely rare but possible if Windows
  //       rejects the toast before queueing it.
  // BOTH fall through to the basic Notification path below, so a user
  // ALWAYS sees the notification even if our toast XML breaks in some
  // unforeseen way. The fallback is the same shape that worked
  // pre-Slice-6.3 and pre-dates any custom XML.
  if (process.platform === 'win32') {
    try {
      const n = buildNotification({ useToastXml: true });
      attachListeners(n, 'rich');
      n.show();
      return { ok: true };
    } catch (err) {
      console.warn('[Aniston Desktop] rich toast failed, falling back to basic:', err && err.message);
      // fall through to the basic path below
    }
  }

  // Fallback / non-Windows path: vanilla Electron Notification.
  let n;
  try {
    n = buildNotification({ useToastXml: false });
  } catch (err) {
    return { ok: false, reason: 'construct-failed', error: String(err && err.message || err) };
  }
  attachListeners(n, 'basic');
  try { n.show(); }
  catch (err) {
    return { ok: false, reason: 'show-failed', error: String(err && err.message || err) };
  }

  return { ok: true };
}

module.exports = { notify };
