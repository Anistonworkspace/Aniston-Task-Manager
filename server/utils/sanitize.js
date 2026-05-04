const xss = require('xss');

/**
 * Sanitize user input to prevent XSS attacks.
 * Strips dangerous HTML tags and attributes while preserving safe text.
 */
function sanitizeInput(str) {
  if (!str || typeof str !== 'string') return str;
  return xss(str, {
    whiteList: {},       // No HTML tags allowed
    stripIgnoreTag: true, // Strip all tags
    stripIgnoreTagBody: ['script', 'style'], // Remove script/style content entirely
  });
}

/**
 * Sanitize allowing basic formatting (bold, italic, links).
 * Use for rich-text fields like descriptions.
 */
function sanitizeRichText(str) {
  if (!str || typeof str !== 'string') return str;
  return xss(str); // Default xss whitelist allows basic safe tags
}

/**
 * Sanitize a single inline value for a notification message.
 *
 * Notification messages flow into THREE renderers:
 *   1. React text in NotificationsPanel — already escapes by default
 *   2. OS-level browser push (web-push body) — renderer varies per browser/OS
 *   3. Microsoft Teams Adaptive Card text — supports Markdown by default
 *
 * Renderer #3 is the worst case — a `task.title` of `[click](javascript:alert(1))`
 * becomes a clickable link in some Teams clients. xss() with an empty whitelist
 * strips all tags; we additionally collapse Markdown link syntax to plain text
 * and bound the length so a malicious 5MB title cannot blow up the column.
 */
function sanitizeNotificationField(str, maxLen = 160) {
  if (str === null || str === undefined) return '';
  let s = String(str);
  // 1. Strip every HTML tag/script.
  s = xss(s, { whiteList: {}, stripIgnoreTag: true, stripIgnoreTagBody: ['script', 'style'] });
  // 2. Defang Markdown links / images so Teams (and any other Markdown
  //    renderer downstream) cannot turn user-controlled text into a clickable
  //    link. We simply strip the bracket+URL portion entirely — leaving the
  //    visible label and discarding the URL — because any URL coming from a
  //    user-controlled task title is by definition untrusted.
  //
  //    `![alt](url)`  → `alt`
  //    `[click](url)` → `click`         (URL discarded — it could be javascript:)
  //    `[text]`       → `text`          (orphan brackets)
  s = s.replace(/!?\[([^\]]*)\]\(.*?\)/g, '$1'); // links with no nested parens in URL
  // For URLs that DO contain parens (e.g. `(javascript:alert(1))`) the prior
  // regex fails. Strip the leading `[label]` part and let the trailing
  // `(…)` survive as plain text — readable but not renderable as a link.
  s = s.replace(/!?\[([^\]]*)\]/g, '$1');
  // 3. Collapse whitespace; trim; bound length.
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + '…';
  return s;
}

/**
 * Sanitize an assembled notification message body. Same rules as
 * sanitizeNotificationField but with a higher length budget — the message is
 * the full sentence presented to the user, while the field helper is for a
 * single interpolated value (task title, user name, board name, comment).
 *
 * Also enforces the Notification.message column limit (currently 500 in the
 * model). Truncation is silent — callers are expected to keep messages short.
 */
function sanitizeNotificationMessage(str, maxLen = 480) {
  return sanitizeNotificationField(str, maxLen);
}

module.exports = {
  sanitizeInput,
  sanitizeRichText,
  sanitizeNotificationField,
  sanitizeNotificationMessage,
};
