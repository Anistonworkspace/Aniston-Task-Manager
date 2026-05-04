/**
 * Tests for the new notification-message sanitizers.
 *
 * Notification messages flow into three renderers (React, OS push, Teams
 * Adaptive Card). The Teams card supports Markdown by default — a malicious
 * task title of `[click](javascript:alert(1))` becomes a clickable link
 * unless we defang the syntax. These helpers do that plus the standard
 * HTML strip + length bound.
 */

'use strict';

const {
  sanitizeNotificationField,
  sanitizeNotificationMessage,
} = require('../../utils/sanitize');

describe('sanitizeNotificationField', () => {
  it('strips HTML tags', () => {
    expect(sanitizeNotificationField('<script>alert(1)</script>hello')).toBe('hello');
    expect(sanitizeNotificationField('<b>Project SunSet</b>')).toBe('Project SunSet');
  });

  it('defangs Markdown links so Teams cards do not render them as clickable', () => {
    // Simple link — URL stripped entirely.
    expect(sanitizeNotificationField('![img](http://evil)')).toBe('img');
    expect(sanitizeNotificationField('See [docs](https://docs)')).toBe('See docs');
    // URL with nested parens — link bracket pair removed so the markdown
    // syntax is dead even though the trailing `(…)` survives as plain text.
    const out = sanitizeNotificationField('[click](javascript:alert(1))');
    expect(out).not.toMatch(/\[/); // no surviving open bracket
    expect(out).not.toMatch(/\]\(/); // no surviving link syntax
    expect(out.startsWith('click')).toBe(true);
  });

  it('collapses whitespace', () => {
    expect(sanitizeNotificationField('a   b\nc\td')).toBe('a b c d');
  });

  it('bounds length with an ellipsis', () => {
    const out = sanitizeNotificationField('a'.repeat(500), 32);
    expect(out.length).toBeLessThanOrEqual(32);
    expect(out.endsWith('…')).toBe(true);
  });

  it('handles null/undefined gracefully', () => {
    expect(sanitizeNotificationField(null)).toBe('');
    expect(sanitizeNotificationField(undefined)).toBe('');
  });
});

describe('sanitizeNotificationMessage', () => {
  it('returns plain text within the 480-char default budget', () => {
    const safe = sanitizeNotificationMessage('Hello <i>world</i>');
    expect(safe).toBe('Hello world');
  });

  it('truncates oversized messages within the column limit', () => {
    const out = sanitizeNotificationMessage('x'.repeat(600));
    expect(out.length).toBeLessThanOrEqual(480);
  });
});
